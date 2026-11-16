# SPHEREx S3 fallback: working sample, not a global replacement

**All three experiments worked on real DR1/QR3 files on 2026-11-15.** Remote headers and scientific-layer cutouts need only partial object reads. A two-image local index answers point queries without contacting IRSA. The application, endpoints, dependency lock and existing discovery functions are unchanged. This is NOT an automatic fallback or a validated replacement for IRSA's complete scientific service.

## Run it

From `apps/server`, using the existing `uv` environment (Astropy, fsspec and httpx):

```bash
OUT=$(mktemp -d)
uv run --no-sync python scripts/spherex_s3_poc.py inspect --release dr1 --output "$OUT/dr1.json"
uv run --no-sync python scripts/spherex_s3_poc.py inspect --release qr3 --output "$OUT/qr3.json"
uv run --no-sync python scripts/spherex_s3_poc.py cutout --release dr1 --size-arcmin 1 --output "$OUT/dr1.fits"
uv run --no-sync python scripts/spherex_s3_poc.py cutout --release qr3 --size-arcmin 1 --output "$OUT/qr3.fits"
uv run --no-sync python scripts/spherex_s3_poc.py index --headers "$OUT/dr1.json" "$OUT/qr3.json" --output "$OUT/sample.sqlite"
uv run --no-sync python scripts/spherex_s3_poc.py query --index "$OUT/sample.sqlite" --ra 160.61699069788853 --dec 30.670454926168155 --size-arcmin 1 --output "$OUT/query.json"
uv run --no-sync pytest scripts/tests/test_spherex_s3_poc.py -q
SPHEREX_S3_LIVE=1 uv run --no-sync pytest scripts/tests/test_spherex_s3_live.py -q -s
```

Supply `--ra` and `--dec` together to cut out another position within the selected image; otherwise its actual WCS center is used. `--help` lists all options. Outputs must not already exist. Each cutout also produces a sibling `.json` report. Keep desired outputs; remove your temporary directory afterward. Live tests use only the same two allowlisted objects, not mocks.

## POC 1 — Actual anonymous access

Verified keys under `s3://nasa-irsa-spherex/`:

```text
dr1/level2/2025W17_4B/l2b-v27-2026-196/1/level2_2025W17_4B_0001_1D1_spx_l2b-v27-2026-196.fits
qr3/level2/2026W20_2A/l2b-v27-2026-267/1/level2_2026W20_2A_0001_1D1_spx_l2b-v27-2026-267.fits
```

| Measured operation (cold open) | DR1 | QR3 |
| --- | ---: | ---: |
| Original object bytes, HEAD | 65,393,280 | 65,977,920 |
| All HDU headers, received body bytes | 89,600 | 89,600 |
| Header range GETs / HEADs | 15 / 1 | 15 / 1 |
| Header elapsed seconds | 2.26 | 1.97 |
| One-arcmin center cutout, received bytes | 4,163,133 | 4,166,032 |
| Cutout range GETs / HEADs | 58 / 1 | 58 / 1 |
| Cutout elapsed seconds | 12.65 | 7.77 |

Every data GET must return HTTP 206 and the exact `Content-Range`; the body is refused if ranges are ignored. No full FITS download was needed. Transfer volume is about 6.3% of the original file for this cutout, including headers and whole supporting tables. Body counts include cache misses/repeated reads but exclude HTTP/TLS overhead. There was **no full-download latency benchmark**: many small requests can lose to one full download on a fast link.

The adapter uses `fits.open(use_fsspec=True)` with an isolated `spxpoc://` fsspec protocol mapped to anonymous HTTPS on the fixed S3 host. It reuses httpx and fsspec already present; it does NOT claim that an uninstrumented native `s3://`/s3fs client was tested. Neither optional s3fs nor aiohttp was installed. The adapter measures the actual bytes fed to Astropy, uses a cold 4 KiB read-ahead cache, pins reads with `If-Match` when ETag is available, and caps each open at 16 MiB / 500 range GETs by default. Socket timeout is 20 seconds; a 120-second deadline is checked before each range. No retries amplify failures. This is a deliberately small experimental transport, not a production filesystem.

Bounded bucket discovery used 11 anonymous delimiter listings (`max-keys=10`) and two HEADs. Root releases observed: DR1, QR2, QR3. Layout is release → `level2` → planning period → processing version → detector. Ordinary and retry processing prefixes coexist; do not assume one version per period. No recursive mission scan was performed. Metadata and exact measurements are retained in [the evidence JSON](spherex-s3-results.json).

