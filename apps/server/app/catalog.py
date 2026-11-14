"""Curated catalog objects and precomputed cache detection."""

from __future__ import annotations

import json
import math
from typing import Any

from app.config import JOBS_CACHE_DIR

CURATED_OBJECTS: list[dict[str, Any]] = [
    {
        "id": "local-dr1-sample",
        "name": "Local DR1 sample",
        "ra_deg": 270.693033,
        "dec_deg": 61.876516,
        "type": "SPHEREx field",
        "default_size_arcmin": 6.0,
        "description": "Covered by the local D2 FITS",
    },
    {
        "id": "m81-field",
        "name": "M81 field",
        "ra_deg": 210.80227,
        "dec_deg": 54.34895,
        "type": "Galaxy field",
        "default_size_arcmin": 6.0,
        "description": "Notebook TAP demo field",
    },
    {
        "id": "spherex-demo-field",
        "name": "SPHEREx demo field",
        "ra_deg": 304.693509,
        "dec_deg": 42.443687,
        "type": "SPHEREx field",
        "default_size_arcmin": 6.0,
        "description": "Notebook SIA demo field",
    },
    {
        "id": "wise-0855",
        "name": "WISE 0855−0714",
        "ra_deg": 133.7951,
        "dec_deg": -7.2451,
        "type": "Brown dwarf",
        "default_size_arcmin": 6.0,
        "description": "Coldest known brown dwarf",
    },
    {
        "id": "barnard",
        "name": "Barnard's Star",
        "ra_deg": 269.4521,
        "dec_deg": 4.6934,
        "type": "Red dwarf",
        "default_size_arcmin": 6.0,
        "description": "Highest known proper motion",
    },
    {
        "id": "epsilon-indi",
        "name": "Epsilon Indi Ba/Bb",
        "ra_deg": 330.8471,
        "dec_deg": -56.7892,
        "type": "Brown dwarf pair",
        "default_size_arcmin": 6.0,
        "description": "Nearby binary",
    },
    {
        "id": "rw-aur",
        "name": "RW Aurigae",
        "ra_deg": 77.8981,
        "dec_deg": 30.3974,
        "type": "Variable star",
        "default_size_arcmin": 6.0,
        "description": "Young T Tauri star",
    },
    {
        "id": "r-dra",
        "name": "R Draconis",
        "ra_deg": 248.1676,
        "dec_deg": 66.7550,
        "type": "Variable star",
        "default_size_arcmin": 6.0,
        "description": "Mira variable",
    },
]


def is_object_precomputed(obj: dict[str, Any]) -> bool:
    """Check if a ready job snapshot exists in the disk cache for this object."""
    if not JOBS_CACHE_DIR.is_dir():
        return False

    ra = obj["ra_deg"]
    dec = obj["dec_deg"]

    for snapshot_file in JOBS_CACHE_DIR.glob("*.json"):
        try:
            with open(snapshot_file, encoding="utf-8") as f:
                data = json.load(f)
            if data.get("status") != "ready":
                continue
            req = data.get("request", {})
            req_ra = req.get("ra_deg")
            req_dec = req.get("dec_deg")
            if (
                req_ra is not None
                and req_dec is not None
                and math.isclose(ra, req_ra, abs_tol=1e-4)
                and math.isclose(dec, req_dec, abs_tol=1e-4)
            ):
                return True
        except Exception:
            continue
    return False


def get_catalog() -> dict[str, list[dict[str, Any]]]:
    """Return all curated catalog objects with current precomputed status."""
    objects = []
    for item in CURATED_OBJECTS:
        obj = dict(item)
        obj["precomputed"] = is_object_precomputed(obj)
        objects.append(obj)
    return {"objects": objects}
