"""Offline scientific guardrails for calibrated, same-epoch mosaics."""

from __future__ import annotations

import io
import json

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS, Sip
from PIL import Image

from app.services import mosaics
from app.services.fits import DerivedCutout


def grid(ra=359.999, rotation=0.0):
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, 10.0]
    w.wcs.crpix = [8.5, 8.5]
    theta = np.deg2rad(rotation)
    w.wcs.cdelt = [-6.13 / 3600, 6.13 / 3600]
    w.wcs.pc = [[np.cos(theta), -np.sin(theta)], [np.sin(theta), np.cos(theta)]]
    return dict(w.to_header(relax=True))


def source(value=10.0, variance=1.0, obs="2025W18_2B_0001_1", header=None):
    a = np.full((16, 16), value, dtype=float)
    return DerivedCutout(
        1,
        0,
        obs,
        "2025-05-01T00:00:00Z",
        "remote",
        "cutout:" + obs,
        a,
        np.full_like(a, variance),
        np.zeros_like(a, dtype=np.int32),
        np.full_like(a, 99),
        np.full_like(a, 99),
        {
            "wcs_header": header or grid(),
            "version": "12",
            "original_product_uri": "s3://nasa-irsa-spherex/" + obs,
            "units": {"image": "MJy / sr", "variance": "MJy2 / sr2"},
            "date_mjd": 60796.0,
            "flag_bits": [],
        },
    )


def calibrated(tmp_path, cutout, **changes):
    header = fits.Header(cutout.metadata["wcs_header"])
    shape = cutout.image.shape
    wave = fits.ImageHDU(np.full(shape, 0.9), header, name="CWAVE")
    band = fits.ImageHDU(np.full(shape, 0.02), header, name="CBAND")
    wave.header["BUNIT"] = "um"
    band.header["BUNIT"] = "um"
    path = tmp_path / (cutout.obs_id + ".fits")
    fits.HDUList([fits.PrimaryHDU(), wave, band]).writeto(path, overwrite=True)
    record = {
        "product": {
            "obs_id": cutout.obs_id,
            "original_product_uri": cutout.metadata["original_product_uri"],
            "version": "12",
        },
        "detector": 1,
        "calibration_id": "spectral-wcs-d1",
        "calibration_version": "4",
        "calibration_path": path.name,
        "pixel_alignment": {
            "method": "identical_celestial_wcs_and_shape",
            "science_shape": list(shape),
            "calibration_shape": list(shape),
            "wcs_sha256": mosaics.celestial_wcs_fingerprint(header),
        },
    }
    record.update(changes)
    manifest = tmp_path / (cutout.obs_id + ".json")
    manifest.write_text(json.dumps(record))
    return mosaics.load_verified_calibration(cutout, manifest)


@pytest.fixture(autouse=True)
def channel(monkeypatch):
    monkeypatch.setattr(mosaics, "get_channel_window", lambda _: (0.89, 0.91))


def test_calibration_requires_explicit_manifest(monkeypatch):
    monkeypatch.delenv("SPHEREX_CALIBRATION_MANIFEST", raising=False)
    c = source()
    c.metadata["calibrated"] = True  # This marker cannot forge verification.
    with pytest.raises(mosaics.CalibrationUnavailableError):
        mosaics.load_verified_calibration(c)
    with pytest.raises(mosaics.CalibrationUnavailableError):
        mosaics.build_mosaic([c], 359.999, 10, 1, 0, 0)


def test_calibration_has_exact_product_grid_units_and_no_source_mutation(tmp_path):
    c = source()
    verified = calibrated(tmp_path, c)
    assert np.allclose(verified.wavelength, 0.9)
    assert np.allclose(verified.bandwidth, 0.02)
    assert np.all(c.wavelength == 99)
    assert verified.metadata["calibrated"] is True
    assert verified.metadata["calibration"]["wcs_sha256"]
    assert verified.metadata["calibration"]["sha256"]


