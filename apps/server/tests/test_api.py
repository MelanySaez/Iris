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


def test_health_endpoint():
    client = TestClient(app)
    resp = client.get("/api/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["version"] == "0.2.0"
    assert data["local_assets"] is True
    assert "DR1 All-Sky Cube HiPS" in data["products"]


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
    by_id = {o["id"]: o for o in objects}
    # The notebook demo field at (210.80227, 54.34895) is M101, not M81.
    assert "m81-field" not in by_id
    assert by_id["m101-field"]["name"] == "M101 field"
    assert (by_id["m101-field"]["ra_deg"], by_id["m101-field"]["dec_deg"]) == (
        210.80227,
        54.34895,
    )
    # M81 itself, at its real J2000 position.
    assert by_id["m81"]["name"] == "M81 (Bode's Galaxy)"
    assert by_id["m81"]["ra_deg"] == pytest.approx(148.888221)
    assert by_id["m81"]["dec_deg"] == pytest.approx(69.065294)


def test_regions_resolve_endpoint():
    client = TestClient(app)
    # Local sample region is covered by local asset
    resp = client.post("/api/regions/resolve", json=SAMPLE)
    assert resp.status_code == 200
    data = resp.json()
    assert data["coverage"] == "available"
    assert any(p["source"] == "local" for p in data["products"])

    # Out of range size > 60 arcmin
    resp_large = client.post("/api/regions/resolve", json={**SAMPLE, "size_arcmin": 35.0})
    assert resp_large.status_code == 422


def test_job_lifecycle_and_products_end_to_end():
    client = TestClient(app)

    # Submit job for channel 20 (Detector 2, matching local asset)
    payload = {
        "ra_deg": SAMPLE["ra_deg"],
        "dec_deg": SAMPLE["dec_deg"],
        "size_arcmin": SAMPLE["size_arcmin"],
        "channels": [20],
        "products": ["image", "variance", "flags"],
        "mode": "latest",
        "stretch": "asinh",
    }
    create_resp = client.post("/api/jobs", json=payload)
    assert create_resp.status_code == 202
    job_id = create_resp.json()["id"]

    ready_snap = wait_until_ready(client, job_id)
    assert ready_snap["status"] == "ready", ready_snap.get("error")
    assert ready_snap["wavelength_status"] == "wcs_wave_approximate"
    assert ready_snap["calibrated"] is False
    assert ready_snap["multi_product_mosaic"] == "pending"

    assert len(ready_snap["cutouts"]) >= 1
    assert len(ready_snap["frames"]) == 3  # image, variance, flags

    # Test full and slice frame PNG routes
    for product in ("image", "variance", "flags"):
        full_resp = client.get(
            f"/api/jobs/{job_id}/frames/20/{product}.png", params={"mode": "full"}
        )
        assert full_resp.status_code == 200
        assert full_resp.headers["content-type"] == "image/png"
        assert full_resp.content.startswith(b"\x89PNG\r\n\x1a\n")

        slice_resp = client.get(
            f"/api/jobs/{job_id}/frames/20/{product}.png", params={"mode": "slice"}
        )
        assert slice_resp.status_code == 200
        assert slice_resp.headers["content-type"] == "image/png"

    # Test raw NPY routes
    for product in ("image", "variance", "flags", "wavelengths"):
        npy_resp = client.get(f"/api/jobs/{job_id}/frames/20/{product}.npy")
        assert npy_resp.status_code == 200
        assert npy_resp.content.startswith(b"\x93NUMPY")

    # Test pixel probe route
    h, w = ready_snap["cutouts"][0]["shape"]
    cx, cy = w // 2, h // 2
    pixel_resp = client.get(
        f"/api/jobs/{job_id}/pixel",
        params={"x": cx, "y": cy, "channel": 20, "epoch": 0},
    )
    assert pixel_resp.status_code == 200
    pixel = pixel_resp.json()
    assert pixel["x"] == cx
    assert pixel["y"] == cy
    assert pixel["wavelength_status"] == "wcs_wave_approximate"
    assert pixel["calibrated"] is False
    assert pixel["image"] is not None
    assert pixel["wavelength_um"] is not None
    assert isinstance(pixel["in_channel"], bool)
    assert isinstance(pixel["flag_bits"], list)

    # Test manifest route
    manifest_resp = client.get(f"/api/jobs/{job_id}/manifest")
    assert manifest_resp.status_code == 200
    manifest = manifest_resp.json()
    assert manifest["job_id"] == job_id
    assert manifest["wavelength_status"] == "wcs_wave_approximate"
    assert manifest["calibrated"] is False
    assert len(manifest["cutouts"]) >= 1


def test_api_error_paths():
    client = TestClient(app)

    # Unknown job: 404
    assert client.get("/api/jobs/nonexistent-job-id").status_code == 404
    assert (
        client.get("/api/jobs/nonexistent-job-id/frames/20/image.png").status_code == 404
    )

    # Request size > 60 arcmin: 422
    invalid_req = {**SAMPLE, "size_arcmin": 75.0, "channels": [20]}
    assert client.post("/api/jobs", json=invalid_req).status_code == 422

    # Request > 8 channels: 422
    too_many_ch = {
        **SAMPLE,
        "size_arcmin": 4.0,
        "channels": [1, 2, 3, 4, 5, 6, 7, 8, 9],
    }
    assert client.post("/api/jobs", json=too_many_ch).status_code == 422

    # Unrequested product: 404
    single_prod_req = {**SAMPLE, "channels": [20], "products": ["image"]}
    created = client.post("/api/jobs", json=single_prod_req).json()
    wait_until_ready(client, created["id"])

    # Variance was not requested
    assert (
        client.get(f"/api/jobs/{created['id']}/frames/20/variance.png").status_code == 404
    )

    # Pixel probe out of bounds: 422
    assert (
        client.get(
            f"/api/jobs/{created['id']}/pixel",
            params={"x": 9999, "y": 9999, "channel": 20},
        ).status_code
        == 422
    )


def test_blank_and_out_of_range_channels_rejected():
    client = TestClient(app)

    blank = {**SAMPLE, "channels": [50], "products": ["image"]}
    resp_blank = client.post("/api/jobs", json=blank)
    assert resp_blank.status_code == 422
    assert "blank" in resp_blank.json()["detail"]

    out_of_range = {**SAMPLE, "channels": [102], "products": ["image"]}
    assert client.post("/api/jobs", json=out_of_range).status_code == 422


def test_frames_and_pixel_survive_memory_eviction():
    """A ready job must reload cutouts from the derived cache, not a guessed URL."""
    from app.jobs import job_manager

    client = TestClient(app)
    payload = {
        "ra_deg": SAMPLE["ra_deg"],
        "dec_deg": SAMPLE["dec_deg"],
        "size_arcmin": 3.5,
        "channels": [20],
        "products": ["image"],
        "mode": "latest",
    }
    created = client.post("/api/jobs", json=payload)
    assert created.status_code == 202
    job_id = created.json()["id"]
    ready = wait_until_ready(client, job_id)
    assert ready["status"] == "ready", ready.get("error")
    assert ready["cutouts"][0]["uri"].startswith("local:")

    # Simulate an LRU eviction or a server restart: drop both memory state and
    # the in-memory arrays, keeping only the derived disk cache.
    job = job_manager.get_job(job_id)
    job.cutout_objects.clear()
    with job_manager.lock:
        job_manager.jobs.pop(job_id, None)

    frame = client.get(f"/api/jobs/{job_id}/frames/20/image.png")
    assert frame.status_code == 200
    assert frame.headers["content-type"] == "image/png"

    pixel = client.get(
        f"/api/jobs/{job_id}/pixel", params={"x": 0, "y": 0, "channel": 20}
    )
    assert pixel.status_code == 200


def test_manifest_reports_provenance_fields():
    client = TestClient(app)
    payload = {
        "ra_deg": SAMPLE["ra_deg"],
        "dec_deg": SAMPLE["dec_deg"],
        "size_arcmin": 3.0,
        "channels": [20],
        "products": ["image"],
        "mode": "latest",
    }
    job_id = client.post("/api/jobs", json=payload).json()["id"]
    ready = wait_until_ready(client, job_id)
    assert ready["status"] == "ready", ready.get("error")

    manifest = client.get(f"/api/jobs/{job_id}/manifest").json()
    assert manifest["job_id"] == job_id
    assert manifest["release"].startswith("SPHEREx DR1 level-2")
    assert manifest["lvf_status"] == "wcs_wave_approximate"
    assert manifest["wavelength_status"] == "wcs_wave_approximate"
    assert manifest["calibrated"] is False
    assert manifest["products"] == ["image"]
    assert manifest["units"]["image"] == "MJy / sr"
    assert manifest["dates"]
    assert manifest["cache"] in ({"hit": True}, {"hit": False})
    assert len(manifest["flag_definitions"]) > 0
    assert manifest["cutouts"][0]["uri"].startswith("local:")


def test_failed_job_is_replaced_on_resubmit():
    from app.jobs import JobState, job_manager
    from app.models import JobRequest

    req = JobRequest(
        ra_deg=SAMPLE["ra_deg"],
        dec_deg=SAMPLE["dec_deg"],
        size_arcmin=2.5,
        channels=[20],
        products=["image"],
    )
    job_id = job_manager.compute_job_id(req)
    stale = JobState(id=job_id, request=req, status="failed", error="transient")

    with job_manager.lock:
        job_manager.jobs[job_id] = stale

    retried = job_manager.submit(JobRequest(**req.model_dump()))
    assert retried is not stale

    client = TestClient(app)
    ready = wait_until_ready(client, retried.id)
    assert ready["status"] == "ready", ready.get("error")


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
