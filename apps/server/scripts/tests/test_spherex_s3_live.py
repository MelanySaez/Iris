"""Opt-in REAL anonymous S3 checks, excluded from ordinary offline runs."""

import os

import httpx
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

from scripts.spherex_s3_poc import SAMPLES, cutout_hdul, region_slices, verify_cutout

pytestmark = pytest.mark.skipif(
    os.environ.get("SPHEREX_S3_LIVE") != "1", reason="Set SPHEREX_S3_LIVE=1 for real S3"
)


@pytest.mark.parametrize("release", ["dr1", "qr3"])
def test_real_s3_cutout_and_existing_pipeline(release, tmp_path):
    from app.services.fits import extract_cutout_fits

    with (
        httpx.Client(timeout=20, trust_env=False) as client,
        fits.open(
            "spxpoc://" + SAMPLES[release],
            use_fsspec=True,
            memmap=False,
            fsspec_kwargs={"client": client, "max_bytes": 16 * 1024**2},
        ) as source,
    ):
        # Off-center position detects spectral-coordinate shifts that a
        # symmetric central cutout can conceal.
        sky = WCS(source["IMAGE"].header).celestial.pixel_to_world(1200, 800)
        view = region_slices(source["IMAGE"], sky.ra.deg, sky.dec.deg, 1.0)
        path = tmp_path / f"{release}.fits"
        with cutout_hdul(source, view) as cutout:
            cutout.writeto(path, checksum=True)
        with fits.open(path, checksum=True) as saved:
            saved.verify("exception")
            assert all(h.verify_checksum() == 1 for h in saved)
            assert saved["IMAGE"].shape == (10, 10)
            assert len(saved["EPSF"].data) == 441
            for name in ["IMAGE", "FLAGS", "VARIANCE", "ZODI"]:
                np.testing.assert_array_equal(
                    saved[name].data, source[name].section[view]
                )
            np.testing.assert_array_equal(saved["EPSF"].data, source["EPSF"].data)
            np.testing.assert_array_equal(saved["WCS-WAVE"].data, source["WCS-WAVE"].data)
            verify_cutout(source, saved, view)
            x, y = WCS(saved["IMAGE"].header).celestial.world_to_pixel(sky)
            assert abs(x - 4.5) <= 0.50001 and abs(y - 4.5) <= 0.50001
            arrays, metadata = extract_cutout_fits(path, sky.ra.deg, sky.dec.deg)
            for key in ["image", "variance", "flags", "wavelength", "bandwidth"]:
                assert arrays[key].shape == (10, 10)
                assert np.isfinite(arrays[key]).all()
            assert metadata["detector"] == 1
        remote = source._file._file
        assert remote.transferred < remote.size
        print(release, remote.stats())
