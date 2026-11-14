"""Selection records persisted in PostgreSQL.

Uses the project database from ``DATABASE_URL`` but never its data: each test
session creates a throwaway schema (``test_<random>``), applies the real
Alembic migrations inside it, truncates its tables per test and drops it at
the end. Tests that need PostgreSQL are skipped when ``DATABASE_URL`` is unset.
"""

from __future__ import annotations

import os
import time
import uuid
from decimal import Decimal
from unittest.mock import patch

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import make_url, text

from app.jobs import job_manager
from app.main import app
from app.selections.api import configure_selections
from app.selections.db import get_database_url, get_engine
from app.selections.store import normalize_region

DATABASE_URL = get_database_url()
SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

requires_db = pytest.mark.skipif(not DATABASE_URL, reason="DATABASE_URL is not set")


def schema_url(url: str, schema: str) -> str:
    """Same database, with every connection confined to ``schema``."""
    scoped = make_url(url).update_query_dict({"options": f"-csearch_path={schema}"})
    return scoped.render_as_string(hide_password=False)


@pytest.fixture(autouse=True)
def mock_external_network():
    """Never call IRSA TAP or download cutouts over the network."""
    with (
        patch("app.discovery.query_irsa_tap", return_value=([], None)),
        patch("app.fits_assets.download_cutout", side_effect=RuntimeError("No network")),
        patch("app.jobs.download_cutout", side_effect=RuntimeError("No network")),
    ):
        yield


@pytest.fixture(scope="session")
def migrated_db():
    """Create a throwaway schema, migrate it, and drop it after the session."""
    schema = f"test_{uuid.uuid4().hex[:12]}"
    admin = get_engine(DATABASE_URL)
    with admin.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    url = schema_url(DATABASE_URL, schema)
    previous = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = url
    try:
        cfg = Config(os.path.join(SERVER_DIR, "alembic.ini"))
        cfg.set_main_option("script_location", os.path.join(SERVER_DIR, "app/alembic"))
        command.upgrade(cfg, "head")
        yield url
    finally:
        if previous is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = previous
        configure_selections(None, job_manager)
        get_engine(url).dispose()
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))


@pytest.fixture
def client(migrated_db):
    with get_engine(migrated_db).begin() as conn:
        conn.execute(text("TRUNCATE selection, spectral_product, sky_region CASCADE"))
    configure_selections(migrated_db, job_manager)
    try:
        yield TestClient(app)
    finally:
        configure_selections(None, job_manager)


def region(ra: float, dec: float = -20.0, size: float = 4.0) -> dict:
    """Unique coordinates per test avoid the shared in-memory job cache."""
    return {"ra_deg": ra, "dec_deg": dec, "size_arcmin": size}


def wait_for_outcome(client: TestClient, selection_id: str, timeout: float = 10.0):
    start = time.time()
    while time.time() - start < timeout:
        body = client.get(f"/api/selections/{selection_id}").json()
        if body["job_status"] in ("ready", "failed"):
            return body
        time.sleep(0.02)
    raise TimeoutError(f"selection {selection_id} never reached a final status")


def find_by_job(client: TestClient, job_id: str) -> dict:
    items = client.get("/api/selections").json()["items"]
    matches = [item for item in items if item["job_id"] == job_id]
    assert len(matches) == 1
    return matches[0]


# -- pure normalization ------------------------------------------------------


def test_normalize_region_wraps_ra_and_fixes_precision():
    key = normalize_region(-10.0, 12.3456789, 4.00049)
    assert key == {
        "ra_deg": Decimal("350.00000"),
        "dec_deg": Decimal("12.34568"),
        "size_arcmin": Decimal("4.000"),
    }
    assert normalize_region(360.0, 0.0, 1.0)["ra_deg"] == Decimal("0.00000")


# -- automatic saving --------------------------------------------------------


@requires_db
def test_job_submission_is_saved_automatically(client):
    resp = client.post(
        "/api/jobs",
        json={**region(10.5), "channels": [44, 12], "products": ["variance"]},
    )
    assert resp.status_code == 202
    job = resp.json()

    saved = find_by_job(client, job["id"])
    assert saved["channels"] == [12, 44]
    assert saved["products"] == ["image", "variance"]
    assert saved["mode"] == "latest"
    assert saved["stretch"] == "asinh"
    assert saved["hits"] == 1
    assert saved["region"]["ra_deg"] == 10.5
    assert saved["region"]["dec_deg"] == -20.0
    assert saved["region"]["size_arcmin"] == 4.0
    assert saved["region"]["fov_deg"] == round(4.0 / 60.0, 4)

    final = wait_for_outcome(client, saved["id"])
    assert final["job_status"] == "failed"
    assert final["region"]["coverage"] == "none"
    assert final["manifest"] is None


