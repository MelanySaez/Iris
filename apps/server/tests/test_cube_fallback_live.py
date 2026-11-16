"""Opt-in live check of the DR1 All-Sky Cube fallback against the real S3 tiles.

Run from apps/server:  RUN_SPHEREX_CUBE_LIVE=1 uv run --no-sync pytest \
    tests/test_cube_fallback_live.py -q -s

IRSA TAP is simulated as down (HTTP 502) and the S3 L2 index as empty, so the
job must be served by the cube. Reads only the needed rows of a few channels.
"""

from __future__ import annotations

import io
import os
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app
from app.services import discovery
from app.services.cube_fallback import discover_cube

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_SPHEREX_CUBE_LIVE") != "1",
    reason="set RUN_SPHEREX_CUBE_LIVE=1 to read real DR1 cube tiles from S3",
)

RA, DEC = 267.52431, -5.44656  # verified tile Npix7416


@pytest.mark.parametrize("size_arcmin", [4.0, 180.0])
def test_tap_outage_job_is_served_by_the_real_cube(monkeypatch, tmp_path, size_arcmin):
    monkeypatch.setattr(discovery, "DISCOVERY_CACHE_DIR", tmp_path)
    monkeypatch.setattr(
        discovery, "query_irsa_tap", lambda *a, **kw: ([], "IRSA TAP returned HTTP 502")
    )
    monkeypatch.setattr(
        discovery,
        "query_index",
        lambda *a, **kw: {
            "products": [],
            "coverage_state": "unknown_not_indexed",
            "coverage_complete": False,
        },
    )
    monkeypatch.setattr(discovery, "discover_cube", discover_cube)  # undo conftest

    client = TestClient(app)
    payload = {
        "ra_deg": RA,
        "dec_deg": DEC,
        "size_arcmin": size_arcmin,
        "channels": [20, 88],
        "products": ["image", "flags"],
        "mode": "history",
    }
    started = time.time()
    job_id = client.post("/api/jobs", json=payload).json()["id"]
    snap = {}
    while time.time() - started < 300:
        snap = client.get(f"/api/jobs/{job_id}").json()
        if snap["status"] in ("ready", "failed"):
            break
        time.sleep(0.2)
    elapsed = time.time() - started

    assert snap["status"] == "ready", snap.get("error")
    assert snap["discovery"]["coverage_state"] == "cube_fallback"
    assert snap["discovery"]["temporal_available"] is False
    assert "no temporal information" in snap["animation_reason"]
    assert {f["source"] for f in snap["frames"]} == {"cube"}
    transferred = sum(p["bytes"] for c in snap["cutouts"] for p in c["provenance"])
    tiles = sorted({p["tile"] for c in snap["cutouts"] for p in c["provenance"]})
    for channel in (20, 88):
        png = client.get(f"/api/jobs/{job_id}/frames/{channel}/image.png")
        assert png.status_code == 200
        pixels = np.asarray(Image.open(io.BytesIO(png.content)))
        assert pixels.std() > 0  # real sky structure, not a blank frame
    shape = snap["cutouts"][0]["shape"]
    print(
        f"\n{size_arcmin} arcmin: {shape} px, tiles {tiles}, "
        f"{transferred / 1e6:.2f} MB of rows for 2 channels, {elapsed:.1f} s"
    )
