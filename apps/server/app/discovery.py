"""Discovery module: local footprint coverage, IRSA TAP sync queries, and JSON cache."""

from __future__ import annotations

import hashlib
import io
import json
import logging
import math
import re
import time
from typing import Any, Callable

import httpx
import numpy as np
from astropy.io import fits
from astropy.table import Table
from astropy.time import Time
from astropy.wcs import WCS, NoConvergence

from app.config import (
    DISCOVERY_CACHE_DIR,
    DISCOVERY_TTL_SECONDS,
    LOCAL_FITS_PATH,
    TAP_QUERY_RETRIES,
    TAP_QUERY_TIMEOUT,
    TAP_SYNC_URL,
)

logger = logging.getLogger(__name__)
DiscoveryAttemptObserver = Callable[[dict[str, Any]], None]


def _notify_discovery_attempt(
    observer: DiscoveryAttemptObserver | None, event: dict[str, Any]
) -> None:
    """Report attempt progress without allowing observers to affect discovery."""
    if observer is None:
        return
    try:
        observer(event)
    except Exception:
        logger.exception("Discovery attempt observer failed")


def get_local_asset_metadata() -> dict[str, Any] | None:
    """Read key metadata from the configured local FITS without loading pixel arrays."""
    if not LOCAL_FITS_PATH.is_file():
        return None
    try:
        with fits.open(LOCAL_FITS_PATH, memmap=True) as hdul:
            img_hdr = hdul["IMAGE"].header
            obs_id = img_hdr.get("OBSID", "2025W18_1B_0001_1")
            mjd = float(img_hdr.get("MJD-OBS", 60793.541849016))
            date_obs = str(img_hdr.get("DATE-OBS", "2025-04-28T13:00:15.755"))
            date_iso = date_obs if date_obs.endswith("Z") else date_obs + "Z"
            detector = int(img_hdr.get("DETECTOR", 2))
            return {
                "obs_id": obs_id,
                "date_mjd": mjd,
                "date_iso": date_iso,
                "detector": detector,
                "band": f"SPHEREx-D{detector}",
                "filename": LOCAL_FITS_PATH.name,
            }
    except Exception:
        return None


def check_local_footprint(ra_deg: float, dec_deg: float, size_arcmin: float) -> bool:
    """Check if requested box lies fully inside local FITS footprint."""
    if not LOCAL_FITS_PATH.is_file():
        return False
    try:
        with fits.open(LOCAL_FITS_PATH, memmap=True) as hdul:
            img = hdul["IMAGE"]
            ny, nx = img.data.shape
            spatial = WCS(img.header).celestial

            half_deg = (size_arcmin / 60.0) / 2.0
            cos_dec = max(1e-6, math.cos(math.radians(dec_deg)))
            d_ra = half_deg / cos_dec
            d_dec = half_deg

            corners = [
                (ra_deg - d_ra, dec_deg - d_dec),
                (ra_deg - d_ra, dec_deg + d_dec),
                (ra_deg + d_ra, dec_deg - d_dec),
                (ra_deg + d_ra, dec_deg + d_dec),
            ]

            for c_ra, c_dec in corners:
                approx = spatial.wcs_world2pix([[c_ra, c_dec]], 0)[0]
                if not np.all(np.isfinite(approx)) or not (
                    -nx <= approx[0] <= 2 * nx and -ny <= approx[1] <= 2 * ny
                ):
                    return False
                try:
                    px, py = spatial.all_world2pix([[c_ra, c_dec]], 0)[0]
                except NoConvergence:
                    return False
                if not (np.isfinite(px) and np.isfinite(py)):
                    return False
                if not (0 <= px < nx and 0 <= py < ny):
                    return False
            return True
    except Exception:
        return False


def discovery_cache_key(ra_deg: float, dec_deg: float, size_arcmin: float) -> str:
    """Generate deterministic SHA-1 cache key for discovery results."""
    token = f"{ra_deg:.5f}:{dec_deg:.5f}:{size_arcmin:.3f}"
    return hashlib.sha1(token.encode("utf-8")).hexdigest()


