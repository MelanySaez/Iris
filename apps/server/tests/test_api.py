"""End-to-end API integration tests for Planet X v3 backend (no external network)."""

from __future__ import annotations

import time
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app

SAMPLE = {"ra_deg": 270.693033497, "dec_deg": 61.876515912, "size_arcmin": 4.0}


@pytest.fixture(autouse=True)
def mock_external_network():
    """Guarantee that tests never call IRSA TAP or download cutouts over network."""
    with (
        patch("app.discovery.query_irsa_tap", return_value=([], None)),
        patch("app.fits_assets.download_cutout", side_effect=RuntimeError("No network")),
    ):
        yield


def wait_until_ready(client: TestClient, job_id: str, timeout: float = 10.0) -> dict:
    start = time.time()
    while time.time() - start < timeout:
        resp = client.get(f"/api/jobs/{job_id}")
        assert resp.status_code == 200
        snap = resp.json()
        if snap["status"] in ("ready", "failed"):
            return snap
        time.sleep(0.01)
    raise TimeoutError(f"Job {job_id} did not complete within {timeout}s")


def test_channels_endpoint():
    client = TestClient(app)
    resp = client.get("/api/channels")
    assert resp.status_code == 200
    data = resp.json()
    assert data["source"]["depth"] == 102
    assert len(data["channels"]) == 102
    assert data["channels"][50]["available"] is False
    assert data["channels"][51]["available"] is False


def test_catalog_endpoint():
    client = TestClient(app)
    resp = client.get("/api/catalog")
    assert resp.status_code == 200
    objects = resp.json()["objects"]
    assert len(objects) >= 8
    obj_ids = [o["id"] for o in objects]
    assert "local-dr1-sample" in obj_ids
    assert "m81-field" in obj_ids


def test_blank_and_out_of_range_channels_rejected():
    client = TestClient(app)

    blank = {**SAMPLE, "channels": [50], "products": ["image"]}
    resp_blank = client.post("/api/jobs", json=blank)
    assert resp_blank.status_code == 422
    assert "blank" in resp_blank.json()["detail"]

    out_of_range = {**SAMPLE, "channels": [102], "products": ["image"]}
    assert client.post("/api/jobs", json=out_of_range).status_code == 422


def test_discovery_failure_is_reported_as_unknown_not_missing():
    """A TAP failure must not be reported as 'no coverage'."""
    client = TestClient(app)
    payload = {
        "ra_deg": 210.80227,
        "dec_deg": 54.34895,
        "size_arcmin": 2.0,
        "channels": [44],
        "products": ["image"],
    }

    unknown = {
        "coverage": "unknown",
        "products": [],
        "warning": "IRSA TAP returned HTTP 503",
        "region": {},
        "detectors": [],
        "notes": [],
    }
    with patch("app.jobs.resolve_region", return_value=unknown):
        job_id = client.post("/api/jobs", json=payload).json()["id"]
        snapshot = wait_until_ready(client, job_id)

    assert snapshot["status"] == "failed"
    assert "IRSA TAP" in snapshot["error"]
    assert "No SPHEREx coverage" not in snapshot["error"]


def test_trace_and_expanded_region_contract():
    from app.models import JobRequest

    client = TestClient(app)
    assert client.get("/api/health").headers["x-request-id"]
    assert JobRequest(**{**SAMPLE, "size_arcmin": 60}).size_arcmin == 60
    assert client.post("/api/jobs", json={**SAMPLE, "size_arcmin": 61}).status_code == 422
