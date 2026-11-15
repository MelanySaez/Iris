"""Read-only readbacks over a finished job: frames, pixels and manifest.

Every product endpoint resolves the same way: a ready job, a product the job
actually requested, and a derived cutout that is still cached. The helpers here
keep that order and its error contract in one place so the routers stay thin.
"""

from __future__ import annotations

import io
from typing import Any

import numpy as np

from app.core.config import (
    CALIBRATED,
    WAVELENGTH_STATUS,
)
from app.exceptions.domain import (
    CutoutUnavailableError,
    FrameOptionError,
    JobNotReadyError,
    PixelOutOfBoundsError,
    ProductNotRequestedError,
    UnknownProductError,
)
from app.services.channels import get_channel, get_channel_window
from app.services.jobs import JobState, job_manager, resolve_cutout
from app.services.rendering import compute_cutout_percentiles, render_frame_product

PNG_PRODUCTS = ("image", "variance", "flags")
NPY_PRODUCTS = (
    "image",
    "variance",
    "flags",
    "wavelengths",
    "bandwidths",
    "coverage",
    "nhits",
)


def _ready_job(job_id: str) -> JobState:
    """Load the job and refuse unless it finished successfully."""
    job = job_manager.get_job(job_id)
    if job.status != "ready":
        raise JobNotReadyError(job.error or f"Job {job_id} is in status '{job.status}'")
    return job


