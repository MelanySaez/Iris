# Large-field SPHEREx jobs

Requests accept 1–180 arcmin. IRSA TAP remains primary; provider outages can fall
back to known S3 products. The current local S3 index is deliberately incomplete.
An empty unindexed query means unknown, not no observations.

## Run and configure

1. Apply the additive database migration before using large saved regions:
   `cd apps/server && uv run alembic upgrade head`. Migration 0007 widens
   `Numeric(5,3)` to `Numeric(6,3)` and the region/source checks without rewriting
   existing records. Downgrade refuses while incompatible records exist; never
   delete user records to force a downgrade. This change does not run migrations
   against a deployment automatically.
2. Initialize a bounded S3 sample index using the command in
   [provider checks](spherex-provider.md). `SPHEREX_S3_INDEX_PATH` selects a local
   index; no credentials or mission-wide bucket scan are needed.
3. To generate calibrated mosaics, set `SPHEREX_CALIBRATION_MANIFEST` to a local
   manifest following [the calibration contract](spherex-mosaics.md). Current
   real samples have WCS-WAVE only: the implementation does **not** claim that
   these produce verified calibrated mosaics.

Small `latest` requests without a calibration manifest retain the existing
approximate single-detector view. `history`, requests over 60 arcmin, and jobs
with a calibration manifest use the strict mosaic pipeline. No associated
verified calibration means `calibration_unavailable`, never a fake calibrated
result. Only manifest-associated candidates are considered before downloading;
then every pixel-grid/product/unit association is verified.

## API and bounded behavior

- Region/job/assistant size limit: 180 arcmin, including persisted selections.
- Discovery searches the whole square with footprint intersection and keyset
  pagination (up to 10×400 artifacts). `coverage_complete` is false if the cap or
  VOTable overflow prevents proof of completeness. Incomplete results are not
  cached as definitive absence.
- S3 fallback follows timeouts, transport failures or HTTP 5xx only. Successful
  empty results, HTTP 4xx and invalid input do not trigger it. Cutout failures
  use S3 only for the exact positively indexed observation/detector.
- A `large-slew` is one epoch. Spatial inputs are capped at 24 per epoch and
  256 MiB of loaded input arrays; excess is an explicit error, not silent
  truncation. At most 12 time-spread epochs are selected; latest uses the newest.
- Mosaics use a shared TAN WCS and native 6.13-arcsec scale, inverse-variance
  weighting and nearest-pixel sampling. They preserve surface-brightness units;
  output-pixel covariance is not modeled. ZODI is not subtracted.
- Channel-specific derived identities include inputs, calibration hashes, region,
  epoch and algorithm. Disk reload preserves masks, hit counts and provenance.
- `GET /api/jobs/{id}/animation.gif?channel_id=0` requires 2–12 calibrated epochs,
  returns a display derivative at 2 fps and at most 1024px, with a shared stretch.
- Existing PNG/NPY/pixel/manifest routes accept real epoch identifiers. Mosaic
  NPY routes additionally expose `coverage.npy` and `nhits.npy`. The timeline
  allows manual inspection of approximate images but never animates them as
  calibrated data. Playback respects reduced-motion preferences.
- Job `events` and `discovery.provider_trace` expose provider failures, fallback
  attempts and incomplete coverage. Provenance/calibration status is per frame.

## Verify

```bash
cd apps/server
uv run --no-sync pytest tests/test_expansion.py tests/test_temporal_jobs.py \
  tests/test_mosaic_schema.py tests/test_mosaics.py tests/test_spherex_provider.py -q
RUN_SPHEREX_PROVIDER_LIVE=1 uv run --no-sync pytest tests/test_spherex_provider_live.py -q -s
```

Live availability results are documented separately in the provider report.
Synthetic tests validate calibration and mosaicking mathematics; they are not
proof of a real calibrated temporal mosaic. Notebook 003 supplies useful ideas
but its saved outputs are inconsistent, so it is not accepted as validation.
