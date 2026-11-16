"""Job/API seam proof using actual synthetic calibrated FITS, not marker flags."""

from __future__ import annotations

import io
import json

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app
from app.schemas.jobs import JobRequest, JobSnapshot
from app.services import fits as fits_service
from app.services import job_queries, jobs, mosaics, temporal_jobs
from app.services.fits import DerivedCutout


@pytest.mark.parametrize("epoch_count", [2, 6])
def test_verified_epochs_survive_cache_reload_and_public_gif(
    monkeypatch, tmp_path, epoch_count
):
    monkeypatch.setattr(jobs.job_manager.snapshots, "_directory", tmp_path)
    monkeypatch.setattr(fits_service, "DERIVED_CACHE_DIR", tmp_path)
    monkeypatch.setattr(mosaics, "get_channel_window", lambda _: (0.89, 0.91))
    monkeypatch.setattr(jobs, "get_channel_window", lambda _: (0.89, 0.91))
    monkeypatch.setattr(job_queries, "get_channel_window", lambda _: (0.89, 0.91))
    monkeypatch.setattr(job_queries, "get_channel", lambda _: {"wavelength_um": 0.9})
    monkeypatch.setattr(temporal_jobs, "download_cutout", lambda _: None)
    # download_product binds its dependency by default; pass through a local no-op.
    monkeypatch.setattr(temporal_jobs, "download_product", lambda *a: None)
    monkeypatch.setattr(temporal_jobs, "remember_products", lambda *a: None)
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [10, 10]
    w.wcs.crpix = [8.5, 8.5]
    w.wcs.cdelt = [-6.13 / 3600, 6.13 / 3600]
    header = dict(w.to_header())
    products, sources, records = [], {}, []
    for i in range(epoch_count):
        obs = f"2025W18_2B_{i + 1:04d}_1"
        uri = "https://example.invalid/" + obs
        product = {
            "id": obs,
            "obs_id": obs,
            "uri": uri,
            "detector": 1,
            "date_mjd": 60796.0 + i,
            "date_iso": f"2025-05-0{i + 1}T00:00:00Z",
            "source": "remote",
        }
        products.append(product)
        image = np.full((16, 16), float(10 + i))
        metadata = {
            "wcs_header": header,
            "original_product_uri": uri,
            "version": "1",
            "date_mjd": product["date_mjd"],
            "units": {"image": "MJy/sr", "variance": "MJy2/sr2"},
        }
        sources[uri] = DerivedCutout(
            1,
            i,
            obs,
            product["date_iso"],
            "remote",
            uri,
            image,
            np.ones_like(image),
            np.zeros_like(image, dtype=np.int32),
            image,
            image,
            metadata,
        )
        wave = fits.ImageHDU(np.full_like(image, 0.9), fits.Header(header), name="CWAVE")
        band = fits.ImageHDU(np.full_like(image, 0.02), fits.Header(header), name="CBAND")
        wave.header["BUNIT"] = band.header["BUNIT"] = "um"
        path = tmp_path / f"{obs}.fits"
        fits.HDUList([fits.PrimaryHDU(), wave, band]).writeto(path)
        records.append(
            {
                "product": {"obs_id": obs, "original_product_uri": uri, "version": "1"},
                "detector": 1,
                "calibration_id": obs,
                "calibration_version": "1",
                "calibration_path": path.name,
                "pixel_alignment": {
                    "method": "identical_celestial_wcs_and_shape",
                    "science_shape": [16, 16],
                    "calibration_shape": [16, 16],
                    "wcs_sha256": mosaics.celestial_wcs_fingerprint(header),
                },
            }
        )
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"products": records}))
    monkeypatch.setenv("SPHEREX_CALIBRATION_MANIFEST", str(manifest))
    monkeypatch.setattr(
        temporal_jobs, "get_or_extract_derived", lambda p, *a: sources[p["uri"]]
    )
    monkeypatch.setattr(
        jobs,
        "resolve_region",
        lambda *a, **kw: {
            "coverage": "available",
            "coverage_complete": True,
            "products": products,
        },
    )
    request = JobRequest(
        ra_deg=10, dec_deg=10, size_arcmin=1, channels=[0, 1], mode="history"
    )
    job = jobs.JobState(id=jobs.job_manager.compute_job_id(request), request=request)
    jobs.job_manager._run_job(job)
    assert job.status == "ready", job.error
    snapshot = JobSnapshot(**job.to_snapshot())
    assert snapshot.calibrated and len(snapshot.frames) == epoch_count * 2
    assert (
        len({c["uri"] for c in job.cutouts}) == epoch_count * 2
    )  # No detector/channel collision.
    jobs.job_manager.jobs[job.id] = job
    client = TestClient(app)
    try:
        response = client.get(f"/api/jobs/{job.id}/animation.gif?channel_id=0")
        assert response.status_code == 200, response.text
        gif = Image.open(io.BytesIO(response.content))
        assert gif.n_frames == epoch_count and gif.info["duration"] == 500
        png = client.get(f"/api/jobs/{job.id}/frames/0/image.png?epoch=0")
        assert png.status_code == 200
        assert np.array_equal(
            np.asarray(gif.convert("L")),
            np.asarray(Image.open(io.BytesIO(png.content)).convert("L")),
        )
        assert (
            client.get(f"/api/jobs/{job.id}/frames/0/image.png?epoch=1").status_code
            == 200
        )
        counts = client.get(f"/api/jobs/{job.id}/frames/0/nhits.npy?epoch=1")
        assert counts.status_code == 200
        assert np.load(io.BytesIO(counts.content)).max() == 1
        for layer in ("wavelengths", "bandwidths"):
            response = client.get(f"/api/jobs/{job.id}/frames/0/{layer}.npy?epoch=1")
            assert response.status_code == 200
            assert response.headers["X-Wavelength-Status"] == "calibrated_cwave_cband"
        result = client.get(f"/api/jobs/{job.id}/manifest").json()
        assert result["calibrated"] and result["cutouts"][0]["provenance"]
        job.cutout_objects.clear()
        restored = jobs.job_manager._rebuild_job_from_snapshot(job.to_snapshot(), request)
        assert len(restored.cutout_objects) <= 4
        jobs.job_manager.jobs.pop(job.id, None)
        resurrected = jobs.job_manager.get_job(job.id)
        assert resurrected.status == "ready"
        assert len(resurrected.cutout_objects) <= 4
        cached, is_new = jobs.job_manager._submit(request)
        assert not is_new and cached.id == job.id
        assert resurrected.derived_cache_complete
        assert jobs.resolve_cutout(restored, 1, 1, 1).metadata["calibrated"]
        assert (
            client.get(f"/api/jobs/{job.id}/animation.gif?channel_id=2").status_code
            == 422
        )
    finally:
        jobs.job_manager.jobs.pop(job.id, None)


