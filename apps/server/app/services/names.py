"""Resolve object names and catalogue codes (M31, NGC 224, HD 48915...) to positions.

Resolution order:

1. Coordinate-based designations (``J023650.95+094746.2``, ``2MASS J05551028-0724254``)
   are parsed locally: the designation *is* the position, so no network is needed.
2. Disk cache of earlier answers (shared by every user of this server).
3. SIMBAD (through the Harvard CfA mirror; the CDS primary has been unavailable)
   and NED (NASA/IPAC, extragalactic objects only), asked at the same time.
   SIMBAD's answer is the main result; NED's is listed in ``alternatives`` when
   it knows the name too, so the user can choose either.

A name is reported as unknown (404) only when SIMBAD itself answered "not found";
if SIMBAD could not be reached, a NED miss is not definitive and the result is 503.
Provider failures are never cached, so a recovery is picked up immediately.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import httpx

from app.core.config import (
    NAME_CACHE_DIR,
    NAME_CACHE_TTL_SECONDS,
    NAME_NOT_FOUND_TTL_SECONDS,
    NAME_RESOLVER_TIMEOUT,
    NED_LOOKUP_URL,
    SIMBAD_SCRIPT_URL,
)
from app.exceptions.domain import (
    NameInvalidError,
    NameNotFoundError,
    NameResolverUnavailableError,
)

logger = logging.getLogger(__name__)

MAX_NAME_LENGTH = 100
# Letters (any script), digits, spaces and the punctuation catalogue names use.
# Newlines and quotes are excluded: the name is embedded in a SIMBAD script line.
_ALLOWED = re.compile(r"^[\w .+\-*'()/:\[\]]+$", re.UNICODE)
# SIMBAD reports an unknown identifier with one of these messages; any other
# ::error is a server-side problem and must not be remembered as "unknown".
_SIMBAD_NOT_FOUND = re.compile(r"no known catalog|not found", re.IGNORECASE)
# Keys every cached hit must have; older entries without them are refreshed.
_CURRENT_RESULT_KEYS = {"size_arcmin", "alternatives"}
_DESIGNATION = re.compile(
    r"^(?:[A-Za-z0-9]+\s+)?J"
    r"(\d{2})(\d{2})(\d{2})\.?(\d*)"
    r"([+-])(\d{2})(\d{2})(\d{2})\.?(\d*)$"
)


class ResolverUnavailable(Exception):
    """A provider could not be reached or answered with an error."""


class NoCoordinates(Exception):
    """SIMBAD knows the object (args[0] is its main id) but has no position for it."""


def normalize_name(raw: str) -> str:
    """Trim and collapse whitespace; reject anything unsafe or empty (422)."""
    name = " ".join(raw.split())
    if not name or len(raw) > MAX_NAME_LENGTH or "\n" in raw or "\r" in raw:
        raise NameInvalidError("Enter an object name or catalogue code.")
    if not _ALLOWED.match(name):
        raise NameInvalidError(
            "Object names may only use letters, digits, spaces "
            "and + - . * ' ( ) / : [ ]."
        )
    return name


def parse_designation(name: str) -> tuple[float, float] | None:
    """Position encoded in a J2000 designation such as ``J023650.95+094746.2``."""
    m = _DESIGNATION.match(name)
    if not m:
        return None
    hh, mm, ss, ss_frac, sign, dd, dm, ds, ds_frac = m.groups()
    ra_seconds = float(f"{ss}.{ss_frac or 0}")
    dec_seconds = float(f"{ds}.{ds_frac or 0}")
    ra_deg = (int(hh) + int(mm) / 60 + ra_seconds / 3600) * 15
    dec_deg = int(dd) + int(dm) / 60 + dec_seconds / 3600
    valid_parts = int(mm) < 60 and int(dm) < 60 and ra_seconds < 60 and dec_seconds < 60
    if not (valid_parts and 0 <= ra_deg < 360 and dec_deg <= 90):
        return None  # not a real position: let SIMBAD judge the name
    return ra_deg, -dec_deg if sign == "-" else dec_deg


def _cache_path(name: str):
    digest = hashlib.sha1(name.lower().encode("utf-8")).hexdigest()
    return NAME_CACHE_DIR / f"{digest}.json"


def _read_cache(name: str) -> dict[str, Any] | None:
    path = _cache_path(name)
    try:
        entry = json.loads(path.read_text("utf-8"))
        ttl = NAME_CACHE_TTL_SECONDS if entry.get("found") else NAME_NOT_FOUND_TTL_SECONDS
        if time.time() - float(entry["stored_at"]) > ttl:
            return None
        return entry
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _write_cache(name: str, entry: dict[str, Any]) -> None:
    path = _cache_path(name)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(f".{time.time_ns()}.tmp")
        tmp.write_text(json.dumps({**entry, "stored_at": time.time()}), "utf-8")
        tmp.replace(path)
    except OSError:
        logger.warning("Could not cache name resolution for %r", name, exc_info=True)


def _query_simbad(client: httpx.Client, name: str) -> dict[str, Any] | None:
    """SIMBAD answer for ``name``: a hit, or None when SIMBAD says it is unknown."""
    script = (
        "output console=off script=off\n"
        'format object "%MAIN_ID|%COO(d;A D;ICRS)|%OTYPE(S)|%DIM(X;Y;A)"\n'
        f"query id {name}"
    )
    try:
        resp = client.post(SIMBAD_SCRIPT_URL, data={"script": script})
    except httpx.HTTPError as exc:
        raise ResolverUnavailable(f"SIMBAD: {exc}") from None
    if resp.status_code != 200:
        raise ResolverUnavailable(f"SIMBAD answered HTTP {resp.status_code}")
    lines = [line.strip() for line in resp.text.splitlines() if line.strip()]
    if not lines:
        # An empty 200 is a degraded mirror, not SIMBAD saying "unknown".
        raise ResolverUnavailable("SIMBAD answered an empty body")
    if lines[0].startswith("::error"):
        if _SIMBAD_NOT_FOUND.search(" ".join(lines[1:])):
            return None
        raise ResolverUnavailable(
            f"SIMBAD reported an error: {' '.join(lines[1:])[:200]}"
        )
    fields = lines[0].split("|")
    if len(fields) not in (3, 4):
        raise ResolverUnavailable(f"SIMBAD answered an unexpected line: {lines[0]!r}")
    main_id, coords, otype = fields[:3]
    dims = fields[3] if len(fields) == 4 else ""
    if not coords.strip():
        raise NoCoordinates(" ".join(main_id.split()))
    try:
        ra_text, dec_text = coords.split()
        ra, dec = float(ra_text), float(dec_text)
    except ValueError:
        raise ResolverUnavailable(
            f"SIMBAD answered an unexpected line: {lines[0]!r}"
        ) from None
    return {
        "name": " ".join(main_id.split()),
        "ra_deg": ra,
        "dec_deg": dec,
        "object_type": otype.strip() or None,
        "size_arcmin": _major_axis(dims),
    }


def _query_ned(client: httpx.Client, name: str) -> dict[str, Any] | None:
    """NED answer for ``name``: a hit, or None when NED does not know it."""
    try:
        resp = client.post(
            NED_LOOKUP_URL, data={"json": json.dumps({"name": {"v": name}})}
        )
        payload = resp.json() if resp.status_code == 200 else None
    except (httpx.HTTPError, ValueError) as exc:
        raise ResolverUnavailable(f"NED: {exc}") from None
    if payload is None:
        raise ResolverUnavailable(f"NED answered HTTP {resp.status_code}")
    try:
        preferred = payload.get("Preferred") or {}
        position = preferred.get("Position") or {}
        if "RA" not in position or "Dec" not in position:
            return None
        return {
            "name": " ".join(str(preferred.get("Name", name)).split()),
            "ra_deg": float(position["RA"]),
            "dec_deg": float(position["Dec"]),
            "object_type": (preferred.get("ObjType") or {}).get("Value") or None,
            "size_arcmin": None,
        }
    except (AttributeError, TypeError, ValueError):
        raise ResolverUnavailable("NED answered an unexpected payload") from None


def _major_axis(dims: str) -> float | None:
    """Major axis in arcmin from SIMBAD %DIM ("199.53;70.79;35"); None for points."""
    major = dims.split(";")[0].strip() if dims else ""
    try:
        value = float(major)
    except ValueError:
        return None  # "~" means SIMBAD has no size (point source)
    return value if value > 0 else None


def _ask(query, client: httpx.Client, name: str) -> tuple[str, Any]:
    """One provider's outcome: ("hit", result), ("miss", None),
    ("no_coordinates", main_id) or ("down", error)."""
    try:
        hit = query(client, name)
    except NoCoordinates as known:
        return "no_coordinates", known.args[0]
    except ResolverUnavailable as exc:
        return "down", exc
    return ("hit", hit) if hit is not None else ("miss", None)


def _make_client() -> httpx.Client:
    return httpx.Client(timeout=NAME_RESOLVER_TIMEOUT, follow_redirects=True)


def resolve_name(raw: str) -> dict[str, Any]:
    """Position of an object name or catalogue code; raises 404 / 422 / 503."""
    name = normalize_name(raw)

    designation = parse_designation(name)
    if designation is not None:
        ra, dec = designation
        return {
            "query": name,
            "name": name,
            "ra_deg": ra,
            "dec_deg": dec,
            "object_type": None,
            "size_arcmin": None,
            "source": "designation",
            "alternatives": [],
            "cached": False,
        }

    cached = _read_cache(name)
    # Hits cached before sizes or alternatives were recorded: ask again so the
    # answer has the current shape instead of reusing an old one for 30 days.
    if (
        cached is not None
        and cached.get("found")
        and not cached["result"].keys() >= _CURRENT_RESULT_KEYS
    ):
        cached = None
    if cached is not None:
        if not cached.get("found"):
            raise NameNotFoundError(_not_found(name))
        return {**cached["result"], "query": name, "cached": True}

    # Both catalogues are asked at once; SIMBAD's answer is preferred and NED's
    # is offered as an alternative when it knows the name too.
    with _make_client() as client, ThreadPoolExecutor(max_workers=2) as pool:
        pending = [
            (source, pool.submit(_ask, query, client, name))
            for source, query in (("simbad", _query_simbad), ("ned", _query_ned))
        ]
        outcomes = {source: future.result() for source, future in pending}

    hits: list[dict[str, Any]] = []
    failures: list[str] = []
    for source, (kind, value) in outcomes.items():
        if kind == "hit":
            hits.append({**value, "source": source})
        elif kind == "down":
            logger.warning("Name resolver %s unavailable for %r: %s", source, name, value)
            failures.append(source)

    if hits:
        result = {**hits[0], "alternatives": hits[1:]}
        # Cache only complete answers: if a catalogue was down, the next request
        # asks again so its alternative can still appear.
        if not failures:
            _write_cache(name, {"found": True, "result": result})
        return {**result, "query": name, "cached": False}

    simbad_kind, simbad_value = outcomes["simbad"]
    if simbad_kind == "no_coordinates":
        raise NameNotFoundError(
            f"SIMBAD knows '{name}' as '{simbad_value}' "
            "but has no coordinates for it."
        )
    simbad_answered = simbad_kind != "down"
    if simbad_answered:
        # Remember the miss only when every provider answered; if NED was down,
        # a NED-only name could exist, so the next request should ask again.
        if not failures:
            _write_cache(name, {"found": False})
        raise NameNotFoundError(_not_found(name))
    raise NameResolverUnavailableError(
        "Name resolvers are unavailable "
        f"({', '.join(failures) or 'SIMBAD'}); try again later or use coordinates."
    )


def _not_found(name: str) -> str:
    return f"No object named '{name}' was found in SIMBAD or NED."
