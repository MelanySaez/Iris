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

from app.services.jobs import job_manager
from app.main import app
from app.services.selections import configure_selections
from app.core.database import get_database_url, get_engine
from app.repositories.selection import normalize_region

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
        patch("app.services.discovery.query_irsa_tap", return_value=([], None)),
        patch("app.services.fits.download_cutout", side_effect=RuntimeError("No network")),
        patch("app.services.jobs.download_cutout", side_effect=RuntimeError("No network")),
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
    assert final["job_error"] == "No SPHEREx coverage found for this region."
    assert final["failed_stage"] == "discovering"
    assert final["error_kind"] == "no_coverage"
    assert final["error_trace"] is None
    assert [e["stage"] for e in final["job_events"]] == ["Discovering products", "Failed"]
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


# -- view mode (how the Sky map showed the region) ----------------------------


@requires_db
def test_selection_stores_the_view_mode_it_was_made_in(client):
    view = {"mode": "rgb", "rgb": [16, 32, 46]}
    payload = {**region(12.5), "channels": [44], "view": view}
    job = client.post("/api/jobs", json=payload).json()

    saved = find_by_job(client, job["id"])
    assert saved["view_mode"] == "rgb"
    assert saved["rgb_channels"] == [16, 32, 46]
    assert saved["channels"] == [44]


@requires_db
def test_selection_without_a_view_has_no_view_mode(client):
    job = client.post("/api/jobs", json={**region(13.5), "channels": [44]}).json()

    saved = find_by_job(client, job["id"])
    assert saved["view_mode"] is None
    assert saved["rgb_channels"] is None


@requires_db
def test_repeated_selection_keeps_the_latest_view_and_ignores_missing_ones(client):
    payload = {**region(14.5), "channels": [44]}
    rgb_view = {"mode": "rgb", "rgb": [16, 32, 46]}
    first = client.post("/api/jobs", json={**payload, "view": rgb_view}).json()
    saved = find_by_job(client, first["id"])
    wait_for_outcome(client, saved["id"])

    second = client.post("/api/jobs", json={**payload, "view": {"mode": "single"}}).json()
    assert second["id"] == first["id"]
    latest = find_by_job(client, first["id"])
    assert latest["view_mode"] == "single"
    assert latest["rgb_channels"] is None
    assert latest["hits"] == 2

    # A request without a view (e.g. Plate re-requesting a job) keeps the recorded one.
    client.post("/api/jobs", json=payload)
    kept = find_by_job(client, first["id"])
    assert kept["view_mode"] == "single"
    assert kept["hits"] == 3


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
    with patch("app.services.jobs.resolve_region", return_value=discovery):
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


# -- names ------------------------------------------------------------------


@requires_db
def test_selection_can_be_named_renamed_and_unnamed(client):
    job = client.post("/api/jobs", json={**region(15.25), "channels": [44]}).json()
    saved = find_by_job(client, job["id"])
    assert saved["name"] is None

    resp = client.patch(f"/api/selections/{saved['id']}", json={"name": "  M101 core  "})
    assert resp.status_code == 200
    assert resp.json()["name"] == "M101 core"
    assert resp.json()["id"] == saved["id"]
    assert find_by_job(client, job["id"])["name"] == "M101 core"
    assert client.get(f"/api/selections/{saved['id']}").json()["name"] == "M101 core"

    renamed = client.patch(f"/api/selections/{saved['id']}", json={"name": "Whirlpool"})
    assert renamed.json()["name"] == "Whirlpool"

    for cleared in ({"name": "   "}, {"name": None}):
        resp = client.patch(f"/api/selections/{saved['id']}", json=cleared)
        assert resp.status_code == 200
        assert resp.json()["name"] is None


@requires_db
def test_name_survives_selecting_the_same_region_again(client):
    payload = {**region(15.75), "channels": [44]}
    job = client.post("/api/jobs", json=payload).json()
    saved = find_by_job(client, job["id"])
    wait_for_outcome(client, saved["id"])
    client.patch(f"/api/selections/{saved['id']}", json={"name": "Kept"})

    client.post("/api/jobs", json=payload)
    again = find_by_job(client, job["id"])
    assert again["hits"] == 2
    assert again["name"] == "Kept"


@requires_db
def test_invalid_names_and_unknown_selections_are_rejected(client):
    job = client.post("/api/jobs", json={**region(15.5), "channels": [44]}).json()
    saved = find_by_job(client, job["id"])

    too_long = client.patch(f"/api/selections/{saved['id']}", json={"name": "x" * 81})
    assert too_long.status_code == 422
    assert client.patch(f"/api/selections/{saved['id']}", json={}).status_code == 422
    assert find_by_job(client, job["id"])["name"] is None

    exact = client.patch(f"/api/selections/{saved['id']}", json={"name": "y" * 80})
    assert exact.status_code == 200

    missing = client.patch(f"/api/selections/{uuid.uuid4()}", json={"name": "Ghost"})
    assert missing.status_code == 404
    assert missing.json()["detail"] == "Selection not found."


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

    def on_submitted(self, job, is_new, request=None) -> None:
        self.events.append("submitted" if is_new else "submitted-cached")

    def on_discovered(self, job, discovery) -> None:
        self.events.append("discovered")

    def on_finished(self, job) -> None:
        self.events.append("finished")


