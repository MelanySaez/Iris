"""Job execution, lifecycle, threading, LRU memory cache, and snapshot persistence."""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Protocol

import numpy as np
from fastapi import HTTPException

from app.channels import get_channel, get_channel_window
from app.config import (
    CALIBRATED,
    JOB_SNAPSHOT_LRU_SIZE,
    JOB_WORKERS,
    JOBS_CACHE_DIR,
    MAX_CHANNELS_PER_JOB,
    MAX_CUTOUT_DOWNLOADS_PER_JOB,
    MAX_DOWNLOAD_WORKERS,
    MAX_REGION_SIZE_ARCMIN,
    MIN_REGION_SIZE_ARCMIN,
    MULTI_PRODUCT_MOSAIC,
    WAVELENGTH_STATUS,
)
from app.discovery import resolve_region
from app.fits_assets import (
    DerivedCutout,
    download_cutout,
    get_or_extract_derived,
    load_derived_cutout,
)
from app.models import (
    JobRequest,
)
from app.render import compute_cutout_percentiles

logger = logging.getLogger("uvicorn.error")


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
    cutout_objects: dict[tuple[int, int], DerivedCutout] = field(default_factory=dict)
    percentiles: dict[tuple[int, int, str], tuple[float, float]] = field(
        default_factory=dict
    )
    events: list[dict[str, Any]] = field(default_factory=list)
    cache_hit: bool = False

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
            "wavelength_status": WAVELENGTH_STATUS,
            "calibrated": CALIBRATED,
            "multi_product_mosaic": MULTI_PRODUCT_MOSAIC,
        }


