"""Tests for FITS assets, local slicing, flag bits, and WCS-WAVE calculations."""

from __future__ import annotations

import numpy as np
import pytest
from astropy.io import fits

from app.config import LOCAL_FITS_PATH
from app.discovery import check_local_footprint
from app.fits_assets import extract_flag_bits, slice_local_fits

SAMPLE = {"ra_deg": 270.693033497, "dec_deg": 61.876515912, "size_arcmin": 4.0}
FAR_POINT = {"ra_deg": 60.0, "dec_deg": 52.0, "size_arcmin": 4.0}


def test_extract_flag_bits_from_local_fits():
    assert LOCAL_FITS_PATH.is_file(), f"Local FITS missing at {LOCAL_FITS_PATH}"
    with fits.open(LOCAL_FITS_PATH, memmap=True) as hdul:
        flags_hdr = hdul["FLAGS"].header
        bits = extract_flag_bits(flags_hdr)

    assert len(bits) > 0
    bit_map = {b["bit"]: b for b in bits}

    # Verify key known flag bits from the SPHEREx mission header
    assert 0 in bit_map
    assert bit_map[0]["name"] == "MP_TRANSIENT"
    assert "Transient" in bit_map[0]["description"]

    assert 21 in bit_map
    assert bit_map[21]["name"] == "MP_SOURCE"
    assert "known source" in bit_map[21]["description"]


def test_local_footprint_coverage():
    # The local DR1 sample region lies fully inside detector 2
    assert (
        check_local_footprint(SAMPLE["ra_deg"], SAMPLE["dec_deg"], SAMPLE["size_arcmin"])
        is True
    )

    # A distant region outside the footprint is not covered
    assert (
        check_local_footprint(
            FAR_POINT["ra_deg"], FAR_POINT["dec_deg"], FAR_POINT["size_arcmin"]
        )
        is False
    )


def test_local_cutout_slice_and_wcs_wave():
    arrays, meta = slice_local_fits(
        SAMPLE["ra_deg"], SAMPLE["dec_deg"], SAMPLE["size_arcmin"]
    )

    # Check products presence
    assert "image" in arrays
    assert "variance" in arrays
    assert "flags" in arrays
    assert "wavelength" in arrays
    assert "bandwidth" in arrays

    wave = arrays["wavelength"]
    bw = arrays["bandwidth"]

    assert wave.shape == arrays["image"].shape
    assert np.all(np.isfinite(wave))
    assert np.all(np.isfinite(bw))

    # For SPHEREx detector 2, wavelengths must lie strictly inside 1.0 - 1.8 um
    assert float(np.min(wave)) >= 1.0
    assert float(np.max(wave)) <= 1.8

    # Bandwidths must be positive
    assert float(np.min(bw)) > 0.0

    # Check metadata
    assert meta["detector"] == 2
    assert meta["source"] == "local"
    assert meta["units"]["image"] == "MJy / sr"
    assert meta["units"]["variance"] == "MJy2 / sr2"
    assert len(meta["flag_bits"]) > 0


def test_slice_out_of_bounds_raises_error():
    with pytest.raises(ValueError) as exc_info:
        slice_local_fits(FAR_POINT["ra_deg"], FAR_POINT["dec_deg"], 10.0)
    assert "extends beyond this spectral FITS" in str(exc_info.value)


def test_distant_wcs_rejected_before_iterative_inversion(monkeypatch):
    """Unit fixture only: not evidence of authentic DR1 imaging."""
    from unittest.mock import MagicMock

    import app.discovery as discovery

    fake_hdu = MagicMock()
    fake_hdu.data.shape = (2040, 2040)
    hdul = MagicMock()
    hdul.__enter__.return_value.__getitem__.return_value = fake_hdu
    wcs = MagicMock()
    wcs.celestial = wcs
    wcs.wcs_world2pix.return_value = np.array([[np.nan, np.nan]])
    monkeypatch.setattr(discovery, "LOCAL_FITS_PATH", MagicMock())
    monkeypatch.setattr(discovery.fits, "open", lambda *a, **kw: hdul)
    monkeypatch.setattr(discovery, "WCS", lambda *a: wcs)
    assert not discovery.check_local_footprint(100.51457, 4.0134, 1)
    wcs.all_world2pix.assert_not_called()
