"""Offline tests: synthetic fixtures are not evidence of real S3 connectivity."""

import io
import json

import httpx
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS, Sip

from scripts.spherex_s3_poc import RangeFile, cutout_hdul, region_slices, verify_cutout


def sample():
    wcs = WCS(naxis=2)
    wcs.wcs.crpix = [20, 15]
    wcs.wcs.crval = [359.99, 70]
    wcs.wcs.cd = np.array([[-0.001, 0.0003], [0.0003, 0.001]])
    wcs.wcs.ctype = ["RA---TAN-SIP", "DEC--TAN-SIP"]
    a, b = np.zeros((3, 3)), np.zeros((3, 3))
    a[2, 0], b[0, 2] = 1e-5, -1e-5
    wcs.sip = Sip(a, b, None, None, wcs.wcs.crpix)
    header = wcs.to_header(relax=True)
    header["BUNIT"] = "MJy/sr"
    header["CRPIX1W"], header["CRPIX2W"] = 1.0, 1.0
    for axis in [1, 2]:
        header[f"CTYPE{axis}W"] = "WAVE-TAB"
        header[f"CUNIT{axis}W"] = "um"
        header[f"CRVAL{axis}W"] = 1.0
        header[f"CDELT{axis}W"] = 1.0
        header[f"PS{axis}_0W"] = "WCS-WAVE"
        header[f"PS{axis}_1W"] = "VALUES"
        header[f"PS{axis}_2W"] = "X" if axis == 1 else "Y"
        header[f"PV{axis}_3W"] = axis
    data = np.arange(1200, dtype=np.float32).reshape(30, 40)
    hdul = fits.HDUList(
        [fits.PrimaryHDU()]
        + [
            fits.ImageHDU(data.copy(), header=header.copy(), name=name)
            for name in ["IMAGE", "FLAGS", "VARIANCE", "ZODI"]
        ]
        + [
            fits.BinTableHDU.from_columns(
                [
                    fits.Column(name="X", format="2D", array=[[1.0, 40.0]]),
                    fits.Column(name="Y", format="2D", array=[[1.0, 30.0]]),
                    fits.Column(
                        name="VALUES",
                        format="8D",
                        dim="(2,2,2)",
                        array=[
                            [[[0.8, 0.02], [0.9, 0.021]], [[1.0, 0.022], [1.1, 0.023]]]
                        ],
                    ),
                ],
                name="WCS-WAVE",
            )
        ]
    )
    stream = io.BytesIO()
    hdul.writeto(stream)
    stream.seek(0)
    return fits.open(stream)


def test_cutout_preserves_pixels_units_and_both_wcs(tmp_path):
    with sample() as source:
        sky = WCS(source["IMAGE"].header).celestial.pixel_to_world(19, 14)
        view = region_slices(source["IMAGE"], sky.ra.deg, sky.dec.deg, 0.6)
        result = cutout_hdul(source, view)
        assert result["IMAGE"].shape == (10, 10)
        for name in ["IMAGE", "FLAGS", "VARIANCE", "ZODI"]:
            np.testing.assert_array_equal(result[name].data, source[name].data[view])
            assert result[name].header["BUNIT"] == source[name].header["BUNIT"]
        path = tmp_path / "cutout.fits"
        result.writeto(path)
        with fits.open(path) as saved:
            assert verify_cutout(source, saved, view)["spectral_wcs_matches"]
        x, y = WCS(result["IMAGE"].header).celestial.world_to_pixel(sky)
        assert abs(x - 4.5) <= 0.5 and abs(y - 4.5) <= 0.5
        assert result["IMAGE"].header["CRPIX1W"] == 1 - view[1].start
        np.testing.assert_array_equal(result["WCS-WAVE"].data, source["WCS-WAVE"].data)


@pytest.mark.parametrize("ra,dec,size", [(0, 91, 1), (0, 0, 0), (float("nan"), 0, 1)])
def test_region_rejects_invalid_inputs(ra, dec, size):
    with sample() as source, pytest.raises(ValueError):
        region_slices(source["IMAGE"], ra, dec, size)


def test_region_rejects_outside_and_clips_border():
    with sample() as source:
        with pytest.raises(ValueError):
            region_slices(source["IMAGE"], 100, -50, 1)
        sky = WCS(source["IMAGE"].header).celestial.pixel_to_world(0, 0)
        view = region_slices(source["IMAGE"], sky.ra.deg, sky.dec.deg, 0.6)
        assert view[0].start == view[1].start == 0


def test_range_read_counts_body_and_refuses_unbounded_download():
    def handler(request):
        if request.method == "HEAD":
            return httpx.Response(200, headers={"content-length": "100000"})
        assert request.headers["range"].startswith("bytes=")
        start, end = map(int, request.headers["range"][6:].split("-"))
        return httpx.Response(
            206,
            stream=httpx.ByteStream(b"x" * (end - start + 1)),
            headers={"content-range": f"bytes {start}-{end}/100000"},
        )

    with (
        httpx.Client(transport=httpx.MockTransport(handler)) as client,
        RangeFile(client, "https://example.test/a", max_bytes=8192) as remote,
    ):
        assert remote.read(100) == b"x" * 100
        assert 100 <= remote.transferred <= 8192
        assert remote.requests == 1
        with pytest.raises(ValueError, match="budget"):
            remote.read(100000)

    def ignored(request):
        return httpx.Response(200, headers={"content-length": "100000"})

    with (
        httpx.Client(transport=httpx.MockTransport(ignored)) as client,
        RangeFile(client, "https://example.test/a") as remote,
        pytest.raises(ValueError, match="206"),
    ):
        remote.read(1)


def test_sample_index_wrap_rotation_edges_order_and_unknown(tmp_path):
    from scripts.spherex_s3_poc import build_index, describe, query_spherex_s3

    reports = []
    with sample() as source:
        for mjd in [60002.0, 60001.0]:
            source["IMAGE"].header["MJD-OBS"] = mjd
            source["IMAGE"].header["DETECTOR"] = 1
            report = describe(source, f"dr1/level2/period/version/{mjd}/file.fits")
            path = tmp_path / f"{mjd}.json"
            path.write_text(json.dumps(report))
            reports.append(path)
        index = tmp_path / "sample.sqlite"
        build_index(reports, index)
        sky = WCS(source["IMAGE"].header).celestial.pixel_to_world(39, 29)
        found = query_spherex_s3(sky.ra.deg, sky.dec.deg, 1, index_path=index)
        assert [p["date_mjd"] for p in found["products"]] == [60001.0, 60002.0]
        assert found["index_complete"] is False
        assert found["coverage"] == "sample_matches"
        empty = query_spherex_s3(180, -70, 1, index_path=index)
        assert empty["products"] == [] and empty["coverage"] == "unknown_not_indexed"
        # A sky point beyond a rotated image corner must not pass a bounding box.
        outside = WCS(source["IMAGE"].header).celestial.pixel_to_world(41, 31)
        assert not query_spherex_s3(outside.ra.deg, outside.dec.deg, 1, index_path=index)[
            "products"
        ]
