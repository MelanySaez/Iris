"""Offline tests for opening the user's own SPHEREx FITS in Plate (POST /api/uploads)."""

from __future__ import annotations

import io

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS
from fastapi.testclient import TestClient
from test_cube_fallback import DEPTH, WIDTH, build_tile

import app.services.fits as fits_service
import app.services.fits_upload as upload_service
from app.main import app
from app.services.jobs import job_manager


def build_l2(detector: int = 3) -> bytes:
    """Minimal SPHEREx Level-2 image: IMAGE/FLAGS/VARIANCE + key-W WCS-WAVE table."""
    wcs = WCS(naxis=2)
    wcs.wcs.crpix = [20, 15]
    wcs.wcs.crval = [150.0, 2.0]
    wcs.wcs.cdelt = [-0.0017, 0.0017]
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    header = wcs.to_header()
    header["BUNIT"] = "MJy/sr"
    header["DETECTOR"] = detector
    header["MJD-OBS"] = 60789.75
    header["DATE-OBS"] = "2025-04-24T18:01:05.843"
    header["OBSID"] = "2025W17_4B_0001_3"
    header["CRPIX1W"], header["CRPIX2W"] = 1.0, 1.0
    for axis in (1, 2):
        header[f"CTYPE{axis}W"] = "WAVE-TAB"
        header[f"CUNIT{axis}W"] = "um"
        header[f"CRVAL{axis}W"] = 1.0
        header[f"CDELT{axis}W"] = 1.0
        header[f"PS{axis}_0W"] = "WCS-WAVE"
        header[f"PS{axis}_1W"] = "VALUES"
        header[f"PS{axis}_2W"] = "X" if axis == 1 else "Y"
        header[f"PV{axis}_3W"] = axis
    image = np.arange(1200, dtype=np.float32).reshape(30, 40)
    hdus = [fits.PrimaryHDU()]
    for name, data in (
        ("IMAGE", image),
        ("FLAGS", np.zeros((30, 40), dtype=np.int32)),
        ("VARIANCE", np.full((30, 40), 4.0, dtype=np.float32)),
    ):
        hdus.append(fits.ImageHDU(data, header=header.copy(), name=name))
    hdus.append(
        fits.BinTableHDU.from_columns(
            [
                fits.Column(name="X", format="2D", array=[[1.0, 40.0]]),
                fits.Column(name="Y", format="2D", array=[[1.0, 30.0]]),
                fits.Column(
                    name="VALUES",
                    format="8D",
                    dim="(2,2,2)",
                    array=[[[[1.6, 0.02], [1.7, 0.021]], [[1.8, 0.022], [1.9, 0.023]]]],
                ),
            ],
            name="WCS-WAVE",
        )
    )
    stream = io.BytesIO()
    fits.HDUList(hdus).writeto(stream)
    return stream.getvalue()


@pytest.fixture(autouse=True)
def isolated_cache(tmp_path, monkeypatch):
    """Keep uploads, derived arrays and job snapshots out of the developer cache."""
    derived = tmp_path / "derived"
    derived.mkdir()
    monkeypatch.setattr(fits_service, "DERIVED_CACHE_DIR", derived)
    monkeypatch.setattr(upload_service, "UPLOAD_DIR", tmp_path / "uploads")
    monkeypatch.setattr(job_manager, "_save_snapshot_to_disk", lambda job: None)


def upload(client: TestClient, body: bytes, filename: str = "plate.fits"):
    return client.post(
        "/api/uploads",
        params={"filename": filename},
        content=body,
        headers={"content-type": "application/octet-stream"},
    )


def test_level2_upload_opens_as_a_ready_plate_for_its_detector():
    client = TestClient(app)
    resp = upload(client, build_l2(detector=3), "my-spherex.fits")
    assert resp.status_code == 200, resp.text
    snap = resp.json()

    assert snap["id"].startswith("upload-")
    assert snap["status"] == "ready"
    assert snap["upload"]["format"] == "spherex_l2"
    assert snap["upload"]["filename"] == "my-spherex.fits"
    assert snap["upload"]["detector"] == 3
    assert {f["source"] for f in snap["frames"]} == {"upload"}
    # All 17 channels of detector 3 (34..50), every product of the file.
    assert sorted({f["channel"] for f in snap["frames"]}) == list(range(34, 51))
    assert {f["product"] for f in snap["frames"]} == {"image", "variance", "flags"}
    assert snap["region"]["ra_deg"] == pytest.approx(150.0, abs=0.05)
    assert snap["region"]["dec_deg"] == pytest.approx(2.0, abs=0.05)

    job_id = snap["id"]
    png = client.get(f"/api/jobs/{job_id}/frames/40/image.png")
    assert png.status_code == 200
    assert png.content.startswith(b"\x89PNG")
    pixel = client.get(
        f"/api/jobs/{job_id}/pixel", params={"x": 3, "y": 2, "channel": 40}
    )
    assert pixel.status_code == 200
    assert pixel.json()["image"] == pytest.approx(83.0)
    assert pixel.json()["variance"] == pytest.approx(4.0)


