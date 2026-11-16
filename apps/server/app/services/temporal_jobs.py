"""Bounded orchestration of independently calibrated, channel-specific epochs."""

from __future__ import annotations

import json
import os
import time
from collections import defaultdict
from collections.abc import Callable
from pathlib import Path
from typing import Any

from app.core.config import MAX_EPOCHS_PER_JOB, MAX_MOSAIC_INPUTS_PER_EPOCH
from app.schemas.jobs import JobRequest
from app.services.fits import (
    DerivedCutout,
    download_cutout,
    get_or_extract_derived,
    save_derived_cutout,
)
from app.services.spherex_provider import (
    download_s3_cutout,
    is_provider_unavailable,
    query_index,
    remember_products,
)

MAX_EPOCH_ARRAY_BYTES = 256 * 1024 * 1024


def download_product(
    product: dict,
    req: JobRequest,
    observe: Callable[[dict], None],
    downloader=download_cutout,
) -> None:
    """IRSA first; cutout outages may use only an exact positively indexed product."""
    if product.get("source") == "s3":
        product["size_arcmin"] = req.size_arcmin
        download_s3_cutout(product, req.ra_deg, req.dec_deg, req.size_arcmin)
        return
    try:
        downloader(product["uri"])
    except Exception as error:
        cause = error.__cause__ or error
        if not is_provider_unavailable(cause):
            raise
        fallback = query_index(req.ra_deg, req.dec_deg, req.size_arcmin)
        match = next(
            (
                p
                for p in fallback["products"]
                if p.get("obs_id") == product.get("obs_id")
                and p.get("detector") == product.get("detector")
                and p.get("obs_id")
            ),
            None,
        )
        observe(
            {
                "stage": "IRSA cutout unavailable; checking indexed S3 product",
                "provider": "IRSA cutout",
                "error_kind": type(cause).__name__,
                "detail": str(cause)[:240],
                "fallback": True,
                "coverage_state": fallback["coverage_state"],
                "at": time.time(),
            }
        )
        if match is None:
            raise RuntimeError(
                "IRSA cutout unavailable; matching S3 product is not indexed"
            ) from error
        # The index record owns its validated object URL and region cache key.
        product.update(match)
        product["size_arcmin"] = req.size_arcmin
        download_s3_cutout(product, req.ra_deg, req.dec_deg, req.size_arcmin)


