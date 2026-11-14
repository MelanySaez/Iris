"""Tests for PNG rendering: full grayscale, channel slice RGBA, and flag masks."""

from __future__ import annotations

import io

import numpy as np
from PIL import Image

from app.render import (
    compute_cutout_percentiles,
    render_flags,
    render_frame_product,
    render_image_full,
    render_image_slice,
)

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def test_render_image_full():
    data = np.linspace(0.0, 10.0, 100).reshape((10, 10)).astype(np.float32)
    png_bytes = render_image_full(data, lo=1.0, hi=9.0, stretch="asinh")

    assert png_bytes.startswith(PNG_SIGNATURE)
    img = Image.open(io.BytesIO(png_bytes))
    assert img.mode == "L"
    assert img.size == (10, 10)


def test_render_image_slice_is_rgba():
    data = np.ones((20, 20), dtype=np.float32)
    wave = np.linspace(1.2, 1.4, 400).reshape((20, 20)).astype(np.float32)

    # Channel window around 1.3 um
    png_bytes = render_image_slice(
        data=data,
        wavelength=wave,
        channel_wavelength=1.3,
        half_window=0.03,
        lo=0.0,
        hi=2.0,
        stretch="asinh",
    )

    assert png_bytes.startswith(PNG_SIGNATURE)
    img = Image.open(io.BytesIO(png_bytes))
    assert img.mode == "RGBA"
    assert img.size == (20, 20)

    # Verify alpha values: 235 inside window, 45 outside
    rgba_arr = np.array(img)
    alpha = rgba_arr[..., 3]
    in_win = np.abs(wave - 1.3) <= 0.03

    assert np.all(alpha[in_win] == 235)
    assert np.all(alpha[~in_win] == 45)


def test_render_flags_bit_mask_differs_from_nobit():
    flags = np.zeros((15, 15), dtype=np.int32)
    flags[5, 5] = 1 << 21  # bit 21 set
    flags[7, 7] = (1 << 0) | (1 << 21)
    flags[2, 2] = 1 << 0

    wave = np.full((15, 15), 1.3, dtype=np.float32)

    # Render without bit (count of set bits)
    png_nobit = render_flags(
        flags=flags,
        wavelength=wave,
        channel_wavelength=1.3,
        half_window=0.05,
        bit=None,
        mode="full",
    )
    # Render with bit 21
    png_bit21 = render_flags(
        flags=flags,
        wavelength=wave,
        channel_wavelength=1.3,
        half_window=0.05,
        bit=21,
        mode="full",
    )

    assert png_nobit.startswith(PNG_SIGNATURE)
    assert png_bit21.startswith(PNG_SIGNATURE)
    assert png_nobit != png_bit21

    # In bit 21 mode, only pixels with bit 21 set should be 255
    arr_bit21 = np.array(Image.open(io.BytesIO(png_bit21)))
    assert arr_bit21[5, 5] == 255
    assert arr_bit21[7, 7] == 255
    assert arr_bit21[2, 2] == 0


def test_render_variance():
    var = np.array([[-1.0, 0.0], [0.01, 0.05]], dtype=np.float32)
    lo, hi = compute_cutout_percentiles(var, is_variance=True)
    assert lo > 0.0
    assert hi >= lo

    wave = np.full((2, 2), 1.3, dtype=np.float32)
    arrays = {
        "image": np.ones((2, 2), dtype=np.float32),
        "variance": var,
        "flags": np.zeros((2, 2), dtype=np.int32),
        "wavelength": wave,
        "bandwidth": np.full((2, 2), 0.02, dtype=np.float32),
    }

    png_bytes = render_frame_product(
        product="variance",
        arrays=arrays,
        channel_wavelength=1.3,
        half_window=0.05,
        percentiles=(lo, hi),
        mode="full",
    )
    assert png_bytes.startswith(PNG_SIGNATURE)