def test_cube_tile_upload_gives_one_channel_cutout_per_plane():
    client = TestClient(app)
    resp = upload(client, build_tile(), "Npix1901_cube.fits")
    assert resp.status_code == 200, resp.text
    snap = resp.json()

    assert snap["upload"]["format"] == "dr1_cube_tile"
    assert snap["upload"]["temporal_available"] is False
    assert sorted(c["channel"] for c in snap["cutouts"]) == list(range(DEPTH))
    assert {f["product"] for f in snap["frames"]} == {"image", "flags"}
    assert snap["wavelength_status"] == "cube_channel_nominal"
    assert "no temporal information" in snap["animation_reason"]
    job_id = snap["id"]

    # Plane k holds 1000*k + row, so channel 70 must read plane 70.
    pixel = client.get(
        f"/api/jobs/{job_id}/pixel", params={"x": 5, "y": 7, "channel": 70}
    )
    assert pixel.status_code == 200
    assert pixel.json()["image"] == pytest.approx(70007.0)
    assert pixel.json()["variance"] is None
    nhits = client.get(f"/api/jobs/{job_id}/frames/70/nhits.npy")
    assert nhits.status_code == 200
    assert np.load(io.BytesIO(nhits.content)).shape == (WIDTH, WIDTH)


def test_same_file_reopens_the_same_plate():
    client = TestClient(app)
    first = upload(client, build_l2()).json()
    second = upload(client, build_l2(), "renamed.fits").json()
    assert first["id"] == second["id"]


def test_upload_reloads_from_the_derived_cache_after_eviction(monkeypatch):
    saved = {}
    monkeypatch.setattr(
        job_manager,
        "_save_snapshot_to_disk",
        lambda job: saved.update({job.id: job.to_snapshot()}),
    )
    monkeypatch.setattr(job_manager.snapshots, "read", lambda job_id: saved.get(job_id))
    for job_id in [key for key in job_manager.jobs if key.startswith("upload-")]:
        job_manager.jobs.pop(job_id)  # an earlier test may have opened the same tile
    client = TestClient(app)
    job_id = upload(client, build_tile()).json()["id"]
    job_manager.jobs.pop(job_id)

    reloaded = client.get(f"/api/jobs/{job_id}")
    assert reloaded.status_code == 200
    assert reloaded.json()["upload"]["format"] == "dr1_cube_tile"
    assert client.get(f"/api/jobs/{job_id}/frames/12/image.png").status_code == 200


def test_non_fits_bytes_are_rejected():
    resp = upload(TestClient(app), b"this is not a FITS file at all" * 200)
    assert resp.status_code == 422
    assert "not a readable FITS file" in resp.json()["detail"]


def test_fits_without_spherex_layers_is_rejected_with_what_is_missing():
    stream = io.BytesIO()
    fits.HDUList(
        [fits.PrimaryHDU(), fits.ImageHDU(np.zeros((4, 4)), name="SCI")]
    ).writeto(stream)
    resp = upload(TestClient(app), stream.getvalue())
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert "Level-2" in detail and "VARIANCE" in detail
    assert "All-Sky Cube" in detail and "NHITS" in detail


def test_oversized_upload_is_refused(monkeypatch):
    monkeypatch.setattr(upload_service, "MAX_UPLOAD_BYTES", 1000)
    resp = upload(TestClient(app), build_l2())
    assert resp.status_code == 413
    assert "1000 bytes" in resp.json()["detail"]
    assert not list((upload_service.UPLOAD_DIR).glob("*.fits"))


def test_empty_upload_is_rejected():
    resp = upload(TestClient(app), b"")
    assert resp.status_code == 422


@pytest.mark.parametrize("layer", ["VARIANCE", "FLAGS"])
def test_level2_mismatched_layer_is_rejected_before_publishing(layer):
    with fits.open(io.BytesIO(build_l2())) as hdul:
        hdul[layer].data = hdul[layer].data[:2, :2].copy()
        stream = io.BytesIO()
        hdul.writeto(stream)
    jobs_before = set(job_manager.jobs)
    derived_before = set(fits_service.DERIVED_CACHE_DIR.iterdir())

    resp = upload(TestClient(app), stream.getvalue())

    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == f"{layer} does not have the IMAGE shape."
    assert set(job_manager.jobs) == jobs_before
    assert set(fits_service.DERIVED_CACHE_DIR.iterdir()) == derived_before


def test_upload_cap_is_350_decimal_megabytes():
    assert upload_service.MAX_UPLOAD_BYTES == 350_000_000


def test_upload_at_limit_is_accepted_but_one_more_byte_is_rejected(monkeypatch):
    body = build_l2()
    monkeypatch.setattr(upload_service, "MAX_UPLOAD_BYTES", len(body))
    client = TestClient(app)
    accepted = upload(client, body)
    assert accepted.status_code == 200
    jobs_before = set(job_manager.jobs)
    files_before = {p: p.read_bytes() for p in upload_service.UPLOAD_DIR.iterdir()}
    refused = upload(client, body + b"x")
    assert refused.status_code == 413
    assert "upload limit" in refused.json()["detail"]
    assert set(job_manager.jobs) == jobs_before
    assert {
        p: p.read_bytes() for p in upload_service.UPLOAD_DIR.iterdir()
    } == files_before


def test_oversized_upload_message_names_350_mb():
    with upload_service.UploadWriter() as writer:
        writer.size = 350_000_000
        with pytest.raises(
            upload_service.UploadTooLargeError, match="350 MB upload limit"
        ):
            writer.write(b"x")
    assert not list(upload_service.UPLOAD_DIR.iterdir())
