"""Synthetic provider tests are not evidence of live-service availability."""

import hashlib
import io

import httpx
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS, Sip

from app.services.spherex_provider import (
    RangeReader,
    canonical_s3_url,
    download_s3_cutout,
    is_provider_unavailable,
    query_index,
    region_slices,
    remember_products,
)

URL = "https://nasa-irsa-spherex.s3.amazonaws.com/dr1/level2/a.fits"


def image_hdul():
    wcs = WCS(naxis=2)
    wcs.wcs.crpix, wcs.wcs.crval = [20, 15], [359.99, 70]
    wcs.wcs.cd = [[-0.001, 0.0003], [0.0003, 0.001]]
    wcs.wcs.ctype = ["RA---TAN-SIP", "DEC--TAN-SIP"]
    a, b = np.zeros((3, 3)), np.zeros((3, 3))
    a[2, 0], b[0, 2] = 1e-5, -1e-5
    wcs.sip = Sip(a, b, None, None, wcs.wcs.crpix)
    header = wcs.to_header(relax=True)
    for k, v in {
        "DETECTOR": 1,
        "OBSID": "2025W17_4B_0001_1",
        "MJD-OBS": 60789.0,
        "DATE-OBS": "2025-04-24T00:00:00",
        "BUNIT": "MJy / sr",
    }.items():
        header[k] = v
    primary = fits.PrimaryHDU()
    primary.header["VERSION"] = "7.0.5"
    return fits.HDUList(
        [primary]
        + [
            fits.ImageHDU(
                np.arange(1200, dtype=np.float32).reshape(30, 40),
                header=header.copy(),
                name=name,
            )
            for name in ("IMAGE", "FLAGS", "VARIANCE", "ZODI")
        ]
    )


def record(hdul):
    return {
        "s3_url": URL,
        "spatial_header": hdul["IMAGE"].header.tostring(sep="\n"),
        "shape": [30, 40],
        "detector": 1,
        "date_mjd": 60789.0,
        "date_iso": "2025-04-24T00:00:00Z",
        "obs_id": "2025W17_4B_0001_1",
    }


def transport(payload, ignore_range=False):
    def handler(request):
        if request.method == "HEAD":
            return httpx.Response(
                200, headers={"content-length": str(len(payload)), "etag": '"unchanged"'}
            )
        assert request.headers["if-match"] == '"unchanged"'
        start, end = map(int, request.headers["range"][6:].split("-"))
        return httpx.Response(
            200 if ignore_range else 206,
            stream=httpx.ByteStream(payload[start : end + 1]),
            headers={"content-range": f"bytes {start}-{end}/{len(payload)}"},
        )

    return httpx.MockTransport(handler)


def test_outage_classification_does_not_hide_client_errors():
    request = httpx.Request("GET", URL)
    for status in (500, 502, 503, 400, 401, 403, 404, 429):
        exc = httpx.HTTPStatusError(
            "error", request=request, response=httpx.Response(status, request=request)
        )
        assert is_provider_unavailable(exc) == (status >= 500)
    assert is_provider_unavailable(httpx.ConnectTimeout("timeout"))
    assert not is_provider_unavailable(ValueError("bad query"))


def test_s3_allowlist():
    assert canonical_s3_url("s3://nasa-irsa-spherex/dr1/level2/a.fits") == URL
    for bad in (
        "https://evil.test/dr1/a.fits",
        "s3://other/dr1/a.fits",
        "https://user@localhost/dr1/a.fits",
        URL + "?x=1",
        "https://nasa-irsa-spherex.s3.amazonaws.com/../secret",
    ):
        with pytest.raises(ValueError):
            canonical_s3_url(bad)


def test_range_reader_is_bounded_and_rejects_ignored_ranges():
    payload = b"x" * 20000
    with httpx.Client(transport=transport(payload)) as client:
        reader = RangeReader(client, URL, max_bytes=8192)
        assert reader.read(100) == payload[:100]
        assert reader.transferred <= 8192
        with pytest.raises(ValueError, match="budget"):
            reader.read(18000)
    with (
        httpx.Client(transport=transport(payload, True)) as client,
        pytest.raises(ValueError, match="206"),
    ):
        RangeReader(client, URL).read(1)


def test_overlap_includes_center_outside_rotated_detector_and_ra_wrap():
    with image_hdul() as hdul:
        sky = WCS(hdul["IMAGE"].header).celestial.pixel_to_world(44, 15)
        view = region_slices(hdul["IMAGE"], sky.ra.deg, sky.dec.deg, 1)
        assert view[1].stop == 40 and 0 <= view[1].start < 40
        with pytest.raises(ValueError, match="overlap"):
            region_slices(hdul["IMAGE"], 180, -70, 1)
        assert region_slices(hdul["IMAGE"], 359.99, 70, 180) == (
            slice(0, 30),
            slice(0, 40),
        )