@requires_db
def test_repeated_selection_counts_hits_instead_of_duplicating(client):
    payload = {**region(11.5), "channels": [44]}
    first = client.post("/api/jobs", json=payload).json()
    saved = find_by_job(client, first["id"])
    wait_for_outcome(client, saved["id"])

    second = client.post("/api/jobs", json=payload).json()
    assert second["id"] == first["id"]

    items = client.get("/api/selections").json()["items"]
    assert len(items) == 1
    assert items[0]["hits"] == 2
    assert items[0]["last_seen_at"] >= items[0]["created_at"]


@requires_db
def test_discovered_products_are_stored_with_derived_fields(client):
    discovery = {
        "coverage": "available",
        "products": [
            {
                "id": "prod-1",
                "source": "remote",
                "detector": 3,
                "band": "SPHEREx-D3",
                "obs_id": "obs-1",
                "uri": "https://example.invalid/prod-1.fits",
                "date_mjd": 60800.5,
                "date_iso": "2025-05-08T12:00:00Z",
            }
        ],
        "detectors": [],
        "notes": [],
    }
    with patch("app.jobs.resolve_region", return_value=discovery):
        job = client.post("/api/jobs", json={**region(12.5), "channels": [44]}).json()
        saved = find_by_job(client, job["id"])
        detail = wait_for_outcome(client, saved["id"])

    assert detail["region"]["coverage"] == "available"
    assert detail["spectral_products"] == [
        {
            "product_id": "prod-1",
            "detector": 3,
            "band": "SPHEREx-D3",
            "source": "remote",
            "obs_id": "obs-1",
            "uri": "https://example.invalid/prod-1.fits",
            "date_mjd": 60800.5,
            "date_iso": "2025-05-05T12:00:00.000Z",
        }
    ]


# -- listing -----------------------------------------------------------------


@requires_db
def test_list_is_paginated_by_last_seen(client):
    for ra in (13.5, 14.5, 15.5):
        client.post("/api/jobs", json={**region(ra), "channels": [44]})

    page1 = client.get("/api/selections", params={"limit": 2}).json()
    assert len(page1["items"]) == 2
    assert page1["next_before"] is not None

    page2 = client.get(
        "/api/selections", params={"limit": 2, "before": page1["next_before"]}
    ).json()
    assert len(page2["items"]) == 1
    assert page2["next_before"] is None
    seen = {i["id"] for i in page1["items"]} | {i["id"] for i in page2["items"]}
    assert len(seen) == 3


# -- deletion ----------------------------------------------------------------


@requires_db
def test_delete_removes_only_the_selection(client, migrated_db):
    job = client.post("/api/jobs", json={**region(16.5), "channels": [44]}).json()
    saved = find_by_job(client, job["id"])
    wait_for_outcome(client, saved["id"])

    resp = client.delete(f"/api/selections/{saved['id']}")
    assert resp.status_code == 204
    assert resp.content == b""

    assert client.get(f"/api/selections/{saved['id']}").status_code == 404
    assert client.delete(f"/api/selections/{saved['id']}").status_code == 404
    assert client.get("/api/selections").json()["items"] == []

    with get_engine(migrated_db).connect() as conn:
        regions = conn.execute(text("SELECT count(*) FROM sky_region")).scalar_one()
    assert regions == 1


@requires_db
def test_unknown_or_malformed_ids(client):
    assert client.get(f"/api/selections/{uuid.uuid4()}").status_code == 404
    assert client.get("/api/selections/not-a-uuid").status_code == 422
    assert client.delete("/api/selections/not-a-uuid").status_code == 422


# -- storage disabled or failing never breaks jobs ----------------------------


def test_endpoints_answer_503_when_storage_is_disabled():
    configure_selections(None, job_manager)
    client = TestClient(app)
    for method, path in (
        ("get", "/api/selections"),
        ("get", f"/api/selections/{uuid.uuid4()}"),
        ("delete", f"/api/selections/{uuid.uuid4()}"),
    ):
        resp = getattr(client, method)(path)
        assert resp.status_code == 503
        assert "DATABASE_URL" in resp.json()["detail"]

    resp = client.post("/api/jobs", json={**region(17.5), "channels": [44]})
    assert resp.status_code == 202


