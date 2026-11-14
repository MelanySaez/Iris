"""End-to-end API integration tests for Planet X v3 backend (no external network)."""

from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

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


NO_COVERAGE = {"ra_deg": 10.25, "dec_deg": -30.0, "size_arcmin": 4.0}


def test_api_error_paths():
    client = TestClient(app)

    # Unknown job: 404
    assert client.get("/api/jobs/nonexistent-job-id").status_code == 404
    assert (
        client.get("/api/jobs/nonexistent-job-id/frames/20/image.png").status_code == 404
    )

    # Region larger than 60 arcmin: 422
    assert (
        client.post("/api/jobs", json={**NO_COVERAGE, "size_arcmin": 75.0}).status_code
        == 422
    )

    # More than 8 channels: 422
    too_many = {**NO_COVERAGE, "channels": [1, 2, 3, 4, 5, 6, 7, 8, 9]}
    assert client.post("/api/jobs", json=too_many).status_code == 422


def test_failed_job_is_replaced_and_rerun_on_resubmit():
    from app.jobs import JobState, job_manager
    from app.models import JobRequest

    req = JobRequest(**NO_COVERAGE, channels=[20], products=["image"])
    job_id = job_manager.compute_job_id(req)
    stale = JobState(id=job_id, request=req, status="failed", error="transient")
    with job_manager.lock:
        job_manager.jobs[job_id] = stale

    retried = job_manager.submit(JobRequest(**req.model_dump()))
    assert retried is not stale
    assert retried.id == job_id

    snapshot = wait_until_ready(TestClient(app), retried.id)
    assert snapshot["status"] == "failed"
    assert snapshot["error"] == "No SPHEREx coverage found for this region."
    assert any(e["stage"] == "Discovering products" for e in snapshot["events"])


# -- failure traceability ----------------------------------------------------


def _submit_and_wait(client: TestClient, payload: dict) -> tuple[dict, dict]:
    resp = client.post("/api/jobs", json=payload)
    assert resp.status_code == 202
    return resp, wait_until_ready(client, resp.json()["id"])


def test_no_coverage_failure_records_stage_and_kind():
    client = TestClient(app)
    _, snap = _submit_and_wait(client, {**NO_COVERAGE, "ra_deg": 11.25, "channels": [44]})
    assert snap["status"] == "failed"
    assert snap["failed_stage"] == "discovering"
    assert snap["error_kind"] == "no_coverage"
    assert snap["error_trace"] is None
    assert [e["stage"] for e in snap["events"]] == ["Discovering products", "Failed"]


def test_discovery_outage_is_classified_as_unavailable():
    discovery = {
        "coverage": "unknown",
        "warning": "ReadTimeout: timed out",
        "products": [],
    }
    client = TestClient(app)
    with patch("app.jobs.resolve_region", return_value=discovery):
        _, snap = _submit_and_wait(
            client, {**NO_COVERAGE, "ra_deg": 12.25, "channels": [44]}
        )
    assert snap["failed_stage"] == "discovering"
    assert snap["error_kind"] == "discovery_unavailable"
    assert "ReadTimeout: timed out" in snap["error"]


def test_unexpected_error_keeps_stage_kind_and_traceback():
    discovery = {
        "coverage": "available",
        "products": [
            {
                "id": "p1",
                "source": "remote",
                "detector": 3,
                "band": "SPHEREx-D3",
                "obs_id": "o1",
                "uri": "https://example.invalid/p1.fits",
                "date_mjd": 60800.5,
                "date_iso": "2025-05-05T12:00:00.000Z",
            }
        ],
    }
    client = TestClient(app)
    with (
        patch("app.jobs.resolve_region", return_value=discovery),
        patch("app.jobs.download_cutout", side_effect=RuntimeError("No network")),
    ):
        _, snap = _submit_and_wait(
            client, {**NO_COVERAGE, "ra_deg": 13.25, "channels": [44]}
        )
    assert snap["failed_stage"] == "downloading"
    assert snap["error_kind"] == "download_failed"
    assert snap["error"] == "RuntimeError: No network"
    assert "Traceback" in snap["error_trace"]
    assert 'File "' in snap["error_trace"] and ", line " in snap["error_trace"]
    assert snap["error_trace"].rstrip().endswith("RuntimeError: No network")


def test_job_keeps_the_request_id_that_created_it():
    client = TestClient(app)
    resp, snap = _submit_and_wait(
        client, {**NO_COVERAGE, "ra_deg": 14.25, "channels": [44]}
    )
    assert snap["request_id"] == resp.headers["X-Request-ID"]


def _discovery_with(detector: int, source: str) -> dict:
    return {
        "coverage": "available",
        "products": [
            {
                "id": f"p-{detector}-{source}",
                "source": source,
                "detector": detector,
                "band": f"SPHEREx-D{detector}",
                "obs_id": "o1",
                "uri": "https://example.invalid/p.fits",
                "date_mjd": 60800.5,
                "date_iso": "2025-05-05T12:00:00.000Z",
            }
        ],
    }


def test_channels_without_detector_coverage_are_classified():
    # Channel 44 needs detector 3; discovery only found detector 1.
    client = TestClient(app)
    with patch("app.jobs.resolve_region", return_value=_discovery_with(1, "remote")):
        _, snap = _submit_and_wait(
            client, {**NO_COVERAGE, "ra_deg": 15.25, "channels": [44]}
        )
    assert snap["failed_stage"] == "discovering"
    assert snap["error_kind"] == "no_detector_coverage"
    assert snap["error_trace"] is None


def test_crash_during_discovery_falls_back_to_unexpected():
    client = TestClient(app)
    with patch("app.jobs.resolve_region", side_effect=RuntimeError("TAP crashed")):
        _, snap = _submit_and_wait(
            client, {**NO_COVERAGE, "ra_deg": 16.25, "channels": [44]}
        )
    assert snap["failed_stage"] == "discovering"
    assert snap["error_kind"] == "unexpected"
    assert snap["error_trace"].rstrip().endswith("RuntimeError: TAP crashed")


def test_extraction_crash_is_classified():
    client = TestClient(app)
    with (
        patch("app.jobs.resolve_region", return_value=_discovery_with(3, "local")),
        patch("app.jobs.get_or_extract_derived", side_effect=ValueError("bad WCS")),
    ):
        _, snap = _submit_and_wait(
            client, {**NO_COVERAGE, "ra_deg": 17.25, "channels": [44]}
        )
    assert snap["failed_stage"] == "extracting"
    assert snap["error_kind"] == "extraction_failed"
    assert snap["error_trace"].rstrip().endswith("ValueError: bad WCS")


def test_render_crash_is_classified():
    cutout = MagicMock(detector=3)
    client = TestClient(app)
    with (
        patch("app.jobs.resolve_region", return_value=_discovery_with(3, "local")),
        patch("app.jobs.get_or_extract_derived", return_value=cutout),
        patch(
            "app.jobs.compute_cutout_percentiles", side_effect=RuntimeError("no pixels")
        ),
    ):
        _, snap = _submit_and_wait(
            client, {**NO_COVERAGE, "ra_deg": 18.25, "channels": [44]}
        )
    assert snap["failed_stage"] == "rendering"
    assert snap["error_kind"] == "render_failed"
    assert snap["error_trace"].rstrip().endswith("RuntimeError: no pixels")