class JobObserver(Protocol):
    """Port notified about job lifecycle events (e.g. selection persistence).

    Observers must not influence job processing: any exception they raise is
    logged and swallowed by the manager.
    """

    def on_submitted(self, job: JobState) -> None: ...

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
        token = (
            f"{req.ra_deg:.5f}:{req.dec_deg:.5f}:{req.size_arcmin:.3f}:"
            f"{channels_str}:{products_str}:{req.mode}:{req.stretch}"
        )
        return hashlib.sha256(token.encode("utf-8")).hexdigest()[:20]

    def validate_request(self, req: JobRequest) -> None:
        """Validate request against contract caps and physical constraints."""
        if req.size_arcmin > MAX_REGION_SIZE_ARCMIN:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Region size {req.size_arcmin} arcmin exceeds limit of "
                    f"{MAX_REGION_SIZE_ARCMIN} arcmin; "
                    "multi-product mosaicking is pending."
                ),
            )
        if req.size_arcmin < MIN_REGION_SIZE_ARCMIN:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Region size {req.size_arcmin} arcmin must be at least "
                    f"{MIN_REGION_SIZE_ARCMIN} arcmin."
                ),
            )
        if not (1 <= len(req.channels) <= MAX_CHANNELS_PER_JOB):
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Requested channels count {len(req.channels)} must be between "
                    f"1 and {MAX_CHANNELS_PER_JOB}."
                ),
            )
        for index in req.channels:
            try:
                info = get_channel(index)
            except HTTPException:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"Channel index {index} is out of range; the DR1 cube "
                        "provides channels 0..101."
                    ),
                ) from None
            if not info["available"]:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"Channel {index} is blank in the DR1 All-Sky Cube "
                        "(frames 50 and 51 carry no data)."
                    ),
                )
        if not (-90.0 <= req.dec_deg <= 90.0):
            raise HTTPException(
                status_code=422,
                detail="Declination must be between -90 and +90 degrees.",
            )
        if "image" not in req.products:
            req.products.append("image")

    def submit(self, req: JobRequest) -> JobState:
        """Submit a job or retrieve an active/cached one, notifying observers."""
        job = self._submit(req)
        self._notify("on_submitted", job)
        return job

    def _submit(self, req: JobRequest) -> JobState:
        """Submit a job or retrieve an active/cached one."""
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
                    logger.info("job=%s cache=memory_hit", job_id)
                    self.jobs.move_to_end(job_id)
                    return job

            # Check disk snapshot cache
            snapshot_file = JOBS_CACHE_DIR / f"{job_id}.json"
            if snapshot_file.is_file():
                try:
                    with open(snapshot_file, encoding="utf-8") as f:
                        snap_data = json.load(f)
                    if snap_data.get("status") == "ready":
                        job = self._rebuild_job_from_snapshot(snap_data, req)
                        if job.cutouts and len(job.cutout_objects) == len(job.cutouts):
                            logger.info("job=%s cache=disk_hit", job_id)
                            job.cache_hit = True
                            self._put_lru(job)
                            return job
                except Exception:
                    pass

            # Create new job
            job = JobState(id=job_id, request=req)
            self._put_lru(job)
            logger.info(
                "job=%s stage=queued channels=%s size_arcmin=%s",
                job.id,
                req.channels,
                req.size_arcmin,
            )
            self.pool.submit(self._run_job, job)
            return job

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

        snapshot_file = JOBS_CACHE_DIR / f"{job_id}.json"
        if snapshot_file.is_file():
            try:
                with open(snapshot_file, encoding="utf-8") as f:
                    snap_data = json.load(f)
                req_dict = snap_data.get("request", {})
                req = JobRequest(**req_dict)
                job = self._rebuild_job_from_snapshot(snap_data, req)
                if job.cutouts and len(job.cutout_objects) == len(job.cutouts):
                    with self.lock:
                        self._put_lru(job)
                    return job
                raise HTTPException(
                    status_code=404,
                    detail=(
                        f"Job {job_id} snapshot is stale: its derived cutout cache "
                        "is incomplete. Submit the request again to rebuild it."
                    ),
                )
            except HTTPException:
                raise
            except Exception:
                pass

        raise HTTPException(
            status_code=404,
            detail=f"Unknown or expired job {job_id}",
        )

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
        )

        # Cutouts are reloaded from the derived cache using the persisted source
        # URI. If an entry was evicted, the frame routes report it honestly
        # instead of re-downloading from a guessed URL.
        for c_meta in job.cutouts:
            det = c_meta.get("detector")
            epoch = c_meta.get("epoch")
            if det is None or epoch is None:
                continue
            cutout = resolve_cutout(job, det, epoch)
            if cutout is None:
                continue
            for p in ("image", "variance"):
                job.percentiles[(det, epoch, p)] = compute_cutout_percentiles(
                    getattr(cutout, p), is_variance=(p == "variance")
                )

        return job

    def _save_snapshot_to_disk(self, job: JobState) -> None:
        """Persist snapshot JSON to JOBS_CACHE_DIR."""
        try:
            target = JOBS_CACHE_DIR / f"{job.id}.json"
            snapshot = job.to_snapshot()
            with open(target, "w", encoding="utf-8") as f:
                json.dump(snapshot, f, indent=2)
        except Exception as exc:
            logger.warning("Failed to persist job %s snapshot: %s", job.id, exc)

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

            discovery = resolve_region(ra, dec, size)
            self._notify("on_discovered", job, discovery)
            if discovery["coverage"] == "none":
                job.status = "failed"
                job.progress = 100
                job.stage = "Failed"
                job.events.append({"stage": job.stage, "at": time.time()})
                logger.info(
                    "job=%s stage=%s progress=%s", job.id, job.stage, job.progress
                )
                job.error = "No SPHEREx coverage found for this region."
                self._save_snapshot_to_disk(job)
                return
            if discovery["coverage"] == "unknown":
                job.status = "failed"
                job.progress = 100
                job.stage = "Failed"
                job.events.append({"stage": job.stage, "at": time.time()})
                logger.info(
                    "job=%s stage=%s progress=%s", job.id, job.stage, job.progress
                )
                job.error = (
                    "Coverage could not be determined: IRSA TAP discovery failed. "
                    "Retry the request. "
                    f"Discovery error: {discovery.get('warning') or 'unknown'}"
                )
                self._save_snapshot_to_disk(job)
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
                    # In latest mode, prefer local asset for detector 2
                    local_match = next((p for p in prods if p["source"] == "local"), None)
                    if local_match is not None:
                        selected_targets.append((local_match, 0))
                    else:
                        # Newest remote product (highest date_mjd)
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
                job.status = "failed"
                job.progress = 100
                job.stage = "Failed"
                job.events.append({"stage": job.stage, "at": time.time()})
                logger.info(
                    "job=%s stage=%s progress=%s", job.id, job.stage, job.progress
                )
                job.error = (
                    f"None of the requested channels {req.channels} have "
                    "available detector coverage."
                )
                self._save_snapshot_to_disk(job)
                return

            # Enforce max cutout downloads cap
            if len(selected_targets) > MAX_CUTOUT_DOWNLOADS_PER_JOB:
                selected_targets = selected_targets[:MAX_CUTOUT_DOWNLOADS_PER_JOB]

            # Stage 2: Downloading
            job.status = "downloading"
            remote_downloads = [
                prod for prod, _ in selected_targets if prod.get("source") == "remote"
            ]
            total_dl = len(remote_downloads)

            if total_dl > 0:
                job.progress = 20
                job.stage = f"Downloading DR1 cutouts 0/{total_dl}"
                job.events.append({"stage": job.stage, "at": time.time()})
                logger.info(
                    "job=%s stage=%s progress=%s", job.id, job.stage, job.progress
                )

                dl_futures = [
                    self.download_pool.submit(download_cutout, p["uri"])
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

            loaded_cutouts: dict[tuple[int, int], DerivedCutout] = {}
            for prod, epoch in selected_targets:
                cutout = get_or_extract_derived(prod, ra, dec, size, epoch=epoch)
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
            logger.exception("Error processing job %s: %s", job.id, exc)
            job.status = "failed"
            job.progress = 100
            job.stage = "Failed"
            job.events.append({"stage": job.stage, "at": time.time()})
            logger.info("job=%s stage=%s progress=%s", job.id, job.stage, job.progress)
            job.error = f"{type(exc).__name__}: {exc}"
            self._save_snapshot_to_disk(job)
        finally:
            self._notify("on_finished", job)


job_manager = JobManager()


def resolve_cutout(job: JobState, detector: int, epoch: int) -> DerivedCutout | None:
    """Return a job cutout from memory or the derived disk cache (never network)."""
    cutout = job.cutout_objects.get((detector, epoch))
    if cutout is not None:
        return cutout

    meta = next(
        (
            c
            for c in job.cutouts
            if c.get("detector") == detector and c.get("epoch") == epoch
        ),
        None,
    )
    if meta is None or not meta.get("uri"):
        return None

    cutout = load_derived_cutout(meta["uri"], detector, epoch)
    if cutout is None:
        return None

    with job_manager.lock:
        job.cutout_objects[(detector, epoch)] = cutout
    return cutout


def get_pixel_probe(
    job_id: str,
    x: int,
    y: int,
    channel: int,
    epoch: int = 0,
) -> dict[str, Any]:
    """Inspect single pixel: data, wavelength, and active flag bits."""
    job = job_manager.get_job(job_id)
    if job.status != "ready":
        raise HTTPException(
            status_code=409,
            detail=job.error or f"Job {job_id} is in status '{job.status}'",
        )

    det = (channel // 17) + 1
    cutout = resolve_cutout(job, det, epoch)
    if cutout is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Cutout for channel {channel} (detector {det}) epoch {epoch} "
                "is not available in this job; the derived cache entry may have "
                "been evicted. Re-run the job to rebuild it."
            ),
        )

    h, w = cutout.image.shape
    if not (0 <= x < w and 0 <= y < h):
        raise HTTPException(
            status_code=422,
            detail=f"Pixel coordinates ({x}, {y}) outside cutout dimensions {w}x{h}",
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
        "wavelength_status": WAVELENGTH_STATUS,
        "calibrated": CALIBRATED,
    }


