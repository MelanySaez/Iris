"""Tests for HiPS properties fetching, parsing, and channel catalog generation."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.channels import (
    build_channel_table,
    get_channel_catalog,
    get_channel_window,
    parse_properties_text,
)

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "hips-properties.txt"


@pytest.fixture
def properties_text() -> str:
    return FIXTURE_PATH.read_text(encoding="utf-8")


def test_parse_properties_text(properties_text: str):
    parsed = parse_properties_text(properties_text)
    assert parsed["hips_cube_depth"] == 102
    assert parsed["hips_order"] == 5
    assert parsed["hips_tile_format"] == "png"
    assert len(parsed["wavelengths"]) == 102


def test_channel_table_structure_and_bands(properties_text: str):
    parsed = parse_properties_text(properties_text)
    channels = build_channel_table(parsed["wavelengths"])

    assert len(channels) == 102

    # Check detector band mapping: (index // 17) + 1
    for ch in channels:
        idx = ch["index"]
        expected_band = (idx // 17) + 1
        assert ch["band"] == expected_band
        assert ch["detector"] == f"D{expected_band}"

        # Blank channels 50 and 51
        if idx in (50, 51):
            assert ch["available"] is False
        else:
            assert ch["available"] is True

        # All bandwidths must be positive
        assert ch["bandwidth_um"] > 0.0

    # First and last wavelengths
    assert channels[0]["wavelength_um"] == 0.753
    assert channels[0]["bandwidth_um"] == 0.018
    assert channels[-1]["wavelength_um"] == 4.988


def test_channel_window():
    win_min, win_max = get_channel_window(0)
    assert win_min < win_max
    assert win_min <= 0.753 <= win_max


def test_channel_window_is_half_the_local_spacing():
    """Slice rule: |lambda - center| <= 0.5 * local channel spacing."""
    from app.channels import get_channel

    for index in (0, 20, 44, 101):
        channel = get_channel(index)
        win_min, win_max = get_channel_window(index)
        half = channel["bandwidth_um"] / 2.0
        assert win_min == round(channel["wavelength_um"] - half, 4)
        assert win_max == round(channel["wavelength_um"] + half, 4)
        # The window must be narrower than the full spacing.
        assert (win_max - win_min) == pytest.approx(channel["bandwidth_um"], abs=1e-4)


def test_channel_stale_cache_and_503(tmp_path: Path, properties_text: str):
    cache_file = tmp_path / "hips-properties.json"

    # With missing cache and network failure, raises 503
    with (
        patch("app.channels.HIPS_PROPERTIES_CACHE_PATH", cache_file),
        patch("httpx.Client.get", side_effect=RuntimeError("Network down")),
    ):
        with pytest.raises(HTTPException) as exc_info:
            get_channel_catalog(force_refresh=True)
        assert exc_info.value.status_code == 503

    # With stale cache and network failure, returns stale cached data
    import json
    import time

    parsed = parse_properties_text(properties_text)
    channels = build_channel_table(parsed["wavelengths"])
    cache_file.write_text(
        json.dumps(
            {
                "fetched_at": time.time() - 1000000,  # Old timestamp
                "source": {
                    "collection": "SPHEREx DR1 All-Sky Cube",
                    "properties_url": "https://example.com/properties",
                    "depth": 102,
                    "order": 5,
                    "blank_channels": [50, 51],
                },
                "channels": channels,
            }
        ),
        encoding="utf-8",
    )

    with (
        patch("app.channels.HIPS_PROPERTIES_CACHE_PATH", cache_file),
        patch("httpx.Client.get", side_effect=RuntimeError("Network down")),
    ):
        cat = get_channel_catalog(force_refresh=True)
        assert cat["cached"] is True
        assert len(cat["channels"]) == 102
