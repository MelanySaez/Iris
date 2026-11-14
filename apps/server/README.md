# Planet X v3 — Spectral Image Backend

High-performance spectral plate backend for SPHEREx DR1 Level-2 spectral images. Serves authenticated scientific cutouts discovered via IRSA TAP and sliced from local mission assets. Intentionally distinct from the SPHEREx DR1 All-Sky Cube HiPS used for the sky map.

## Run

```bash
cd apps/server
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

## Database (selection records)

Every job submission is saved as a selection record in PostgreSQL (SQLAlchemy + Alembic). Storage is optional: when `DATABASE_URL` is unset or invalid, jobs still work and `/api/selections` answers 503. A driverless `postgresql://` URL is accepted and uses psycopg 3. Saving runs inside `POST /api/jobs`, so an unreachable database can delay a submission by up to 3 seconds (connect timeout).

1. Create the two environment files from their templates. The root `.env` configures the container (`DB_PORT`, 5433 by default so it does not clash with a system PostgreSQL, plus `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`). `apps/server/.env` configures the backend (`DATABASE_URL`, `TEST_DATABASE_URL`, optional `SPHEREX_SPECTRAL_FITS`); keep its credentials and port in sync with the root file:

   ```bash
   # from the repository root
   cp .env.example .env
   cp apps/server/.env.example apps/server/.env
   ```

2. Start PostgreSQL from the repository root (compose reads the root `.env` automatically). `--wait` returns only once the healthcheck reports the database as ready, so the next commands never hit it while it is still initializing:

   ```bash
   docker compose up -d --wait db   # or: podman compose up -d --wait db
   ```

   Using a native PostgreSQL instead: `createuser -P iris && createdb -O iris iris`, then point `DATABASE_URL` at its port.

3. Export the backend variables and apply the migrations. The server does not load `.env` by itself, so source it in every shell that runs it:

   ```bash
   cd apps/server
   set -a && source .env && set +a
   uv run alembic upgrade head
   ```

4. Start the server in the same shell (it reads `DATABASE_URL`).

Selection tests run against a disposable database and are skipped otherwise:

```bash
docker compose exec db createdb -U iris iris_test   # from the repository root (or: podman compose ...)
uv run pytest -q                                    # in apps/server, uses TEST_DATABASE_URL from .env
```

After changing the models in `app/selections/orm.py`, create a migration with `uv run alembic revision --autogenerate -m "<message>"` and review it before committing.

To run with a custom local spectral asset:
```bash
SPHEREX_SPECTRAL_FITS=/path/to/level2.fits uv run uvicorn app.main:app --reload
```

## Endpoints

All endpoints are mounted under `/api`:

- `GET /api/health`: Health status, supported products, and local asset availability.
- `GET /api/channels`: Authoritative 102-channel catalog derived from the official SPHEREx DR1 All-Sky Cube HiPS `properties`. Blank frames 50 and 51 are explicitly marked `available: false`.
- `GET /api/catalog`: Curated astronomical demo objects with `precomputed` cache indicators.
- `POST /api/regions/resolve`: Coordinate-based discovery of available detector products via IRSA TAP and local footprint matching. Capped at 30 arcmin. Returns 200 even on remote discovery warning; only definitive outcomes are cached for 6 hours.
- `POST /api/jobs`: Queue or deduplicate a spectral plate preparation job (`latest` or `history` mode, up to 8 channels, `image`, `variance`, `flags`). Blank channels and out-of-range indices are rejected with 422 before a job exists; resubmitting after a failure starts a fresh attempt.
- `GET /api/jobs/{id}`: Poll job status, progress, stage, and ready frame descriptors.
- `GET /api/jobs/{id}/frames/{channel}/{product}.png`: Render 8-bit grayscale cutout (`mode=full`) or RGBA channel slice (`mode=slice`, opaque alpha 235 inside the LVF window, dim alpha 45 context). The window is `lambda_channel +/- bandwidth_um / 2`, where `bandwidth_um` is the local channel spacing. Supports `variance` and `flags` (with optional `bit` mask query).
- `GET /api/jobs/{id}/frames/{channel}/{product}.npy`: Export raw float32/int32 NumPy array (`image`, `variance`, `flags`, `wavelengths`, `bandwidths`).
- `GET /api/jobs/{id}/pixel?x=&y=&channel=&epoch=`: Per-pixel probe returning calibrated units, raw values, exact LVF wavelength/bandwidth, channel window inclusion, and set `MP_*` flag bit names.
- `GET /api/jobs/{id}/manifest`: Complete scientific provenance document for the plate inspector.
- `GET /api/selections?limit=&before=`: Saved selections (one per job request), most recently seen first. `next_before` is the cursor for the next page.
- `GET /api/selections/{id}`: One saved selection with its discovered spectral products and, for ready jobs, the provenance manifest.
- `DELETE /api/selections/{id}`: Delete one saved selection (204). Shared region data is kept. All selection endpoints answer 503 when `DATABASE_URL` is unset.