def test_history_without_verified_calibration_fails_honestly(monkeypatch):
    monkeypatch.delenv("SPHEREX_CALIBRATION_MANIFEST", raising=False)
    request = JobRequest(
        ra_deg=10, dec_deg=10, size_arcmin=180, channels=[0], mode="history"
    )
    job = jobs.JobState(id="missing-calibration-proof", request=request)
    monkeypatch.setattr(
        jobs, "resolve_region", lambda *a, **kw: {"coverage": "available", "products": []}
    )
    jobs.job_manager._run_job(job)
    assert job.status == "failed" and job.error_kind == "calibration_unavailable"
    assert not job.to_snapshot()["calibrated"] and job.frames == []


def test_job_identity_includes_referenced_calibration_content(monkeypatch, tmp_path):
    calibration = tmp_path / "calibration.fits"

    def write(value):
        fits.HDUList(
            [fits.PrimaryHDU(), fits.ImageHDU(np.full((2, 2), value), name="CWAVE")]
        ).writeto(calibration, overwrite=True)

    write(0.9)
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"calibration_path": calibration.name}))
    monkeypatch.setenv("SPHEREX_CALIBRATION_MANIFEST", str(manifest))
    request = JobRequest(ra_deg=10, dec_deg=10, channels=[0], mode="history")
    first = jobs.job_manager.compute_job_id(request)
    write(0.91)
    second = jobs.job_manager.compute_job_id(request)
    assert first != second
    calibration.unlink()
    assert jobs.job_manager.compute_job_id(request) not in (first, second)