def parse_tap_votable(
    xml_bytes: bytes,
    ra_deg: float,
    dec_deg: float,
    size_arcmin: float,
) -> list[dict[str, Any]]:
    """Parse TAP sync votable output into product descriptors."""
    table = Table.read(io.BytesIO(xml_bytes), format="votable", use_names_over_ids=True)
    products: list[dict[str, Any]] = []

    # Map column names
    col_uri = "uri" if "uri" in table.colnames else "col_0"
    col_mjd = "time_bounds_lower" if "time_bounds_lower" in table.colnames else "col_1"
    col_band = (
        "energy_bandpassname" if "energy_bandpassname" in table.colnames else "col_2"
    )
    col_plane = "planeid" if "planeid" in table.colnames else "col_3"

    for row in table:
        uri = str(row[col_uri])
        mjd = float(row[col_mjd])
        band_name = str(row[col_band])
        plane_id = str(row[col_plane])

        det_match = re.search(r"D(\d+)", band_name)
        detector = int(det_match.group(1)) if det_match else 2

        obs_match = re.search(r"level2_(.+?)D\d+_", uri)
        obs_id = obs_match.group(1) if obs_match else plane_id[:16]

        date_iso = Time(mjd, format="mjd").isot + "Z"
        product_id = f"remote:{hashlib.sha1(uri.encode()).hexdigest()[:16]}"

        products.append(
            {
                "id": product_id,
                "source": "remote",
                "detector": detector,
                "band": band_name,
                "obs_id": obs_id,
                "uri": uri,
                "date_mjd": round(mjd, 6),
                "date_iso": date_iso,
            }
        )

    return products


def query_irsa_tap(
    ra_deg: float,
    dec_deg: float,
    size_arcmin: float,
    on_attempt: DiscoveryAttemptObserver | None = None,
) -> tuple[list[dict[str, Any]], str | None]:
    """Execute TAP sync ADQL query, reporting each attempt. Never raises 500."""
    size_deg = size_arcmin / 60.0
    uri_template = (
        "'https://irsa.ipac.caltech.edu/' || a.uri || "
        f"'?center={ra_deg:.6f},{dec_deg:.6f}d&size={size_deg:.4f}' AS uri"
    )
    query = f"""
SELECT TOP 400
    {uri_template},
    p.time_bounds_lower,
    p.energy_bandpassname,
    p.planeid
FROM spherex.artifact a
JOIN spherex.plane p ON a.planeid = p.planeid
WHERE 1 = CONTAINS(POINT('ICRS', {ra_deg:.6f}, {dec_deg:.6f}), p.poly)
ORDER BY p.time_bounds_lower
"""
    data = {
        "REQUEST": "doQuery",
        "LANG": "ADQL",
        "FORMAT": "votable",
        "QUERY": query,
    }

    last_err: str | None = None
    max_attempts = TAP_QUERY_RETRIES + 1
    for attempt in range(1, max_attempts + 1):
        attempt_info = {
            "event_type": "discovery_attempt",
            "provider": "IRSA TAP",
            "attempt": attempt,
            "max_attempts": max_attempts,
        }
        _notify_discovery_attempt(on_attempt, {**attempt_info, "outcome": "started"})
        detail: str | None = None
        try:
            with httpx.Client(timeout=TAP_QUERY_TIMEOUT) as client:
                resp = client.post(TAP_SYNC_URL, data=data)
                if resp.status_code == 200:
                    products = parse_tap_votable(
                        resp.content, ra_deg, dec_deg, size_arcmin
                    )
                    _notify_discovery_attempt(
                        on_attempt,
                        {
                            **attempt_info,
                            "outcome": "succeeded",
                            "will_retry": False,
                            "result_count": len(products),
                        },
                    )
                    return products, None
                last_err = f"IRSA TAP returned HTTP {resp.status_code}: {resp.text[:200]}"
                detail = f"HTTP {resp.status_code}"
        except Exception as exc:
            last_err = f"{type(exc).__name__}: {exc}"
            detail = f"{type(exc).__name__}: {exc or 'Request failed'}"
        will_retry = attempt < max_attempts
        retry_after_seconds = min(8.0, 0.5 * 2 ** (attempt - 1)) if will_retry else None
        _notify_discovery_attempt(
            on_attempt,
            {
                **attempt_info,
                "outcome": "failed",
                "will_retry": will_retry,
                "retry_after_seconds": retry_after_seconds,
                "detail": (detail or last_err or "Unknown discovery error")[:240],
            },
        )
        if retry_after_seconds is not None:
            time.sleep(retry_after_seconds)

    return [], last_err


