"""Fallback cutouts and mosaics from the SPHEREx DR1 All-Sky Cube tiles on S3.

Used only when IRSA TAP discovery is unavailable and the indexed S3 L2 sample has
no products. Each requested channel is read on its own: for every HiPS tile the
region touches, one HTTP range per HDU (IMAGE, FLAGS, NHITS) covering only the
rows the region needs. The tiles are never downloaded whole.

The cube combines every DR1 observation into one image, so these results have
no temporal information, no VARIANCE layer, and only nominal per-channel
wavelengths. Callers must present them that way.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

import astropy.units as u
import httpx
import numpy as np
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
from astropy_healpix import HEALPix

from app.core.config import (
    CUBE_FETCH_TIMEOUT,
    CUBE_ORDER,
    CUBE_S3_BASE_URL,
    CUBE_TILE_WORKERS,
)
from app.exceptions.domain import CubeUpstreamError, SpectrumNotFoundError
from app.services.cube_spectrum import (
    CubeLayout,
    TileChangedError,
    _dtype_for,
    _get_range,
    celestial_wcs,
    get_layout,
    invalidate_tile,
    tile_for,
)
from app.services.fits import DerivedCutout, load_derived_cutout

logger = logging.getLogger(__name__)

CUBE_SOURCE = "cube"
CUBE_PROVIDER = "S3 DR1 All-Sky Cube"
CUBE_COVERAGE_STATE = "cube_fallback"
CUBE_WAVELENGTH_STATUS = "cube_channel_nominal"
CUBE_OBS_ID = "SPHEREx DR1 All-Sky Cube"
CUBE_VERSION = CUBE_S3_BASE_URL.rstrip("/").rsplit("/", 1)[-1]
CUBE_HDUS = ("IMAGE", "FLAGS", "NHITS")
DETECTORS = (1, 2, 3, 4, 5, 6)
ProgressCallback = Callable[[int, int], None]

__all__ = [
    "CUBE_COVERAGE_STATE",
    "CUBE_PROVIDER",
    "CUBE_SOURCE",
    "CubeCutout",
    "CubeUpstreamError",
    "build_cube_cutout",
    "discover_cube",
    "no_temporal_notice",
]


@dataclass
class CubeCutout(DerivedCutout):
    """A channel cutout resampled from cube tiles, with its contributing-hit count."""

    nhits: np.ndarray = field(default_factory=lambda: np.zeros((0, 0), np.int32))


def no_temporal_notice(date_beg: str, date_end: str) -> str:
    """User-facing explanation of what the cube fallback is and what it lacks."""
    span = f"{date_beg[:10] or 'unknown'} to {date_end[:10] or 'unknown'}"
    return (
        "IRSA TAP discovery is unavailable, so this result comes from the SPHEREx "
        "DR1 All-Sky Cube on S3. The cube combines every DR1 observation from "
        f"{span} into one image, so it has no temporal information: individual "
        "epochs, timeline comparison and animation are unavailable. The cube has "
        "no VARIANCE layer, and wavelengths are nominal channel centres, not "
        "calibrated values."
    )


@contextmanager
def _session(client: httpx.Client | None) -> Iterator[httpx.Client]:
    if client is not None:
        yield client
        return
    with httpx.Client(timeout=CUBE_FETCH_TIMEOUT, follow_redirects=True) as own:
        yield own


def _tiles_for(ra: np.ndarray, dec: np.ndarray) -> np.ndarray:
    """NESTED order-``CUBE_ORDER`` tile index of every position (degrees)."""
    hp = HEALPix(nside=2**CUBE_ORDER, order="nested")
    return np.asarray(hp.lonlat_to_healpix(ra * u.deg, dec * u.deg), dtype=np.int64)


def _pixel_scale_arcsec(layout: CubeLayout) -> float:
    """Native pixel size at the tile centre (see ``pixel_scale_from_wcs``)."""
    wcs = celestial_wcs(fits.Header.fromstring(layout.celestial_header))
    return pixel_scale_from_wcs(wcs, layout.width, layout.height)


def pixel_scale_from_wcs(wcs: WCS, width: int, height: int) -> float:
    """Pixel size at the image centre: square root of the pixel's sky area.

    Measured on the WCS so it holds for the HEALPix (HPX) projection, whose
    pixels are rotated 45 degrees in the projection plane.
    """
    cx, cy = (width - 1) / 2.0, (height - 1) / 2.0
    ra, dec = wcs.pixel_to_world_values([cx, cx + 1, cx], [cy, cy, cy + 1])
    cos_dec = math.cos(math.radians(float(dec[0])))
    dx = ((float(ra[1] - ra[0]) + 180) % 360 - 180) * cos_dec, float(dec[1] - dec[0])
    dy = ((float(ra[2] - ra[0]) + 180) % 360 - 180) * cos_dec, float(dec[2] - dec[0])
    area = abs(dx[0] * dy[1] - dx[1] * dy[0])
    if not math.isfinite(area) or area <= 0:
        raise CubeUpstreamError("Cube tile WCS has no usable pixel scale.")
    return math.sqrt(area) * 3600.0


def _target_grid(
    ra: float, dec: float, size_arcmin: float, scale_arcsec: float
) -> tuple[WCS, np.ndarray, np.ndarray]:
    """North-up TAN grid at native cube scale and the sky position of each pixel."""
    n = max(1, math.ceil(size_arcmin * 60.0 / scale_arcsec))
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [ra, dec]
    wcs.wcs.crpix = [(n + 1) / 2.0, (n + 1) / 2.0]
    wcs.wcs.cdelt = [-scale_arcsec / 3600.0, scale_arcsec / 3600.0]
    wcs.wcs.cunit = ["deg", "deg"]
    wcs.wcs.radesys = "ICRS"
    yy, xx = np.mgrid[0:n, 0:n]
    world_ra, world_dec = wcs.pixel_to_world_values(xx, yy)
    return wcs, np.mod(world_ra, 360.0), world_dec


def _date_mjd(date: str) -> float:
    try:
        return float(Time(date, format="isot", scale="utc").mjd)
    except ValueError:
        return 0.0


def _iso(date: str) -> str:
    return date if not date or date.endswith("Z") else f"{date}Z"


def _read_rows(
    client: httpx.Client, layout: CubeLayout, hdu: str, channel: int, y0: int, y1: int
) -> np.ndarray:
    """Read rows ``y0..y1`` of one channel plane of one HDU with a single range."""
    dtype = _dtype_for(layout.bitpix[hdu])
    width = layout.width
    start = (
        layout.data_offsets[hdu]
        + (channel * width * layout.height + y0 * width) * dtype.itemsize
    )
    length = (y1 - y0 + 1) * width * dtype.itemsize
    body, total = _get_range(client, layout.url, start, start + length)
    if total != layout.tile_size:
        raise TileChangedError(f"tile size {total} != cached {layout.tile_size}")
    if len(body) != length:
        raise CubeUpstreamError("Cube range response has the wrong length.")
    return (
        np.frombuffer(body, dtype=dtype)
        .reshape(y1 - y0 + 1, width)
        .astype(dtype.newbyteorder("="))
    )


def _check_channel(layout: CubeLayout, channel: int) -> dict[str, Any]:
    if not 0 <= channel < layout.depth:
        raise CubeUpstreamError(
            f"Channel {channel} is outside the cube (0..{layout.depth - 1})."
        )
    info = layout.channels[channel]
    if info["detector"] != channel // 17 + 1:
        raise CubeUpstreamError(
            f"Cube channel {channel} belongs to detector {info['detector']}, "
            f"not detector {channel // 17 + 1}."
        )
    return info


def _sample_tile(
    client: httpx.Client,
    layout: CubeLayout,
    channel: int,
    ra: np.ndarray,
    dec: np.ndarray,
) -> tuple[dict[str, np.ndarray], np.ndarray, dict[str, Any]]:
    """Nearest-pixel samples of the channel plane at the given sky positions."""
    wcs = celestial_wcs(fits.Header.fromstring(layout.celestial_header))
    px, py = wcs.world_to_pixel_values(ra, dec)
    ix = np.floor(np.asarray(px) + 0.5)
    iy = np.floor(np.asarray(py) + 0.5)
    # HEALPix already assigned these positions to this tile; allow half a pixel
    # of rounding at the tile edge, reject anything further out.
    ok = (
        np.isfinite(ix)
        & np.isfinite(iy)
        & (ix >= -1)
        & (ix <= layout.width)
        & (iy >= -1)
        & (iy <= layout.height)
    )
    ix = np.clip(np.where(ok, ix, 0), 0, layout.width - 1).astype(np.int64)
    iy = np.clip(np.where(ok, iy, 0), 0, layout.height - 1).astype(np.int64)
    if not ok.any():
        return {}, ok, {}
    y0, y1 = int(iy[ok].min()), int(iy[ok].max())
    values = {}
    for hdu in CUBE_HDUS:
        rows = _read_rows(client, layout, hdu, channel, y0, y1)
        values[hdu] = rows[iy - y0, ix]
    width = layout.width
    itemsizes = sum(_dtype_for(layout.bitpix[h]).itemsize for h in CUBE_HDUS)
    provenance = {
        "provider": CUBE_PROVIDER,
        "tile": layout.npix,
        "url": layout.url,
        "rows": [y0, y1],
        "range_gets": len(CUBE_HDUS),
        "bytes": (y1 - y0 + 1) * width * itemsizes,
    }
    return values, ok, provenance


def _layout(client: httpx.Client, npix: int) -> CubeLayout:
    return get_layout(client, npix, "s3")


def cube_cutout_uri(ra: float, dec: float, size_arcmin: float, channel: int) -> str:
    """Stable identity of one channel cutout (also its derived-cache key)."""
    return (
        f"cube:{CUBE_VERSION}:{CUBE_ORDER}:{ra % 360.0:.6f}:{dec:.6f}:"
        f"{size_arcmin:g}:ch{channel}"
    )


def _build(
    client: httpx.Client,
    ra: float,
    dec: float,
    size_arcmin: float,
    channel: int,
    on_progress: ProgressCallback | None = None,
) -> CubeCutout:
    center = _layout(client, tile_for(ra, dec))
    info = _check_channel(center, channel)
    scale = _pixel_scale_arcsec(center)
    wcs, world_ra, world_dec = _target_grid(ra, dec, size_arcmin, scale)
    shape = world_ra.shape
    tiles = _tiles_for(world_ra, world_dec)

    image = np.full(shape, np.nan, dtype=np.float32)
    flags = np.zeros(shape, dtype=np.int32)
    nhits = np.zeros(shape, dtype=np.int32)
    tile_ids = sorted(int(t) for t in np.unique(tiles))

    def read_tile(npix: int) -> tuple[int, dict[str, np.ndarray], np.ndarray, dict]:
        mask = tiles == npix
        try:
            layout = center if npix == center.npix else _layout(client, npix)
            _check_channel(layout, channel)
            values, ok, prov = _sample_tile(
                client, layout, channel, world_ra[mask], world_dec[mask]
            )
        except TileChangedError:
            # The tile was republished: cached offsets are stale. Rebuild once.
            invalidate_tile(npix, "s3")
            layout = _layout(client, npix)
            values, ok, prov = _sample_tile(
                client, layout, channel, world_ra[mask], world_dec[mask]
            )
        return npix, values, ok, prov

    if on_progress:
        on_progress(0, len(tile_ids))
    results = {}
    workers = max(1, min(CUBE_TILE_WORKERS, len(tile_ids)))
    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        futures = [pool.submit(read_tile, npix) for npix in tile_ids]
        for done, future in enumerate(as_completed(futures), 1):
            npix, values, ok, prov = future.result()
            results[npix] = (values, ok, prov)
            if on_progress:
                on_progress(done, len(tile_ids))
    finally:
        # On failure, drop the reads that have not started: the cutout fails anyway.
        pool.shutdown(wait=True, cancel_futures=True)

    provenance = []
    for npix in tile_ids:  # apply in tile order, whatever order reads finished in
        values, ok, prov = results[npix]
        if not values:
            continue
        idx = np.flatnonzero(tiles == npix)[ok]
        image.flat[idx] = values["IMAGE"][ok]
        flags.flat[idx] = values["FLAGS"][ok]
        nhits.flat[idx] = values["NHITS"][ok]
        provenance.append(prov)

    detector = channel // 17 + 1
    corners_ra, corners_dec = wcs.pixel_to_world_values(
        [0, shape[1], shape[1], 0], [0, 0, shape[0], shape[0]]
    )
    header = dict(wcs.to_header())
    uri = cube_cutout_uri(ra, dec, size_arcmin, channel)
    metadata: dict[str, Any] = {
        "wcs_header": header,
        "spatial_header": header,
        "detector": detector,
        "channel": channel,
        "obs_id": CUBE_OBS_ID,
        "date_mjd": _date_mjd(center.date_end),
        "date_iso": _iso(center.date_end),
        "date_beg": center.date_beg,
        "date_end": center.date_end,
        "source": CUBE_SOURCE,
        "version": CUBE_VERSION,
        "shape": [int(shape[0]), int(shape[1])],
        "pixel_scale_arcsec": round(scale, 2),
        "footprint": {
            "center": [ra, dec],
            "corners": [[float(a), float(b)] for a, b in zip(corners_ra, corners_dec)],
        },
        "units": {"image": center.unit, "variance": ""},
        "flag_bits": [],
        "calibrated": False,
        "wavelength_status": CUBE_WAVELENGTH_STATUS,
        "temporal": False,
        "has_variance": False,
        "blank_channel": not bool(np.isfinite(image).any()),
        "channel_wavelength_um": info["wavelength_um"],
        "channel_bandwidth_um": info["bandwidth_um"],
        "provenance": provenance,
        "uri": uri,
        "original_product_uri": center.url,
        "notice": no_temporal_notice(center.date_beg, center.date_end),
    }
    return CubeCutout(
        detector=detector,
        epoch=0,
        obs_id=CUBE_OBS_ID,
        date_iso=metadata["date_iso"],
        source=CUBE_SOURCE,
        uri=uri,
        image=image,
        variance=np.full(shape, np.nan, dtype=np.float32),
        flags=flags,
        wavelength=np.full(shape, info["wavelength_um"], dtype=np.float32),
        bandwidth=np.full(shape, info["bandwidth_um"], dtype=np.float32),
        metadata=metadata,
        nhits=nhits,
    )


def _guard(action):
    """Map transport and malformed-tile failures onto CubeUpstreamError."""
    try:
        return action()
    except CubeUpstreamError:
        raise
    except SpectrumNotFoundError as exc:
        raise CubeUpstreamError(f"No All-Sky Cube tile on S3: {exc}") from None
    except httpx.HTTPError as exc:
        raise CubeUpstreamError(f"S3 cube request failed: {exc}") from None
    except (ValueError, KeyError, TypeError, IndexError, TileChangedError) as exc:
        logger.warning("Unreadable S3 cube tile: %r", exc)
        raise CubeUpstreamError(
            f"Unreadable S3 cube tile: {type(exc).__name__}: {exc}"
        ) from None


def build_cube_cutout(
    ra_deg: float,
    dec_deg: float,
    size_arcmin: float,
    channel: int,
    *,
    client: httpx.Client | None = None,
    on_progress: ProgressCallback | None = None,
    use_cache: bool = True,
) -> CubeCutout:
    """Resample one channel of the cube onto a north-up TAN grid of the region.

    ``on_progress(done, total)`` is called as tiles finish. A cutout already in
    the derived cache (same region, channel and cube version) is reused
    without any network access.
    """
    ra = ra_deg % 360.0
    if use_cache:
        cached = load_derived_cutout(
            cube_cutout_uri(ra, dec_deg, size_arcmin, channel), channel // 17 + 1
        )
        if isinstance(cached, CubeCutout) and cached.metadata.get("provenance"):
            if on_progress:
                on_progress(1, 1)
            return cached
    with _session(client) as session:
        return _guard(
            lambda: _build(session, ra, dec_deg, size_arcmin, channel, on_progress)
        )


def discover_cube(
    ra_deg: float,
    dec_deg: float,
    size_arcmin: float,
    *,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    """Confirm the centre tile is readable on S3 and describe the fallback product.

    Reads only tile headers (cached afterwards). Returns one product per
    detector so the job can map each requested channel onto it.
    """
    ra = ra_deg % 360.0

    def run(session: httpx.Client) -> dict[str, Any]:
        center = _layout(session, tile_for(ra, dec_deg))
        _, world_ra, world_dec = _target_grid(
            ra, dec_deg, size_arcmin, _pixel_scale_arcsec(center)
        )
        tiles = sorted(int(t) for t in np.unique(_tiles_for(world_ra, world_dec)))
        notice = no_temporal_notice(center.date_beg, center.date_end)
        products = [
            {
                "id": f"cube:{CUBE_VERSION}:{center.npix}:D{det}",
                "uri": f"cube:{CUBE_VERSION}:{center.npix}:D{det}",
                "source": CUBE_SOURCE,
                "detector": det,
                "date_mjd": _date_mjd(center.date_end),
                "date_iso": _iso(center.date_end),
                "date_beg": center.date_beg,
                "date_end": center.date_end,
                "obs_id": CUBE_OBS_ID,
                "tiles": tiles,
                "temporal": False,
            }
            for det in DETECTORS
        ]
        return {
            "products": products,
            "tiles": tiles,
            "date_beg": center.date_beg,
            "date_end": center.date_end,
            "notice": notice,
        }

    with _session(client) as session:
        return _guard(lambda: run(session))
