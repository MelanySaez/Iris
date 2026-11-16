"""Offline tests for DR1 All-Sky Cube fallback cutouts read from S3 tiles."""

from __future__ import annotations

import io

import httpx
import numpy as np
import pytest
from astropy.io import fits

import app.services.cube_fallback as fallback
import app.services.cube_spectrum as cube

RA, DEC = 148.888, 69.065
WIDTH, DEPTH = 64, 102
SCALE_DEG = 0.0036  # synthetic tile pixel scale (~13 arcsec, like the real cube)


def build_tile(blank_channel: int | None = 50) -> bytes:
    """Synthetic tile with the published HDU layout and a TAN WCS centred on RA/DEC.

    IMAGE plane ``k`` holds ``1000 * k + row`` so a test can tell which plane
    and which detector row every output pixel was sampled from.
    """
    primary = fits.PrimaryHDU()
    primary.header["DATE-BEG"] = "2025-08-11T15:49:07.467"
    primary.header["DATE-END"] = "2026-05-04T12:55:15.136"
    rows = np.arange(WIDTH, dtype=np.float32)[None, :, None]
    planes = np.arange(DEPTH, dtype=np.float32)[:, None, None]
    image = np.broadcast_to(1000.0 * planes + rows, (DEPTH, WIDTH, WIDTH)).copy()
    if blank_channel is not None:
        image[blank_channel] = np.nan
    nhits = np.full((DEPTH, WIDTH, WIDTH), 9, dtype=np.int32)
    flags = np.zeros((DEPTH, WIDTH, WIDTH), dtype=np.int32)
    flags[3, WIDTH // 2, WIDTH // 2] = 1 << 4

    def hdu(data: np.ndarray, name: str, unit: str) -> fits.ImageHDU:
        out = fits.ImageHDU(data=data, name=name)
        h = out.header
        h["CTYPE1"], h["CTYPE2"] = "RA---TAN", "DEC--TAN"
        h["CRPIX1"], h["CRPIX2"] = WIDTH / 2 + 0.5, WIDTH / 2 + 0.5
        h["CRVAL1"], h["CRVAL2"] = RA, DEC
        h["CDELT1"], h["CDELT2"] = -SCALE_DEG, SCALE_DEG
        h["CTYPE3"], h["CUNIT3"] = "WAVE-TAB", "um"
        h["BUNIT"] = unit
        return out

    idx = np.arange(DEPTH)
    channels = fits.BinTableHDU.from_columns(
        [
            fits.Column("DETECTOR", "I", array=idx // 17 + 1),
            fits.Column("SUBCHAN", "I", array=idx % 17 + 1),
            fits.Column("WAVELENGTH", "E", array=0.75 + idx * 0.042),
            fits.Column("WL_MIN", "E", array=0.74 + idx * 0.042),
            fits.Column("WL_MAX", "E", array=0.76 + idx * 0.042),
            fits.Column("BANDWIDTH", "E", array=np.full(DEPTH, 0.02)),
        ],
        name="SPECTRAL_CHANNELS",
    )
    buf = io.BytesIO()
    fits.HDUList(
        [
            primary,
            hdu(image, "IMAGE", "MJy/sr"),
            hdu(nhits, "NHITS", "count"),
            hdu(flags, "FLAGS", ""),
            channels,
        ]
    ).writeto(buf)
    return buf.getvalue()


class S3Tiles:
    """Single-range S3-like transport; records every requested URL and range."""

    def __init__(self, blob: bytes):
        self.blob = blob
        self.ranges: list[tuple[str, int, int]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        a, b = (
            int(v) for v in request.headers["range"].removeprefix("bytes=").split("-")
        )
        self.ranges.append((str(request.url), a, b))
        total = len(self.blob)
        b = min(b, total - 1)
        return httpx.Response(
            206,
            content=self.blob[a : b + 1],
            headers={"content-range": f"bytes {a}-{b}/{total}"},
        )


@pytest.fixture
def tiles(tmp_path, monkeypatch):
    import app.services.fits as fits_service

    monkeypatch.setattr(cube, "CUBE_CACHE_DIR", tmp_path)
    derived = tmp_path / "derived"
    derived.mkdir()
    monkeypatch.setattr(fits_service, "DERIVED_CACHE_DIR", derived)
    server = S3Tiles(build_tile())
    client = httpx.Client(transport=httpx.MockTransport(server))
    # Every position maps to the one synthetic tile.
    monkeypatch.setattr(fallback, "_tiles_for", lambda ra, dec: np.full(ra.shape, 1901))
    yield server, client
    client.close()


def test_reads_only_requested_channel_rows_from_s3(tiles):
    server, client = tiles
    cutout = fallback.build_cube_cutout(RA, DEC, 4.0, 20, client=client)

    layout = cube.get_layout(client, 1901, "s3")
    plane = WIDTH * WIDTH * 4
    data_ranges = [
        r
        for r in server.ranges
        if any(off <= r[1] < off + DEPTH * plane for off in layout.data_offsets.values())
    ]
    assert all(url.startswith(cube.CUBE_S3_BASE_URL) for url, _, _ in server.ranges)
    assert "/Npix1901_cube.fits" in server.ranges[0][0]
    # One range per needed HDU (IMAGE, FLAGS, NHITS), each inside channel 20's plane.
    assert len(data_ranges) == 3
    for name in ("IMAGE", "FLAGS", "NHITS"):
        start = layout.data_offsets[name] + 20 * plane
        assert any(start <= a and b < start + plane for _, a, b in data_ranges)
    assert sum(b - a + 1 for _, a, b in data_ranges) < 3 * plane

    finite = cutout.image[np.isfinite(cutout.image)]
    assert finite.size == cutout.image.size
    assert np.all((finite >= 20000) & (finite < 20000 + WIDTH))
    assert cutout.image.shape[0] == cutout.image.shape[1] >= 18
    assert np.all(cutout.nhits == 9)


def test_cube_cutout_is_labelled_non_temporal_and_uncalibrated(tiles):
    _, client = tiles
    cutout = fallback.build_cube_cutout(RA, DEC, 4.0, 20, client=client)

    assert cutout.source == "cube"
    assert cutout.detector == 2
    assert np.all(np.isnan(cutout.variance))
    assert np.all(cutout.wavelength == pytest.approx(0.75 + 20 * 0.042))
    assert np.all(cutout.bandwidth == pytest.approx(0.02))
    meta = cutout.metadata
    assert meta["channel"] == 20
    assert meta["temporal"] is False
    assert meta["has_variance"] is False
    assert meta["calibrated"] is False
    assert meta["wavelength_status"] == "cube_channel_nominal"
    assert meta["date_beg"].startswith("2025-08-11")
    assert meta["date_end"].startswith("2026-05-04")
    assert meta["provenance"][0]["tile"] == 1901


def test_each_channel_reads_its_own_plane(tiles):
    _, client = tiles
    low = fallback.build_cube_cutout(RA, DEC, 2.0, 3, client=client)
    high = fallback.build_cube_cutout(RA, DEC, 2.0, 70, client=client)

    assert np.nanmin(low.image) >= 3000 and np.nanmax(low.image) < 4000
    assert np.nanmin(high.image) >= 70000 and np.nanmax(high.image) < 71000
    assert low.uri != high.uri
    assert low.flags.max() == 1 << 4  # flag set at the tile centre on plane 3
    assert high.flags.max() == 0


def test_blank_channel_is_reported(tiles):
    _, client = tiles
    cutout = fallback.build_cube_cutout(RA, DEC, 2.0, 50, client=client)
    assert np.all(np.isnan(cutout.image))
    assert cutout.metadata["blank_channel"] is True


def test_republished_tile_is_rediscovered_once(tiles, monkeypatch):
    server, client = tiles
    fallback.build_cube_cutout(RA, DEC, 2.0, 5, client=client)
    server.blob = (
        build_tile(blank_channel=None) + b"\0" * 2880
    )  # new size → stale offsets
    cutout = fallback.build_cube_cutout(RA, DEC, 2.0, 50, client=client)
    assert np.all(np.isfinite(cutout.image))


def test_large_region_spans_several_tiles(tiles, monkeypatch):
    server, client = tiles
    # Left half of the sky grid in tile 1901, right half in tile 1902.
    monkeypatch.setattr(
        fallback, "_tiles_for", lambda ra, dec: np.where(ra > RA, 1901, 1902)
    )
    cutout = fallback.build_cube_cutout(RA, DEC, 6.0, 10, client=client)
    urls = {url for url, _, _ in server.ranges}
    assert any("Npix1901_cube" in u for u in urls)
    assert any("Npix1902_cube" in u for u in urls)
    assert [p["tile"] for p in cutout.metadata["provenance"]] == [1901, 1902]
    assert np.all(np.isfinite(cutout.image))


def test_discovery_describes_one_product_per_detector(tiles):
    _, client = tiles
    found = fallback.discover_cube(RA, DEC, 4.0, client=client)
    assert [p["detector"] for p in found["products"]] == [1, 2, 3, 4, 5, 6]
    assert {p["source"] for p in found["products"]} == {"cube"}
    assert found["tiles"] == [1901]
    notice = found["notice"]
    assert "no temporal information" in notice
    assert "2025-08-11" in notice and "2026-05-04" in notice


def test_unreachable_s3_is_a_cube_upstream_error(tmp_path, monkeypatch):
    monkeypatch.setattr(cube, "CUBE_CACHE_DIR", tmp_path)

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline", request=request)

    with (
        httpx.Client(transport=httpx.MockTransport(down)) as client,
        pytest.raises(fallback.CubeUpstreamError),
    ):
        fallback.discover_cube(RA, DEC, 4.0, client=client)


# --- Discovery, job and API integration (T2) ---------------------------------

import time  # noqa: E402
from unittest.mock import patch  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.services import discovery  # noqa: E402
from app.services.fits import load_derived_cutout, save_derived_cutout  # noqa: E402

NOTICE = fallback.no_temporal_notice("2025-08-11T15:49:07", "2026-05-04T12:55:15")


def cube_discovery(products: list[dict] | None = None) -> dict:
    return {
        "products": products
        if products is not None
        else [
            {
                "id": f"cube:D{d}",
                "uri": f"cube:D{d}",
                "source": "cube",
                "detector": d,
                "date_mjd": 61164.5,
                "date_iso": "2026-05-04T12:55:15Z",
                "obs_id": fallback.CUBE_OBS_ID,
            }
            for d in fallback.DETECTORS
        ],
        "tiles": [1901],
        "notice": NOTICE,
    }


def synthetic_cube_cutout(ra, dec, size, channel, offset: float = 0.0):
    shape = (12, 12)
    image = (np.arange(144, dtype=np.float32).reshape(shape) / 143.0) + offset
    meta = {
        "channel": channel,
        "source": "cube",
        "calibrated": False,
        "temporal": False,
        "has_variance": False,
        "wavelength_status": "cube_channel_nominal",
        "provenance": [{"provider": fallback.CUBE_PROVIDER, "tile": 1901}],
        "version": "hips_20261026",
        "pixel_scale_arcsec": 12.88,
        "units": {"image": "MJy/sr", "variance": ""},
        "channel_wavelength_um": 1.195,
        "channel_bandwidth_um": 0.028,
        "flag_bits": [],
        "wcs_header": {},
        "uri": f"cube:test:{ra}:{channel}",
    }
    return fallback.CubeCutout(
        detector=channel // 17 + 1,
        epoch=0,
        obs_id=fallback.CUBE_OBS_ID,
        date_iso="2026-05-04T12:55:15Z",
        source="cube",
        uri=meta["uri"],
        image=image,
        variance=np.full(shape, np.nan, np.float32),
        flags=np.zeros(shape, np.int32),
        wavelength=np.full(shape, 1.195, np.float32),
        bandwidth=np.full(shape, 0.028, np.float32),
        metadata=meta,
        nhits=np.full(shape, 9, np.int32),
    )


def _wait(client: TestClient, payload: dict) -> dict:
    resp = client.post("/api/jobs", json=payload)
    assert resp.status_code == 202
    job_id = resp.json()["id"]
    for _ in range(1000):
        snap = client.get(f"/api/jobs/{job_id}").json()
        if snap["status"] in ("ready", "failed"):
            return snap
        time.sleep(0.01)
    raise TimeoutError(job_id)


def test_tap_outage_without_index_uses_the_cube(monkeypatch, tmp_path):
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
    monkeypatch.setattr(discovery, "discover_cube", lambda *a, **kw: cube_discovery())

    result = discovery.resolve_region(1, 1, 4, force_refresh=True)

    assert result["coverage"] == "available"
    assert result["coverage_state"] == "cube_fallback"
    assert result["coverage_complete"] is False
    assert result["temporal_available"] is False
    assert "no temporal information" in result["fallback_notice"]
    last = result["provider_trace"][-1]
    assert (last["provider"], last["outcome"], last["temporal_available"]) == (
        fallback.CUBE_PROVIDER,
        "succeeded",
        False,
    )
    assert not list(tmp_path.iterdir())  # a fallback result is never cached


def test_indexed_l2_products_are_preferred_over_the_cube(monkeypatch, tmp_path):
    monkeypatch.setattr(discovery, "DISCOVERY_CACHE_DIR", tmp_path)
    monkeypatch.setattr(
        discovery, "query_irsa_tap", lambda *a, **kw: ([], "IRSA TAP returned HTTP 502")
    )
    l2 = {
        "id": "s3:x",
        "uri": "s3-cutout:x",
        "source": "s3",
        "detector": 2,
        "date_mjd": 60789.7,
        "date_iso": "2025-04-24T18:01:05Z",
    }
    monkeypatch.setattr(
        discovery,
        "query_index",
        lambda *a, **kw: {
            "products": [l2],
            "coverage_state": "indexed_matches",
            "coverage_complete": False,
        },
    )
    called = []
    monkeypatch.setattr(
        discovery, "discover_cube", lambda *a, **kw: called.append(1) or cube_discovery()
    )
    result = discovery.resolve_region(1, 1, 4, force_refresh=True)
    assert called == []
    assert result["coverage_state"] == "indexed_matches"
    assert result["temporal_available"] is True
    assert result["fallback_notice"] is None


def test_cube_unavailable_keeps_coverage_unknown(monkeypatch, tmp_path):
    monkeypatch.setattr(discovery, "DISCOVERY_CACHE_DIR", tmp_path)
    monkeypatch.setattr(
        discovery, "query_irsa_tap", lambda *a, **kw: ([], "ReadTimeout: timeout")
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
    result = discovery.resolve_region(1, 1, 4, force_refresh=True)  # conftest: S3 off
    assert result["coverage"] == "unknown"
    last = result["provider_trace"][-1]
    assert (last["provider"], last["outcome"]) == (fallback.CUBE_PROVIDER, "unavailable")


def test_cube_job_is_ready_without_epochs_or_variance():
    payload = {
        "ra_deg": 41.125,
        "dec_deg": 12.5,
        "size_arcmin": 4.0,
        "channels": [20, 21],
        "products": ["image", "variance", "flags"],
    }
    offsets = {20: 0.0, 21: 100.0}
    client = TestClient(app)
    with (
        patch(
            "app.services.jobs.resolve_region",
            return_value={
                "coverage": "available",
                "coverage_state": "cube_fallback",
                "coverage_complete": False,
                "temporal_available": False,
                "fallback_notice": NOTICE,
                **cube_discovery(),
            },
        ),
        patch(
            "app.services.jobs.build_cube_cutout",
            side_effect=lambda ra, dec, size, ch: synthetic_cube_cutout(
                ra, dec, size, ch, offsets[ch]
            ),
        ),
    ):
        snap = _wait(client, payload)

    assert snap["status"] == "ready", snap.get("error")
    assert {f["source"] for f in snap["frames"]} == {"cube"}
    assert {f["product"] for f in snap["frames"]} == {"image", "flags"}
    assert {f["epoch"] for f in snap["frames"]} == {0}
    assert snap["calibrated"] is False
    assert snap["wavelength_status"] == "cube_channel_nominal"
    assert snap["discovery"]["temporal_available"] is False
    assert "no temporal information" in snap["animation_reason"]
    kinds = {e.get("event_type") for e in snap["events"]}
    assert {"cube_fallback", "cube_no_variance"} <= kinds
    cube_event = next(e for e in snap["events"] if e.get("event_type") == "cube_fallback")
    assert cube_event["temporal_available"] is False
    assert [c["channel"] for c in snap["cutouts"]] == [20, 21]

    job_id = snap["id"]
    # Same pattern at different brightness: per-channel stretch renders the same PNG.
    png20 = client.get(f"/api/jobs/{job_id}/frames/20/image.png")
    png21 = client.get(f"/api/jobs/{job_id}/frames/21/image.png")
    assert png20.status_code == png21.status_code == 200
    assert png20.content == png21.content
    params = {"x": 1, "y": 1, "channel": 21}
    probe = client.get(f"/api/jobs/{job_id}/pixel", params=params)
    assert probe.status_code == 200
    body = probe.json()
    assert body["variance"] is None
    assert body["image"] == pytest.approx(100.0 + 13 / 143.0)
    assert body["wavelength_status"] == "cube_channel_nominal"
    nhits = client.get(f"/api/jobs/{job_id}/frames/21/nhits.npy")
    assert nhits.status_code == 200
    assert np.load(io.BytesIO(nhits.content)).max() == 9


def test_unreadable_cube_fails_the_job_as_cube_unavailable():
    payload = {
        "ra_deg": 43.125,
        "dec_deg": 12.5,
        "size_arcmin": 4.0,
        "channels": [20],
        "products": ["image"],
    }
    client = TestClient(app)
    with (
        patch(
            "app.services.jobs.resolve_region",
            return_value={
                "coverage": "available",
                "coverage_state": "cube_fallback",
                "fallback_notice": NOTICE,
                **cube_discovery(),
            },
        ),
        patch(
            "app.services.jobs.build_cube_cutout",
            side_effect=fallback.CubeUpstreamError("S3 cube request failed: boom"),
        ),
    ):
        snap = _wait(client, payload)
    assert snap["status"] == "failed"
    assert snap["error_kind"] == "cube_unavailable"
    assert snap["failed_stage"] == "downloading"


def test_cube_cutout_round_trips_through_the_derived_cache():
    cutout = synthetic_cube_cutout(44.0, 1.0, 4.0, 30)
    cutout.uri = cutout.metadata["uri"] = f"cube:roundtrip:{time.time_ns()}"
    save_derived_cutout(cutout)
    loaded = load_derived_cutout(cutout.uri, cutout.detector)
    assert isinstance(loaded, fallback.CubeCutout)
    assert loaded.source == "cube"
    assert np.array_equal(loaded.nhits, cutout.nhits)
    assert np.all(np.isnan(loaded.variance))


def test_selection_records_skip_synthetic_cube_products():
    from app.services.selections import SelectionRecorder

    class Store:
        calls = []

        def record_discovery(self, req, discovery):
            self.calls.append(discovery)

    store = Store()
    recorder = SelectionRecorder(store)
    recorder.on_discovered(
        type("J", (), {"request": None})(),
        {"coverage_state": "cube_fallback", "products": []},
    )
    recorder.on_discovered(
        type("J", (), {"request": None})(), {"coverage_state": "complete", "products": []}
    )
    assert [d["coverage_state"] for d in store.calls] == ["complete"]


# --- Progress, deadlines and reuse (T5/T6) ------------------------------------


def _outage(monkeypatch, tmp_path, tap_calls: list | None = None):
    """TAP down (HTTP 502), empty L2 index, working cube."""
    monkeypatch.setattr(discovery, "DISCOVERY_CACHE_DIR", tmp_path)

    def tap(*args, **kwargs):
        if tap_calls is not None:
            tap_calls.append(1)
        return [], "IRSA TAP returned HTTP 502"

    monkeypatch.setattr(discovery, "query_irsa_tap", tap)
    monkeypatch.setattr(
        discovery,
        "query_index",
        lambda *a, **kw: {
            "products": [],
            "coverage_state": "unknown_not_indexed",
            "coverage_complete": False,
        },
    )
    monkeypatch.setattr(discovery, "discover_cube", lambda *a, **kw: cube_discovery())


def test_a_region_served_by_the_cube_reuses_it_without_retrying_tap(
    monkeypatch, tmp_path
):
    tap_calls: list = []
    _outage(monkeypatch, tmp_path, tap_calls)
    first = discovery.resolve_region(5, 5, 4)
    events: list = []
    second = discovery.resolve_region(5, 5, 4, on_attempt=events.append)

    assert tap_calls == [1]
    assert first["coverage_state"] == second["coverage_state"] == "cube_fallback"
    assert second["reused"] is True
    assert second["fallback_notice"] == first["fallback_notice"]
    assert [e["event_type"] for e in events] == ["provider_reuse"]
    assert "reusing the S3 DR1 All-Sky Cube result" in events[0]["detail"]
    assert events[0]["temporal_available"] is False


def test_reuse_is_bounded_and_skipped_on_explicit_refresh(monkeypatch, tmp_path):
    tap_calls: list = []
    _outage(monkeypatch, tmp_path, tap_calls)
    discovery.resolve_region(6, 5, 4)
    discovery.resolve_region(6, 5, 4, force_refresh=True)
    assert len(tap_calls) == 2
    monkeypatch.setattr(discovery, "FALLBACK_REUSE_SECONDS", -1)
    discovery.resolve_region(6, 5, 4)
    assert len(tap_calls) == 3


def test_successful_tap_results_are_not_remembered_as_fallbacks(monkeypatch, tmp_path):
    monkeypatch.setattr(discovery, "DISCOVERY_CACHE_DIR", tmp_path)
    product = {
        "id": "p",
        "uri": "u",
        "source": "remote",
        "detector": 1,
        "date_mjd": 1.0,
        "date_iso": "2025-01-01T00:00:00Z",
    }
    calls: list = []
    monkeypatch.setattr(
        discovery, "query_irsa_tap", lambda *a, **kw: calls.append(1) or ([product], None)
    )
    discovery.resolve_region(7, 5, 4, force_refresh=True)
    discovery.resolve_region(7, 5, 4, force_refresh=True)
    assert len(calls) == 2


def test_tap_attempt_announces_and_enforces_its_deadline(monkeypatch):
    monkeypatch.setattr(discovery, "TAP_ATTEMPT_DEADLINE_SECONDS", 0.0)
    monkeypatch.setattr(discovery.time, "sleep", lambda s: None)
    events: list = []
    products, error = discovery.query_irsa_tap(1, 1, 4, on_attempt=events.append)

    assert products == []
    assert error.startswith("DeadlineExceeded")
    started = [e for e in events if e["outcome"] == "started"]
    assert [e["deadline_seconds"] for e in started] == [0.0, 0.0]
    failed = [e for e in events if e["outcome"] == "failed"]
    assert failed[-1]["will_retry"] is False


def test_deadline_exceeded_counts_as_an_outage(monkeypatch, tmp_path):
    _outage(monkeypatch, tmp_path)
    monkeypatch.setattr(
        discovery,
        "query_irsa_tap",
        lambda *a, **kw: ([], "DeadlineExceeded: attempt took longer than 45 s"),
    )
    result = discovery.resolve_region(8, 5, 4)
    assert result["coverage_state"] == "cube_fallback"


def test_job_activity_tracks_the_running_attempt_and_retry_wait():
    from app.schemas.jobs import JobRequest
    from app.services.jobs import JobState, job_manager

    job = JobState(
        id=f"activity-{time.time_ns()}",
        request=JobRequest(ra_deg=1, dec_deg=1, size_arcmin=4, channels=[20]),
        status="discovering",
    )
    base = {
        "event_type": "discovery_attempt",
        "provider": "IRSA TAP",
        "attempt": 1,
        "max_attempts": 2,
    }
    job_manager._record_discovery_attempt(
        job, {**base, "outcome": "started", "deadline_seconds": 45.0}
    )
    activity = job.to_snapshot()["activity"]
    assert activity["kind"] == "discovery_attempt"
    assert (activity["attempt"], activity["max_attempts"]) == (1, 2)
    assert activity["budget_seconds"] == 45.0
    assert activity["elapsed_seconds"] >= 0

    job_manager._record_discovery_attempt(
        job, {**base, "outcome": "failed", "will_retry": True, "retry_after_seconds": 0.5}
    )
    assert job.to_snapshot()["activity"]["kind"] == "retry_wait"

    job_manager._record_discovery_attempt(
        job,
        {
            "event_type": "provider_fallback",
            "provider": fallback.CUBE_PROVIDER,
            "outcome": "started",
        },
    )
    assert job.stage == "S3 DR1 All-Sky Cube fallback · checking"
    assert job.to_snapshot()["activity"]["kind"] == "fallback"

    job_manager._record_discovery_attempt(
        job,
        {
            "event_type": "provider_fallback",
            "provider": fallback.CUBE_PROVIDER,
            "outcome": "succeeded",
            "result_count": 6,
        },
    )
    assert job.stage == "S3 DR1 All-Sky Cube fallback · 6 products found"
    assert job.to_snapshot()["activity"] is None


def test_tile_progress_is_reported_and_tiles_are_read_in_parallel(tiles, monkeypatch):
    server, client = tiles
    monkeypatch.setattr(
        fallback, "_tiles_for", lambda ra, dec: np.where(ra > RA, 1901, 1902)
    )
    calls: list = []
    cutout = fallback.build_cube_cutout(
        RA, DEC, 6.0, 10, client=client, on_progress=lambda d, t: calls.append((d, t))
    )
    assert calls[0] == (0, 2)
    assert calls[-1] == (2, 2)
    assert [p["tile"] for p in cutout.metadata["provenance"]] == [1901, 1902]


def test_built_cube_cutouts_are_reused_without_network(tiles):
    server, client = tiles
    built = fallback.build_cube_cutout(RA, DEC, 4.0, 20, client=client)
    save_derived_cutout(built)
    before = len(server.ranges)
    calls: list = []
    again = fallback.build_cube_cutout(
        RA, DEC, 4.0, 20, client=client, on_progress=lambda d, t: calls.append((d, t))
    )
    assert len(server.ranges) == before
    assert np.array_equal(again.image, built.image)
    assert calls == [(1, 1)]


IRSA_USAGE_FAULT = b"""<?xml version="1.0" encoding="utf-8"?>
<VOTABLE version="1.3" xmlns="http://www.ivoa.net/xml/VOTable/v1.3">
  <RESOURCE type="results">
    <INFO name="QUERY_STATUS" value="ERROR">UsageFault: BAD_REQUEST: \
Invalid or unsupported ADQL query string.</INFO>
  </RESOURCE>
</VOTABLE>"""


def test_tap_error_status_reports_the_irsa_message():
    with pytest.raises(discovery.TapServiceError, match="UsageFault: BAD_REQUEST"):
        discovery.parse_tap_votable(IRSA_USAGE_FAULT, 1, 1, 4)


def test_tap_answering_200_without_a_table_falls_back(monkeypatch, tmp_path):
    """Observed 2026-11-15: IRSA answered HTTP 200 + QUERY_STATUS=ERROR."""
    real_tap = discovery.query_irsa_tap
    _outage(monkeypatch, tmp_path)
    monkeypatch.setattr(discovery.time, "sleep", lambda s: None)

    class Client:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def post(self, url, data, **kwargs):
            return httpx.Response(
                200, content=IRSA_USAGE_FAULT, request=httpx.Request("POST", url)
            )

    monkeypatch.setattr(discovery.httpx, "Client", Client)
    monkeypatch.setattr(discovery, "query_irsa_tap", real_tap)
    events: list = []
    result = discovery.resolve_region(9, 5, 4, on_attempt=events.append)

    failed = [e for e in events if e.get("outcome") == "failed"]
    assert "UsageFault: BAD_REQUEST" in failed[-1]["detail"]
    assert result["coverage_state"] == "cube_fallback"
