"""Remote FITS cutout downloads, WCS-WAVE maps, and derived NPZ cache."""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import numpy as np
from astropy import log as astropy_log
from astropy.io import fits
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales

from app.core.config import (
    CUTOUT_CACHE_DIR,
    CUTOUT_CONNECT_TIMEOUT,
    CUTOUT_DOWNLOAD_RETRIES,
    CUTOUT_READ_TIMEOUT,
    DERIVED_CACHE_DIR,
)

# Suppress astropy verbose WCS notices
astropy_log.setLevel("ERROR")
logging.getLogger("astropy").setLevel(logging.ERROR)

_uri_locks_guard = threading.Lock()
_uri_locks: dict[str, threading.Lock] = {}


def get_uri_lock(uri: str) -> threading.Lock:
    """Acquire a per-URI lock to prevent duplicate concurrent downloads."""
    with _uri_locks_guard:
        if uri not in _uri_locks:
            _uri_locks[uri] = threading.Lock()
        return _uri_locks[uri]


@dataclass
class DerivedCutout:
    """In-memory representation of extracted arrays and metadata for one cutout."""

    detector: int
    epoch: int
    obs_id: str
    date_iso: str
    source: str
    uri: str
    image: np.ndarray
    variance: np.ndarray
    flags: np.ndarray
    wavelength: np.ndarray
    bandwidth: np.ndarray
    metadata: dict[str, Any]


def extract_flag_bits(header: fits.Header) -> list[dict[str, Any]]:
    """Parse MP_* or MSKN/MSKD/MSKM flag bit definitions from the FLAGS header."""
    bits: dict[int, dict[str, Any]] = {}

    # Check direct MP_* cards when the FITS header provides them.
    for k in header:
        if k.startswith("MP_"):
            try:
                bit_idx = int(header[k])
                desc = header.comments[k] or ""
                bits[bit_idx] = {"bit": bit_idx, "name": k, "description": desc}
            except (ValueError, TypeError):
                continue

    # Check MSKN / MSKM / MSKD cards (as in remote DR1 cutouts)
    if not bits:
        for k in header:
            if k.startswith("MSKN"):
                suffix = k[4:]
                name = f"MP_{header[k]}"
                mask_val = header.get(f"MSKM{suffix}")
                desc = str(header.get(f"MSKD{suffix}", ""))
                if mask_val is not None:
                    try:
                        mask_int = int(mask_val)
                        bit_idx = (
                            int(round(math.log2(mask_int)))
                            if mask_int > 0
                            else int(suffix)
                        )
                        bits[bit_idx] = {
                            "bit": bit_idx,
                            "name": name,
                            "description": desc,
                        }
                    except (ValueError, TypeError):
                        pass

    return [bits[b] for b in sorted(bits.keys())]


def download_cutout(uri: str) -> Path:
    """Download a remote cutout FITS atomically into CUTOUT_CACHE_DIR."""
    uri_hash = hashlib.sha1(uri.encode("utf-8")).hexdigest()
    target_fits = CUTOUT_CACHE_DIR / f"{uri_hash}.fits"

    uri_lock = get_uri_lock(uri)
    with uri_lock:
        if target_fits.is_file() and target_fits.stat().st_size > 0:
            return target_fits

        pid = os.getpid()
        tid = threading.get_ident()
        tmp_fits = CUTOUT_CACHE_DIR / f"{uri_hash}.fits.tmp.{pid}.{tid}"

        last_exc: Exception | None = None
        received = 0
        for attempt in range(CUTOUT_DOWNLOAD_RETRIES + 1):
            try:
                timeout = httpx.Timeout(
                    CUTOUT_READ_TIMEOUT, connect=CUTOUT_CONNECT_TIMEOUT
                )
                with httpx.stream("GET", uri, timeout=timeout) as resp:
                    resp.raise_for_status()
                    with open(tmp_fits, "wb") as f:
                        for chunk in resp.iter_bytes(chunk_size=65536):
                            received += len(chunk)
                            if received > 128 * 1024 * 1024:
                                raise ValueError("Cutout exceeds 128 MiB transfer budget")
                            f.write(chunk)
                tmp_fits.replace(target_fits)
                return target_fits
            except Exception as exc:
                last_exc = exc
                if tmp_fits.exists():
                    tmp_fits.unlink()
                from app.services.spherex_provider import is_provider_unavailable

                if not is_provider_unavailable(exc):
                    break
                if attempt < CUTOUT_DOWNLOAD_RETRIES:
                    time.sleep(0.5 * (2**attempt))

        raise RuntimeError(
            f"Failed to download cutout from {uri}: {last_exc}"
        ) from last_exc


