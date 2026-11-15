"""Discovery module: local footprint coverage, IRSA TAP sync queries, and JSON cache."""

from __future__ import annotations

import hashlib
import io
import json
import logging
import math
import re
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urljoin

import httpx
from astropy.table import Table
from astropy.time import Time

from app.core.config import (
    DISCOVERY_CACHE_DIR,
    DISCOVERY_TTL_SECONDS,
    MAX_REGION_SIZE_ARCMIN,
    MIN_REGION_SIZE_ARCMIN,
    TAP_QUERY_RETRIES,
    TAP_QUERY_TIMEOUT,
    TAP_SYNC_URL,
)
from app.exceptions.domain import RegionRequestError
from app.services.cube_fallback import (
    CUBE_COVERAGE_STATE,
    CUBE_PROVIDER,
    CubeUpstreamError,
    discover_cube,
)
from app.services.spherex_provider import query_index

logger = logging.getLogger(__name__)
TAP_PAGE_SIZE = 400
TAP_MAX_PAGES = 10

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


def discovery_cache_key(ra_deg: float, dec_deg: float, size_arcmin: float) -> str:
    """Generate deterministic SHA-1 cache key for discovery results."""
    token = f"area-v2:{ra_deg:.5f}:{dec_deg:.5f}:{size_arcmin:.3f}"
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
                "original_product_uri": urljoin(
                    "https://irsa.ipac.caltech.edu/", str(row["source_uri"])
                )
                if "source_uri" in table.colnames
                else uri.split("?")[0],
                "artifact_uri": str(row["source_uri"])
                if "source_uri" in table.colnames
                else uri.split("?")[0],
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
    query_template = f"""
SELECT TOP {TAP_PAGE_SIZE}
    {uri_template},
    p.time_bounds_lower,
    p.energy_bandpassname,
    p.planeid,
    a.uri AS source_uri
FROM spherex.artifact a
JOIN spherex.plane p ON a.planeid = p.planeid
WHERE 1 = INTERSECTS(BOX('ICRS', {ra_deg:.6f}, {dec_deg:.6f},
    {size_deg:.6f}, {size_deg:.6f}), p.poly)
{{cursor}}
ORDER BY a.uri
"""
    query = query_template.format(cursor="")
    data = {
        "REQUEST": "doQuery",
        "LANG": "ADQL",
        "FORMAT": "votable",
        "QUERY": query,
    }

    last_err: str | None = None
    max_attempts = TAP_QUERY_RETRIES + 1
    for attempt in range(1, max_attempts + 1):
        data["QUERY"] = query
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
                    products = []
                    seen = set()
                    complete = False
                    for page in range(TAP_MAX_PAGES):
                        if page:
                            resp = client.post(TAP_SYNC_URL, data=data)
                            resp.raise_for_status()
                        batch = parse_tap_votable(
                            resp.content, ra_deg, dec_deg, size_arcmin
                        )
                        fresh = [p for p in batch if p["id"] not in seen]
                        products.extend(fresh)
                        seen.update(p["id"] for p in fresh)
                        overflow = b"OVERFLOW" in resp.content
                        if len(batch) < TAP_PAGE_SIZE and not overflow:
                            complete = True
                            break
                        if not fresh:
                            break
                        cursor = batch[-1]["artifact_uri"].replace("'", "''")
                        data["QUERY"] = query_template.format(
                            cursor=f"AND a.uri > '{cursor}'"
                        )
                    products.sort(key=lambda p: (p["date_mjd"], p["id"]))
                    _notify_discovery_attempt(
                        on_attempt,
                        {
                            **attempt_info,
                            "outcome": "succeeded",
                            "will_retry": False,
                            "result_count": len(products),
                            "coverage_complete": complete,
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


def _try_cube_fallback(
    ra_deg: float,
    dec_deg: float,
    size_arcmin: float,
    observe: Callable[[dict[str, Any]], None],
) -> dict[str, Any] | None:
    """Last resort after IRSA TAP and the S3 L2 index: the DR1 All-Sky Cube.

    Returns the cube discovery (products and user notice), or None when the
    cube tiles cannot be read either. Both outcomes are recorded as events.
    """
    try:
        found = discover_cube(ra_deg, dec_deg, size_arcmin)
    except CubeUpstreamError as exc:
        observe(
            {
                "event_type": "provider_fallback",
                "provider": CUBE_PROVIDER,
                "fallback": True,
                "outcome": "unavailable",
                "coverage_state": "unknown_not_indexed",
                "coverage_complete": False,
                "temporal_available": False,
                "detail": str(exc),
                "result_count": 0,
            }
        )
        return None
    observe(
        {
            "event_type": "provider_fallback",
            "provider": CUBE_PROVIDER,
            "fallback": True,
            "outcome": "succeeded",
            "coverage_state": CUBE_COVERAGE_STATE,
            "coverage_complete": False,
            "temporal_available": False,
            "detail": found["notice"],
            "result_count": len(found["products"]),
            "tiles": found["tiles"],
        }
    )
    return found


def validate_region_size(size_arcmin: float) -> None:
    """Enforce the region-size contract shared by discovery and jobs."""
    if not math.isfinite(size_arcmin):
        raise RegionRequestError("Region size must be finite.")
    if size_arcmin > MAX_REGION_SIZE_ARCMIN:
        raise RegionRequestError(
            f"Region size {size_arcmin} arcmin exceeds limit of "
            f"{MAX_REGION_SIZE_ARCMIN} arcmin."
        )
    if size_arcmin < MIN_REGION_SIZE_ARCMIN:
        raise RegionRequestError(
            f"Region size {size_arcmin} arcmin must be at least "
            f"{MIN_REGION_SIZE_ARCMIN} arcmin."
        )


def resolve_region(
    ra_deg: float,
    dec_deg: float,
    size_arcmin: float = 6.0,
    force_refresh: bool = False,
    on_attempt: DiscoveryAttemptObserver | None = None,
) -> dict[str, Any]:
    """Discover available spectral image products from remote TAP."""
    validate_region_size(size_arcmin)
    if (
        not math.isfinite(ra_deg)
        or not math.isfinite(dec_deg)
        or not -90 <= dec_deg <= 90
    ):
        raise RegionRequestError(
            "Coordinates must be finite; declination must be in [-90, 90]."
        )
    ra_deg %= 360
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

    provider_trace: list[dict[str, Any]] = []
    fallback_notice: str | None = None

    def observe(event: dict[str, Any]) -> None:
        provider_trace.append(event)
        _notify_discovery_attempt(on_attempt, event)

    remote_products, warning = query_irsa_tap(
        ra_deg, dec_deg, size_arcmin, on_attempt=observe
    )
    products = remote_products
    complete = warning is None and all(
        e.get("coverage_complete", True)
        for e in provider_trace
        if e.get("outcome") == "succeeded"
    )
    coverage_state = "complete" if complete else "incomplete"
    # query_irsa_tap's public two-tuple contract is retained. Its bounded error
    # text is classified conservatively; parser/validation/4xx errors never fall back.
    unavailable = bool(
        warning
        and re.search(
            r"HTTP 5\d\d|(?:Read|Connect|Write|Pool)Timeout|"
            r"ConnectError|ReadError|RemoteProtocolError",
            warning,
        )
    )
    if unavailable:
        fallback = query_index(ra_deg, dec_deg, size_arcmin)
        products = fallback["products"]
        complete = bool(fallback.get("coverage_complete", False))
        coverage_state = fallback["coverage_state"]
        observe(
            {
                "event_type": "provider_fallback",
                "provider": "S3",
                "fallback": True,
                "outcome": "succeeded" if products else "unavailable",
                "coverage_state": coverage_state,
                "coverage_complete": complete,
                "detail": warning,
                "result_count": len(products),
            }
        )
        if not products:
            cube = _try_cube_fallback(ra_deg, dec_deg, size_arcmin, observe)
            if cube is not None:
                products = cube["products"]
                complete = False
                coverage_state = CUBE_COVERAGE_STATE
                fallback_notice = cube["notice"]

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
    elif warning is not None or not complete:
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
        "coverage_complete": complete,
        "coverage_state": coverage_state,
        "temporal_available": coverage_state != CUBE_COVERAGE_STATE,
        "fallback_notice": fallback_notice,
        "provider_trace": provider_trace,
        "products": products,
        "detectors": detectors,
        "notes": [
            "IRSA primary; S3 fallback is experimental and only "
            "positively indexed footprints are known."
        ],
    }

    # Save to disk cache. Only definitive outcomes are cached: a transient TAP
    # failure ("unknown") must not poison the region for the whole TTL.
    if coverage != "unknown" and complete:
        try:
            to_cache = dict(result)
            to_cache["cached_at"] = time.time()
            with open(cache_path, "w", encoding="utf-8") as f:
                json.dump(to_cache, f, indent=2)
        except Exception:
            pass

    return result
