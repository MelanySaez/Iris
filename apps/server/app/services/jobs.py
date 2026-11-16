"""Job execution, lifecycle, threading, LRU memory cache, and snapshot persistence."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
import traceback
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any, Protocol

import numpy as np

from app.core.config import (
    JOB_SNAPSHOT_LRU_SIZE,
    JOB_WORKERS,
    MAX_CHANNELS_PER_JOB,
    MAX_CUTOUT_DOWNLOADS_PER_JOB,
    MAX_DOWNLOAD_WORKERS,
    MAX_REGION_SIZE_ARCMIN,
    MIN_REGION_SIZE_ARCMIN,
    MULTI_PRODUCT_MOSAIC,
    WAVELENGTH_STATUS,
)
from app.exceptions.domain import (
    ChannelOutOfRangeError,
    JobNotFoundError,
    RegionRequestError,
)
from app.repositories.job_snapshots import JobSnapshotRepository
from app.schemas.jobs import JobRequest
from app.services.channels import get_channel, get_channel_window
from app.services.cube_fallback import (
    CUBE_COVERAGE_STATE,
    CUBE_PROVIDER,
    CubeCutout,
    CubeUpstreamError,
    build_cube_cutout,
    no_temporal_notice,
)
from app.services.discovery import resolve_region
from app.services.fits import (
    DerivedCutout,
    download_cutout,
    get_or_extract_derived,
    load_derived_cutout,
    save_derived_cutout,
)
from app.services.rendering import compute_cutout_percentiles
from app.utils.tracing import request_id_var

logger = logging.getLogger("uvicorn.error")

# error_kind for an unexpected exception, by the stage that was running.
UNEXPECTED_ERROR_KINDS = {
    "downloading": "download_failed",
    "extracting": "extraction_failed",
    "rendering": "render_failed",
}
TRACE_MAX_LINES = 30
TRACE_MAX_CHARS = 6000


def _trimmed_traceback() -> str:
    """Current exception traceback, keeping the innermost frames and the error."""
    lines = traceback.format_exc().rstrip().splitlines()
    if len(lines) > TRACE_MAX_LINES:
        lines = [lines[0], "  ..."] + lines[-(TRACE_MAX_LINES - 2) :]
    text = "\n".join(lines)
    return text if len(text) <= TRACE_MAX_CHARS else "...\n" + text[-TRACE_MAX_CHARS:]


@dataclass
class JobState:
    """Internal runtime state for an active or completed job."""

    id: str
    request: JobRequest
    status: str = "queued"
    progress: int = 0
    stage: str = "Queued"
    error: str | None = None
    frames: list[dict[str, Any]] = field(default_factory=list)
    cutouts: list[dict[str, Any]] = field(default_factory=list)
    cutout_objects: dict[tuple[int, ...], DerivedCutout] = field(default_factory=dict)
    percentiles: dict[tuple[int, int, str], tuple[float, float]] = field(
        default_factory=dict
    )
    events: list[dict[str, Any]] = field(default_factory=list)
    cache_hit: bool = False
    failed_stage: str | None = None
    error_kind: str | None = None
    error_trace: str | None = None
    request_id: str | None = None
    derived_cache_complete: bool = True
    discovery: dict[str, Any] = field(default_factory=dict)
    animation_reason: str | None = None
    # What the worker is doing right now, with its own progress budget; None
    # between steps. Exposed so the UI can show live sub-progress.
    activity: dict[str, Any] | None = None

    def _wavelength_status(self) -> str:
        """Job-level wavelength status: calibrated, cube nominal, or approximate."""
        if self.frames and all(f.get("calibrated") for f in self.frames):
            return "calibrated_cwave_cband"
        if self.frames and all(f.get("source") == "cube" for f in self.frames):
            return str(self.frames[0]["wavelength_status"])
        return WAVELENGTH_STATUS

    def to_snapshot(self) -> dict[str, Any]:
        """Convert current job state to a serializable dictionary matching JobSnapshot."""
        ch_items = []
        for c in self.request.channels:
            try:
                ch = get_channel(c)
                ch_items.append(
                    {
                        "index": ch["index"],
                        "wavelength_um": ch["wavelength_um"],
                        "bandwidth_um": ch["bandwidth_um"],
                        "detector": ch["band"],
                        "available": ch["available"],
                    }
                )
            except Exception:
                pass

        return {
            "id": self.id,
            "status": self.status,
            "progress": self.progress,
            "stage": self.stage,
            "events": list(self.events),
            "error": self.error,
            "failed_stage": self.failed_stage,
            "error_kind": self.error_kind,
            "error_trace": self.error_trace,
            "request_id": self.request_id,
            "request": self.request.model_dump(),
            "region": {
                "ra_deg": self.request.ra_deg,
                "dec_deg": self.request.dec_deg,
                "size_arcmin": self.request.size_arcmin,
                "fov_deg": round(self.request.size_arcmin / 60.0, 4),
            },
            "channels": ch_items,
            "products": sorted(set(self.request.products)),
            "frames": self.frames,
            "cutouts": self.cutouts,
            "cache": {"hit": self.cache_hit},
            "wavelength_status": self._wavelength_status(),
            "calibrated": bool(self.frames)
            and all(f.get("calibrated") for f in self.frames),
            "multi_product_mosaic": "complete"
            if self.frames and all(f.get("calibrated") for f in self.frames)
            else MULTI_PRODUCT_MOSAIC,
            "discovery": self.discovery,
            "animation_reason": self.animation_reason,
            "activity": self._activity_snapshot(),
        }

    def _activity_snapshot(self) -> dict[str, Any] | None:
        if self.activity is None or self.status in ("ready", "failed"):
            return None
        snapshot = dict(self.activity)
        started = snapshot.get("started_at")
        if isinstance(started, (int, float)):
            snapshot["elapsed_seconds"] = round(max(0.0, time.time() - started), 1)
        return snapshot


class JobObserver(Protocol):
    """Port notified about job lifecycle events (e.g. selection persistence).

    Observers must not influence job processing: any exception they raise is
    logged and swallowed by the manager.
    """

    def on_submitted(
        self,
        job: JobState,
        is_new: bool,
        request: JobRequest | None = None,
        owner: uuid.UUID | None = None,
    ) -> None:
        """``is_new`` is False for cache hits: the job will not run again.

        ``request`` is the request just submitted. On a cache hit it can differ
        from ``job.request`` in fields outside the job id, such as ``view``.
        ``owner`` identifies the browser that submitted it, or is None when
        that browser did not accept cookies.
        """

    def on_discovered(self, job: JobState, discovery: dict[str, Any]) -> None: ...

    def on_finished(self, job: JobState) -> None: ...


class JobManager:
    """Thread-safe manager for job lifecycle, LRU snapshots, and pool workers."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.jobs: OrderedDict[str, JobState] = OrderedDict()
        self.pool = ThreadPoolExecutor(
            max_workers=JOB_WORKERS, thread_name_prefix="planetx-jobs"
        )
        self.download_pool = ThreadPoolExecutor(
            max_workers=MAX_DOWNLOAD_WORKERS, thread_name_prefix="cutout-dl"
        )
        self.observers: list[JobObserver] = []
        self.snapshots = JobSnapshotRepository()

    def add_observer(self, observer: JobObserver) -> None:
        """Register an observer for job lifecycle events."""
        self.observers.append(observer)

    def remove_observer(self, observer: JobObserver) -> None:
        """Unregister a previously added observer (no-op when absent)."""
        if observer in self.observers:
            self.observers.remove(observer)

    def _notify(self, event: str, *args: Any) -> None:
        """Deliver an event to every observer; failures never affect the job."""
        for observer in list(self.observers):
            try:
                getattr(observer, event)(*args)
            except Exception:
                logger.exception("job observer %s failed on %s", observer, event)

    def compute_job_id(self, req: JobRequest) -> str:
        """Deterministic hash for deduplicating identical requests."""
        channels_str = ",".join(str(c) for c in sorted(req.channels))
        products_str = ",".join(sorted(set(req.products)))
        calibration = os.environ.get("SPHEREX_CALIBRATION_MANIFEST", "")
        if calibration:
            from pathlib import Path

            with suppress(OSError, ValueError, TypeError, KeyError):
                manifest_path = Path(calibration)
                raw = manifest_path.read_bytes()
                digest = hashlib.sha256(raw)
                payload = json.loads(raw)
                entries = payload.get("products", [payload])
                paths = {
                    manifest_path.parent / entry["calibration_path"]
                    for entry in entries
                    if isinstance(entry, dict) and entry.get("calibration_path")
                }
                for path in sorted(paths):
                    digest.update(str(path).encode())
                    try:
                        with path.open("rb") as stream:
                            while chunk := stream.read(1024 * 1024):
                                digest.update(chunk)
                    except OSError:
                        digest.update(b"missing-calibration")
                calibration = digest.hexdigest()
        token = (
            f"mosaic-v2:{calibration}:{req.ra_deg:.5f}:{req.dec_deg:.5f}:{req.size_arcmin:.3f}:"
            f"{channels_str}:{products_str}:{req.mode}:{req.stretch}"
        )
        return hashlib.sha256(token.encode("utf-8")).hexdigest()[:20]

    def validate_request(self, req: JobRequest) -> None:
        """Validate request against contract caps and physical constraints."""
        if req.size_arcmin > MAX_REGION_SIZE_ARCMIN:
            raise RegionRequestError(
                f"Region size {req.size_arcmin} arcmin exceeds limit of "
                f"{MAX_REGION_SIZE_ARCMIN} arcmin; "
                "Use a smaller region."
            )
        if req.size_arcmin < MIN_REGION_SIZE_ARCMIN:
            raise RegionRequestError(
                f"Region size {req.size_arcmin} arcmin must be at least "
                f"{MIN_REGION_SIZE_ARCMIN} arcmin."
            )
        if not (1 <= len(req.channels) <= MAX_CHANNELS_PER_JOB):
            raise RegionRequestError(
                f"Requested channels count {len(req.channels)} must be between "
                f"1 and {MAX_CHANNELS_PER_JOB}."
            )
        for index in req.channels:
            try:
                info = get_channel(index)
            except ChannelOutOfRangeError:
                raise RegionRequestError(
                    f"Channel index {index} is out of range; the DR1 cube "
                    "provides channels 0..101."
                ) from None
            if not info["available"]:
                raise RegionRequestError(
                    f"Channel {index} is blank in the DR1 All-Sky Cube "
                    "(frames 50 and 51 carry no data)."
                )
        if not (-90.0 <= req.dec_deg <= 90.0):
            raise RegionRequestError("Declination must be between -90 and +90 degrees.")
        if "image" not in req.products:
            req.products.append("image")

    def submit(self, req: JobRequest, owner: uuid.UUID | None = None) -> JobState:
        """Submit a job or retrieve an active/cached one, notifying observers.

        Observers hear about the submission before a new job is scheduled, so
        no lifecycle event can reach them ahead of ``on_submitted``.
        """
        job, is_new = self._submit(req)
        self._notify("on_submitted", job, is_new, req, owner)
        if is_new:
            self.pool.submit(self._run_job, job)
        return job

    def _submit(self, req: JobRequest) -> tuple[JobState, bool]:
        """Find an active/cached job or register a new one (not yet scheduled)."""
        self.validate_request(req)
        job_id = self.compute_job_id(req)

        with self.lock:
            # Check in-memory LRU
            if job_id in self.jobs:
                job = self.jobs[job_id]
                if job.status == "failed":
                    # A failed attempt is not a cache entry: let the caller retry.
                    del self.jobs[job_id]
                else:
                    logger.info(
                        "job=%s request=%s cache=memory_hit", job_id, request_id_var.get()
                    )
                    self.jobs.move_to_end(job_id)
                    return job, False

            # Check disk snapshot cache
            snap_data = self.snapshots.read(job_id)
            if snap_data is not None and snap_data.get("status") == "ready":
                job = self._rebuild_job_from_snapshot(snap_data, req)
                if job.cutouts and job.derived_cache_complete:
                    logger.info(
                        "job=%s request=%s cache=disk_hit",
                        job_id,
                        request_id_var.get(),
                    )
                    job.cache_hit = True
                    self._put_lru(job)
                    return job, False

            # Create new job
            job = JobState(id=job_id, request=req, request_id=request_id_var.get())
            self._put_lru(job)
            logger.info(
                "job=%s request=%s stage=queued channels=%s size_arcmin=%s",
                job.id,
                job.request_id,
                req.channels,
                req.size_arcmin,
            )
            return job, True

    def _put_lru(self, job: JobState) -> None:
        """Insert or refresh job in memory LRU cache."""
        self.jobs[job.id] = job
        self.jobs.move_to_end(job.id)
        while len(self.jobs) > JOB_SNAPSHOT_LRU_SIZE:
            self.jobs.popitem(last=False)

    def get_job(self, job_id: str) -> JobState:
        """Retrieve job from memory LRU or rebuild from disk cache; 404 if missing."""
        with self.lock:
            if job_id in self.jobs:
                self.jobs.move_to_end(job_id)
                return self.jobs[job_id]

        snap_data = self.snapshots.read(job_id)
        if snap_data is not None:
            try:
                req = JobRequest(**snap_data.get("request", {}))
                job = self._rebuild_job_from_snapshot(snap_data, req)
                if job.cutouts and job.derived_cache_complete:
                    with self.lock:
                        self._put_lru(job)
                    return job
                raise JobNotFoundError(
                    f"Job {job_id} snapshot is stale: its derived cutout cache "
                    "is incomplete. Submit the request again to rebuild it."
                )
            except JobNotFoundError:
                raise
            except Exception:
                pass

        raise JobNotFoundError(f"Unknown or expired job {job_id}")

    def _rebuild_job_from_snapshot(
        self,
        snap: dict[str, Any],
        req: JobRequest,
    ) -> JobState:
        """Reconstruct job state and re-link derived cutouts from the disk cache."""
        job = JobState(
            id=snap["id"],
            request=req,
            status=snap.get("status", "ready"),
            progress=snap.get("progress", 100),
            stage=snap.get("stage", "Ready"),
            events=snap.get("events", []),
            error=snap.get("error"),
            frames=snap.get("frames", []),
            cutouts=snap.get("cutouts", []),
            cache_hit=True,
            discovery=snap.get("discovery", {}),
            animation_reason=snap.get("animation_reason"),
        )

        # Cutouts are reloaded from the derived cache using the persisted source
        # URI. If an entry was evicted, the frame routes report it honestly
        # instead of re-downloading from a guessed URL.
        for c_meta in job.cutouts:
            det = c_meta.get("detector")
            epoch = c_meta.get("epoch")
            if det is None or epoch is None:
                continue
            cutout = resolve_cutout(job, det, epoch, c_meta.get("channel"))
            if cutout is None:
                job.derived_cache_complete = False
                continue
            for p in ("image", "variance"):
                job.percentiles[(det, epoch, p)] = compute_cutout_percentiles(
                    getattr(cutout, p), is_variance=(p == "variance")
                )

        return job

    def _save_snapshot_to_disk(self, job: JobState) -> None:
        """Persist this job's snapshot through the snapshot repository."""
        self.snapshots.write(job.id, job.to_snapshot())

    def _fail(
        self, job: JobState, kind: str, message: str, trace: str | None = None
    ) -> None:
        """Mark the job failed, keeping where (stage), why (kind) and how (trace)."""
        job.failed_stage = job.status
        job.error_kind = kind
        job.error = message
        job.error_trace = trace
        job.status = "failed"
        job.activity = None
        job.progress = 100
        job.stage = "Failed"
        job.events.append({"stage": job.stage, "at": time.time()})
        logger.info(
            "job=%s request=%s stage=Failed failed_stage=%s error_kind=%s",
            job.id,
            job.request_id,
            job.failed_stage,
            kind,
        )
        self._save_snapshot_to_disk(job)

    def _record_discovery_attempt(self, job: JobState, attempt: dict[str, Any]) -> None:
        """Append upstream retry details to the polled job trace."""
        provider = str(attempt.get("provider") or "Discovery provider")
        number = attempt.get("attempt", "?")
        maximum = attempt.get("max_attempts", "?")
        outcome = attempt.get("outcome", "unknown")
        will_retry = bool(attempt.get("will_retry", False))

        event_type = attempt.get("event_type")
        now = time.time()
        if event_type == "provider_reuse":
            stage = f"Reusing the {provider} result for this region"
            job.activity = None
        elif event_type == "provider_fallback":
            count = attempt.get("result_count")
            stage = {
                "started": f"{provider} fallback · checking",
                "succeeded": f"{provider} fallback · {count} products found",
            }.get(outcome, f"{provider} fallback unavailable")
            job.activity = (
                {"kind": "fallback", "provider": provider, "started_at": now}
                if outcome == "started"
                else None
            )
        elif outcome == "started":
            stage = f"{provider} · Attempt {number} of {maximum} in progress"
            job.activity = {
                "kind": "discovery_attempt",
                "provider": provider,
                "attempt": number,
                "max_attempts": maximum,
                "started_at": now,
                "budget_seconds": attempt.get("deadline_seconds"),
            }
        elif outcome == "failed" and will_retry:
            stage = f"{provider} · Attempt {number} of {maximum} failed; retrying"
            job.activity = {
                "kind": "retry_wait",
                "provider": provider,
                "attempt": number,
                "max_attempts": maximum,
                "started_at": now,
                "budget_seconds": attempt.get("retry_after_seconds"),
            }
        elif outcome == "failed":
            stage = f"{provider} · Attempt {number} of {maximum} failed"
            job.activity = None
        else:
            stage = f"{provider} · Attempt {number} of {maximum} succeeded"
            job.activity = None

        event = {**attempt, "stage": stage, "at": now}
        job.stage = stage
        job.events.append(event)
        logger.info(
            "job=%s request=%s provider=%s attempt=%s/%s "
            "outcome=%s will_retry=%s detail=%s",
            job.id,
            job.request_id,
            provider,
            number,
            maximum,
            outcome,
            will_retry,
            attempt.get("detail", ""),
        )
        self._save_snapshot_to_disk(job)

    def _run_mosaic_job(self, job: JobState, discovery: dict[str, Any]) -> None:
        """Prepare calibrated, channel-specific epochs without retaining all arrays."""
        from app.services.temporal_jobs import prepare_temporal_cutouts

        job.status = "extracting"
        job.progress = 30
        job.stage = "Verifying calibration and preparing epoch mosaics"
        job.cutouts = prepare_temporal_cutouts(
            discovery["products"], job.request, job.events.append
        )
        if not job.cutouts:
            self._fail(
                job,
                "calibration_unavailable",
                "No calibrated channel mosaics are available. Supply verified "
                "product-associated CWAVE/CBAND calibration; "
                "WCS-WAVE is not sufficient.",
            )
            return
        for cutout in job.cutouts:
            channel, epoch = cutout["channel"], cutout["epoch"]
            win_min, win_max = get_channel_window(channel)
            for product in sorted(set(job.request.products)):
                base = f"/api/jobs/{job.id}/frames/{channel}"
                job.frames.append(
                    {
                        **{
                            key: cutout[key]
                            for key in (
                                "channel",
                                "detector",
                                "epoch",
                                "obs_id",
                                "date_iso",
                                "source",
                                "calibrated",
                                "wavelength_status",
                                "provenance",
                                "epoch_id",
                            )
                        },
                        "product": product,
                        "width": cutout["shape"][1],
                        "height": cutout["shape"][0],
                        "url": f"{base}/{product}.png?mode=full&epoch={epoch}",
                        "slice_url": f"{base}/{product}.png?mode=slice&epoch={epoch}",
                        "wavelengths_url": f"{base}/wavelengths.npy?epoch={epoch}",
                        "window_um": [win_min, win_max],
                    }
                )
        job.animation_reason = (
            "Fewer than two calibrated epochs for one or more channels"
            if any(
                sum(c["channel"] == channel for c in job.cutouts) < 2
                for channel in job.request.channels
            )
            else None
        )
        job.status, job.progress, job.stage = "ready", 100, "Ready"
        job.events.append({"stage": job.stage, "at": time.time()})
        self._save_snapshot_to_disk(job)

    def _run_cube_job(self, job: JobState, discovery: dict[str, Any]) -> None:
        """Build one cutout per requested channel from the DR1 All-Sky Cube on S3.

        The cube is a single combined image: there is exactly one epoch, no
        VARIANCE layer, and wavelengths are nominal channel centres. The job
        events, ``animation_reason`` and frame metadata say so.
        """
        req = job.request
        notice = discovery.get("fallback_notice") or no_temporal_notice("", "")
        job.animation_reason = notice
        job.events.append(
            {
                "stage": "Using DR1 All-Sky Cube fallback",
                # No provider/fallback keys: the discovery event already
                # carries them, so the provider trace shows the notice once.
                "event_type": "cube_fallback",
                "temporal_available": False,
                "detail": notice,
                "at": time.time(),
            }
        )
        products = [p for p in sorted(set(req.products)) if p != "variance"]
        if "variance" in req.products:
            job.events.append(
                {
                    "stage": "Variance unavailable",
                    "event_type": "cube_no_variance",
                    "provider": CUBE_PROVIDER,
                    "detail": "The DR1 All-Sky Cube has no VARIANCE layer; "
                    "variance frames are omitted.",
                    "at": time.time(),
                }
            )
        channels = sorted(set(req.channels))
        job.status = "downloading"
        cutouts: dict[int, CubeCutout] = {}
        for done, channel in enumerate(channels, 1):
            job.stage = f"Reading DR1 cube channel {channel} ({done}/{len(channels)})"
            job.progress = 20 + int(65 * (done - 1) / len(channels))
            job.events.append({"stage": job.stage, "at": time.time()})
            job.activity = {
                "kind": "cube_read",
                "provider": CUBE_PROVIDER,
                "channel": channel,
                "channel_index": done,
                "channels": len(channels),
                "tiles_done": 0,
                "tiles_total": None,
                "started_at": time.time(),
            }

            def progress(tiles_done: int, tiles_total: int, index: int = done) -> None:
                if job.activity is not None:
                    job.activity.update(tiles_done=tiles_done, tiles_total=tiles_total)
                share = tiles_done / tiles_total if tiles_total else 0.0
                job.progress = 20 + int(65 * (index - 1 + share) / len(channels))

            try:
                cutout = build_cube_cutout(
                    req.ra_deg,
                    req.dec_deg,
                    req.size_arcmin,
                    channel,
                    on_progress=progress,
                )
            except CubeUpstreamError as exc:
                self._fail(job, "cube_unavailable", str(exc))
                return
            try:
                save_derived_cutout(cutout)
            except OSError:
                logger.warning("Could not cache cube cutout %s", cutout.uri)
            cutouts[channel] = cutout
            job.cutout_objects[(cutout.detector, 0, channel)] = cutout

        job.activity = None
        job.status = "rendering"
        job.progress = 85
        job.stage = "Rendering frames"
        job.events.append({"stage": job.stage, "at": time.time()})

        cutouts_meta: list[dict[str, Any]] = []
        frames: list[dict[str, Any]] = []
        for channel, cutout in cutouts.items():
            meta = cutout.metadata
            h, w = cutout.image.shape
            job.percentiles[("cube", channel, "image")] = compute_cutout_percentiles(
                cutout.image
            )
            wavelength = float(meta["channel_wavelength_um"])
            cutouts_meta.append(
                {
                    "detector": cutout.detector,
                    "epoch": 0,
                    "channel": channel,
                    "obs_id": cutout.obs_id,
                    "date_iso": cutout.date_iso,
                    "source": cutout.source,
                    "calibrated": False,
                    "wavelength_status": meta["wavelength_status"],
                    "provenance": meta["provenance"],
                    "uri": cutout.uri,
                    "version": meta["version"],
                    "shape": [int(h), int(w)],
                    "pixel_scale_arcsec": meta["pixel_scale_arcsec"],
                    "wavelength_min_um": round(wavelength, 4),
                    "wavelength_max_um": round(wavelength, 4),
                    "bandwidth_median_um": round(float(meta["channel_bandwidth_um"]), 4),
                    "image_unit": meta["units"]["image"],
                    "variance_unit": "",
                    "flags_defined": False,
                    "flag_bits": [],
                }
            )
            win_min, win_max = get_channel_window(channel)
            base_url = f"/api/jobs/{job.id}/frames/{channel}"
            for product in products:
                frames.append(
                    {
                        "channel": channel,
                        "product": product,
                        "detector": cutout.detector,
                        "epoch": 0,
                        "obs_id": cutout.obs_id,
                        "date_iso": cutout.date_iso,
                        "source": cutout.source,
                        "calibrated": False,
                        "wavelength_status": meta["wavelength_status"],
                        "provenance": meta["provenance"],
                        "width": int(w),
                        "height": int(h),
                        "url": f"{base_url}/{product}.png?mode=full&epoch=0",
                        "slice_url": f"{base_url}/{product}.png?mode=slice&epoch=0",
                        "wavelengths_url": f"{base_url}/wavelengths.npy?epoch=0",
                        "window_um": [win_min, win_max],
                    }
                )

        job.cutouts = cutouts_meta
        job.frames = frames
        job.status = "ready"
        job.progress = 100
        job.stage = "Ready"
        job.events.append({"stage": job.stage, "at": time.time()})
        self._save_snapshot_to_disk(job)

    def _run_job(self, job: JobState) -> None:
        """Complete workflow for a queued job: discover, download, extract, render."""
        try:
            req = job.request
            ra, dec, size = req.ra_deg, req.dec_deg, req.size_arcmin

            # Stage 1: Discovering
            job.status = "discovering"
            job.progress = 10
            job.stage = "Discovering products"
            job.events.append({"stage": job.stage, "at": time.time()})
            logger.info("job=%s stage=%s progress=%s", job.id, job.stage, job.progress)

            discovery = resolve_region(
                ra,
                dec,
                size,
                on_attempt=lambda attempt: self._record_discovery_attempt(job, attempt),
            )
            job.activity = None
            job.discovery = {
                key: discovery[key]
                for key in (
                    "coverage",
                    "coverage_state",
                    "coverage_complete",
                    "provider_trace",
                    "warning",
                    "temporal_available",
                    "fallback_notice",
                    "reused",
                )
                if key in discovery
            }
            self._notify("on_discovered", job, discovery)
            if discovery["coverage"] == "none":
                self._fail(
                    job, "no_coverage", "No SPHEREx coverage found for this region."
                )
                return
            if discovery["coverage"] == "unknown":
                self._fail(
                    job,
                    "discovery_unavailable",
                    "Coverage could not be determined: IRSA TAP discovery failed. "
                    "Retry the request. "
                    f"Discovery error: {discovery.get('warning') or 'unknown'}",
                )
                return

            if discovery.get("coverage_state") == CUBE_COVERAGE_STATE:
                self._run_cube_job(job, discovery)
                return

            if (
                req.mode == "history"
                or size > 60
                or os.environ.get("SPHEREX_CALIBRATION_MANIFEST")
            ):
                self._run_mosaic_job(job, discovery)
                return

            # Group discovered products by detector
            prods_by_det: dict[int, list[dict[str, Any]]] = {}
            for p in discovery["products"]:
                prods_by_det.setdefault(p["detector"], []).append(p)

            # Determine detectors required by requested channels
            needed_dets = sorted(set((c // 17) + 1 for c in req.channels))

            # Select products per detector based on mode (latest vs history)
            selected_targets: list[tuple[dict[str, Any], int]] = []
            for det in needed_dets:
                prods = prods_by_det.get(det, [])
                if not prods:
                    continue

                if req.mode == "latest":
                    # Use the newest available remote product.
                    sorted_prods = sorted(prods, key=lambda x: x["date_mjd"])
                    selected_targets.append((sorted_prods[-1], 0))
                else:
                    # History mode: up to 2 distinct epochs (first and last date)
                    sorted_prods = sorted(prods, key=lambda x: x["date_mjd"])
                    if len(sorted_prods) == 1:
                        selected_targets.append((sorted_prods[0], 0))
                    else:
                        selected_targets.append((sorted_prods[0], 0))
                        selected_targets.append((sorted_prods[-1], 1))

            if not selected_targets:
                self._fail(
                    job,
                    "no_detector_coverage",
                    f"None of the requested channels {req.channels} have "
                    "available detector coverage.",
                )
                return

            # Enforce max cutout downloads cap
            if len(selected_targets) > MAX_CUTOUT_DOWNLOADS_PER_JOB:
                selected_targets = selected_targets[:MAX_CUTOUT_DOWNLOADS_PER_JOB]

            # Stage 2: Downloading
            job.status = "downloading"
            remote_downloads = [prod for prod, _ in selected_targets]
            total_dl = len(remote_downloads)

            if total_dl > 0:
                job.progress = 20
                job.stage = f"Downloading DR1 cutouts 0/{total_dl}"
                job.events.append({"stage": job.stage, "at": time.time()})
                logger.info(
                    "job=%s stage=%s progress=%s", job.id, job.stage, job.progress
                )

                from app.services.temporal_jobs import download_product

                dl_futures = [
                    self.download_pool.submit(
                        download_product, p, req, job.events.append, download_cutout
                    )
                    for p in remote_downloads
                ]
                for done_count, fut in enumerate(dl_futures, 1):
                    fut.result()
                    job.progress = 20 + int(40 * (done_count / total_dl))
                    job.stage = f"Downloading DR1 cutouts {done_count}/{total_dl}"
                    job.events.append({"stage": job.stage, "at": time.time()})
                    logger.info(
                        "job=%s stage=%s progress=%s", job.id, job.stage, job.progress
                    )

            # Stage 3: Extracting
            job.status = "extracting"
            job.progress = 65
            job.stage = "Extracting LVF map"
            job.events.append({"stage": job.stage, "at": time.time()})
            logger.info("job=%s stage=%s progress=%s", job.id, job.stage, job.progress)

            loaded_cutouts: dict[tuple[int, ...], DerivedCutout] = {}
            for prod, epoch in selected_targets:
                cutout = get_or_extract_derived(prod, ra, dec, epoch=epoch)
                det = cutout.detector
                loaded_cutouts[(det, epoch)] = cutout

            job.cutout_objects = loaded_cutouts

            # Stage 4: Rendering & assembling frames/cutouts
            job.status = "rendering"
            job.progress = 85
            job.stage = "Rendering frames"
            job.events.append({"stage": job.stage, "at": time.time()})
            logger.info("job=%s stage=%s progress=%s", job.id, job.stage, job.progress)

            # Precalculate percentiles per cutout
            cutouts_meta_list: list[dict[str, Any]] = []
            for (det, epoch), cutout in loaded_cutouts.items():
                p_lo, p_hi = compute_cutout_percentiles(cutout.image, is_variance=False)
                job.percentiles[(det, epoch, "image")] = (p_lo, p_hi)
                v_lo, v_hi = compute_cutout_percentiles(cutout.variance, is_variance=True)
                job.percentiles[(det, epoch, "variance")] = (v_lo, v_hi)

                w_finite = cutout.wavelength[np.isfinite(cutout.wavelength)]
                b_finite = cutout.bandwidth[np.isfinite(cutout.bandwidth)]

                cutouts_meta_list.append(
                    {
                        "detector": det,
                        "epoch": epoch,
                        "obs_id": cutout.obs_id,
                        "date_iso": cutout.date_iso,
                        "source": cutout.source,
                        "uri": cutout.uri,
                        "version": cutout.metadata.get("version", ""),
                        "shape": [int(cutout.image.shape[0]), int(cutout.image.shape[1])],
                        "pixel_scale_arcsec": cutout.metadata.get(
                            "pixel_scale_arcsec", 6.13
                        ),
                        "wavelength_min_um": round(
                            float(np.min(w_finite)) if w_finite.size else 0.0, 4
                        ),
                        "wavelength_max_um": round(
                            float(np.max(w_finite)) if w_finite.size else 0.0, 4
                        ),
                        "bandwidth_median_um": round(
                            float(np.median(b_finite)) if b_finite.size else 0.0, 4
                        ),
                        "image_unit": cutout.metadata.get("units", {}).get(
                            "image", "MJy / sr"
                        ),
                        "variance_unit": cutout.metadata.get("units", {}).get(
                            "variance", "MJy2 / sr2"
                        ),
                        "flags_defined": bool(cutout.metadata.get("flag_bits")),
                        "flag_bits": cutout.metadata.get("flag_bits", []),
                    }
                )

            # Build frames list
            frames_list: list[dict[str, Any]] = []
            for c in req.channels:
                det = (c // 17) + 1
                try:
                    get_channel(c)
                except Exception:
                    continue
                win_min, win_max = get_channel_window(c)

                # For each epoch available for this detector
                for epoch in (0, 1):
                    if (det, epoch) not in loaded_cutouts:
                        continue
                    cutout = loaded_cutouts[(det, epoch)]
                    h, w = cutout.image.shape

                    for p in sorted(set(req.products)):
                        base_url = f"/api/jobs/{job.id}/frames/{c}"
                        f_url = f"{base_url}/{p}.png?mode=full&epoch={epoch}"
                        s_url = f"{base_url}/{p}.png?mode=slice&epoch={epoch}"
                        w_url = f"{base_url}/wavelengths.npy?epoch={epoch}"
                        frames_list.append(
                            {
                                "channel": c,
                                "product": p,
                                "detector": det,
                                "epoch": epoch,
                                "obs_id": cutout.obs_id,
                                "date_iso": cutout.date_iso,
                                "source": cutout.source,
                                "width": int(w),
                                "height": int(h),
                                "url": f_url,
                                "slice_url": s_url,
                                "wavelengths_url": w_url,
                                "window_um": [win_min, win_max],
                            }
                        )

            job.cutouts = cutouts_meta_list
            job.frames = frames_list
            job.status = "ready"
            job.progress = 100
            job.stage = "Ready"
            job.events.append({"stage": job.stage, "at": time.time()})
            logger.info("job=%s stage=%s progress=%s", job.id, job.stage, job.progress)

            self._save_snapshot_to_disk(job)

        except Exception as exc:
            logger.exception(
                "Error processing job %s (request=%s, stage=%s): %s",
                job.id,
                job.request_id,
                job.status,
                exc,
            )
            self._fail(
                job,
                UNEXPECTED_ERROR_KINDS.get(job.status, "unexpected"),
                f"{type(exc).__name__}: {exc}",
                trace=_trimmed_traceback(),
            )
        finally:
            self._notify("on_finished", job)


job_manager = JobManager()


def resolve_cutout(
    job: JobState, detector: int, epoch: int, channel: int | None = None
) -> DerivedCutout | None:
    """Return a job cutout from memory or the derived disk cache (never network)."""
    key = (detector, epoch, channel) if channel is not None else (detector, epoch)
    cutout = job.cutout_objects.get(key)
    if cutout is None and channel is not None:
        cutout = job.cutout_objects.get((detector, epoch))
    if cutout is not None:
        return cutout

    meta = next(
        (
            c
            for c in job.cutouts
            if c.get("detector") == detector
            and c.get("epoch") == epoch
            and (c.get("channel") is None or c.get("channel") == channel)
        ),
        None,
    )
    if meta is None or not meta.get("uri"):
        return None

    cutout = load_derived_cutout(meta["uri"], detector, epoch)
    if cutout is None:
        return None

    with job_manager.lock:
        # Reconstruct mosaics on demand, retaining at most four large arrays per job.
        if channel is not None and cutout.metadata.get("calibrated"):
            while len(job.cutout_objects) >= 4:
                job.cutout_objects.pop(next(iter(job.cutout_objects)))
        job.cutout_objects[key] = cutout
    return cutout