def test_submission_is_notified_before_the_job_can_finish():
    """Even a job that finishes instantly must be recorded before its outcome."""
    from app.schemas.jobs import JobRequest

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


class _FakeStore:
    def __init__(self, inserted: bool, stored_status: str | None = None) -> None:
        self.inserted = inserted
        self.stored_status = stored_status
        self.calls: list[tuple] = []

    def record_submission(self, job_id, req, status, *, new_attempt):
        from app.repositories.selection import SubmissionResult

        self.calls.append(("submission", job_id, status, new_attempt))
        return SubmissionResult(
            inserted=self.inserted, stored_status=self.stored_status or status
        )

    def record_outcome(self, job_id, status, manifest, error, **details):
        self.calls.append(("outcome", job_id, status, manifest, error))


def _fake_manifest(manifest):
    return (
        patch("app.services.selections.get_job_manifest", return_value=manifest),
        patch(
            "app.services.selections.ManifestResponse",
            side_effect=lambda **kw: type(
                "M", (), {"model_dump": lambda self, mode: kw}
            )(),
        ),
    )


def test_cached_terminal_job_records_its_outcome_when_its_row_is_new():
    """A cache hit never runs again: a freshly created row needs the outcome now."""
    from app.services.jobs import JobState
    from app.schemas.jobs import JobRequest
    from app.services.selections import SelectionRecorder

    store = _FakeStore(inserted=True)
    job = JobState(id="cached-job", request=JobRequest(**region(20.5)), status="ready")
    manifest = {"job_id": "cached-job", "region": {}}
    p1, p2 = _fake_manifest(manifest)
    with p1, p2:
        SelectionRecorder(store).on_submitted(job, False)

    assert store.calls == [
        ("submission", "cached-job", "ready", False),
        ("outcome", "cached-job", "ready", manifest, None),
    ]


def test_repeated_cache_hit_does_not_rebuild_the_outcome():
    """An existing row already holds the outcome: only the hit is counted."""
    from app.services.jobs import JobState
    from app.schemas.jobs import JobRequest
    from app.services.selections import SelectionRecorder

    store = _FakeStore(inserted=False, stored_status="ready")
    job = JobState(id="cached-job", request=JobRequest(**region(20.5)), status="ready")
    p1, p2 = _fake_manifest({"job_id": "cached-job"})
    with p1 as manifest_mock, p2:
        SelectionRecorder(store).on_submitted(job, False)

    assert store.calls == [("submission", "cached-job", "ready", False)]
    manifest_mock.assert_not_called()


def test_new_attempt_is_submitted_as_a_reset():
    from app.services.jobs import JobState
    from app.schemas.jobs import JobRequest
    from app.services.selections import SelectionRecorder

    store = _FakeStore(inserted=False)
    job = JobState(id="new-job", request=JobRequest(**region(20.5)))
    SelectionRecorder(store).on_submitted(job, True)
    assert store.calls == [("submission", "new-job", "queued", True)]


# -- single database: tests never touch the developer's data ------------------


@requires_db
def test_tests_run_inside_a_throwaway_schema(client, migrated_db):
    with get_engine(migrated_db).connect() as conn:
        schema = conn.execute(text("SELECT current_schema()")).scalar_one()
    assert schema.startswith("test_")
    assert schema != "public"


def test_other_tests_do_not_record_selections_by_default():
    from app.services.selections import SelectionRecorder

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


# -- job_error -------------------------------------------------------------------


def test_failed_outcome_stores_the_job_error():
    from app.services.jobs import JobState
    from app.schemas.jobs import JobRequest
    from app.services.selections import SelectionRecorder

    calls: list[tuple] = []

    class FakeStore:
        def record_outcome(self, job_id, status, manifest, error, **details):
            calls.append((job_id, status, manifest, error))

    job = JobState(
        id="failed-job",
        request=JobRequest(**region(21.5)),
        status="failed",
        error="Coverage could not be determined: IRSA TAP discovery failed.",
    )
    SelectionRecorder(FakeStore()).on_finished(job)
    assert calls == [
        (
            "failed-job",
            "failed",
            None,
            "Coverage could not be determined: IRSA TAP discovery failed.",
        )
    ]


