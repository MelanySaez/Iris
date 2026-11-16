"""Open the user's own SPHEREx FITS as a Plate job.

Two layouts are accepted, matching what the app itself serves:

* ``spherex_l2``: a SPHEREx Level-2 image or cutout with IMAGE, VARIANCE and
  FLAGS HDUs and the key-W WCS-WAVE lookup. It is read with the same extractor
  as remote cutouts, so every plate feature works for its detector.
* ``dr1_cube_tile``: a DR1 All-Sky Cube tile (the format the cube fallback
  reads), with IMAGE, FLAGS and NHITS cubes and the SPECTRAL_CHANNELS table.
  Each plane becomes one channel cutout; there is no VARIANCE and no epoch.

Uploads are stored by content hash, so the same file always opens the same
plate. They are not saved as Records, which describe Sky regions.
"""

from __future__ import annotations

import hashlib
import logging
import math
import os
import tempfile
import time
from collections.abc import Iterable
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales

from app.core.config import (
    MAX_REGION_SIZE_ARCMIN,
    MAX_UPLOAD_BYTES,
    MIN_REGION_SIZE_ARCMIN,
    UPLOAD_DIR,
    WAVELENGTH_STATUS,
)
from app.exceptions.domain import UploadRejectedError, UploadTooLargeError
from app.schemas.jobs import JobRequest
from app.services.channels import get_channel_window
from app.services.cube_fallback import (
    CUBE_WAVELENGTH_STATUS,
    CubeCutout,
    pixel_scale_from_wcs,
)
from app.services.cube_spectrum import celestial_wcs
from app.services.fits import DerivedCutout, extract_cutout_fits, save_derived_cutout
from app.services.jobs import JobState, job_manager
from app.services.rendering import compute_cutout_percentiles

logger = logging.getLogger(__name__)

UPLOAD_SOURCE = "upload"
L2_FORMAT = "spherex_l2"
CUBE_FORMAT = "dr1_cube_tile"
L2_HDUS = ("IMAGE", "VARIANCE", "FLAGS", "WCS-WAVE")
CUBE_HDUS = ("IMAGE", "FLAGS", "NHITS", "SPECTRAL_CHANNELS")
CHANNELS_PER_DETECTOR = 17


class UploadWriter:
    """Write an upload to the cache as it arrives, refusing it past the size cap.

    Use as a context manager: an unfinished or refused upload leaves no file.
    """

    def __init__(self) -> None:
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(dir=UPLOAD_DIR, prefix=".upload.", suffix=".tmp")
        self._handle = os.fdopen(fd, "wb")
        self._tmp = Path(tmp_name)
        self._digest = hashlib.sha256()
        self.size = 0

    def write(self, chunk: bytes) -> None:
        self.size += len(chunk)
        if self.size > MAX_UPLOAD_BYTES:
            raise UploadTooLargeError(
                f"The file is larger than the {MAX_UPLOAD_BYTES} bytes Plate accepts."
            )
        self._digest.update(chunk)
        self._handle.write(chunk)

    def finish(self) -> tuple[Path, str]:
        """Publish the upload under its content hash; return its path and hash."""
        self._handle.close()
        if self.size == 0:
            raise UploadRejectedError("The uploaded file is empty.")
        content_hash = self._digest.hexdigest()
        path = UPLOAD_DIR / f"{content_hash}.fits"
        os.replace(self._tmp, path)
        return path, content_hash

    def __enter__(self) -> UploadWriter:
        return self

    def __exit__(self, *exc: object) -> None:
        self._handle.close()
        self._tmp.unlink(missing_ok=True)


def store_upload(chunks: Iterable[bytes]) -> tuple[Path, str]:
    """Store an iterable of chunks; return the cached path and content hash."""
    with UploadWriter() as writer:
        for chunk in chunks:
            writer.write(chunk)
        return writer.finish()


def _missing(names: set[str], required: tuple[str, ...]) -> list[str]:
    return [name for name in required if name not in names]


