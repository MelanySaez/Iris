"""Explicit live checks: provider/network failures FAIL, never pass by simulation."""

import os
import time

import httpx
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

from app.services.fits import extract_cutout_fits
from app.services.spherex_provider import (
    BUCKET_URL,
    SAMPLE_KEYS,
    download_s3_cutout,
    inspect_product,
    query_index,
    remember_products,
)

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_SPHEREX_PROVIDER_LIVE") != "1",
    reason="Set RUN_SPHEREX_PROVIDER_LIVE=1 for anonymous IRSA/S3 network checks",
)


@pytest.mark.parametrize("key", SAMPLE_KEYS, ids=["dr1", "qr3"])
def test_live_s3_header_index_cutout_and_extractor(key, tmp_path, monkeypatch):
    import app.services.spherex_provider as provider

    started = time.monotonic()
    record = inspect_product(BUCKET_URL + key)
    header = fits.Header.fromstring(record["spatial_header"], sep="\n")
    sky = WCS(header).celestial.pixel_to_world(1200, 800)
    index = tmp_path / "index.sqlite"
    remember_products([record], index_path=index)
    result = query_index(sky.ra.deg, sky.dec.deg, 1, index_path=index)
    assert result["coverage_complete"] is False
    assert len(result["products"]) == 1
    monkeypatch.setattr(provider, "CUTOUT_CACHE_DIR", tmp_path)
    path = download_s3_cutout(result["products"][0], sky.ra.deg, sky.dec.deg, 1)
    with fits.open(path, checksum=True) as hdul:
        assert all(h.verify_checksum() == 1 for h in hdul)
        assert {"IMAGE", "FLAGS", "VARIANCE", "ZODI", "EPSF", "WCS-WAVE"} <= {
            h.name for h in hdul
        }
    arrays, metadata = extract_cutout_fits(path, sky.ra.deg, sky.dec.deg)
    assert metadata["detector"] == 1
    assert all(
        np.isfinite(arrays[n]).all()
        for n in ("image", "variance", "flags", "wavelength", "bandwidth")
    )
    print(
        f"S3 {key.split('/')[0]} bytes={path.stat().st_size} "
        f"shape={arrays['image'].shape} seconds={time.monotonic() - started:.2f}"
    )


def test_live_irsa_cutout_service_and_extractor(tmp_path):
    key = SAMPLE_KEYS[0]
    ra, dec = 160.61699069788853, 30.670454926168155
    url = "https://irsa.ipac.caltech.edu/ibe/data/spherex/" + key
    data = bytearray()
    with (
        httpx.Client(timeout=httpx.Timeout(90, connect=10), trust_env=False) as client,
        client.stream(
            "GET", url, params={"center": f"{ra},{dec}d", "size": 1 / 60}
        ) as response,
    ):
        print("IRSA cutout", response.status_code)
        response.raise_for_status()
        for chunk in response.iter_bytes():
            data.extend(chunk)
            assert len(data) <= 16 * 1024**2, "Cutout service ignored requested size"
    path = tmp_path / "irsa.fits"
    path.write_bytes(data)
    arrays, metadata = extract_cutout_fits(path, ra, dec)
    assert metadata["detector"] == 1
    assert np.isfinite(arrays["image"]).any()
    assert max(arrays["image"].shape) < 30
    print("IRSA cutout", len(data), arrays["image"].shape)


@pytest.mark.parametrize("service", ["TAP", "SIA"])
def test_live_irsa_metadata_service(service):
    with httpx.Client(timeout=httpx.Timeout(90, connect=10), trust_env=False) as client:
        if service == "TAP":
            response = client.post(
                "https://irsa.ipac.caltech.edu/TAP/sync",
                data={
                    "REQUEST": "doQuery",
                    "LANG": "ADQL",
                    "FORMAT": "votable",
                    "QUERY": "SELECT TOP 1 a.uri FROM spherex.artifact a",
                },
            )
        else:
            response = client.get(
                "https://irsa.ipac.caltech.edu/SIA",
                params={
                    "POS": "CIRCLE 160.61699069788853 30.670454926168155 0.01",
                    "COLLECTION": "spherex",
                },
            )
        print("IRSA", service, response.status_code)
        response.raise_for_status()
        assert len(response.content) < 4 * 1024**2
        assert b"VOTABLE" in response.content.upper()
        assert b'VALUE="ERROR"' not in response.content.upper()