def test_unreachable_database_does_not_break_job_submission():
    configure_selections("postgresql+psycopg://nobody@127.0.0.1:1/missing", job_manager)
    try:
        client = TestClient(app)
        resp = client.post("/api/jobs", json={**region(18.5), "channels": [44]})
        assert resp.status_code == 202
        job_id = resp.json()["id"]
        start = time.time()
        while time.time() - start < 10:
            status = client.get(f"/api/jobs/{job_id}").json()["status"]
            if status in ("ready", "failed"):
                break
            time.sleep(0.02)
        assert status in ("ready", "failed")
    finally:
        configure_selections(None, job_manager)


# -- review follow-ups: startup safety, event ordering, cached outcomes --------


def test_driverless_or_invalid_database_url_never_breaks_startup():
    try:
        store = configure_selections(
            "postgresql://iris:iris@127.0.0.1:1/iris", job_manager
        )
        assert store is not None
        assert store.engine_url.startswith("postgresql+psycopg://")
        assert configure_selections("definitely not a url", job_manager) is None
        resp = TestClient(app).get("/api/selections")
        assert resp.status_code == 503
    finally:
        configure_selections(None, job_manager)


class _OrderObserver:
    def __init__(self) -> None:
        self.events: list[str] = []

    def on_submitted(self, job) -> None:
        self.events.append("submitted")

    def on_discovered(self, job, discovery) -> None:
        self.events.append("discovered")

    def on_finished(self, job) -> None:
        self.events.append("finished")


def test_submission_is_notified_before_the_job_can_finish():
    """Even a job that finishes instantly must be recorded before its outcome."""
    from app.models import JobRequest

    observer = _OrderObserver()
    job_manager.add_observer(observer)

    def run_inline(fn, *args):
        fn(*args)

    try:
        with patch.object(job_manager.pool, "submit", side_effect=run_inline):
            job_manager.submit(JobRequest(**region(19.5), channels=[44]))
    finally:
        job_manager.remove_observer(observer)
    assert observer.events == ["submitted", "discovered", "finished"]


def test_cached_terminal_job_records_its_outcome_on_submit():
    """A cache hit never runs the job again, so the submit must store the outcome."""
    from app.jobs import JobState
    from app.models import JobRequest
    from app.selections.recorder import SelectionRecorder

    calls: list[tuple] = []

    class FakeStore:
        def record_submission(self, job_id, req, status):
            calls.append(("submission", job_id, status))

        def record_outcome(self, job_id, status, manifest):
            calls.append(("outcome", job_id, status, manifest))

    job = JobState(id="cached-job", request=JobRequest(**region(20.5)), status="ready")
    manifest = {"job_id": "cached-job", "region": {}}
    with (
        patch("app.selections.recorder.get_job_manifest", return_value=manifest),
        patch(
            "app.selections.recorder.ManifestResponse",
            side_effect=lambda **kw: type(
                "M", (), {"model_dump": lambda self, mode: kw}
            )(),
        ),
    ):
        SelectionRecorder(FakeStore()).on_submitted(job)

    assert calls == [
        ("submission", "cached-job", "ready"),
        ("outcome", "cached-job", "ready", manifest),
    ]


# -- single database: tests never touch the developer's data ------------------


@requires_db
def test_tests_run_inside_a_throwaway_schema(client, migrated_db):
    with get_engine(migrated_db).connect() as conn:
        schema = conn.execute(text("SELECT current_schema()")).scalar_one()
    assert schema.startswith("test_")
    assert schema != "public"


def test_other_tests_do_not_record_selections_by_default():
    from app.selections.recorder import SelectionRecorder

    assert not any(isinstance(o, SelectionRecorder) for o in job_manager.observers)


def test_invalid_database_url_is_never_logged_with_its_password(caplog):
    caplog.set_level("DEBUG")
    secret = "s3cretPW"
    try:
        store = configure_selections(
            f"postgresql+psycopg//iris:{secret}@h/iris", job_manager
        )
    finally:
        configure_selections(None, job_manager)
    assert store is None
    assert "invalid DATABASE_URL" in caplog.text
    logged = caplog.text + "".join(r.exc_text or "" for r in caplog.records)
    assert secret not in logged