@pytest.mark.parametrize(
    "change",
    [
        {"detector": 2},
        {"calibration_id": ""},
        {"product": {"obs_id": "wrong"}},
        {"pixel_alignment": {"method": "shape_only"}},
    ],
)
def test_calibration_rejects_unproven_association(tmp_path, change):
    with pytest.raises(mosaics.CalibrationUnavailableError):
        calibrated(tmp_path, source(), **change)


def test_calibration_rejects_wcs_or_units_mismatch(tmp_path):
    c = source()
    calibrated(tmp_path, c)
    p = tmp_path / (c.obs_id + ".fits")
    manifest = tmp_path / (c.obs_id + ".json")
    with fits.open(p, mode="update") as h:
        h["CWAVE"].header["CRVAL1"] = 12
    with pytest.raises(mosaics.CalibrationUnavailableError, match="WCS"):
        mosaics.load_verified_calibration(c, manifest)
    calibrated(tmp_path, c)
    with fits.open(p, mode="update") as h:
        h["CBAND"].header["BUNIT"] = "s"
    with pytest.raises(mosaics.CalibrationUnavailableError, match="unit"):
        mosaics.load_verified_calibration(c, manifest)


def test_calibration_nan_bandwidth_excludes_pixel(tmp_path):
    c = calibrated(tmp_path, source())
    c.bandwidth[:] = np.nan
    with pytest.raises(ValueError, match="contributing"):
        mosaics.build_mosaic([c], 359.999, 10, 1, 0, 0)


def test_weighted_mean_variance_hit_counts_and_units(tmp_path):
    a = calibrated(tmp_path, source(10, 1))
    b = calibrated(tmp_path, source(20, 4, obs="2025W18_2B_0001_2"))
    out = mosaics.build_mosaic([a, b], 359.999, 10, 1, 0, 0)
    assert np.allclose(out.image[out.coverage], 12)
    assert np.allclose(out.variance[out.coverage], 0.8)
    assert np.all(out.nhits[out.coverage] == 2)
    assert out.metadata["units"]["image"] == "MJy / sr"
    assert out.metadata["large_slew_id"] == "2025W18_2B_0001"
    assert len(out.metadata["provenance"]) == 2
    assert out.metadata["zodi_subtracted"] is False
    assert out.metadata["calibrated"] is True
    assert out.metadata["channel"] == 0


def test_masks_flags_and_variance_are_not_averaged_as_intensities(tmp_path):
    a = calibrated(tmp_path, source())
    b = calibrated(tmp_path, source(20, 1, obs="2025W18_2B_0001_2"), reject_flag_bits=1)
    b.flags[:] = 2
    out = mosaics.build_mosaic([a, b], 359.999, 10, 1, 0, 0)
    assert np.all(out.flags[out.coverage] == 2)
    b.flags[:] = 1
    out = mosaics.build_mosaic([a, b], 359.999, 10, 1, 0, 0)
    assert np.allclose(out.image[out.coverage], 10)
    assert np.all(out.nhits[out.coverage] == 1)
    a.variance[:] = 0
    with pytest.raises(ValueError, match="contributing"):
        mosaics.build_mosaic([a, b], 359.999, 10, 1, 0, 0)


def test_channel_mask_and_no_coverage_are_explicit(tmp_path):
    a = calibrated(tmp_path, source())
    a.wavelength[:] = 1.4
    with pytest.raises(ValueError, match="contributing"):
        mosaics.build_mosaic([a], 359.999, 10, 1, 0, 0)
    a.wavelength[:] = 0.9
    out = mosaics.build_mosaic([a], 359.999, 10, 3, 0, 0)
    assert np.any(~out.coverage)
    assert np.isnan(out.image[~out.coverage]).all()
    assert np.isnan(out.variance[~out.coverage]).all()
    assert (out.nhits[~out.coverage] == 0).all()