@requires_db
def test_resubmission_clears_the_previous_error(client):
    from app.schemas.jobs import JobRequest
    from app.services.selections import get_selection_repository

    payload = {**region(22.5), "channels": [44]}
    job = client.post("/api/jobs", json=payload).json()
    saved = find_by_job(client, job["id"])
    assert wait_for_outcome(client, saved["id"])["job_error"] is not None

    result = get_selection_repository().record_submission(
        job["id"], JobRequest(**payload), "queued", new_attempt=True
    )
    assert result.inserted is False
    assert result.stored_status == "queued"
    detail = client.get(f"/api/selections/{saved['id']}").json()
    assert detail["job_status"] == "queued"
    assert detail["job_error"] is None
    assert detail["failed_stage"] is None
    assert detail["error_kind"] is None
    assert detail["error_trace"] is None
    assert detail["job_events"] is None


@requires_db
def test_cache_hit_never_overwrites_a_recorded_outcome(client):
    """A late cache-hit write (e.g. a duplicate submit) keeps status and error."""
    from app.schemas.jobs import JobRequest
    from app.services.selections import get_selection_repository

    payload = {**region(23.5), "channels": [44]}
    job = client.post("/api/jobs", json=payload).json()
    saved = find_by_job(client, job["id"])
    final = wait_for_outcome(client, saved["id"])

    get_selection_repository().record_submission(
        job["id"], JobRequest(**payload), "discovering", new_attempt=False
    )
    detail = client.get(f"/api/selections/{saved['id']}").json()
    assert detail["job_status"] == final["job_status"] == "failed"
    assert detail["job_error"] == final["job_error"]
    assert detail["hits"] == 2


@requires_db
def test_record_submission_reports_whether_the_row_was_created(client):
    from app.schemas.jobs import JobRequest
    from app.services.selections import get_selection_repository

    req = JobRequest(**region(24.5), channels=[44])
    store = get_selection_repository()
    first = store.record_submission(
        "fresh-row-000000001", req, "ready", new_attempt=False
    )
    second = store.record_submission(
        "fresh-row-000000001", req, "queued", new_attempt=False
    )
    assert (first.inserted, first.stored_status) == (True, "ready")
    assert (second.inserted, second.stored_status) == (False, "ready")


def test_cache_hit_heals_a_row_stuck_in_an_intermediate_status():
    """If the outcome write was lost, a later cache hit stores it."""
    from app.services.jobs import JobState
    from app.schemas.jobs import JobRequest
    from app.services.selections import SelectionRecorder

    store = _FakeStore(inserted=False, stored_status="discovering")
    job = JobState(
        id="stuck-job",
        request=JobRequest(**region(25.5)),
        status="failed",
        error="No SPHEREx coverage found for this region.",
    )
    SelectionRecorder(store).on_submitted(job, False)
    assert store.calls == [
        ("submission", "stuck-job", "failed", False),
        (
            "outcome",
            "stuck-job",
            "failed",
            None,
            "No SPHEREx coverage found for this region.",
        ),
    ]


@requires_db
def test_lost_outcome_is_recovered_on_the_next_cache_hit(client):
    from app.services.jobs import JobState
    from app.schemas.jobs import JobRequest
    from app.services.selections import get_selection_repository
    from app.services.selections import SelectionRecorder

    req = JobRequest(**region(26.5), channels=[44])
    store = get_selection_repository()
    store.record_submission("stuck-row-0000000001", req, "discovering", new_attempt=True)

    job = JobState(
        id="stuck-row-0000000001",
        request=req,
        status="failed",
        error="Coverage could not be determined: IRSA TAP discovery failed.",
    )
    SelectionRecorder(store).on_submitted(job, False)

    saved = find_by_job(client, "stuck-row-0000000001")
    assert saved["job_status"] == "failed"
    assert saved["job_error"] == job.error
    assert saved["hits"] == 2


def test_outcome_carries_stage_kind_trace_and_timeline():
    from app.services.jobs import JobState
    from app.schemas.jobs import JobRequest
    from app.services.selections import SelectionRecorder

    seen: dict = {}

    class FakeStore:
        def record_outcome(self, job_id, status, manifest, error, **details):
            seen.update(details)

    events = [
        {"stage": "Discovering products", "at": 1.0},
        {"stage": "Failed", "at": 2.5},
    ]
    job = JobState(
        id="traced-job",
        request=JobRequest(**region(27.5)),
        status="failed",
        error="RuntimeError: boom",
        failed_stage="downloading",
        error_kind="download_failed",
        error_trace="Traceback ...\nRuntimeError: boom",
        events=events,
    )
    SelectionRecorder(FakeStore()).on_finished(job)
    assert seen == {
        "failed_stage": "downloading",
        "error_kind": "download_failed",
        "error_trace": "Traceback ...\nRuntimeError: boom",
        "events": events,
    }
