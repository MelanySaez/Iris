"""SPHEREx DR1 All-Sky Cube HiPS channel catalog with 7-day disk cache."""

from __future__ import annotations

import json
import time
from typing import Any

import httpx

from app.core.config import (
    HIPS_PROPERTIES_CACHE_PATH,
    HIPS_PROPERTIES_TTL_SECONDS,
    HIPS_PROPERTIES_URL,
)
from app.exceptions.domain import (
    ChannelCatalogUnavailableError,
    ChannelOutOfRangeError,
)


def parse_properties_text(text: str) -> dict[str, Any]:
    """Parse key HiPS properties from raw properties file text."""
    props: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        props[key.strip()] = value.strip()

    depth_val = props.get("hips_cube_depth", "102")
    order_val = props.get("hips_order", "5")
    tile_format = props.get("hips_tile_format", "png")

    raw_crval3 = props.get("data_cube_crval3_arr", "")
    wavelengths = [float(x) for x in raw_crval3.split() if x]

    if not wavelengths:
        raise ValueError("No data_cube_crval3_arr found in HiPS properties text")

    return {
        "hips_cube_depth": int(depth_val),
        "hips_order": int(order_val),
        "hips_tile_format": tile_format,
        "wavelengths": wavelengths,
        "raw_text": text,
    }


def build_channel_table(wavelengths: list[float]) -> list[dict[str, Any]]:
    """Build the 102-channel representation from the parsed wavelength array."""
    num_channels = len(wavelengths)
    channels: list[dict[str, Any]] = []

    for idx, wave in enumerate(wavelengths):
        band = (idx // 17) + 1
        detector = f"D{band}"
        available = idx not in (50, 51)

        # Local channel spacing: clamped at array edges
        if idx == 0:
            bw = wavelengths[1] - wavelengths[0]
        elif idx == num_channels - 1:
            bw = wavelengths[-1] - wavelengths[-2]
        else:
            bw = (wavelengths[idx + 1] - wavelengths[idx - 1]) / 2.0

        channels.append(
            {
                "index": idx,
                "band": band,
                "detector": detector,
                "wavelength_um": round(wave, 4),
                "bandwidth_um": round(bw, 4),
                "available": available,
            }
        )

    return channels


def get_channel_catalog(
    force_refresh: bool = False,
    override_text: str | None = None,
) -> dict[str, Any]:
    """Retrieve the authoritative channel catalog, using disk cache or network."""
    now = time.time()
    cached_data: dict[str, Any] | None = None

    if override_text is not None:
        parsed = parse_properties_text(override_text)
        channels = build_channel_table(parsed["wavelengths"])
        return {
            "source": {
                "collection": "SPHEREx DR1 All-Sky Cube",
                "properties_url": HIPS_PROPERTIES_URL,
                "depth": parsed["hips_cube_depth"],
                "order": parsed["hips_order"],
                "blank_channels": [50, 51],
            },
            "channels": channels,
            "cached": False,
        }

    if HIPS_PROPERTIES_CACHE_PATH.is_file():
        try:
            with open(HIPS_PROPERTIES_CACHE_PATH, encoding="utf-8") as f:
                cached_data = json.load(f)
        except Exception:
            cached_data = None

    cache_fresh = (
        cached_data is not None
        and not force_refresh
        and (now - cached_data.get("fetched_at", 0)) < HIPS_PROPERTIES_TTL_SECONDS
    )

    if cache_fresh and cached_data is not None:
        return {
            "source": cached_data["source"],
            "channels": cached_data["channels"],
            "cached": True,
        }

    # Attempt fetch from remote
    fetched_text: str | None = None
    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.get(HIPS_PROPERTIES_URL)
            if resp.status_code == 200:
                fetched_text = resp.text
    except Exception:
        fetched_text = None

    if fetched_text is not None:
        try:
            parsed = parse_properties_text(fetched_text)
            channels = build_channel_table(parsed["wavelengths"])
            payload = {
                "fetched_at": now,
                "source": {
                    "collection": "SPHEREx DR1 All-Sky Cube",
                    "properties_url": HIPS_PROPERTIES_URL,
                    "depth": parsed["hips_cube_depth"],
                    "order": parsed["hips_order"],
                    "blank_channels": [50, 51],
                },
                "channels": channels,
            }
            with open(HIPS_PROPERTIES_CACHE_PATH, "w", encoding="utf-8") as f:
                json.dump(payload, f, indent=2)

            return {
                "source": payload["source"],
                "channels": payload["channels"],
                "cached": False,
            }
        except Exception:
            pass

    # Stale cache fallback
    if cached_data is not None:
        return {
            "source": cached_data["source"],
            "channels": cached_data["channels"],
            "cached": True,
        }

    raise ChannelCatalogUnavailableError(
        "Channel properties unavailable; remote network unreachable "
        "and no local cache."
    )


def get_channel(index: int) -> dict[str, Any]:
    """Retrieve metadata for a single channel index."""
    catalog = get_channel_catalog()
    channels = catalog["channels"]
    if not (0 <= index < len(channels)):
        raise ChannelOutOfRangeError(
            f"Channel {index} is out of range (0..{len(channels) - 1})"
        )
    return channels[index]


def get_channel_window(index: int) -> tuple[float, float]:
    """Channel selection window: center ± half the local channel spacing.

    The slice rule is ``|lambda_pixel - lambda_channel| <= 0.5 * spacing``.
    ``bandwidth_um`` is already that local spacing, so the half window is half
    of it -- not the full value.
    """
    ch = get_channel(index)
    wave = ch["wavelength_um"]
    half = ch["bandwidth_um"] / 2.0
    return round(wave - half, 4), round(wave + half, 4)
