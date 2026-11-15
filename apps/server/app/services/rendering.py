"""Rendering module: 8-bit grayscale and RGBA slice PNG generation with Pillow."""

from __future__ import annotations

import io

import numpy as np
from PIL import Image


def compute_cutout_percentiles(
    data: np.ndarray,
    is_variance: bool = False,
) -> tuple[float, float]:
    """Compute robust [1, 99] percentiles over finite pixels of a cutout."""
    if is_variance:
        finite = data[(data > 0) & np.isfinite(data)]
    else:
        finite = data[np.isfinite(data)]

    if finite.size == 0:
        return 0.0, 1.0

    lo, hi = float(np.percentile(finite, 1)), float(np.percentile(finite, 99))
    if hi <= lo:
        hi = lo + 1e-5
    return lo, hi


def apply_stretch(
    data: np.ndarray,
    lo: float,
    hi: float,
    stretch: str = "asinh",
) -> np.ndarray:
    """Normalize and stretch data array into 8-bit uint8 grayscale values."""
    norm = np.clip((data - lo) / max(hi - lo, 1e-10), 0.0, 1.0)
    norm = np.nan_to_num(norm, nan=0.0)

    if stretch == "asinh":
        # Astronomical asinh stretch with softening parameter a=0.1
        scaled = np.arcsinh(norm / 0.1) / np.arcsinh(1.0 / 0.1)
    else:
        scaled = norm

    return (np.clip(scaled, 0.0, 1.0) * 255.0).astype(np.uint8)


def render_image_full(
    data: np.ndarray,
    lo: float,
    hi: float,
    stretch: str = "asinh",
) -> bytes:
    """Render 8-bit grayscale PNG for an entire cutout array."""
    gray = apply_stretch(data, lo, hi, stretch)
    img = Image.fromarray(gray, "L")
    bio = io.BytesIO()
    img.save(bio, "PNG")
    return bio.getvalue()


def render_image_slice(
    data: np.ndarray,
    wavelength: np.ndarray,
    channel_wavelength: float,
    half_window: float,
    lo: float,
    hi: float,
    stretch: str = "asinh",
) -> bytes:
    """Render RGBA PNG where channel window is opaque and context is dim."""
    gray = apply_stretch(data, lo, hi, stretch)
    in_window = np.abs(wavelength - channel_wavelength) <= half_window

    h, w = data.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[..., 0] = gray
    rgba[..., 1] = gray
    rgba[..., 2] = gray
    rgba[..., 3] = np.where(in_window, 235, 45)
    rgba[..., 3] = np.where(np.isfinite(data), rgba[..., 3], 0)

    img = Image.fromarray(rgba, "RGBA")
    bio = io.BytesIO()
    img.save(bio, "PNG")
    return bio.getvalue()


def render_flags(
    flags: np.ndarray,
    wavelength: np.ndarray,
    channel_wavelength: float,
    half_window: float,
    bit: int | None = None,
    mode: str = "full",
) -> bytes:
    """Render flags array: specific bitmask or bit-count grayscale/RGBA."""
    h, w = flags.shape
    in_window = np.abs(wavelength - channel_wavelength) <= half_window

    if bit is not None:
        mask = (flags & (1 << bit)) != 0
        if mode == "full":
            gray = np.where(mask, 255, 0).astype(np.uint8)
            img = Image.fromarray(gray, "L")
        else:
            rgba = np.zeros((h, w, 4), dtype=np.uint8)
            rgba[..., :3] = np.where(mask[..., None], 255, 60)
            rgba[..., 3] = np.where(mask, 255, np.where(in_window, 235, 45))
            img = Image.fromarray(rgba, "RGBA")
    else:
        counts = np.bitwise_count(flags)
        max_c = int(np.max(counts)) if counts.size > 0 else 0
        if max_c > 0:
            gray = (counts / max_c * 255.0).astype(np.uint8)
        else:
            gray = np.zeros_like(counts, dtype=np.uint8)

        if mode == "full":
            img = Image.fromarray(gray, "L")
        else:
            rgba = np.zeros((h, w, 4), dtype=np.uint8)
            rgba[..., 0] = gray
            rgba[..., 1] = gray
            rgba[..., 2] = gray
            rgba[..., 3] = np.where(in_window, 235, 45)
            img = Image.fromarray(rgba, "RGBA")

    bio = io.BytesIO()
    img.save(bio, "PNG")
    return bio.getvalue()


def render_frame_product(
    product: str,
    arrays: dict[str, np.ndarray],
    channel_wavelength: float,
    half_window: float,
    percentiles: tuple[float, float],
    mode: str = "full",
    stretch: str = "asinh",
    bit: int | None = None,
) -> bytes:
    """Render a frame PNG matching product, mode, stretch, and bit parameters."""
    wavelength = arrays["wavelength"]
    lo, hi = percentiles

    if product in ("image", "variance"):
        data = arrays[product]
        if mode == "slice":
            return render_image_slice(
                data=data,
                wavelength=wavelength,
                channel_wavelength=channel_wavelength,
                half_window=half_window,
                lo=lo,
                hi=hi,
                stretch=stretch,
            )
        return render_image_full(data, lo, hi, stretch)

    if product == "flags":
        return render_flags(
            flags=arrays["flags"],
            wavelength=wavelength,
            channel_wavelength=channel_wavelength,
            half_window=half_window,
            bit=bit,
            mode=mode,
        )

    raise ValueError(f"Unknown product for PNG rendering: {product}")