def prepare_temporal_cutouts(
    products: list[dict], req: JobRequest, observe: Callable[[dict], None]
) -> list[dict[str, Any]]:
    """Return persisted mosaic descriptors, keeping one epoch's inputs in RAM."""
    from app.services.mosaics import (
        CalibrationUnavailableError,
        NoContributingPixelsError,
        build_mosaic,
        large_slew_id,
        load_verified_calibration,
        sample_epochs,
    )

    manifest = os.environ.get("SPHEREX_CALIBRATION_MANIFEST")
    try:
        payload = json.loads(Path(manifest).read_text()) if manifest else {}
        records = payload.get("products", [payload])
        identities = {
            (r["product"]["obs_id"], r["product"]["original_product_uri"])
            for r in records
            if isinstance(r, dict) and isinstance(r.get("product"), dict)
        }
    except (OSError, ValueError, TypeError, KeyError):
        identities = set()
    if not identities:
        observe(
            {
                "stage": "No verified calibration manifest is configured",
                "error_kind": "calibration_unavailable",
                "at": time.time(),
            }
        )
        return []
    groups: dict[str, list[dict]] = defaultdict(list)
    detectors = {(channel // 17) + 1 for channel in req.channels}
    for product in products:
        if product["detector"] not in detectors:
            continue
        identity = (
            product.get("obs_id"),
            product.get("original_product_uri") or product["uri"].split("?")[0],
        )
        if identity not in identities:
            observe(
                {
                    "stage": "Skipping product without an associated calibration record",
                    "error_kind": "calibration_unavailable",
                    "obs_id": product.get("obs_id"),
                }
            )
            continue
        epoch_id = large_slew_id(product)
        if epoch_id:
            groups[epoch_id].append(product)
        else:
            observe(
                {
                    "stage": "Skipping product without a verifiable large-slew ID",
                    "error_kind": "epoch_unavailable",
                    "obs_id": product.get("obs_id", ""),
                }
            )
    all_groups = sorted(
        groups.values(), key=lambda group: min(p["date_mjd"] for p in group)
    )
    selected = sample_epochs(all_groups, MAX_EPOCHS_PER_JOB)
    if req.mode == "latest":
        selected = selected[-1:]
    outputs = []
    for epoch, group in enumerate(selected):
        if len(group) > MAX_MOSAIC_INPUTS_PER_EPOCH:
            raise ValueError(
                f"Epoch exceeds {MAX_MOSAIC_INPUTS_PER_EPOCH} spatial inputs; "
                "narrow the region"
            )
        calibrated = []
        size_bytes = 0
        for original in group:
            product = dict(original)
            download_product(product, req, observe)
            cutout = get_or_extract_derived(product, req.ra_deg, req.dec_deg, epoch)
            remember_products([{**product, **cutout.metadata}])
            try:
                verified = load_verified_calibration(cutout)
            except CalibrationUnavailableError as error:
                observe(
                    {
                        "stage": "Skipping product: verified calibration unavailable",
                        "error_kind": "calibration_unavailable",
                        "obs_id": cutout.obs_id,
                        "detail": str(error),
                        "at": time.time(),
                    }
                )
                continue
            size_bytes += sum(
                getattr(verified, key).nbytes
                for key in ("image", "variance", "flags", "wavelength", "bandwidth")
            )
            if size_bytes > MAX_EPOCH_ARRAY_BYTES:
                raise ValueError("Epoch exceeds 256 MiB array budget; narrow the region")
            calibrated.append(verified)
        for channel in req.channels:
            inputs = [c for c in calibrated if c.detector == (channel // 17) + 1]
            if not inputs:
                continue
            try:
                mosaic = build_mosaic(
                    inputs, req.ra_deg, req.dec_deg, req.size_arcmin, channel, epoch
                )
            except NoContributingPixelsError:
                observe(
                    {
                        "stage": "No contributing calibrated pixels for channel",
                        "channel": channel,
                        "epoch": epoch,
                        "error_kind": "no_channel_pixels",
                    }
                )
                continue
            if not mosaic.coverage.any():
                observe(
                    {
                        "stage": "No calibrated pixels in the selected channel",
                        "channel": channel,
                        "epoch": epoch,
                        "error_kind": "no_channel_pixels",
                    }
                )
                continue
            save_derived_cutout(mosaic)
            outputs.append(describe_cutout(mosaic, channel))
            observe(
                {
                    "stage": "Calibrated epoch mosaic prepared",
                    "epoch": epoch,
                    "channel": channel,
                    "provider": mosaic.source,
                    "at": time.time(),
                }
            )
        del calibrated
    return outputs


def describe_cutout(cutout: DerivedCutout, channel: int) -> dict[str, Any]:
    """Public metadata shared by persisted snapshots and manifests."""
    import numpy as np

    wave = cutout.wavelength[np.isfinite(cutout.wavelength)]
    width = cutout.bandwidth[np.isfinite(cutout.bandwidth)]
    metadata = cutout.metadata
    return {
        "detector": cutout.detector,
        "epoch": cutout.epoch,
        "channel": channel,
        "obs_id": cutout.obs_id,
        "date_iso": cutout.date_iso,
        "source": cutout.source,
        "uri": cutout.uri,
        "version": metadata.get("version", ""),
        "shape": list(cutout.image.shape),
        "pixel_scale_arcsec": metadata.get("pixel_scale_arcsec", 6.13),
        "wavelength_min_um": float(wave.min()) if wave.size else 0.0,
        "wavelength_max_um": float(wave.max()) if wave.size else 0.0,
        "bandwidth_median_um": float(np.median(width)) if width.size else 0.0,
        "image_unit": metadata.get("units", {}).get("image", "MJy / sr"),
        "variance_unit": metadata.get("units", {}).get("variance", "MJy2 / sr2"),
        "flags_defined": bool(metadata.get("flag_bits")),
        "flag_bits": metadata.get("flag_bits", []),
        "calibrated": True,
        "wavelength_status": metadata["wavelength_status"],
        "epoch_id": metadata.get("large_slew_id", ""),
        "provenance": metadata.get("provenance", []),
    }