def test_rotated_ra_wrap_and_sip_reprojection(tmp_path):
    hdr = grid(rotation=30)
    w = WCS(hdr)
    a = np.zeros((3, 3))
    b = np.zeros((3, 3))
    a[2, 0] = 1e-5
    b[0, 2] = -1e-5
    w.sip = Sip(a, b, None, None, w.wcs.crpix)
    hdr = dict(w.to_header(relax=True))
    c = calibrated(tmp_path, source(header=hdr))
    out = mosaics.build_mosaic([c], 359.999, 10, 1, 0, 0)
    assert np.count_nonzero(out.coverage) > 50
    assert np.allclose(out.image[out.coverage], 10)
    ow = WCS(out.metadata["wcs_header"])
    center = (out.image.shape[0] - 1) / 2
    ra, dec = ow.pixel_to_world_values(center, center)
    assert abs(((ra - 359.999 + 180) % 360) - 180) < 1e-8
    assert dec == pytest.approx(10)


@pytest.mark.parametrize("size", [0, 181, float("nan")])
def test_size_bounds(tmp_path, size):
    with pytest.raises(ValueError):
        mosaics.build_mosaic([calibrated(tmp_path, source())], 0, 10, size, 0, 0)


def test_180arcmin_output_is_bounded(tmp_path):
    c = calibrated(tmp_path, source())
    out = mosaics.build_mosaic([c], 359.999, 10, 180, 0, 0)
    assert 1700 < out.image.shape[0] <= 2048
    assert out.image.shape[0] == out.image.shape[1]


def test_mosaic_refuses_detector_or_epoch_mix(tmp_path):
    a = calibrated(tmp_path, source())
    b = calibrated(tmp_path, source(obs="2025W18_2B_0002_1"))
    with pytest.raises(ValueError, match="slew"):
        mosaics.build_mosaic([a, b], 359.999, 10, 1, 0, 0)
    with pytest.raises(ValueError, match="detector"):
        mosaics.build_mosaic([a], 359.999, 10, 1, 17, 0)


def test_large_slew_ids_use_official_observation_grammar():
    assert mosaics.large_slew_id({"obs_id": "2025W18_2B_0001_1"}) == "2025W18_2B_0001"
    assert (
        mosaics.large_slew_id(
            {"uri": "https://host/level2_2025W18_2B_0001_4D6_spx_l2b-v12-2025-164.fits"}
        )
        == "2025W18_2B_0001"
    )
    assert mosaics.large_slew_id({"obs_id": "2025W18_2B_0001_5"}) is None
    assert mosaics.large_slew_id({"obs_id": "invented"}) is None


def test_epoch_sampling_is_chronological_bounded_and_spread_over_time():
    groups = [[{"date_mjd": v}] for v in [99, 1, 2, 3, 20, 40, 60, 80, 100]]
    sampled = mosaics.sample_epochs(groups, limit=4)
    assert [g[0]["date_mjd"] for g in sampled] == [1, 40, 60, 100]
    many = [[{"date_mjd": v}] for v in range(50)]
    assert len(mosaics.sample_epochs(many)) == 12
    assert mosaics.sample_epochs(many)[0] == many[0]
    assert mosaics.sample_epochs(many)[-1] == many[-1]
    assert mosaics.sample_epochs([]) == []


def test_gif_has_shared_stretch_order_timing_and_dimensions():
    images = [np.full((4, 4), v, dtype=float) for v in [1, 2, 10]]
    gif = Image.open(io.BytesIO(mosaics.encode_gif(images, stretch="linear")))
    assert gif.n_frames == 3
    assert gif.size == (4, 4)
    assert gif.info["loop"] == 0
    values = []
    for i in range(gif.n_frames):
        gif.seek(i)
        assert gif.info["duration"] == 500
        values.append(np.asarray(gif.convert("L")).mean())
    assert values[0] < values[1] < values[2]
    lo, hi = mosaics.shared_percentiles(images)
    assert lo == 1 and hi == 10
    big = [np.full((1200, 1300), v, dtype=float) for v in [0, 1]]
    assert max(Image.open(io.BytesIO(mosaics.encode_gif(big))).size) == 1024