def detect_format(hdul: fits.HDUList) -> str:
    """Name the SPHEREx layout of an open file, or explain what is missing."""
    names = {hdu.name.upper() for hdu in hdul}
    image_axes = int(hdul["IMAGE"].header.get("NAXIS", 0)) if "IMAGE" in names else 0
    if not _missing(names, CUBE_HDUS) and image_axes == 3:
        return CUBE_FORMAT
    if not _missing(names, L2_HDUS) and image_axes == 2:
        if "CTYPE1W" not in hdul["IMAGE"].header:
            raise UploadRejectedError(
                "This Level-2 file has no key-W WCS-WAVE axes in its IMAGE header, "
                "so its wavelengths cannot be read."
            )
        return L2_FORMAT
    l2_missing = _missing(names, L2_HDUS) or ["a 2-D IMAGE"]
    cube_missing = _missing(names, CUBE_HDUS) or ["a 3-D IMAGE cube"]
    raise UploadRejectedError(
        "This FITS is not a SPHEREx file Plate can open. A SPHEREx Level-2 image "
        f"needs {', '.join(L2_HDUS)} (missing: {', '.join(l2_missing)}); a DR1 "
        f"All-Sky Cube tile needs {', '.join(CUBE_HDUS)} "
        f"(missing: {', '.join(cube_missing)})."
    )


def _request(ra: float, dec: float, extent_arcmin: float, channel: int) -> JobRequest:
    """Job request for display; the true extent is kept in ``job.upload``."""
    size = min(MAX_REGION_SIZE_ARCMIN, max(MIN_REGION_SIZE_ARCMIN, extent_arcmin))
    return JobRequest(
        ra_deg=ra % 360.0,
        dec_deg=dec,
        size_arcmin=round(size, 3),
        channels=[channel],
        products=["image", "variance", "flags"],
    )


def _frame(job_id: str, cutout: DerivedCutout, channel: int, product: str) -> dict:
    h, w = cutout.image.shape
    base = f"/api/jobs/{job_id}/frames/{channel}"
    win_min, win_max = get_channel_window(channel)
    return {
        "channel": channel,
        "product": product,
        "detector": cutout.detector,
        "epoch": 0,
        "obs_id": cutout.obs_id,
        "date_iso": cutout.date_iso,
        "source": UPLOAD_SOURCE,
        "calibrated": False,
        "wavelength_status": cutout.metadata["wavelength_status"],
        "width": int(w),
        "height": int(h),
        "url": f"{base}/{product}.png?mode=full&epoch=0",
        "slice_url": f"{base}/{product}.png?mode=slice&epoch=0",
        "wavelengths_url": f"{base}/wavelengths.npy?epoch=0",
        "window_um": [win_min, win_max],
    }


def _cutout_meta(cutout: DerivedCutout, channel: int | None = None) -> dict:
    meta = cutout.metadata
    h, w = cutout.image.shape
    wave = cutout.wavelength[np.isfinite(cutout.wavelength)]
    band = cutout.bandwidth[np.isfinite(cutout.bandwidth)]
    entry = {
        "detector": cutout.detector,
        "epoch": 0,
        "obs_id": cutout.obs_id,
        "date_iso": cutout.date_iso,
        "source": UPLOAD_SOURCE,
        "calibrated": False,
        "wavelength_status": meta["wavelength_status"],
        "uri": cutout.uri,
        "version": str(meta.get("version", "")),
        "shape": [int(h), int(w)],
        "pixel_scale_arcsec": float(meta.get("pixel_scale_arcsec", 0.0)),
        "wavelength_min_um": round(float(wave.min()) if wave.size else 0.0, 4),
        "wavelength_max_um": round(float(wave.max()) if wave.size else 0.0, 4),
        "bandwidth_median_um": round(float(np.median(band)) if band.size else 0.0, 4),
        "image_unit": meta.get("units", {}).get("image", "MJy / sr"),
        "variance_unit": meta.get("units", {}).get("variance", ""),
        "flags_defined": bool(meta.get("flag_bits")),
        "flag_bits": meta.get("flag_bits", []),
    }
    if channel is not None:
        entry["channel"] = channel
    return entry