def test_index_only_claims_positive_matches_never_absence(tmp_path):
    index = tmp_path / "index.sqlite"
    assert (
        query_index(0, 0, 1, index_path=index)["coverage_state"] == "unknown_not_indexed"
    )
    with image_hdul() as hdul:
        remember_products([record(hdul)], index_path=index)
        result = query_index(359.99, 70, 1, index_path=index)
    assert len(result["products"]) == 1
    assert result["coverage_state"] == "indexed_matches"
    assert result["coverage_complete"] is False
    product = result["products"][0]
    assert product["source"] == "s3" and product["s3_url"] == URL
    assert product["uri"] != URL
    assert query_index(180, -70, 180, index_path=index)["products"] == []
    remember_products([{"uri": URL}], index_path=index)


def test_downloader_serializes_crop_wcs_layers_and_cache_identity(tmp_path, monkeypatch):
    import app.services.spherex_provider as provider

    with image_hdul() as hdul:
        stream = io.BytesIO()
        hdul.writeto(stream)
        payload = stream.getvalue()
        sky = WCS(hdul["IMAGE"].header).celestial.pixel_to_world(44, 15)
        expected = region_slices(hdul["IMAGE"], sky.ra.deg, sky.dec.deg, 1)
        product = {"uri": "s3-cutout:unique-region", "s3_url": URL}
        monkeypatch.setattr(provider, "CUTOUT_CACHE_DIR", tmp_path)
        monkeypatch.setattr(
            provider, "_client", lambda: httpx.Client(transport=transport(payload))
        )
        path = download_s3_cutout(product, sky.ra.deg, sky.dec.deg, 1)
        assert path.stem == hashlib.sha1(product["uri"].encode()).hexdigest()
        with fits.open(path) as crop:
            np.testing.assert_array_equal(
                crop["IMAGE"].data, hdul["IMAGE"].data[expected]
            )
            before = WCS(hdul["IMAGE"].header).celestial.pixel_to_world(
                expected[1].start, expected[0].start
            )
            after = WCS(crop["IMAGE"].header).celestial.pixel_to_world(0, 0)
            assert before.separation(after).arcsec < 1e-5
            assert crop["IMAGE"].header["BUNIT"] == "MJy / sr"


def test_known_irsa_namespace_mapping_and_validation():
    from app.services.spherex_provider import original_to_s3_url

    assert (
        original_to_s3_url(
            "https://irsa.ipac.caltech.edu/ibe/data/spherex/"
            "dr1/level2/a.fits?center=1,2d&size=.1"
        )
        == URL
    )
    assert (
        original_to_s3_url("https://evil.test/ibe/data/spherex/dr1/level2/a.fits") is None
    )
    assert original_to_s3_url("https://irsa.ipac.caltech.edu/other/a.fits") is None
    for region in [(0, 91, 1), (0, 0, 181), (0, 0, 0), (float("nan"), 0, 1)]:
        with pytest.raises(ValueError):
            query_index(*region)


def test_dict_headers_and_optional_index_failure_do_not_break_cutouts(tmp_path, caplog):
    with image_hdul() as hdul:
        product = record(hdul)
        product["spatial_header"] = dict(hdul["IMAGE"].header)
        index = tmp_path / "index.sqlite"
        remember_products([product], index_path=index)
        assert len(query_index(359.99, 70, 1, index_path=index)["products"]) == 1
        blocked = tmp_path / "not-a-directory"
        blocked.write_text("blocked")
        remember_products([product], index_path=blocked / "index.sqlite")
        assert "could not be updated" in caplog.text


def test_index_deduplicates_object_with_multiple_verified_footprints(tmp_path):
    import sqlite3

    index = tmp_path / "index.sqlite"
    with image_hdul() as hdul:
        first = record(hdul)
        second = {**first, "spatial_header": dict(hdul["IMAGE"].header)}
        second["spatial_header"]["CRPIX1"] += 1
        remember_products([first, second], index_path=index)
        with sqlite3.connect(index) as db:
            assert db.execute("SELECT count(*) FROM products").fetchone()[0] == 2
        assert len(query_index(359.99, 70, 1, index_path=index)["products"]) == 1
    broken = tmp_path / "broken.sqlite"
    broken.write_text("not sqlite")
    assert (
        query_index(0, 0, 1, index_path=broken)["coverage_state"] == "unknown_not_indexed"
    )