def render_frame_png(
    job_id: str,
    channel: int,
    product: str,
    mode: str = "full",
    epoch: int = 0,
    stretch: str | None = None,
    bit: int | None = None,
) -> bytes:
    """Render one frame product as PNG bytes."""
    job = _ready_job(job_id)

    if product not in PNG_PRODUCTS:
        raise UnknownProductError(
            f"Unknown product '{product}'. Must be one of {PNG_PRODUCTS}."
        )
    if product not in job.request.products:
        raise ProductNotRequestedError(
            f"Product '{product}' was not requested in job {job_id}."
        )
    if mode not in ("full", "slice"):
        raise FrameOptionError(f"mode must be 'full' or 'slice', got '{mode}'.")
    if stretch is not None and stretch not in ("asinh", "linear"):
        raise FrameOptionError(f"stretch must be 'asinh' or 'linear', got '{stretch}'.")

    ch_info = get_channel(channel)
    det = (channel // 17) + 1
    cutout = resolve_cutout(job, det, epoch, channel)
    if cutout is None:
        raise CutoutUnavailableError(
            f"No cutout available for channel {channel} "
            f"(detector {det}) epoch {epoch}; the derived cache entry may "
            "have been evicted. Re-run the job to rebuild it."
        )

    active_stretch = stretch or job.request.stretch
    target_prod = product if product in ("image", "variance") else "image"
    if cutout.metadata.get("calibrated"):
        percentile_key = (channel, -1, target_prod)
    elif cutout.metadata.get("source") == "cube":
        # Cube cutouts are per channel: a per-detector key would share one
        # stretch across every channel of the detector.
        percentile_key = ("cube", channel, target_prod)
    else:
        percentile_key = (det, epoch, target_prod)
    percentiles = job.percentiles.get(percentile_key)
    if percentiles is None:
        if cutout.metadata.get("calibrated"):
            from app.services.mosaics import shared_percentiles

            samples = []
            for metadata in job.cutouts:
                if metadata.get("channel") != channel:
                    continue
                other = resolve_cutout(job, det, metadata["epoch"], channel)
                if other is not None:
                    arr = getattr(other, target_prod).ravel()
                    samples.append(arr[:: max(1, int(np.ceil(arr.size / 100_000)))])
            percentiles = shared_percentiles(samples)
        else:
            arr = getattr(cutout, target_prod)
            percentiles = compute_cutout_percentiles(
                arr, is_variance=(product == "variance")
            )
        job.percentiles[percentile_key] = percentiles

    win_min, win_max = get_channel_window(channel)
    half_window = (win_max - win_min) / 2.0

    arrays = {
        "image": cutout.image,
        "variance": cutout.variance,
        "flags": cutout.flags,
        "wavelength": cutout.wavelength,
        "bandwidth": cutout.bandwidth,
    }

    return render_frame_product(
        product=product,
        arrays=arrays,
        channel_wavelength=ch_info["wavelength_um"],
        half_window=half_window,
        percentiles=percentiles,
        mode=mode,
        stretch=active_stretch,
        bit=bit,
    )


def get_frame_npy(job_id: str, channel: int, product: str, epoch: int = 0) -> bytes:
    """Serialise one raw frame array as `.npy` bytes."""
    job = _ready_job(job_id)

    if product not in NPY_PRODUCTS:
        raise UnknownProductError(
            f"Unknown product '{product}'. Must be one of {NPY_PRODUCTS}."
        )
    if product in PNG_PRODUCTS and product not in job.request.products:
        raise ProductNotRequestedError(
            f"Product '{product}' was not requested in job {job_id}."
        )

    det = (channel // 17) + 1
    cutout = resolve_cutout(job, det, epoch, channel)
    if cutout is None:
        raise CutoutUnavailableError(
            f"No cutout loaded for channel {channel} "
            f"(detector {det}) epoch {epoch}; the derived cache entry may "
            "have been evicted. Re-run the job to rebuild it."
        )

    if product == "image":
        arr = cutout.image
    elif product == "variance":
        arr = cutout.variance
    elif product == "flags":
        arr = cutout.flags
    elif product == "wavelengths":
        arr = cutout.wavelength
    elif product == "bandwidths":
        arr = cutout.bandwidth
    elif product in ("coverage", "nhits"):
        arr = getattr(cutout, product, None)
        if arr is None:
            raise CutoutUnavailableError(
                "Coverage is available only for calibrated mosaics"
            )
    else:  # pragma: no cover - guarded by NPY_PRODUCTS above
        raise UnknownProductError("Invalid product")

    bio = io.BytesIO()
    np.save(bio, arr, allow_pickle=False)
    return bio.getvalue()


def get_pixel_probe(
    job_id: str,
    x: int,
    y: int,
    channel: int,
    epoch: int = 0,
) -> dict[str, Any]:
    """Inspect single pixel: data, wavelength, and active flag bits."""
    job = _ready_job(job_id)

    det = (channel // 17) + 1
    cutout = resolve_cutout(job, det, epoch, channel)
    if cutout is None:
        raise CutoutUnavailableError(
            f"Cutout for channel {channel} (detector {det}) epoch {epoch} "
            "is not available in this job; the derived cache entry may have "
            "been evicted. Re-run the job to rebuild it."
        )

    h, w = cutout.image.shape
    if not (0 <= x < w and 0 <= y < h):
        raise PixelOutOfBoundsError(
            f"Pixel coordinates ({x}, {y}) outside cutout dimensions {w}x{h}"
        )

    win_min, win_max = get_channel_window(channel)
    wave_val = float(cutout.wavelength[y, x])
    bw_val = float(cutout.bandwidth[y, x])
    in_ch = win_min <= wave_val <= win_max

    img_val = float(cutout.image[y, x]) if np.isfinite(cutout.image[y, x]) else None
    var_val = float(cutout.variance[y, x]) if np.isfinite(cutout.variance[y, x]) else None
    raw_flags = int(cutout.flags[y, x])

    # Filter only bits that are actually set
    set_flag_bits = []
    for bit_def in cutout.metadata.get("flag_bits", []):
        b = bit_def["bit"]
        if (raw_flags & (1 << b)) != 0:
            set_flag_bits.append(
                {
                    "bit": b,
                    "name": bit_def["name"],
                    "description": bit_def["description"],
                }
            )

    return {
        "x": x,
        "y": y,
        "channel": channel,
        "epoch": epoch,
        "wavelength_um": round(wave_val, 4) if np.isfinite(wave_val) else None,
        "bandwidth_um": round(bw_val, 4) if np.isfinite(bw_val) else None,
        "window_um": [win_min, win_max],
        "in_channel": bool(in_ch),
        "image": img_val,
        "variance": var_val,
        "flags": raw_flags,
        "flag_bits": set_flag_bits,
        "wavelength_status": cutout.metadata.get("wavelength_status", WAVELENGTH_STATUS),
        "calibrated": bool(cutout.metadata.get("calibrated", CALIBRATED)),
    }


def get_job_manifest(job_id: str) -> dict[str, Any]:
    """Assemble complete provenance document for a ready job."""
    job = _ready_job(job_id)

    manifest_cutouts = []
    versions: list[str] = []
    dates: list[str] = []
    units: dict[str, str] = {}
    flag_definitions: dict[int, dict[str, Any]] = {}

    for c in job.cutouts:
        det = c["detector"]
        epoch = c["epoch"]
        cutout = resolve_cutout(job, det, epoch, c.get("channel"))
        uri = c.get("uri", "") or (cutout.uri if cutout else "")
        version = c.get("version", "") or (
            cutout.metadata.get("version", "") if cutout else ""
        )
        if version and version not in versions:
            versions.append(version)

        date_obs = (
            cutout.metadata.get("date_iso", c.get("date_iso", ""))
            if cutout
            else c.get("date_iso", "")
        )
        date_mjd = cutout.metadata.get("date_mjd", 0.0) if cutout else 0.0
        if date_obs and date_obs not in dates:
            dates.append(date_obs)

        for bit_def in c.get("flag_bits", []):
            flag_definitions.setdefault(bit_def["bit"], bit_def)

        if not units:
            units = {
                "image": c.get("image_unit", "MJy / sr"),
                "variance": c.get("variance_unit", "MJy2 / sr2"),
            }

        manifest_cutouts.append(
            {
                "detector": det,
                "channel": c.get("channel"),
                "calibrated": c.get("calibrated", False),
                "wavelength_status": c.get("wavelength_status", WAVELENGTH_STATUS),
                "epoch_id": c.get("epoch_id", ""),
                "provenance": c.get("provenance", []),
                "epoch": epoch,
                "obs_id": c.get("obs_id", ""),
                "source": c.get("source", "remote"),
                "uri": uri,
                "version": version,
                "date_obs": date_obs,
                "date_mjd": date_mjd,
                "units": {
                    "image": c.get("image_unit", "MJy / sr"),
                    "variance": c.get("variance_unit", "MJy2 / sr2"),
                },
                "flag_bits": c.get("flag_bits", []),
                "pixel_scale_arcsec": c.get("pixel_scale_arcsec", 6.13),
                "shape": c.get("shape", [0, 0]),
            }
        )

    release = "SPHEREx Level-2"
    if versions:
        release = f"SPHEREx Level-2 ({', '.join(sorted(versions))})"

    status = job.to_snapshot()
    return {
        "job_id": job.id,
        "request": job.request.model_dump(),
        "region": {
            "ra_deg": job.request.ra_deg,
            "dec_deg": job.request.dec_deg,
            "size_arcmin": job.request.size_arcmin,
            "fov_deg": round(job.request.size_arcmin / 60.0, 4),
        },
        "products": sorted(set(job.request.products)),
        "release": release,
        "dates": sorted(dates),
        "units": units or {"image": "MJy / sr", "variance": "MJy2 / sr2"},
        "lvf_status": status["wavelength_status"],
        "wavelength_status": status["wavelength_status"],
        "calibrated": status["calibrated"],
        "flag_definitions": [flag_definitions[b] for b in sorted(flag_definitions)],
        "cache": {"hit": job.cache_hit},
        "multi_product_mosaic": status["multi_product_mosaic"],
        "collection": "SPHEREx Level-2 spectral image cutouts",
        "cutouts": manifest_cutouts,
        "notes": (
            [
                "CWAVE/CBAND verified per product; "
                "inverse-variance nearest-sampled mosaics.",
                "Epochs remain separate. Output-pixel covariance is not modeled; "
                "ZODI is not subtracted.",
                "Coverage and hit counts are cached; "
                "provider/algorithm/calibration provenance is retained.",
            ]
            if status["calibrated"]
            else [
                "WCS-WAVE is approximate visualization-grade; no verified calibration.",
                "This is a single detector cutout, not a calibrated temporal mosaic.",
            ]
        ),
    }


def render_animation_gif(job_id: str, channel: int) -> bytes:
    """Export only verified same-channel epochs, using the PNG shared stretch."""
    from app.services.mosaics import encode_gif

    job = _ready_job(job_id)
    if channel not in job.request.channels:
        raise FrameOptionError("Channel was not requested in this job")
    metadata = sorted(
        (c for c in job.cutouts if c.get("channel") == channel and c.get("calibrated")),
        key=lambda c: (c["date_iso"], c["epoch"]),
    )
    if not 2 <= len(metadata) <= 12:
        raise FrameOptionError("Animation requires 2–12 verified calibrated epochs")
    images = []
    for item in metadata:
        cutout = resolve_cutout(job, (channel // 17) + 1, item["epoch"], channel)
        if cutout is None or not cutout.metadata.get("calibrated"):
            raise CutoutUnavailableError(
                "A calibrated animation epoch is no longer cached"
            )
        images.append(cutout.image)
    return encode_gif(images, job.request.stretch)
