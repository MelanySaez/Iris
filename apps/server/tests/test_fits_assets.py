"""Tests for FITS assets, local slicing, flag bits, and WCS-WAVE calculations."""

from __future__ import annotations

import numpy as np

SAMPLE = {"ra_deg": 270.693033497, "dec_deg": 61.876515912, "size_arcmin": 4.0}
FAR_POINT = {"ra_deg": 60.0, "dec_deg": 52.0, "size_arcmin": 4.0}


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