def get_job_manifest(job_id: str) -> dict[str, Any]:
    """Assemble complete provenance document for a ready job."""
    job = job_manager.get_job(job_id)
    if job.status != "ready":
        raise HTTPException(
            status_code=409,
            detail=job.error or f"Job {job_id} is in status '{job.status}'",
        )

    manifest_cutouts = []
    versions: list[str] = []
    dates: list[str] = []
    units: dict[str, str] = {}
    flag_definitions: dict[int, dict[str, Any]] = {}

    for c in job.cutouts:
        det = c["detector"]
        epoch = c["epoch"]
        cutout = resolve_cutout(job, det, epoch)
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

    release = "SPHEREx DR1 level-2"
    if versions:
        release = f"SPHEREx DR1 level-2 ({', '.join(sorted(versions))})"

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
        "lvf_status": WAVELENGTH_STATUS,
        "wavelength_status": WAVELENGTH_STATUS,
        "calibrated": CALIBRATED,
        "flag_definitions": [flag_definitions[b] for b in sorted(flag_definitions)],
        "cache": {"hit": job.cache_hit},
        "multi_product_mosaic": MULTI_PRODUCT_MOSAIC,
        "collection": "SPHEREx DR1 Level-2 spectral image cutouts",
        "cutouts": manifest_cutouts,
        "notes": [
            (
                "WCS-WAVE is approximate visualization-grade; "
                "calibrated CWAVE/CBAND unavailable in this release."
            ),
            "Multi-product mosaicking is pending; cutouts are single-detector products.",
        ],
    }
