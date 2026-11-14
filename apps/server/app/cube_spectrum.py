"""Quick-look 102-channel spectra sampled from the SPHEREx DR1 All-Sky Cube HiPS.

Each order-5 HiPS tile ships a ``Npix{n}_cube.fits`` file (~320 MB) holding the
full spectral cube for that sky patch: ``IMAGE`` (MJy/sr), ``NHITS`` and ``FLAGS``
planes plus a ``SPECTRAL_CHANNELS`` table. Instead of downloading the tile, this
module walks the FITS headers and reads the 102 values of a single pixel with
HTTP multipart byte-range requests.

The result is a mosaic quick-look profile, not forced photometry of a source.
"""

from __future__ import annotations

import io
import json
import logging
import math
import os
import re
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import astropy.units as u
import httpx
import numpy as np
from astropy.coordinates import ICRS, SkyCoord
from astropy.io import fits
from astropy.wcs import WCS
from astropy_healpix import HEALPix
from fastapi import HTTPException

from app.config import (
    CUBE_BASE_URL,
    CUBE_CACHE_DIR,
    CUBE_CACHE_TTL_SECONDS,
    CUBE_FETCH_TIMEOUT,
    CUBE_ORDER,
    CUBE_SPECTRUM_CACHE_DIR,
    MAX_RANGE_RESPONSE_BYTES,
)

logger = logging.getLogger(__name__)

FITS_BLOCK = 2880
CARD = 80
CUBE_PRODUCTS = ("IMAGE", "NHITS", "FLAGS")
QUICK_LOOK_NOTES = [
    "Quick-look profile sampled from one pixel of the DR1 All-Sky Cube mosaic.",
    "Not forced photometry of a source; use the SPHEREx Spectrophotometry Tool "
    "for science-grade source spectra.",
    "Channel wavelengths are nominal per-channel centres from SPECTRAL_CHANNELS.",
]

_SPECTRAL_KEY = re.compile(
    r"^(CTYPE|CUNIT|CRPIX|CRVAL|CDELT|CNAME|CROTA)3$|^(PS|PV)3_\d+$|^PC(3_\d+|\d+_3)$"
)
_layout_lock = threading.Lock()
_tile_locks: dict[int, threading.Lock] = {}


@dataclass(frozen=True)
class CubeLayout:
    """Byte layout and metadata of one cube tile, cached as JSON."""

    npix: int
    url: str
    tile_size: int
    width: int
    height: int
    depth: int
    data_offsets: dict[str, int]
    bitpix: dict[str, int]
    unit: str
    celestial_header: str
    channels: list[dict[str, Any]]
    date_beg: str
    date_end: str

    def to_json(self) -> dict[str, Any]:
        return self.__dict__.copy()

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> CubeLayout:
        return cls(**data)


def tile_for(ra_deg: float, dec_deg: float, order: int = CUBE_ORDER) -> int:
    """Return the NESTED HEALPix index of the HiPS tile containing the coordinate."""
    hp = HEALPix(nside=2**order, order="nested", frame=ICRS())
    coord = SkyCoord(ra_deg * u.deg, dec_deg * u.deg, frame="icrs")
    return int(hp.skycoord_to_healpix(coord))