def extract_cutout_fits(
    fits_path: Path,
    ra_deg: float,
    dec_deg: float,
) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
    """Extract arrays and per-pixel WCS-WAVE map from a downloaded cutout FITS."""
    with fits.open(fits_path, memmap=True, mode="readonly") as hdul:
        img_hdu = hdul["IMAGE"]
        spatial = WCS(img_hdu.header).celestial
        ny, nx = img_hdu.data.shape

        image = np.asarray(img_hdu.data, dtype=np.float32).copy()
        variance = np.asarray(hdul["VARIANCE"].data, dtype=np.float32).copy()
        flags = np.asarray(hdul["FLAGS"].data, dtype=np.int32).copy()

        wave_wcs = WCS(img_hdu.header, fobj=hdul, key="W")
        wave_wcs.sip = None
        yy, xx = np.mgrid[0:ny, 0:nx]
        wave, bw = wave_wcs.pixel_to_world_values(xx, yy)

        wavelength = np.asarray(wave, dtype=np.float32)
        bandwidth = np.asarray(bw, dtype=np.float32)

        scale = min(proj_plane_pixel_scales(spatial)) * 3600.0  # arcsec/pixel
        corners_ra, corners_dec = spatial.pixel_to_world_values(
            [0, nx, nx, 0], [0, 0, ny, ny]
        )
        corners = [
            [float(c_ra), float(c_dec)] for c_ra, c_dec in zip(corners_ra, corners_dec)
        ]

        obs_id = str(img_hdu.header.get("OBSID", ""))
        if not obs_id:
            obs_id = str(hdul[0].header.get("OBS_ID", ""))
        mjd = float(img_hdu.header.get("MJD-OBS", 0.0))
        date_obs = str(img_hdu.header.get("DATE-OBS", ""))
        date_iso = (
            (date_obs if date_obs.endswith("Z") else date_obs + "Z") if date_obs else ""
        )
        flag_bits = extract_flag_bits(hdul["FLAGS"].header)

        metadata = {
            "wcs_header": dict(spatial.to_header(relax=True)),
            "spatial_header": dict(spatial.to_header(relax=True)),
            "detector": int(img_hdu.header.get("DETECTOR", 2)),
            "obs_id": obs_id,
            "date_mjd": mjd,
            "date_iso": date_iso,
            "source": "remote",
            "version": str(hdul[0].header.get("VERSION", "")),
            "shape": [int(ny), int(nx)],
            "pixel_scale_arcsec": round(float(scale), 2),
            "footprint": {
                "center": [float(ra_deg), float(dec_deg)],
                "corners": corners,
            },
            "units": {
                "image": str(img_hdu.header.get("BUNIT", "MJy / sr")),
                "variance": str(hdul["VARIANCE"].header.get("BUNIT", "MJy2 / sr2")),
            },
            "flag_bits": flag_bits,
        }

        arrays = {
            "image": image,
            "variance": variance,
            "flags": flags,
            "wavelength": wavelength,
            "bandwidth": bandwidth,
        }
        return arrays, metadata


def derived_cache_paths(uri: str) -> tuple[Path, Path]:
    """Return the (npz, meta.json) derived cache paths for a source URI."""
    derived_hash = hashlib.sha1(uri.encode("utf-8")).hexdigest()
    return (
        DERIVED_CACHE_DIR / f"{derived_hash}.npz",
        DERIVED_CACHE_DIR / f"{derived_hash}.meta.json",
    )


