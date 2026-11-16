# Calibrated, per-epoch SPHEREx mosaics

The mosaic engine combines only **product-verified CWAVE/CBAND inputs** from one
detector, selected channel and official large-slew. Existing WCS-WAVE cutouts do
not meet that calibration requirement. No real calibrated mosaic is claimed by
the offline software tests.

## Run the offline checks

```bash
cd apps/server
uv run --no-sync pytest tests/test_mosaics.py -q
ruff check app/services/mosaics.py tests/test_mosaics.py
```

`notebooks/003_mosaics.ipynb` supplied the pixel-grid association and provenance
ideas. Its stored outputs are inconsistent, and its unweighted average is not
used as evidence that the new coadder is scientifically validated.

## Supply verified calibration

Set `SPHEREX_CALIBRATION_MANIFEST` to a local JSON file. A manifest can contain
one record or `{"products": [record, ...]}`. Every source needs exactly one record
matching **both** its observation ID and original artifact URI, and its version
and detector. Do not substitute the region cutout URL for the original URI.

```json
{
  "product": {
    "obs_id": "2025W18_2B_0001_1",
    "original_product_uri": "exact-source-artifact-uri",
    "version": "12"
  },
  "detector": 1,
  "calibration_path": "associated-cutout-spectral-wcs.fits",
  "calibration_id": "verified-spectral-wcs-identity",
  "calibration_version": "4",
  "pixel_alignment": {
    "method": "identical_celestial_wcs_and_shape",
    "science_shape": [100, 100],
    "calibration_shape": [100, 100],
    "wcs_sha256": "sha256-of-normalized-celestial-wcs"
  }
}
```

`calibration_path` is local, resolved relative to the manifest; no calibration is
downloaded automatically. Its `CWAVE` and `CBAND` HDUs must have exactly matching
celestial WCS and shape, with wavelength-equivalent `BUNIT` values (for example
`um`). Both are converted to micrometres. CBAND is a **bandwidth**, not a channel
index. Nonfinite CWAVE or nonpositive/nonfinite CBAND pixels cannot contribute.

Compute the reproducible WCS hash using the implementation itself:

```bash
uv run --no-sync python - <<'PY'
from astropy.io import fits
from app.services.mosaics import celestial_wcs_fingerprint
print(celestial_wcs_fingerprint(fits.getheader("science-cutout.fits", "IMAGE")))
print(celestial_wcs_fingerprint(fits.getheader("associated-cutout-spectral-wcs.fits", "CWAVE")))
print(celestial_wcs_fingerprint(fits.getheader("associated-cutout-spectral-wcs.fits", "CBAND")))
PY
```

All three hashes must agree with `wcs_sha256`. Equal shape alone is insufficient.
For an exact integer crop from a full-frame celestial calibration, use method
`integer_pixel_crop`, add `science_pixel_origin: [x0, y0]` (zero-based), and specify
the full `calibration_shape`. The cropped calibration WCS must still hash to the
science WCS. Detector-space calibration lacking an associated celestial grid is
not accepted merely because its array dimensions match. Establish that mapping
before supplying the manifest; this adapter does not invent it.

The manifest is an operator-supplied calibration association, not independent
proof of an upstream processing release. Use actual release provenance, not
placeholder identities. The calibration file SHA-256 and normalized WCS hash
are retained with each contributor. A metadata `calibrated: true` flag cannot
bypass the loader.

## Coaddition and limits

| Behavior | Implementation |
| --- | --- |
| Spatial grid | North-up ICRS TAN, 6.13 arcsec pixels, requested 1–180 arcmin square (180 arcmin gives 1762² pixels) |
| Pixel selection | Verified CWAVE within the requested channel window; verified positive CBAND; finite IMAGE; finite positive VARIANCE; flag rejection |
| Resampling | Nearest native pixel, including SIP transformations; chunked 128-row coordinate grids |
| Image | `sum(image / variance) / sum(1 / variance)`, normalized to MJy/sr |
| Variance | `1 / sum(1 / variance)` in (MJy/sr)², assuming independent input exposures |
| Flags | Discrete bitwise OR of accepted contributors only; never interpolate flag intensities |
| Coverage | Boolean coverage and integer `NHITS`; uncovered image/variance/wavelength/bandwidth are NaN |
| Provenance | Original products, versions, dates, provider, calibration file/WCS hashes, contributing counts and algorithm identity |
| Zodiacal light | Not subtracted; do not compare directly to the ZODI-subtracted All-Sky Cube as if identical |

By default **every nonzero flag is rejected**; no undocumented good/bad bit
meanings are inferred. An explicitly vetted per-record `reject_flag_bits`
nonnegative integer permits selective rejection (for example `1` rejects bit 0);
remaining flags are still propagated. Duplicate original products cannot be
counted twice.

Nearest sampling avoids interpolating variance as intensity, but can repeat one
native sample into adjacent output pixels. The exported variance does **not**
model that output-pixel covariance or correlated noise between exposures. It is
not a claim of flux-integrated photometric equivalence or IRSA Mosaic Tool
weighting. Surface-brightness preservation, independent-input variance, masks,
flags, RA wrap, rotation, SIP and grid centering are tested synthetically; real
calibrated exposures and science validation remain required.

An epoch is the official planning period plus large-slew counter, e.g.
`2025W18_2B_0001`. Small-slew counters 1–4 can contribute to it. Different epochs
are never coadded. At most 12 epochs are selected nearest uniformly spaced
observation times, preserving the first and last. Inputs with unknown official
identities or nonfinite dates cannot silently become inferred epochs.

## Display derivatives

`shared_percentiles` computes one [1,99] stretch across epochs, sampling at most
100,000 pixels per epoch to bound the calculation. PNG playback and GIF export
must use the same bounds. GIF encoding accepts 2–12 equal-grid arrays, uses 500 ms
per epoch, loops, and reduces display dimensions to at most 1024 px. It preserves
individual epochs even when their displayed pixels are identical. GIF is an
8-bit display derivative, **not a scientific FITS product**. Changing sources,
region, channel window, calibration bytes or algorithm changes the mosaic cache
identity.

## Sources

- [SPHEREx products, IDs and calibration guidance](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/)
- [Astropy WCS transforms](https://docs.astropy.org/en/stable/wcs/)
