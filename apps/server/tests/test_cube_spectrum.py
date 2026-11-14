"""Tests for quick-look spectra sampled from All-Sky Cube fits-cube tiles (no network)."""

from __future__ import annotations

import io
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import numpy as np
import pytest
from astropy.io import fits
from fastapi.testclient import TestClient

import app.cube_spectrum as cube
from app.main import app

RA, DEC = 148.888, 69.065  # M81
SIZE, DEPTH = 6, 102
PX, PY = 2, 3  # pixel the synthetic WCS maps (RA, DEC) onto (0-based)


def build_cube_bytes() -> bytes:
    """Synthetic cube tile with the same HDU layout as the published fits-cube files."""
    primary = fits.PrimaryHDU()
    primary.header["DATE-BEG"] = "2025-10-06T19:27:20.456"
    primary.header["DATE-END"] = "2026-05-07T03:23:19.646"

    image = np.zeros((DEPTH, SIZE, SIZE), dtype=np.float32)
    image[:, PY, PX] = np.arange(DEPTH, dtype=np.float32) * 1.5 + 10.0
    image[50, :, :] = np.nan  # blank channel, as in the real cube (D3:17)
    nhits = np.full((DEPTH, SIZE, SIZE), 7, dtype=np.int32)
    nhits[50] = 0
    flags = np.zeros((DEPTH, SIZE, SIZE), dtype=np.int32)
    flags[3, PY, PX] = 1 << 21

    def cube_hdu(data: np.ndarray, name: str, unit: str) -> fits.ImageHDU:
        hdu = fits.ImageHDU(data=data, name=name)
        h = hdu.header
        h["CTYPE1"], h["CTYPE2"] = "RA---TAN", "DEC--TAN"
        h["CRPIX1"], h["CRPIX2"] = PX + 1, PY + 1
        h["CRVAL1"], h["CRVAL2"] = RA, DEC
        h["CDELT1"], h["CDELT2"] = -0.0036, 0.0036
        # Spectral lookup-table axis: astropy refuses to build a WCS from it
        # without the full HDUList, so the code must strip it.
        h["CTYPE3"], h["CUNIT3"] = "WAVE-TAB", "um"
        h["PS3_0"], h["PS3_1"], h["PS3_2"] = "WCS-WAVE", "WAVELENGTHS", "PLANE"
        h["BUNIT"] = unit
        return hdu

    rows = np.arange(DEPTH)
    channels = fits.BinTableHDU.from_columns(
        [
            fits.Column("DETECTOR", "I", array=rows // 17 + 1),
            fits.Column("SUBCHAN", "I", array=rows % 17 + 1),
            fits.Column("WAVELENGTH", "E", array=0.75 + rows * 0.042),
            fits.Column("WL_MIN", "E", array=0.74 + rows * 0.042),
            fits.Column("WL_MAX", "E", array=0.76 + rows * 0.042),
            fits.Column("R", "E", array=np.full(DEPTH, 40.0)),
            fits.Column("R_STD", "E", array=np.ones(DEPTH)),
            fits.Column("BANDWIDTH", "E", array=np.full(DEPTH, 0.02)),
        ],
        name="SPECTRAL_CHANNELS",
    )
    hdul = fits.HDUList(
        [
            primary,
            cube_hdu(image, "IMAGE", "MJy/sr"),
            cube_hdu(nhits, "NHITS", "count"),
            cube_hdu(flags, "FLAGS", ""),
            channels,
        ]
    )
    buf = io.BytesIO()
    hdul.writeto(buf)
    return buf.getvalue()


class RangeServer:
    """httpx transport that serves byte ranges (single and multipart) from memory."""

    def __init__(self, blob: bytes, *, honour_ranges: bool = True, status: int = 206):
        self.blob = blob
        self.honour_ranges = honour_ranges
        self.status = status
        self.requests = 0
        self.coalesce = False
        self.omit_content_range = False

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests += 1
        if self.status == 404:
            return httpx.Response(404, text="not found")
        if not self.honour_ranges:
            return httpx.Response(200, content=self.blob[:4096])
        spec = request.headers["range"].removeprefix("bytes=")
        ranges = [tuple(int(v) for v in part.split("-")) for part in spec.split(",")]
        total = len(self.blob)
        if len(ranges) == 1 or self.coalesce:
            # One part; a coalescing server merges every range into one span.
            a = min(r[0] for r in ranges)
            b = min(max(r[1] for r in ranges), total - 1)
            headers = (
                {}
                if self.omit_content_range
                else {"content-range": f"bytes {a}-{b}/{total}"}
            )
            return httpx.Response(206, content=self.blob[a : b + 1], headers=headers)
        boundary = "TESTBOUNDARY"
        body = b""
        for a, b in ranges:
            body += (
                f"\r\n--{boundary}\r\nContent-Type: application/fits\r\n"
                f"Content-Range: bytes {a}-{b}/{total}\r\n\r\n"
            ).encode() + self.blob[a : b + 1]
        body += f"\r\n--{boundary}--\r\n".encode()
        return httpx.Response(
            206,
            content=body,
            headers={"content-type": f"multipart/byteranges; boundary={boundary}"},
        )


@pytest.fixture
def cube_server(tmp_path, monkeypatch):
    """Isolate the cube caches and route every tile request to a RangeServer."""
    layout_dir = tmp_path / "cube"
    spectra_dir = layout_dir / "spectra"
    spectra_dir.mkdir(parents=True)
    monkeypatch.setattr(cube, "CUBE_CACHE_DIR", layout_dir)
    monkeypatch.setattr(cube, "CUBE_SPECTRUM_CACHE_DIR", spectra_dir)

    server = RangeServer(build_cube_bytes())
    monkeypatch.setattr(
        cube, "_make_client", lambda: httpx.Client(transport=httpx.MockTransport(server))
    )
    return server


def test_tile_for_matches_published_tile():
    """M81 lies in order-5 tile 1901 (verified against IRSA's directory listing)."""
    assert cube.tile_for(RA, DEC) == 1901
    assert cube.tile_url(1901).endswith("/Norder5/Dir0/Npix1901/Npix1901_cube.fits")
    assert cube.tile_url(12345).endswith(
        "/Norder5/Dir10000/Npix12345/Npix12345_cube.fits"
    )


def test_celestial_wcs_maps_real_hpx_header():
    """Real tile-1901 IMAGE header: the WAVE-TAB axis is dropped, HPX mapping is kept."""
    header = fits.Header()
    for key, value in {
        "NAXIS": 3,
        "NAXIS1": 512,
        "NAXIS2": 512,
        "NAXIS3": 102,
        "WCSAXES": 3,
        "CRPIX1": 13312.5,
        "CRPIX2": 38912.5,
        "PC1_1": -0.00274658203125,
        "PC1_2": -0.00274658203125,
        "PC2_1": 0.00274658203125,
        "PC2_2": -0.00274658203125,
        "CDELT1": 1.0,
        "CDELT2": 1.0,
        "CUNIT1": "deg",
        "CUNIT2": "deg",
        "CTYPE1": "RA---HPX",
        "CTYPE2": "DEC--HPX",
        "CRVAL1": 0.0,
        "CRVAL2": 0.0,
        "PV2_1": 4.0,
        "PV2_2": 3.0,
        "LONPOLE": 0.0,
        "LATPOLE": 90.0,
        "RADESYS": "ICRS",
        "CTYPE3": "WAVE-TAB",
        "CUNIT3": "um",
        "CRPIX3": 1,
        "CDELT3": 1,
        "CRVAL3": 1,
        "PS3_0": "WCS-WAVE",
        "PS3_1": "WAVELENGTHS",
        "PS3_2": "PLANE",
        "PV3_3": 1,
        "PC3_3": 1.0,
    }.items():
        header[key] = value
    x, y = cube.celestial_wcs(header).world_to_pixel_values(RA, DEC)
    assert (round(float(x)), round(float(y))) == (349, 472)


def test_parse_multipart_byteranges():
    body = (
        b"\r\n--B\r\nContent-Range: bytes 10-13/100\r\n\r\nabcd"
        b"\r\n--B\r\nContent-Range: bytes 50-53/100\r\n\r\nwxyz\r\n--B--\r\n"
    )
    parts = cube.parse_multipart_byteranges("multipart/byteranges; boundary=B", body)
    assert parts == {10: b"abcd", 50: b"wxyz"}


def test_spectrum_endpoint_returns_all_channels(cube_server):
    resp = TestClient(app).get("/api/spectrum", params={"ra": RA, "dec": DEC})
    assert resp.status_code == 200
    data = resp.json()

    assert data["unit"] == "MJy/sr"
    assert data["quick_look"] is True
    assert data["calibrated"] is False
    assert data["tile"]["npix"] == 1901
    assert (data["tile"]["x"], data["tile"]["y"]) == (PX, PY)
    assert data["date_beg"] == "2025-10-06T19:27:20.456"

    points = data["points"]
    assert len(points) == DEPTH
    assert [p["channel"] for p in points] == list(range(DEPTH))
    assert points[0]["value"] == pytest.approx(10.0)
    assert points[101]["value"] == pytest.approx(10.0 + 101 * 1.5)
    assert points[17]["detector"] == 2 and points[17]["subchannel"] == 1
    assert points[0]["wavelength_um"] == pytest.approx(0.75)
    assert points[0]["bandwidth_um"] == pytest.approx(0.02)
    assert points[3]["flags"] == 1 << 21
    assert points[0]["nhits"] == 7

    blank = points[50]
    assert blank["value"] is None
    assert blank["available"] is False
    assert blank["nhits"] == 0


def test_spectrum_is_served_from_disk_cache(cube_server):
    client = TestClient(app)
    assert client.get("/api/spectrum", params={"ra": RA, "dec": DEC}).status_code == 200
    first = cube_server.requests
    again = client.get("/api/spectrum", params={"ra": RA, "dec": DEC})
    assert again.status_code == 200
    assert cube_server.requests == first
    assert again.json()["points"][0]["value"] == pytest.approx(10.0)


def test_server_ignoring_range_is_rejected(cube_server):
    cube_server.honour_ranges = False
    resp = TestClient(app).get("/api/spectrum", params={"ra": RA, "dec": DEC})
    assert resp.status_code == 502
    assert "HTTP 200" in resp.json()["detail"]


def test_missing_tile_reports_no_coverage(cube_server):
    cube_server.status = 404
    resp = TestClient(app).get("/api/spectrum", params={"ra": RA, "dec": DEC})
    assert resp.status_code == 404
    assert "No All-Sky Cube tile" in resp.json()["detail"]


def test_network_failure_is_502_not_fabricated(cube_server, monkeypatch):
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline", request=request)

    monkeypatch.setattr(
        cube, "_make_client", lambda: httpx.Client(transport=httpx.MockTransport(refuse))
    )
    resp = TestClient(app).get("/api/spectrum", params={"ra": RA, "dec": DEC})
    assert resp.status_code == 502
    assert re.search("request failed", resp.json()["detail"])


@pytest.mark.parametrize(
    "params", [{"ra": RA, "dec": 91}, {"ra": RA}, {"ra": "x", "dec": 1}]
)
def test_invalid_coordinates_are_422(cube_server, params):
    assert TestClient(app).get("/api/spectrum", params=params).status_code == 422
    assert cube_server.requests == 0


# --- Robustness: concurrent cache writes, corrupt caches, unparseable tiles ---


def spectrum_cache_file(tmp_dir: Path) -> Path:
    return tmp_dir / f"5-1901-{PX}-{PY}.json"


def test_corrupt_spectrum_cache_is_refetched(cube_server):
    cache_file = spectrum_cache_file(cube.CUBE_SPECTRUM_CACHE_DIR)
    cache_file.write_text('{"IMAGE": [1, 2', "utf-8")  # truncated by a crashed writer
    resp = TestClient(app, raise_server_exceptions=False).get(
        "/api/spectrum", params={"ra": RA, "dec": DEC}
    )
    assert resp.status_code == 200
    assert resp.json()["points"][0]["value"] == pytest.approx(10.0)
    assert len(json.loads(cache_file.read_text("utf-8"))["IMAGE"]) == DEPTH


def test_cache_writes_do_not_share_a_fixed_temp_path(cube_server):
    """Another writer's in-flight temp file must not break this request."""
    (cube.CUBE_CACHE_DIR / "layout-5-1901.tmp").mkdir()
    spectrum_cache_file(cube.CUBE_SPECTRUM_CACHE_DIR).with_suffix(".tmp").mkdir()
    resp = TestClient(app, raise_server_exceptions=False).get(
        "/api/spectrum", params={"ra": RA, "dec": DEC}
    )
    assert resp.status_code == 200
    assert spectrum_cache_file(cube.CUBE_SPECTRUM_CACHE_DIR).is_file()


def test_concurrent_cold_requests_discover_the_tile_once(cube_server, monkeypatch):
    header_walks = []
    original = cube.discover_layout

    def slow_discover(client, npix):
        header_walks.append(npix)
        time.sleep(0.2)  # widen the window in which other requests arrive
        return original(client, npix)

    monkeypatch.setattr(cube, "discover_layout", slow_discover)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: cube.get_cube_spectrum(RA, DEC), range(4)))

    assert header_walks == [1901]
    assert all(r["points"][0]["value"] == pytest.approx(10.0) for r in results)