def load_derived_cutout(
    uri: str,
    detector: int,
    epoch: int = 0,
) -> DerivedCutout | None:
    """Load a cutout from the derived disk cache only.

    Never touches the network: this is the safe path for reconstructing a job
    after the in-memory LRU evicted its arrays or the server restarted.
    """
    npz_path, meta_path = derived_cache_paths(uri)
    if not (npz_path.is_file() and meta_path.is_file()):
        return None
    try:
        with open(meta_path, encoding="utf-8") as f:
            metadata = json.load(f)
        with np.load(npz_path) as npz:
            image = npz["image"]
            variance = npz["variance"]
            flags = npz["flags"]
            wavelength = npz["wavelength"]
            bandwidth = npz["bandwidth"]
    except Exception:
        return None

    cutout_type = DerivedCutout
    extra = {}
    if metadata.get("source") == "cube":
        from app.services.cube_fallback import CubeCutout

        cutout_type = CubeCutout
        with np.load(npz_path) as saved:
            if "nhits" in saved:
                extra = {"nhits": saved["nhits"]}
    elif metadata.get("calibrated") and metadata.get("channel") is not None:
        from app.services.mosaics import MosaicCutout

        cutout_type = MosaicCutout
        with np.load(npz_path) as saved:
            extra = {"coverage": saved["coverage"], "nhits": saved["nhits"]}
    return cutout_type(
        **extra,
        detector=detector,
        epoch=epoch,
        obs_id=metadata.get("obs_id", ""),
        date_iso=metadata.get("date_iso", ""),
        source=metadata.get("source", "remote"),
        uri=uri,
        image=image,
        variance=variance,
        flags=flags,
        wavelength=wavelength,
        bandwidth=bandwidth,
        metadata=metadata,
    )


def get_or_extract_derived(
    product: dict[str, Any],
    ra_deg: float,
    dec_deg: float,
    epoch: int = 0,
) -> DerivedCutout:
    """Load derived arrays and metadata from cache or extract from FITS source."""
    uri = product["uri"]
    detector = product.get("detector", 2)

    cached = load_derived_cutout(uri, detector, epoch)
    if cached is not None and cached.metadata.get("wcs_header"):
        if not cached.obs_id:
            cached.obs_id = product.get("obs_id", "")
        if not cached.date_iso:
            cached.date_iso = product.get("date_iso", "")
        return cached

    npz_path, meta_path = derived_cache_paths(uri)

    # Extract
    if product.get("source") == "s3":
        from app.services.spherex_provider import download_s3_cutout

        fits_file = download_s3_cutout(product, ra_deg, dec_deg, product["size_arcmin"])
    else:
        fits_file = download_cutout(uri)
    arrays, metadata = extract_cutout_fits(fits_file, ra_deg, dec_deg)

    metadata["detector"] = detector
    metadata["uri"] = uri
    metadata["source"] = product.get("source", "remote")
    metadata["original_product_uri"] = product.get(
        "original_product_uri", uri.split("?")[0]
    )
    metadata["obs_publisher_did"] = product.get("obs_publisher_did", "")
    if not metadata.get("obs_id"):
        metadata["obs_id"] = product.get("obs_id", "")
    if not metadata.get("date_iso"):
        metadata["date_iso"] = product.get("date_iso", "")

    # Save to derived cache
    try:
        np.savez_compressed(
            npz_path,
            image=arrays["image"],
            variance=arrays["variance"],
            flags=arrays["flags"],
            wavelength=arrays["wavelength"],
            bandwidth=arrays["bandwidth"],
        )
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(metadata, f, indent=2)
    except Exception:
        pass

    return DerivedCutout(
        detector=detector,
        epoch=epoch,
        obs_id=metadata["obs_id"],
        date_iso=metadata["date_iso"],
        source=metadata.get("source", "remote"),
        uri=uri,
        image=arrays["image"],
        variance=arrays["variance"],
        flags=arrays["flags"],
        wavelength=arrays["wavelength"],
        bandwidth=arrays["bandwidth"],
        metadata=metadata,
    )


def save_derived_cutout(cutout: DerivedCutout) -> None:
    """Persist channel-specific mosaics with their WCS, masks and provenance."""
    npz_path, meta_path = derived_cache_paths(cutout.uri)
    arrays = {
        name: getattr(cutout, name)
        for name in ("image", "variance", "flags", "wavelength", "bandwidth")
    }
    for name in ("coverage", "nhits"):
        if hasattr(cutout, name):
            arrays[name] = getattr(cutout, name)
    # URI includes algorithm/calibration identities and is written under the
    # existing per-URI lock, so a reader never sees partially replaced arrays.
    with get_uri_lock(cutout.uri):
        suffix = f".tmp.{os.getpid()}.{threading.get_ident()}"
        temp_npz = npz_path.with_name(npz_path.name + suffix)
        temp_meta = meta_path.with_name(meta_path.name + suffix)
        try:
            with temp_npz.open("wb") as stream:
                np.savez_compressed(stream, **arrays)
            temp_meta.write_text(json.dumps(cutout.metadata), encoding="utf-8")
            temp_npz.replace(npz_path)
            temp_meta.replace(meta_path)
        finally:
            temp_npz.unlink(missing_ok=True)
            temp_meta.unlink(missing_ok=True)