def _open_level2(path: Path, job_id: str, filename: str) -> JobState:
    with fits.open(path, memmap=True) as hdul:
        header = hdul["IMAGE"].header
        ny, nx = hdul["IMAGE"].data.shape
        spatial = WCS(header).celestial
        detector = int(header.get("DETECTOR", 0))
    if detector not in range(1, 7):
        raise UploadRejectedError(
            "The IMAGE header has no SPHEREx DETECTOR (1..6), so its channels "
            "cannot be identified."
        )
    ra, dec = (
        float(v) for v in spatial.pixel_to_world_values((nx - 1) / 2, (ny - 1) / 2)
    )
    arrays, metadata = extract_cutout_fits(path, ra, dec)
    uri = f"{UPLOAD_SOURCE}:{job_id}"
    metadata.update(
        detector=detector,
        uri=uri,
        source=UPLOAD_SOURCE,
        calibrated=False,
        wavelength_status=WAVELENGTH_STATUS,
        upload_format=L2_FORMAT,
        filename=filename,
        original_product_uri=filename,
    )
    cutout = DerivedCutout(
        detector=detector,
        epoch=0,
        obs_id=metadata.get("obs_id", ""),
        date_iso=metadata.get("date_iso", ""),
        source=UPLOAD_SOURCE,
        uri=uri,
        metadata=metadata,
        **arrays,
    )
    save_derived_cutout(cutout)

    channels = list(
        range((detector - 1) * CHANNELS_PER_DETECTOR, detector * CHANNELS_PER_DETECTOR)
    )
    scale = float(metadata.get("pixel_scale_arcsec") or 0.0) or float(
        min(proj_plane_pixel_scales(spatial)) * 3600.0
    )
    extent = max(nx, ny) * scale / 60.0
    job = JobState(id=job_id, request=_request(ra, dec, extent, channels[0]))
    job.cutout_objects[(detector, 0)] = cutout
    job.percentiles[(detector, 0, "image")] = compute_cutout_percentiles(cutout.image)
    job.percentiles[(detector, 0, "variance")] = compute_cutout_percentiles(
        cutout.variance, is_variance=True
    )
    job.cutouts = [_cutout_meta(cutout)]
    job.frames = [
        _frame(job_id, cutout, channel, product)
        for channel in channels
        for product in ("image", "variance", "flags")
    ]
    job.upload = {
        "filename": filename,
        "format": L2_FORMAT,
        "detector": detector,
        "extent_arcmin": round(extent, 2),
        "temporal_available": False,
    }
    job.animation_reason = (
        f"Uploaded SPHEREx Level-2 image ({filename}): one observation, so there "
        "are no epochs to compare."
    )
    return job


def _iso(value: str) -> str:
    return value if not value or value.endswith("Z") else f"{value}Z"


def _mjd(value: str) -> float:
    try:
        return float(Time(value, format="isot", scale="utc").mjd)
    except ValueError:
        return 0.0