def tile_url(npix: int, order: int = CUBE_ORDER) -> str:
    directory = (npix // 10000) * 10000
    return f"{CUBE_BASE_URL}/Norder{order}/Dir{directory}/Npix{npix}/Npix{npix}_cube.fits"


def celestial_wcs(header: fits.Header) -> WCS:
    """Build a 2-D celestial WCS, dropping the WAVE-TAB axis astropy cannot load alone."""
    h = header.copy()
    for key in list(h.keys()):
        if _SPECTRAL_KEY.match(key):
            del h[key]
    h["WCSAXES"] = 2
    h["NAXIS"] = 2
    for key in ("NAXIS3",):
        if key in h:
            del h[key]
    return WCS(h)


def _header_end(buf: bytes) -> int | None:
    """Return the byte length of a complete FITS header in ``buf``, or None."""
    for start in range(0, len(buf) - CARD + 1, CARD):
        if buf[start : start + 3] == b"END" and not buf[start + 3 : start + CARD].strip():
            return ((start // FITS_BLOCK) + 1) * FITS_BLOCK
    return None


def _data_size(header: fits.Header) -> int:
    naxis = header.get("NAXIS", 0)
    if naxis == 0:
        return 0
    count = 1
    for axis in range(1, naxis + 1):
        count *= header[f"NAXIS{axis}"]
    count = header.get("GCOUNT", 1) * (header.get("PCOUNT", 0) + count)
    return abs(header["BITPIX"]) // 8 * count


def _padded(size: int) -> int:
    return ((size + FITS_BLOCK - 1) // FITS_BLOCK) * FITS_BLOCK


class TileChangedError(Exception):
    """The tile on IRSA no longer matches the cached layout (it was republished)."""


def _too_large() -> HTTPException:
    return HTTPException(
        status_code=502,
        detail=(
            "Cube tile range response too large; refusing to download the tile "
            f"(limit {MAX_RANGE_RESPONSE_BYTES} bytes)."
        ),
    )


def _fetch_partial(
    client: httpx.Client, url: str, range_value: str
) -> tuple[httpx.Headers, bytes]:
    """GET a byte range, streaming so an oversized reply is refused before download.

    Only 206 is accepted: a server that ignores Range (200) or merges the ranges
    into a span far larger than requested would otherwise stream the ~320 MB tile.
    """
    with client.stream("GET", url, headers={"Range": range_value}) as resp:
        if resp.status_code == 404:
            raise HTTPException(
                status_code=404, detail="No All-Sky Cube tile covers this position."
            )
        if resp.status_code != 206:
            raise HTTPException(
                status_code=502,
                detail=f"Cube tile server answered HTTP {resp.status_code} to a range.",
            )
        declared = resp.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_RANGE_RESPONSE_BYTES:
            raise _too_large()
        body = bytearray()
        for chunk in resp.iter_bytes():
            body += chunk
            if len(body) > MAX_RANGE_RESPONSE_BYTES:
                raise _too_large()
        return resp.headers, bytes(body)


_TOTAL_RE = re.compile(rb"content-range:\s*bytes\s+\d+-\d+/(\d+)", re.I)


def _range_total(headers: httpx.Headers, body: bytes) -> int | None:
    """Total tile size advertised by Content-Range (top-level or per part)."""
    match = re.search(r"/(\d+)\s*$", headers.get("content-range", ""))
    if match:
        return int(match.group(1))
    part = _TOTAL_RE.search(body)
    return int(part.group(1)) if part else None


def _get_range(client: httpx.Client, url: str, start: int, end: int) -> tuple[bytes, int]:
    """Fetch ``[start, end)``; return the bytes and the tile's total size."""
    headers, body = _fetch_partial(client, url, f"bytes={start}-{end - 1}")
    total = _range_total(headers, body)
    if total is None:
        raise HTTPException(
            status_code=502, detail="Range response without Content-Range."
        )
    return body, total


def parse_multipart_byteranges(content_type: str, body: bytes) -> dict[int, bytes]:
    """Parse a ``multipart/byteranges`` body into ``{start_offset: bytes}``."""
    match = re.search(r'boundary="?([^";]+)"?', content_type)
    if not match:
        raise ValueError("multipart/byteranges response without boundary")
    delimiter = b"--" + match.group(1).encode()
    parts: dict[int, bytes] = {}
    for chunk in body.split(delimiter)[1:]:
        if chunk.startswith(b"--"):
            break
        head, sep, payload = chunk.partition(b"\r\n\r\n")
        if not sep:
            continue
        range_match = re.search(rb"content-range:\s*bytes\s+(\d+)-(\d+)/", head, re.I)
        if not range_match:
            continue
        start, end = int(range_match.group(1)), int(range_match.group(2))
        parts[start] = payload[: end - start + 1]
    return parts


def read_ranges(
    client: httpx.Client,
    url: str,
    offsets: list[int],
    length: int,
    expected_total: int | None = None,
) -> list[bytes]:
    """Read ``length`` bytes at each offset with one multipart range request.

    ``expected_total`` is the tile size recorded with the cached layout; a
    different size means the tile was republished and the offsets are stale.
    """
    spec = ",".join(f"{o}-{o + length - 1}" for o in offsets)
    headers, body = _fetch_partial(client, url, f"bytes={spec}")
    total = _range_total(headers, body)
    if expected_total is not None and total != expected_total:
        # A missing or unknown total (`bytes a-b/*`) cannot prove the cached
        # offsets still fit, so it is treated as a changed tile.
        # (TileChangedError triggers one rediscovery, which requires a total.)
        raise TileChangedError(f"tile size {total} != cached {expected_total}")
    ctype = headers.get("content-type", "")
    if ctype.startswith("multipart/byteranges"):
        parts = parse_multipart_byteranges(ctype, body)
    else:
        # A single range (or a server that coalesced every range into one).
        crange = re.search(r"bytes\s+(\d+)-", headers.get("content-range", ""))
        if not crange:
            raise HTTPException(
                status_code=502, detail="Range response without Content-Range."
            )
        base = int(crange.group(1))
        parts = {o: body[o - base : o - base + length] for o in offsets if o >= base}
    try:
        values = [parts[o] for o in offsets]
    except KeyError as exc:
        raise HTTPException(
            status_code=502, detail=f"Range response is missing offset {exc.args[0]}."
        ) from None
    if any(len(v) != length for v in values):
        raise HTTPException(status_code=502, detail="Range response has truncated parts.")
    return values


def discover_layout(client: httpx.Client, npix: int) -> CubeLayout:
    """Walk the tile's HDU headers with range requests and record their offsets."""
    url = tile_url(npix)
    offset = 0
    primary: fits.Header | None = None
    headers: dict[str, tuple[fits.Header, int]] = {}
    tables: dict[str, bytes] = {}
    tile_size = 0
    for _ in range(8):
        buf = b""
        while (end := _header_end(buf)) is None:
            start = offset + len(buf)
            chunk, tile_size = _get_range(client, url, start, start + 4 * FITS_BLOCK)
            if not chunk:
                raise HTTPException(status_code=502, detail="Truncated cube tile header.")
            buf += chunk
        header = fits.Header.fromstring(buf[:end].decode("ascii"))
        data_offset = offset + end
        size = _data_size(header)
        name = str(header.get("EXTNAME", "PRIMARY")).strip()
        if primary is None:
            primary = header
        else:
            headers[name] = (header, data_offset)
            if header.get("XTENSION", "").strip() == "BINTABLE":
                table_bytes, tile_size = _get_range(
                    client, url, data_offset, data_offset + _padded(size)
                )
                tables[name] = buf[:end] + table_bytes
        if name == "SPECTRAL_CHANNELS":
            break
        offset = data_offset + _padded(size)

    missing = [p for p in (*CUBE_PRODUCTS, "SPECTRAL_CHANNELS") if p not in headers]
    if missing:
        raise HTTPException(
            status_code=502, detail=f"Cube tile is missing HDUs: {', '.join(missing)}."
        )

    image_header = headers["IMAGE"][0]
    table_blob = primary.tostring().encode("ascii") + tables["SPECTRAL_CHANNELS"]
    with fits.open(io.BytesIO(table_blob)) as hdul:
        rows = hdul["SPECTRAL_CHANNELS"].data
        channels = [
            {
                "channel": idx,
                "detector": int(row["DETECTOR"]),
                "subchannel": int(row["SUBCHAN"]),
                "wavelength_um": round(float(row["WAVELENGTH"]), 4),
                "bandwidth_um": round(float(row["BANDWIDTH"]), 4),
                "wl_min_um": round(float(row["WL_MIN"]), 4),
                "wl_max_um": round(float(row["WL_MAX"]), 4),
            }
            for idx, row in enumerate(rows)
        ]

    depth = int(image_header["NAXIS3"])
    for product in CUBE_PRODUCTS:
        _dtype_for(int(headers[product][0]["BITPIX"]))  # KeyError → unreadable tile
        if int(headers[product][0]["NAXIS3"]) != depth:
            raise ValueError(f"{product} has a different channel count than IMAGE")
    if len(channels) != depth:
        raise ValueError(
            f"SPECTRAL_CHANNELS has {len(channels)} rows but the cube has {depth} planes"
        )

    return CubeLayout(
        npix=npix,
        url=url,
        tile_size=tile_size,
        width=int(image_header["NAXIS1"]),
        height=int(image_header["NAXIS2"]),
        depth=depth,
        data_offsets={p: headers[p][1] for p in CUBE_PRODUCTS},
        bitpix={p: int(headers[p][0]["BITPIX"]) for p in CUBE_PRODUCTS},
        unit=str(image_header.get("BUNIT", "MJy/sr")).strip(),
        celestial_header=celestial_wcs(image_header).to_header().tostring(),
        channels=channels,
        date_beg=str(primary.get("DATE-BEG", "")),
        date_end=str(primary.get("DATE-END", "")),
    )


def _tile_lock(npix: int) -> threading.Lock:
    """One lock per tile, so concurrent cold requests walk its headers only once."""
    with _layout_lock:
        return _tile_locks.setdefault(npix, threading.Lock())


def _read_json_cache(path: Path) -> Any | None:
    """Return a cached JSON document, or None when missing, expired or unreadable."""
    try:
        if time.time() - path.stat().st_mtime > CUBE_CACHE_TTL_SECONDS:
            return None
        return json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        logger.warning("Discarding unreadable cube cache file %s", path)
        return None


def _write_json_cache(path: Path, data: Any) -> None:
    """Atomically publish a cache file through a temp file unique to this writer.

    The cache is best-effort: when the final replace loses a race (for example
    a Windows sharing violation while another request reads the file), the
    response is still served and the other writer's identical copy remains.
    """
    fd, tmp_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.stem}.", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle)
        os.replace(tmp, path)
    except OSError:
        logger.warning("Could not publish cube cache file %s", path, exc_info=True)
    finally:
        tmp.unlink(missing_ok=True)


def _layout_path(npix: int) -> Path:
    return CUBE_CACHE_DIR / f"layout-{CUBE_ORDER}-{npix}.json"


def invalidate_tile(npix: int) -> None:
    """Drop the cached layout and every cached spectrum of a republished tile."""
    with _tile_lock(npix):
        _layout_path(npix).unlink(missing_ok=True)
        for path in CUBE_SPECTRUM_CACHE_DIR.glob(f"{CUBE_ORDER}-{npix}-*.json"):
            path.unlink(missing_ok=True)


def get_layout(client: httpx.Client, npix: int) -> CubeLayout:
    """Return the cached layout for a tile, discovering it on first use."""
    path = _layout_path(npix)
    with _tile_lock(npix):
        cached = _read_json_cache(path)
        if cached is not None:
            try:
                return CubeLayout.from_json(cached)
            except (TypeError, KeyError):
                logger.warning("Discarding incompatible cube layout cache %s", path)
        layout = discover_layout(client, npix)
        _write_json_cache(path, layout.to_json())
        return layout


def _valid_spectrum_cache(values: Any, depth: int) -> bool:
    return isinstance(values, dict) and all(
        isinstance(values.get(p), list) and len(values[p]) == depth for p in CUBE_PRODUCTS
    )


_DTYPES = {-64: ">f8", -32: ">f4", 16: ">i2", 32: ">i4", 64: ">i8"}


def _dtype_for(bitpix: int) -> np.dtype:
    return np.dtype(_DTYPES[bitpix])


def read_pixel_spectrum(
    client: httpx.Client, layout: CubeLayout, x: int, y: int
) -> dict[str, list[Any]]:
    """Read all channel values of pixel ``(x, y)`` for IMAGE, NHITS and FLAGS."""
    plane = layout.width * layout.height
    result: dict[str, list[Any]] = {}
    for product in CUBE_PRODUCTS:
        dtype = _dtype_for(layout.bitpix[product])
        base = layout.data_offsets[product]
        offsets = [
            base + (k * plane + y * layout.width + x) * dtype.itemsize
            for k in range(layout.depth)
        ]
        raw = read_ranges(client, layout.url, offsets, dtype.itemsize, layout.tile_size)
        result[product] = [np.frombuffer(b, dtype=dtype)[0].item() for b in raw]
    return result


def pixel_index(position: float, size: int) -> int | None:
    """0-based pixel containing ``position`` (pixel centres at integers).

    Pixel ``i`` spans ``[i - 0.5, i + 0.5)``; the outer edges ``-0.5`` and
    ``size - 0.5`` still belong to the first and last pixel. Returns None
    outside the tile or for a non-finite position.
    """
    if not math.isfinite(position) or not -0.5 <= position <= size - 0.5:
        return None
    return min(int(math.floor(position + 0.5)), size - 1)


def _sample_tile(
    client: httpx.Client, npix: int, ra_deg: float, dec_deg: float
) -> tuple[CubeLayout, int, int, list[dict[str, Any]]]:
    """Locate the pixel, read (or reuse) its 102 values and build the points."""
    layout = get_layout(client, npix)
    wcs = celestial_wcs(fits.Header.fromstring(layout.celestial_header))
    px, py = wcs.world_to_pixel_values(ra_deg, dec_deg)
    x, y = pixel_index(float(px), layout.width), pixel_index(float(py), layout.height)
    if x is None or y is None:
        raise HTTPException(
            status_code=502,
            detail=f"Position maps outside tile {npix} ({px:.2f}, {py:.2f}).",
        )

    cache_path = CUBE_SPECTRUM_CACHE_DIR / f"{CUBE_ORDER}-{npix}-{x}-{y}.json"
    values = _read_json_cache(cache_path)
    if not _valid_spectrum_cache(values, layout.depth):
        values = read_pixel_spectrum(client, layout, x, y)
        _write_json_cache(cache_path, values)

    points = []
    for ch, value, nhits, flags in zip(
        layout.channels, values["IMAGE"], values["NHITS"], values["FLAGS"], strict=True
    ):
        finite = value is not None and math.isfinite(value)
        points.append(
            {
                **ch,
                "value": float(value) if finite else None,
                "nhits": int(nhits),
                "flags": int(flags),
                "available": finite,
            }
        )
    return layout, x, y, points


def _make_client() -> httpx.Client:
    return httpx.Client(timeout=CUBE_FETCH_TIMEOUT, follow_redirects=True)


def get_cube_spectrum(ra_deg: float, dec_deg: float) -> dict[str, Any]:
    """Return the 102-channel quick-look spectrum at one ICRS position."""
    if not (math.isfinite(ra_deg) and math.isfinite(dec_deg)) or not -90 <= dec_deg <= 90:
        raise HTTPException(
            status_code=422, detail="ra/dec must be finite; dec in [-90, 90]."
        )
    ra_deg = ra_deg % 360.0
    npix = tile_for(ra_deg, dec_deg)

    try:
        with _make_client() as client:
            try:
                layout, x, y, points = _sample_tile(client, npix, ra_deg, dec_deg)
            except TileChangedError as exc:
                # IRSA republished the tile: cached offsets are stale. Rebuild once.
                logger.warning(
                    "Cube tile %s changed upstream (%s); rediscovering", npix, exc
                )
                invalidate_tile(npix)
                layout, x, y, points = _sample_tile(client, npix, ra_deg, dec_deg)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail=f"All-Sky Cube tile request failed: {exc}"
        ) from None
    except (ValueError, KeyError, TypeError, IndexError, TileChangedError) as exc:
        # Malformed upstream bytes: non-ASCII headers, bad cards, unknown BITPIX,
        # channel tables that disagree with the cube, or a tile still changing.
        logger.warning("Unreadable cube tile %s: %r", npix, exc)
        raise HTTPException(
            status_code=502,
            detail=f"Unreadable All-Sky Cube tile {npix}: {type(exc).__name__}: {exc}",
        ) from None

    return {
        "ra_deg": ra_deg,
        "dec_deg": dec_deg,
        "unit": layout.unit,
        "source": "SPHEREx DR1 All-Sky Cube (fits-cube HiPS)",
        "tile": {"order": CUBE_ORDER, "npix": npix, "x": x, "y": y, "url": layout.url},
        "date_beg": layout.date_beg,
        "date_end": layout.date_end,
        "quick_look": True,
        "calibrated": False,
        "notes": QUICK_LOOK_NOTES,
        "points": points,
    }
