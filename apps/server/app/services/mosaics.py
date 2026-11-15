"""Product-verified spectral calibration, bounded per-slew mosaics and GIFs.

The nearest-neighbour sampler deliberately preserves discrete flags and avoids
claiming bilinear-interpolation noise independence. It is not IRSA's coadder.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import astropy.units as u
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from PIL import GifImagePlugin, Image

from app.services.channels import get_channel_window
from app.services.fits import DerivedCutout
from app.services.rendering import apply_stretch

MAX_EPOCHS = 12
PIXEL_SCALE_ARCSEC = 6.13
ALGORITHM = "inverse_variance_nearest_v1"
_SLEW = re.compile(
    r"(?<![A-Za-z0-9])(\d{4}W\d{2}_[A-Z0-9]+_\d{4})_[1-4]"
    r"(?:D[1-6])?(?=$|[^A-Za-z0-9])"
)


class NoContributingPixelsError(ValueError):
    """No calibrated valid pixels overlap this requested channel and region."""


class CalibrationUnavailableError(ValueError):
    """The product-to-calibration association or pixel alignment is unproven."""


@dataclass
class _VerifiedCutout(DerivedCutout):
    """Only the manifest verifier constructs eligible mosaic inputs."""


@dataclass
class MosaicCutout(DerivedCutout):
    coverage: np.ndarray
    nhits: np.ndarray


def celestial_wcs_fingerprint(header: dict | fits.Header) -> str:
    """Fingerprint the normalized celestial WCS, including SIP coefficients."""
    canonical = (
        WCS(header)
        .celestial.to_header(relax=True)
        .tostring(sep="\n", endcard=False, padding=False)
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _source_uri(cutout: DerivedCutout) -> str:
    return str(cutout.metadata.get("original_product_uri") or cutout.uri)


def _read_calibration(cutout: DerivedCutout, path: Path) -> _VerifiedCutout:
    payload = json.loads(path.read_text(encoding="utf-8"))
    entries = payload.get("products", [payload]) if isinstance(payload, dict) else []
    matches = [
        r
        for r in entries
        if isinstance(r, dict)
        and r.get("product", {}).get("obs_id") == cutout.obs_id
        and r.get("product", {}).get("original_product_uri") == _source_uri(cutout)
    ]
    if len(matches) != 1:
        raise CalibrationUnavailableError(
            "Exactly one matching product identity is required"
        )
    record = matches[0]
    version = str(cutout.metadata.get("version", "")).strip()
    if not version or str(record["product"].get("version", "")) != version:
        raise CalibrationUnavailableError("Calibration product version mismatch")
    if int(record.get("detector", 0)) != cutout.detector:
        raise CalibrationUnavailableError("Calibration detector mismatch")
    for field in ("calibration_id", "calibration_version"):
        if not str(record.get(field, "")).strip():
            raise CalibrationUnavailableError(f"Missing {field}")
    if not cutout.metadata.get("wcs_header"):
        raise CalibrationUnavailableError("Science celestial WCS is unavailable")
    alignment = record.get("pixel_alignment", {})
    if alignment.get("method") not in (
        "identical_celestial_wcs_and_shape",
        "integer_pixel_crop",
    ):
        raise CalibrationUnavailableError("Pixel alignment method is unproven")
    shape = tuple(cutout.image.shape)
    if alignment.get("science_shape") != list(shape):
        raise CalibrationUnavailableError("Science shape mismatch")
    fingerprint = celestial_wcs_fingerprint(cutout.metadata["wcs_header"])
    if alignment.get("wcs_sha256") != fingerprint:
        raise CalibrationUnavailableError("Science WCS fingerprint mismatch")
    calibration_path = Path(record.get("calibration_path", ""))
    if not calibration_path.is_absolute():
        calibration_path = path.parent / calibration_path
    if not calibration_path.is_file():
        raise CalibrationUnavailableError("Local calibration FITS is unavailable")
    if calibration_path.stat().st_size > 128 * 1024 * 1024:
        raise CalibrationUnavailableError("Calibration FITS exceeds 128 MiB limit")
    arrays = []
    with fits.open(calibration_path, memmap=False) as hdul:
        for name in ("CWAVE", "CBAND"):
            hdu = hdul[name]
            data = np.asarray(hdu.data)
            if data.ndim != 2 or list(data.shape) != alignment.get("calibration_shape"):
                raise CalibrationUnavailableError(f"{name} shape mismatch")
            wcs = WCS(hdu.header).celestial
            if alignment["method"] == "integer_pixel_crop":
                origin = alignment.get("science_pixel_origin", [])
                if len(origin) != 2 or any(type(v) is not int or v < 0 for v in origin):
                    raise CalibrationUnavailableError("Invalid integer calibration crop")
                x, y = origin
                if y + shape[0] > data.shape[0] or x + shape[1] > data.shape[1]:
                    raise CalibrationUnavailableError(
                        "Calibration crop outside pixel grid"
                    )
                slc = (slice(y, y + shape[0]), slice(x, x + shape[1]))
                data = data[slc]
                wcs = wcs.slice(slc)
            if (
                data.shape != shape
                or celestial_wcs_fingerprint(wcs.to_header(relax=True)) != fingerprint
            ):
                raise CalibrationUnavailableError(f"{name} WCS pixel alignment mismatch")
            try:
                unit = u.Unit(hdu.header.get("BUNIT", ""))
                factor = unit.to(u.um)
            except (ValueError, u.UnitConversionError) as exc:
                raise CalibrationUnavailableError(
                    f"{name} wavelength unit invalid"
                ) from exc
            arrays.append(np.asarray(data, dtype=np.float64) * factor)
    reject_bits = record.get("reject_flag_bits")
    if reject_bits is not None and (type(reject_bits) is not int or reject_bits < 0):
        raise CalibrationUnavailableError("reject_flag_bits must be a nonnegative mask")
    digest = hashlib.sha256(calibration_path.read_bytes()).hexdigest()
    metadata = dict(cutout.metadata)
    metadata.update(
        {
            "calibrated": True,
            "wavelength_status": "calibrated_cwave_cband",
            "calibration": {
                "id": str(record["calibration_id"]),
                "version": str(record["calibration_version"]),
                "sha256": digest,
                "wcs_sha256": fingerprint,
                "reject_flag_bits": reject_bits,
            },
        }
    )
    return _VerifiedCutout(
        **{
            **cutout.__dict__,
            "wavelength": arrays[0],
            "bandwidth": arrays[1],
            "metadata": metadata,
        }
    )


def load_verified_calibration(
    cutout: DerivedCutout,
    manifest_path: str | Path | None = None,
) -> DerivedCutout:
    """Load only local, exact product/version/detector/grid-associated CWAVE/CBAND.

    A supplied ``calibrated`` metadata flag never substitutes for verification.
    The source object and its approximate maps are left untouched.
    """
    selected = manifest_path or os.environ.get("SPHEREX_CALIBRATION_MANIFEST")
    if not selected:
        raise CalibrationUnavailableError("No product-associated calibration manifest")
    try:
        return _read_calibration(cutout, Path(selected))
    except CalibrationUnavailableError:
        raise
    except (OSError, ValueError, TypeError, KeyError) as exc:
        raise CalibrationUnavailableError(
            f"Calibration verification failed: {exc}"
        ) from exc


def large_slew_id(product: dict[str, Any] | DerivedCutout) -> str | None:
    """Extract planning period plus large-slew counter from official product IDs."""
    if isinstance(product, DerivedCutout):
        values = [product.obs_id, _source_uri(product), product.uri]
    else:
        values = [
            product.get(k, "")
            for k in ("obs_id", "original_product_uri", "product_uri", "s3_url", "uri")
        ]
    for value in values:
        match = _SLEW.search(str(value))
        if match:
            return match.group(1)
    return None


def sample_epochs(groups: list[list[dict]], limit: int = MAX_EPOCHS) -> list[list[dict]]:
    """Choose nearest evenly-spaced times, preserving endpoints and chronology."""
    if not 1 <= limit <= MAX_EPOCHS:
        raise ValueError("Epoch limit must be 1–12")
    if not groups:
        return []

    def date(group):
        values = [float(p["date_mjd"]) for p in group]
        if not values or not np.isfinite(values).all():
            raise ValueError("Every epoch needs finite observation times")
        return min(values)

    ordered = sorted(groups, key=date)
    if len(ordered) <= limit:
        return ordered
    if limit == 1:
        return [ordered[-1]]
    dates = np.array([date(g) for g in ordered])
    targets = np.linspace(dates[0], dates[-1], limit)
    selected = [0]
    for i, target in enumerate(targets[1:-1], 1):
        lo = selected[-1] + 1
        hi = len(ordered) - (limit - i)
        selected.append(min(range(lo, hi + 1), key=lambda j: abs(dates[j] - target)))
    selected.append(len(ordered) - 1)
    return [ordered[i] for i in selected]


def _target_wcs(ra: float, dec: float, size: float) -> tuple[WCS, int]:
    if not (
        math.isfinite(ra)
        and math.isfinite(dec)
        and -90 <= dec <= 90
        and math.isfinite(size)
        and 1 <= size <= 180
    ):
        raise ValueError("Finite coordinates and size 1–180 arcmin are required")
    side = math.ceil(size * 60 / PIXEL_SCALE_ARCSEC)
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [ra % 360, dec]
    wcs.wcs.crpix = [(side + 1) / 2] * 2
    wcs.wcs.cdelt = [-PIXEL_SCALE_ARCSEC / 3600, PIXEL_SCALE_ARCSEC / 3600]
    return wcs, side


def build_mosaic(
    cutouts: list[DerivedCutout],
    ra_deg: float,
    dec_deg: float,
    size_arcmin: float,
    channel: int,
    epoch: int,
) -> MosaicCutout:
    """Coadd verified same-channel/same-large-slew surface brightness inputs.

    Sample nearest native pixels on the requested common TAN grid. Variance is
    1/sum(1/V) for independent contributors; cross-output-pixel covariance caused
    by repeated native samples is not modeled. No zodiacal model is subtracted.
    """
    target, side = _target_wcs(ra_deg, dec_deg, size_arcmin)
    if not cutouts or any(not isinstance(c, _VerifiedCutout) for c in cutouts):
        raise CalibrationUnavailableError("Mosaics require verified CWAVE/CBAND inputs")
    detector = channel // 17 + 1
    if any(c.detector != detector for c in cutouts):
        raise ValueError("Cannot mix detectors or a different channel detector")
    slews = {large_slew_id(c) for c in cutouts}
    if None in slews or len(slews) != 1:
        raise ValueError("Cannot mix or infer large-slew epochs")
    identities = [_source_uri(c) for c in cutouts]
    if len(set(identities)) != len(identities):
        raise ValueError("Duplicate input products would double-count variance")
    low, high = get_channel_window(channel)
    shape = (side, side)
    sum_w = np.zeros(shape, dtype=np.float64)
    sum_i = np.zeros(shape, dtype=np.float64)
    sum_wave = np.zeros(shape, dtype=np.float64)
    sum_band = np.zeros(shape, dtype=np.float64)
    flags = np.zeros(shape, dtype=np.int32)
    nhits = np.zeros(shape, dtype=np.uint16)
    provenance = []
    for cutout in cutouts:
        spatial = WCS(cutout.metadata["wcs_header"]).celestial
        calibration = cutout.metadata["calibration"]
        reject_bits = calibration.get("reject_flag_bits")
        units = cutout.metadata.get("units", {})
        try:
            image_factor = u.Unit(units["image"]).to(u.MJy / u.sr)
            variance_factor = u.Unit(units["variance"]).to((u.MJy / u.sr) ** 2)
        except (KeyError, ValueError, u.UnitConversionError) as exc:
            raise ValueError("Input image/variance units are unproven") from exc
        valid = (
            np.isfinite(cutout.image)
            & np.isfinite(cutout.variance)
            & (cutout.variance > 0)
            & np.isfinite(cutout.wavelength)
            & np.isfinite(cutout.bandwidth)
            & (cutout.bandwidth > 0)
            & (cutout.wavelength >= low)
            & (cutout.wavelength <= high)
        )
        valid &= (
            (cutout.flags == 0)
            if reject_bits is None
            else ((cutout.flags & reject_bits) == 0)
        )
        ny, nx = cutout.image.shape
        contributed = 0
        for y0 in range(0, side, 128):
            yy, xx = np.mgrid[y0 : min(y0 + 128, side), 0:side]
            ra, dec = target.pixel_to_world_values(xx, yy)
            sx, sy = spatial.world_to_pixel_values(ra, dec)
            inside = (
                np.isfinite(sx)
                & np.isfinite(sy)
                & (sx >= -0.5)
                & (sy >= -0.5)
                & (sx < nx - 0.5)
                & (sy < ny - 0.5)
            )
            ix = np.clip(np.floor(np.nan_to_num(sx) + 0.5), 0, nx - 1).astype(int)
            iy = np.clip(np.floor(np.nan_to_num(sy) + 0.5), 0, ny - 1).astype(int)
            take = inside & valid[iy, ix]
            oy, ox = yy[take], xx[take]
            iy, ix = iy[take], ix[take]
            weights = 1.0 / (cutout.variance[iy, ix] * variance_factor)
            sum_w[oy, ox] += weights
            sum_i[oy, ox] += cutout.image[iy, ix] * image_factor * weights
            sum_wave[oy, ox] += cutout.wavelength[iy, ix] * weights
            sum_band[oy, ox] += cutout.bandwidth[iy, ix] * weights
            flags[oy, ox] |= cutout.flags[iy, ix]
            nhits[oy, ox] += 1
            contributed += len(oy)
        provenance.append(
            {
                "obs_id": cutout.obs_id,
                "uri": _source_uri(cutout),
                "source": cutout.source,
                "date_iso": cutout.date_iso,
                "version": cutout.metadata["version"],
                "calibration": calibration,
                "contributing_output_pixels": contributed,
            }
        )
    coverage = sum_w > 0
    if not np.any(coverage):
        raise NoContributingPixelsError(
            "No contributing calibrated pixels in requested channel/region"
        )

    def average(array):
        out = np.full(shape, np.nan, dtype=np.float32)
        np.divide(array, sum_w, out=out, where=coverage)
        return out

    variance = average(np.ones(shape))
    cache_identity = {
        "algorithm": ALGORITHM,
        "products": provenance,
        "channel": channel,
        "window_um": [low, high],
        "region": [ra_deg % 360, dec_deg, size_arcmin],
        "epoch": epoch,
    }
    digest = hashlib.sha256(
        json.dumps(cache_identity, sort_keys=True).encode()
    ).hexdigest()
    contributing = [p for p in provenance if p["contributing_output_pixels"] > 0]
    metadata = {
        "detector": detector,
        "epoch": epoch,
        "channel": channel,
        "large_slew_id": next(iter(slews)),
        "wcs_header": dict(target.to_header()),
        "calibrated": True,
        "wavelength_status": "calibrated_cwave_cband",
        "multi_product_mosaic": "complete" if len(contributing) > 1 else "single_input",
        "algorithm": ALGORITHM,
        "provenance": provenance,
        "date_mjd": min(float(c.metadata.get("date_mjd", 0)) for c in cutouts),
        "date_iso": min(c.date_iso for c in cutouts),
        "pixel_scale_arcsec": PIXEL_SCALE_ARCSEC,
        "shape": list(shape),
        "units": {"image": "MJy / sr", "variance": "MJy2 / sr2"},
        "flag_bits": cutouts[0].metadata.get("flag_bits", []),
        "zodi_subtracted": False,
        "coverage_fraction": float(np.mean(coverage)),
        "variance_note": (
            "Independent inputs; nearest sampling; output covariance not modeled"
        ),
    }
    sources = {p["source"] for p in contributing}
    source = next(iter(sources)) if len(sources) == 1 else "mixed"
    metadata.update(
        {
            "uri": f"mosaic:{digest}",
            "obs_id": next(iter(slews)),
            "source": source,
            "version": ",".join(sorted({str(c.metadata["version"]) for c in cutouts})),
        }
    )
    return MosaicCutout(
        detector=detector,
        epoch=epoch,
        obs_id=next(iter(slews)),
        date_iso=metadata["date_iso"],
        source=source,
        uri=f"mosaic:{digest}",
        image=average(sum_i),
        variance=variance,
        flags=flags,
        wavelength=average(sum_wave),
        bandwidth=average(sum_band),
        metadata=metadata,
        coverage=coverage,
        nhits=nhits,
    )


def shared_percentiles(images: list[np.ndarray]) -> tuple[float, float]:
    """Compute a common [1,99] display range with bounded per-epoch sampling."""
    samples = []
    for array in images:
        flat = np.asarray(array).ravel()
        sample = flat[:: max(1, math.ceil(flat.size / 100_000))]
        samples.append(sample[np.isfinite(sample)])
    values = np.concatenate(samples) if samples else np.array([])
    if not values.size:
        return 0.0, 1.0
    low, high = np.percentile(values, [1, 99])
    return float(low), float(high if high > low else low + 1e-5)


def encode_gif(images: list[np.ndarray], stretch: str = "asinh") -> bytes:
    """Encode 2–12 same-grid epochs at 2fps with one shared display stretch."""
    if not 2 <= len(images) <= MAX_EPOCHS:
        raise ValueError("Animation requires 2–12 calibrated epochs")
    if stretch not in ("linear", "asinh"):
        raise ValueError("Unknown display stretch")
    shape = images[0].shape
    if len(shape) != 2 or 0 in shape or any(a.shape != shape for a in images):
        raise ValueError("Animation frames must have equal nonempty 2D shapes")
    low, high = shared_percentiles(images)
    frames = []
    for image in images:
        frame = Image.fromarray(apply_stretch(image, low, high, stretch))
        frame.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
        frames.append(frame)
    output = io.BytesIO()
    # Pillow's high-level save merges identical adjacent frames. Write each
    # public GIF-plugin frame explicitly to retain an epoch per 500-ms frame.
    palette = [value for gray in range(256) for value in (gray, gray, gray)]
    for frame in frames:
        frame.putpalette(palette)
    header, _ = GifImagePlugin.getheader(frames[0], info={"loop": 0})
    for block in header:
        output.write(block)
    for frame in frames:
        for block in GifImagePlugin.getdata(frame, duration=500, disposal=2):
            output.write(block)
    output.write(b";")
    return output.getvalue()