## Provenance & Scientific Limitations

- **Visualization-Grade Wavelengths**: Per-pixel wavelength and bandwidth maps are derived from the FITS `WCS-WAVE` table. Calibrated science-grade `CWAVE`/`CBAND` products are not available in this release. Every payload touching spectral data carries `wavelength_status: "wcs_wave_approximate"` and `calibrated: false`.
- **Flag Semantics**: Bit names and descriptions are extracted directly from the `MP_*` keywords in the FITS `FLAGS` header. Bit 21 (`MP_SOURCE`) indicates a known astronomical source and is never represented as an instrument defect.
- **Multi-Product Mosaics**: Regions exceeding 30 arcmin or requiring multi-file mosaic assembly report `multi_product_mosaic: "pending"`. The service never synthesizes artificial data.
- **Honest Failure States**: A TAP failure is reported as `coverage: "unknown"` and as an explicit discovery error on the job, never as "no coverage".
- **Cache-Only Recovery**: A ready job snapshot stores the exact source `uri` per cutout, so frames and pixel probes reload from the derived disk cache after an LRU eviction or restart. The backend never re-downloads from a reconstructed or guessed URL; an evicted entry returns 404 with a "re-run the job" message.
- **Security**: Client input is restricted to celestial coordinates, region sizes, channel indices, and product selections. Client-supplied filesystem paths or arbitrary URLs are rejected.

## Cache Layout

All caching is stored under `apps/server/data/`:

```
data/
├── level2_*.fits                       # Read-only local FITS asset
└── cache/
    ├── hips-properties.json            # 7-day cached HiPS cube properties
    ├── discovery/<sha1>.json           # 6-hour cached IRSA TAP discovery results
    ├── cutouts/<sha1>.fits             # Atomically streamed remote cutout FITS files
    ├── derived/
    │   ├── <sha1>.npz                  # Float32/int32 extracted arrays (compressed)
    │   └── <sha1>.meta.json            # Cutout footprint, dates, units, and flag bits
    └── jobs/<sha1>.json                # Ready job snapshot cache
```

## Warm Script

To precompute and warm the derived cache for curated catalog objects without running the HTTP server:

```bash
uv run python scripts/warm_catalog.py --objects local-dr1-sample,m81-field --channels 20,44 --mode latest
```

Options:
- `--objects`: Comma-separated list of catalog object IDs (default: all).
- `--channels`: Comma-separated channel indices (default: `20`).
- `--products`: Comma-separated products (default: `image`).
- `--mode`: Cutout epoch selection (`latest` or `history`, default: `latest`).
- `--limit`: Maximum number of objects to process.

The script runs internal job execution routines directly, outputs timing per object, and is safe to execute repeatedly.

## Quality Gates

Run checks using the project venv:

```bash
uv run ruff check app tests scripts
uv run pytest -q
```