### Real headers, not inferred science metadata

Both IMAGE arrays are 2040×2040 with TAN-SIP spatial WCS, detector 1. Observation IDs: `2025W17_4B_0001_1` and `2026W20_2A_0001_1`. IMAGE `DATE-BEG`/`DATE-END` give intervals 2025-04-24T18:01:05.843–18:03:00.961 and 2026-05-14T12:08:39.329–12:10:34.446; `MJD-OBS` is 60789.750762072 and 61174.506010752. Original DATE strings are preserved without inventing a timezone suffix. PRIMARY `VERSION=7.0.5` is distinct from processing prefix `l2b-v27-…`. Release comes from the observed key. `SPHEREx-D1` is a detector label, **not a single effective wavelength**; the LVF wavelength varies across pixels. Full original headers are emitted by `inspect`.

## POC 2 — Real scientific-layer cutouts

- `IMAGE`, `VARIANCE`, `FLAGS`, `ZODI`: read with `.section[view]`, preserve exact pixel values and units. Source FLAGS is tile-compressed; Astropy reads/decompresses the relevant tiles, not an arbitrary theoretical pixel byte count. Output FLAGS is an ordinary ImageHDU with the same values.
- `EPSF`: preserve the entire binary table (441 rows for these D1 files), with original detector-zone coordinates. It dominates the transfer floor for tiny cutouts. No ePSF photometry was performed.
- `WCS-WAVE`: preserve the entire lookup table. Shift alternate `CRPIXnW` so cutout pixels address the original grid; do not shift both the table and reference pixels. The existing alternate detector-coordinate WCS is shifted too. `POCX0`/`POCY0` additionally record zero-based origin for mapping back to original ePSF zones.
- Celestial WCS uses `WCS.slice(view)` including SIP; all original units/provenance remain. Changed HDUs receive regenerated checksums, not stale source checksums. PRIMARY is retained.

A nominal one-arcmin request yields 10×10 pixels in these files. This is a detector-aligned rectangle at the WCS reference scale, rounded up, clipped at edges, with no reprojection or padding. It is not a guarantee of an exact north-aligned sky square or identical IRSA edge-rounding behavior. An outside center is rejected. Partial edge cutouts can have smaller dimensions and an off-center requested point.

Actual saved FITS passed the unchanged `app.services.fits.extract_cutout_fits`: image, variance, flags, wavelength and bandwidth were finite and 10×10; units stayed `MJy / sr` and `MJy2 / sr2`. Independent off-center live scenarios compared all four spatial arrays and both full tables against the source, verified checksums, center placement and dimensions, and compared serialized celestial and spectral WCS. The sampled celestial difference was 0 arcsec; spectral outputs matched at relative tolerance 1e-10. Offline tests also use a rotated, RA-wrap, nonzero-SIP and -TAB fixture.

**Compatibility has limits.** `fits.py` directly consumes IMAGE/VARIANCE/FLAGS and key-W spectral WCS, not ZODI/EPSF. The generated file works with that extractor, but its `s3://` provenance URI cannot simply replace the HTTP cutout URL expected by `download_cutout()`. No complete job pipeline or byte-for-byte IRSA cutout comparison was performed.