def resolve_region(
    ra_deg: float,
    dec_deg: float,
    size_arcmin: float = 6.0,
    force_refresh: bool = False,
    on_attempt: DiscoveryAttemptObserver | None = None,
) -> dict[str, Any]:
    """Discover available spectral image products from local asset and remote TAP."""
    start_time = time.time()
    cache_key = discovery_cache_key(ra_deg, dec_deg, size_arcmin)
    cache_path = DISCOVERY_CACHE_DIR / f"{cache_key}.json"

    # Check 6-hour disk cache
    if not force_refresh and cache_path.is_file():
        try:
            with open(cache_path, encoding="utf-8") as f:
                cached_doc = json.load(f)
            cached_at = cached_doc.get("cached_at", 0)
            if (start_time - cached_at) < DISCOVERY_TTL_SECONDS:
                result = dict(cached_doc)
                result["cached"] = True
                result["query_ms"] = int((time.time() - start_time) * 1000)
                result.pop("cached_at", None)
                return result
        except Exception:
            pass

    # Check local asset coverage
    local_covered = check_local_footprint(ra_deg, dec_deg, size_arcmin)
    local_meta = get_local_asset_metadata() if local_covered else None

    # Query remote TAP
    if on_attempt is None:
        remote_products, warning = query_irsa_tap(ra_deg, dec_deg, size_arcmin)
    else:
        remote_products, warning = query_irsa_tap(
            ra_deg, dec_deg, size_arcmin, on_attempt=on_attempt
        )

    products: list[dict[str, Any]] = []
    if local_covered and local_meta:
        local_uri = (
            f"local:{local_meta['filename']}?center={ra_deg:.6f},{dec_deg:.6f}d"
            f"&size={size_arcmin / 60.0:.4f}"
        )
        products.append(
            {
                "id": f"local:{local_meta['obs_id']}D2",
                "source": "local",
                "detector": 2,
                "band": "SPHEREx-D2",
                "obs_id": local_meta["obs_id"],
                "uri": local_uri,
                "date_mjd": local_meta["date_mjd"],
                "date_iso": local_meta["date_iso"],
            }
        )

    products.extend(remote_products)

    # Group into detectors summary
    det_map: dict[int, list[dict[str, Any]]] = {}
    for p in products:
        det = p["detector"]
        det_map.setdefault(det, []).append(p)

    detectors = []
    for det in sorted(det_map.keys()):
        prods = det_map[det]
        epochs = [
            {
                "date_mjd": p["date_mjd"],
                "date_iso": p["date_iso"],
                "product_id": p["id"],
            }
            for p in sorted(prods, key=lambda x: x["date_mjd"])
        ]
        detectors.append(
            {
                "detector": det,
                "band": f"SPHEREx-D{det}",
                "count": len(epochs),
                "epochs": epochs,
            }
        )

    if products:
        coverage = "available"
    elif warning is not None:
        coverage = "unknown"
    else:
        coverage = "none"

    query_ms = int((time.time() - start_time) * 1000)
    result = {
        "region": {
            "ra_deg": ra_deg,
            "dec_deg": dec_deg,
            "size_arcmin": size_arcmin,
            "fov_deg": round(size_arcmin / 60.0, 4),
        },
        "coverage": coverage,
        "cached": False,
        "query_ms": query_ms,
        "warning": warning,
        "products": products,
        "detectors": detectors,
        "notes": ["Discovery via IRSA TAP; individual detector products, not a mosaic."],
    }

    # Save to disk cache. Only definitive outcomes are cached: a transient TAP
    # failure ("unknown") must not poison the region for the whole TTL.
    if coverage != "unknown":
        try:
            to_cache = dict(result)
            to_cache["cached_at"] = time.time()
            with open(cache_path, "w", encoding="utf-8") as f:
                json.dump(to_cache, f, indent=2)
        except Exception:
            pass

    return result