def test_gif_rejects_missing_mismatched_or_too_many_frames():
    for images in [
        [],
        [np.ones((3, 3))],
        [np.ones((3, 3)), np.ones((4, 4))],
        [np.ones((3, 3))] * 13,
    ]:
        with pytest.raises(ValueError):
            mosaics.encode_gif(images)


def test_identical_gif_epochs_keep_individual_half_second_frames():
    images = [np.zeros((3, 3)), np.zeros((3, 3))]
    gif = Image.open(io.BytesIO(mosaics.encode_gif(images)))
    assert gif.n_frames == 2
    for i in range(2):
        gif.seek(i)
        assert gif.info["duration"] == 500


def test_manifest_can_contain_many_exact_product_records(tmp_path):
    c = source()
    calibrated(tmp_path, c)
    manifest = tmp_path / (c.obs_id + ".json")
    record = json.loads(manifest.read_text())
    manifest.write_text(
        json.dumps(
            {
                "products": [
                    {"product": {"obs_id": "another"}},
                    record,
                ]
            }
        )
    )
    assert mosaics.load_verified_calibration(c, manifest).metadata["calibrated"]
    manifest.write_text(json.dumps({"products": [record, record]}))
    with pytest.raises(mosaics.CalibrationUnavailableError):
        mosaics.load_verified_calibration(c, manifest)


def test_full_frame_calibration_requires_exact_integer_crop_alignment(tmp_path):
    c = source()
    full_header = fits.Header(grid())
    origin = [3, 4]
    full_wcs = WCS(full_header)
    c.metadata["wcs_header"] = dict(
        full_wcs.slice((slice(4, 20), slice(3, 19))).to_header(relax=True)
    )
    calibrated(tmp_path, c)
    path = tmp_path / (c.obs_id + ".fits")
    wave = fits.ImageHDU(np.full((24, 24), 0.9), full_header, name="CWAVE")
    band = fits.ImageHDU(np.full((24, 24), 0.02), full_header, name="CBAND")
    wave.header["BUNIT"] = band.header["BUNIT"] = "um"
    fits.HDUList([fits.PrimaryHDU(), wave, band]).writeto(path, overwrite=True)
    manifest = tmp_path / (c.obs_id + ".json")
    record = json.loads(manifest.read_text())
    record["pixel_alignment"].update(
        {
            "method": "integer_pixel_crop",
            "science_pixel_origin": origin,
            "calibration_shape": [24, 24],
        }
    )
    manifest.write_text(json.dumps(record))
    assert np.allclose(mosaics.load_verified_calibration(c, manifest).wavelength, 0.9)
    record["pixel_alignment"]["science_pixel_origin"] = [4, 4]
    manifest.write_text(json.dumps(record))
    with pytest.raises(mosaics.CalibrationUnavailableError, match="WCS"):
        mosaics.load_verified_calibration(c, manifest)


def test_duplicate_products_cannot_double_count_variance(tmp_path):
    c = calibrated(tmp_path, source())
    with pytest.raises(ValueError, match="Duplicate"):
        mosaics.build_mosaic([c, c], 359.999, 10, 1, 0, 0)


def test_flags_or_sources_and_invalid_contributions(tmp_path):
    a = calibrated(tmp_path, source(), reject_flag_bits=1)
    b = calibrated(tmp_path, source(20, 1, obs="2025W18_2B_0001_2"), reject_flag_bits=1)
    a.flags[:] = 2
    b.flags[:] = 4
    b.source = "s3"
    out = mosaics.build_mosaic([a, b], 359.999, 10, 1, 0, 0)
    assert (out.flags[out.coverage] == 6).all()
    assert out.source == out.metadata["source"] == "mixed"
    assert out.metadata["uri"] == out.uri
    assert out.metadata["version"] == "12"
    assert out.metadata["obs_id"] == out.obs_id
    b.image[:] = np.nan
    out = mosaics.build_mosaic([a, b], 359.999, 10, 1, 0, 0)
    assert (out.flags[out.coverage] == 2).all()
    assert (out.nhits[out.coverage] == 1).all()
    assert out.source == "remote"
    assert out.metadata["multi_product_mosaic"] == "single_input"