Most importantly, [IRSA's product guide](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/) says WCS-WAVE fidelity is for visualization; science analysis should use calibration `CWAVE`/`CBAND` arrays. Thus **matching PlanetX's current wavelength computation does not validate its scientific fidelity**. Associating the correct spectral calibration release and validating photometry remain necessary. No zodiacal subtraction was applied, matching the original IMAGE values.

## POC 3 — Sample-only spatial discovery

`query_spherex_s3(ra_deg, dec_deg, size_arcmin, *, index_path=...)` works on a two-row SQLite index made only from the real header reports. It returns original S3 URI, stable local ID (not IRSA planeid), release, processing version, observation time, detector and band label. It stores the full spatial WCS, including distortion, rather than just corners. Point membership uses inverse WCS, detector pixel bounds and a forward roundtrip. Matches are ordered by observation MJD (stable URI tie-break), limited to 400. As in the supplied ADQL, size describes a later cutout; it does **not** change center containment into overlap/cone discovery.

The actual DR1 and QR3 centers find their respective products. (0°,0°) returns `unknown_not_indexed`, **not no observations**. Positive results say `sample_matches`; every result has `index_complete=false`. A singular/non-convergent inverse is not taken as evidence of global absence. A global implementation needs a separate partition-completeness ledger before it can ever claim no observations.

The intentionally tiny database scans its WCS records. An RTree/HEALPix accelerator was **evaluated, not implemented or benchmarked**:

| Option | Appropriate use / tradeoff |
| --- | --- |
| SQLite full WCS scan | Simplest for 2–8 rows; no fragile bounding-box rejection. Not a global design. |
| SQLite + RTree | Lightweight candidate selection, but longitude wrap, poles and conservative distorted boundaries need explicit handling. Always refine with WCS. |
| HEALPix cell → products + WCS | Recommended global direction: spherical partitioning avoids longitude-seam boxes. Requires conservative cell coverage (not just image-center assignment), completeness bookkeeping and exact refinement; dependency/storage tuning remains unmeasured. |

### Building global coverage without full FITS downloads

1. Prefer a versioned bulk metadata/footprint export or manifest from NASA/IPAC, including cloud URI, footprint/WCS, processing version and observation time. **No such public bulk manifest was established** by this bounded investigation. S3 LIST provides keys/sizes, not footprints; filenames alone cannot implement RA/Dec discovery.
2. If no export is available, harvest bounded, partitioned TAP/SIA metadata **while those services are healthy**, then serve the persisted index independently during outages. [Official access docs](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/) describe SIA collections and cloud access references. Partition by release/time, prove pagination completeness, deduplicate retries/versions, and advance watermarks only after complete partitions. SIA may lag weekly ingestion by roughly one day. This bootstraps independently served discovery, not an IRSA-independent bootstrap.
3. For a strictly S3-only bootstrap, obtain a provider-generated metadata inventory or pay the header-read cost. Reading only primary/IMAGE headers rather than every HDU would reduce this POC's 15-GET header pass, and coalesced prefix ranges may help, but they were not benchmarked. Refresh changed/new objects using ETags and explicit release/version policy; do not re-open unchanged objects on every query. S3 Inventory, if configured/published by the owner, supplies object inventory, not astronomical WCS.

At this measured all-HDU rate, one million objects would entail roughly **89.6 GB of header payload and 15 million GETs plus HEADs**, excluding listings and metadata indexing; full downloads would instead be roughly 65 TB. This is arithmetic extrapolation, not a mission count, throughput benchmark, or price quote. Exact global storage, request pricing, ingestion throughput and HEALPix cell expansion have not been measured. Large-scale ingestion is outside this POC.

## Fallback decision and verification

`IRSA TAP/SIA → local index → S3 → FITS cutout` is **technically viable for preindexed products**. Before automatic integration: obtain complete/versioned coverage; add a local-cutout adapter instead of passing S3 URIs to the HTTP downloader; preserve all product descriptor/job/cache semantics; validate detector 2–6 and borders against IRSA reference cutouts; resolve full-fidelity spectral calibration; and bound fallback concurrency, retries, cache eviction and partial failures. An incomplete index must never convert an upstream failure into “no observations.” The reported TAP/SIA 502 incident was not re-tested here; all live POCs bypassed both services.

Observed checks:

- New offline tests: **7 passed**. Opt-in real S3 tests: **2 passed** (22.55 s); ordinary runs skip them.
- Combined suite: **241 passed, 2 failed, 2 skipped**. Failures are the two `test_assistant_is_disabled_until_key_and_model_are_set` cases. They reproduce without importing the new scripts, in unchanged tracked app/test code; existing settings read `.env`, so deleting environment variables does not remove dotenv defaults. They were not modified as part of this POC.
- System Ruff 0.14.6 lint/format checks pass. The environment's `uv run --no-sync ruff` executable fails before running due to a Nix glibc loader/RPATH mismatch; no environment/dependency repair was attempted.
- Expected Astropy convergence warnings occur for deliberately far-outside SIP coordinates; finite pixel bounds and roundtrip validation prevent accepting these as footprint matches. This sample never claims global absence.

References: [IRSA cloud access](https://irsa.ipac.caltech.edu/cloud_access/), [Astropy cloud FITS sections](https://docs.astropy.org/en/stable/io/fits/usage/cloud.html), [SPHEREx tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-intro/). Exact evidence and object IDs: [results JSON](spherex-s3-results.json).