def _open_cube_tile(path: Path, job_id: str, filename: str) -> JobState:
    from app.services.cube_fallback import no_temporal_notice

    with fits.open(path, memmap=True) as hdul:
        primary = hdul[0].header
        image_hdu = hdul["IMAGE"]
        depth, height, width = image_hdu.data.shape
        for name in ("FLAGS", "NHITS"):
            if hdul[name].data.shape != (depth, height, width):
                raise UploadRejectedError(f"{name} does not have the IMAGE cube shape.")
        rows = hdul["SPECTRAL_CHANNELS"].data
        if len(rows) != depth:
            raise UploadRejectedError(
                f"SPECTRAL_CHANNELS has {len(rows)} rows but IMAGE has {depth} planes."
            )
        wcs = celestial_wcs(image_hdu.header)
        scale = pixel_scale_from_wcs(wcs, width, height)
        ra, dec = (
            float(v) for v in wcs.pixel_to_world_values((width - 1) / 2, (height - 1) / 2)
        )
        if not (math.isfinite(ra) and math.isfinite(dec)):
            raise UploadRejectedError("The cube tile WCS does not give a sky position.")
        date_beg = str(primary.get("DATE-BEG", ""))
        date_end = str(primary.get("DATE-END", ""))
        unit = str(image_hdu.header.get("BUNIT", "MJy/sr")).strip()
        notice = no_temporal_notice(date_beg, date_end).replace(
            "IRSA TAP discovery is unavailable, so this result comes from the SPHEREx "
            "DR1 All-Sky Cube on S3.",
            f"This plate shows your DR1 All-Sky Cube tile ({filename}).",
        )
        header = dict(wcs.to_header())
        job = JobState(
            id=job_id, request=_request(ra, dec, max(width, height) * scale / 60.0, 0)
        )
        default_channel: int | None = None
        for k in range(depth):
            detector = int(rows["DETECTOR"][k])
            wavelength = float(rows["WAVELENGTH"][k])
            bandwidth = float(rows["BANDWIDTH"][k])
            image = np.asarray(image_hdu.data[k], dtype=np.float32)
            if default_channel is None and np.isfinite(image).any():
                default_channel = k
            uri = f"{UPLOAD_SOURCE}:{job_id}:ch{k}"
            cutout = CubeCutout(
                detector=detector,
                epoch=0,
                obs_id=filename,
                date_iso=_iso(date_end),
                source=UPLOAD_SOURCE,
                uri=uri,
                image=image,
                variance=np.full(image.shape, np.nan, dtype=np.float32),
                flags=np.asarray(hdul["FLAGS"].data[k], dtype=np.int32),
                wavelength=np.full(image.shape, wavelength, dtype=np.float32),
                bandwidth=np.full(image.shape, bandwidth, dtype=np.float32),
                nhits=np.asarray(hdul["NHITS"].data[k], dtype=np.int32),
                metadata={
                    "wcs_header": header,
                    "spatial_header": header,
                    "detector": detector,
                    "channel": k,
                    "obs_id": filename,
                    "date_mjd": _mjd(date_end),
                    "date_iso": _iso(date_end),
                    "date_beg": date_beg,
                    "date_end": date_end,
                    "source": UPLOAD_SOURCE,
                    "version": str(primary.get("VERSION", "")),
                    "shape": [int(height), int(width)],
                    "pixel_scale_arcsec": round(scale, 2),
                    "units": {"image": unit, "variance": ""},
                    "flag_bits": [],
                    "calibrated": False,
                    "wavelength_status": CUBE_WAVELENGTH_STATUS,
                    "temporal": False,
                    "has_variance": False,
                    "blank_channel": not bool(np.isfinite(image).any()),
                    "channel_wavelength_um": wavelength,
                    "channel_bandwidth_um": bandwidth,
                    "upload_format": CUBE_FORMAT,
                    "filename": filename,
                    "uri": uri,
                },
            )
            save_derived_cutout(cutout)
            job.cutouts.append(_cutout_meta(cutout, channel=k))
            job.frames.extend(_frame(job_id, cutout, k, p) for p in ("image", "flags"))

    if default_channel is not None:
        job.request = _request(ra, dec, job.request.size_arcmin, default_channel)
    job.upload = {
        "filename": filename,
        "format": CUBE_FORMAT,
        "detector": None,
        "extent_arcmin": round(max(width, height) * scale / 60.0, 2),
        "temporal_available": False,
        "date_beg": date_beg,
        "date_end": date_end,
    }
    job.animation_reason = notice
    return job


def open_upload(path: Path, content_hash: str, filename: str) -> JobState:
    """Turn a stored upload into a ready Plate job (reusing it when known)."""
    job_id = f"upload-{content_hash[:20]}"
    try:
        existing = job_manager.get_job(job_id)
        if existing.status == "ready":
            return existing
    except Exception:  # noqa: BLE001 - unknown or stale: build it again
        pass

    started = time.time()
    try:
        with fits.open(path, memmap=True) as hdul:
            file_format = detect_format(hdul)
    except UploadRejectedError:
        raise
    except Exception as exc:  # noqa: BLE001 - astropy raises many types
        raise UploadRejectedError(
            f"This is not a readable FITS file ({type(exc).__name__})."
        ) from None

    try:
        if file_format == L2_FORMAT:
            job = _open_level2(path, job_id, filename)
        else:
            job = _open_cube_tile(path, job_id, filename)
    except UploadRejectedError:
        raise
    except Exception as exc:  # noqa: BLE001 - malformed headers or tables
        logger.warning("upload %s could not be read: %r", job_id, exc)
        raise UploadRejectedError(
            f"This SPHEREx file could not be read: {type(exc).__name__}: {exc}"
        ) from None

    job.status = "ready"
    job.progress = 100
    job.stage = "Ready"
    job.events = [
        {"stage": f"Opened uploaded FITS {filename}", "at": started},
        {"stage": "Ready", "at": time.time()},
    ]
    with job_manager.lock:
        job_manager._put_lru(job)
    job_manager._save_snapshot_to_disk(job)
    return job
