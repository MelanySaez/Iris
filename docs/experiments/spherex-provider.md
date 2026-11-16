# Bounded SPHEREx provider fallback

IRSA remains primary. The experimental NASA S3 adapter can create compatible
clipped FITS cutouts from positively indexed products. It cannot prove global or
temporal absence, or turn WCS-WAVE into verified CWAVE/CBAND calibration.

## Check it

From `apps/server`:

```bash
uv run --no-sync pytest tests/test_spherex_provider.py -q
RUN_SPHEREX_PROVIDER_LIVE=1 uv run --no-sync pytest \
  tests/test_spherex_provider_live.py -q -s
```

Ordinary runs skip live tests unless the switch is exactly `1`. Live checks make
no bucket listings: two known DR1/QR3 objects, one IRSA cutout, one TAP query,
and one SIA query. Provider outages fail the tests rather than silently passing.

## Observed live results — 2026-11-15

| Check | Actual result |
| --- | --- |
| DR1 S3 header → index → off-center crop → extractor | Passed; 17×17, 3,954,240-byte output FITS, 17.75 s |
| QR3 S3 header → index → off-center crop → extractor | Passed; 17×17, 3,954,240-byte output FITS, 15.45 s |
| IRSA cutout service | HTTP 200; 10×10, 3,954,240-byte output FITS; extractor passed |
| IRSA SIA | HTTP 200; VOTable smoke check passed |
| IRSA TAP | HTTP 502 Proxy Error; test failed as intended |

Combined live command: **4 passed, 1 failed in 60.92 s**. These are dated
observations, not availability guarantees. Output FITS size is **not** transferred
S3 bytes. The conservative S3 crop bounds a sky-aligned square on a rotated
detector; final output masking/reprojection belongs to the mosaic layer.

Both real D1 objects are the module's `SAMPLE_KEYS`. `IMAGE`, `FLAGS`, `VARIANCE`,
`ZODI`, `EPSF`, and `WCS-WAVE` were preserved; saved checksums and the existing
five-array extractor passed. This does not prove a calibrated temporal mosaic:
neither sample has verified CWAVE/CBAND calibration.

## Populate a deliberately incomplete index

`SPHEREX_S3_INDEX_PATH` selects the SQLite index; default:
`apps/server/data/cache/spherex-s3.sqlite`. Importing the adapter never creates an
index, accesses the network, or scans the bucket. Existing POC SQLite databases
with complete inspected header reports are directly readable. The compact
committed results JSON lacks full spatial WCS and cannot seed an honest index.

To explicitly seed exactly the two verified objects, run from `apps/server`:

```bash
uv run --no-sync python - <<'PY'
from app.services.spherex_provider import (
    BUCKET_URL, SAMPLE_KEYS, inspect_product, remember_products,
)
for key in SAMPLE_KEYS:
    remember_products([inspect_product(BUCKET_URL + key)])
PY
```

Successful downloads can contribute actual WCS/shape and original product
identity. A cutout contributes only its verified sub-footprint. Multiple known
sub-footprints are retained; query results deduplicate original objects. Records
without trustworthy WCS, bounded shape, date, and fixed-bucket identity are
ignored. Optional index I/O failures are logged without failing primary cutouts.

| Interface | Contract |
| --- | --- |
| `query_index(ra, dec, size, index_path=None)` | Positive overlaps, chronological, ≤400 objects; always `coverage_complete=False` |
| Positive matches | `coverage_state="indexed_matches"`; completeness still unknown |
| Missing/broken index or no overlap | `coverage_state="unknown_not_indexed"`; never “no observations” |
| `remember_products(products, index_path=None)` | Learn verified WCS footprints only; no network or completeness claim |
| `inspect_product(s3_url, max_bytes=1 MiB)` | Headers of one explicitly selected object; no listing |
| `download_s3_cutout(product, ra, dec, size)` | Read `s3_url`; cache SHA1 of region-specific `uri` |
| `original_to_s3_url(uri)` | Exact IRSA SPHEREx IBE namespace → NASA key; not proof of existence |
| `is_provider_unavailable(exc)` | HTTP 5xx and transport/timeouts only; not validation or any 4xx |

Region validation accepts finite RA/Dec, Dec −90…90°, size 1…180′. Densified
sky-square edges are transformed into source WCS, detector-clipped, and padded
conservatively. Tests cover rotation, SIP, RA wrap, borders, and an overlapping
source whose footprint does not contain the request center.

## Safety and limitations

- Fixed anonymous NASA S3 HTTPS host and DR1/QR3 Level-2 keys only. Credentials,
  query strings, custom ports, fragments, traversal, foreign hosts, redirects,
  and ambient proxy settings are rejected or unused.
- HTTP 206 and exact Content-Range are mandatory; If-Match pins available ETags.
  Ignored, truncated, oversized, and over-budget ranges fail closed.
- Per open: 128 MiB body-byte budget, 2,000 range requests, 90-second deadline,
  10-second connect and 30-second read timeouts. Header inspection defaults to
  1 MiB. An in-flight request can finish at its HTTP timeout after the deadline.
- Science units, flags, ancillary tables, spatial/alternate WCS and detector
  crop origin are retained. Atomic writes prevent partial cached FITS files.
- Local scans are deliberately incomplete, not mission-wide catalogs. No claim
  is made that every contributor or epoch has been discovered.
- Compressed FLAGS and full ancillary tables amplify tiny-cutout reads. Large
  requests may approach full-product cost or hit the explicit transfer cap.

## Primary references

- [IRSA cloud prefixes and anonymous access](https://irsa.ipac.caltech.edu/cloud_access/)
- [SPHEREx product guide](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/)
- [Astropy remote FITS access](https://docs.astropy.org/en/stable/io/fits/usage/cloud.html)