def test_unreadable_tile_header_is_502(cube_server):
    blob = bytearray(cube_server.blob)
    blob[200:203] = bytes([0xC3, 0xB1, 0xFF])  # non-ASCII bytes inside the primary header
    cube_server.blob = bytes(blob)
    resp = TestClient(app, raise_server_exceptions=False).get(
        "/api/spectrum", params={"ra": RA, "dec": DEC}
    )
    assert resp.status_code == 502
    assert "Unreadable All-Sky Cube tile" in resp.json()["detail"]


def test_unsupported_plane_type_is_502(cube_server):
    hdul = fits.open(io.BytesIO(cube_server.blob))
    hdul["FLAGS"].data = hdul["FLAGS"].data.astype(np.uint8)  # BITPIX 8
    buf = io.BytesIO()
    hdul.writeto(buf)
    cube_server.blob = buf.getvalue()
    resp = TestClient(app, raise_server_exceptions=False).get(
        "/api/spectrum", params={"ra": RA, "dec": DEC}
    )
    assert resp.status_code == 502
    assert "Unreadable All-Sky Cube tile" in resp.json()["detail"]


# --- Single-part range responses (coalescing servers or proxies) ---


def test_coalesced_range_response_is_sliced_per_offset(cube_server):
    """A server may answer many ranges with one 206 span; values must still line up."""
    cube_server.coalesce = True
    resp = TestClient(app).get("/api/spectrum", params={"ra": RA, "dec": DEC})
    assert resp.status_code == 200
    points = resp.json()["points"]
    assert [p["value"] for p in points[:3]] == pytest.approx([10.0, 11.5, 13.0])
    assert points[101]["value"] == pytest.approx(10.0 + 101 * 1.5)
    assert points[50]["value"] is None
    assert points[3]["flags"] == 1 << 21
    assert points[0]["nhits"] == 7


def test_single_part_response_without_content_range_is_502(cube_server):
    # Layout discovery succeeds first; only the multi-offset pixel read lacks the header.
    TestClient(app).get("/api/spectrum", params={"ra": RA, "dec": DEC + 0.01})
    for f in cube.CUBE_SPECTRUM_CACHE_DIR.glob("*.json"):
        f.unlink()
    cube_server.coalesce = True
    cube_server.omit_content_range = True
    resp = TestClient(app, raise_server_exceptions=False).get(
        "/api/spectrum", params={"ra": RA, "dec": DEC}
    )
    assert resp.status_code == 502
    assert "Content-Range" in resp.json()["detail"]
