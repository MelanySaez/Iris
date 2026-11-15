# Planet X v3 — Spectral Image Backend

High-performance spectral plate backend for SPHEREx DR1 Level-2 spectral images. Serves authenticated scientific cutouts discovered via IRSA TAP and sliced from local mission assets. Intentionally distinct from the SPHEREx DR1 All-Sky Cube HiPS used for the sky map.

## Run

```bash
cd apps/server
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

## Database (selection records)

Every job submission is saved as a selection record in PostgreSQL (SQLAlchemy + Alembic). Storage is optional: when `DATABASE_URL` is unset or invalid, jobs still work and `/api/selections` answers 503. A driverless `postgresql://` URL is accepted and uses psycopg 3. Saving runs inside `POST /api/jobs`, so an unreachable database can delay a submission by up to 3 seconds (connect timeout).

1. Create the two environment files from their templates. The root `.env` configures the container (`DB_PORT`, 5433 by default so it does not clash with a system PostgreSQL, plus `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`). `apps/server/.env` configures the backend (`DATABASE_URL`, optional `SPHEREX_SPECTRAL_FITS`); keep its credentials and port in sync with the root file:

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

The project uses a single database. Selection tests use `DATABASE_URL` but never touch its data: each run creates a throwaway schema (`test_<random>`), applies the migrations there and drops it at the end. Without `DATABASE_URL` those tests are skipped.

```bash
uv run pytest -q   # in apps/server, with .env sourced
```

### View mode

`POST /api/jobs` accepts an optional `view` describing how the Sky map showed the region: `{"mode": "single"}` or `{"mode": "rgb", "rgb": [r, g, b]}` (channels 0..101; `rgb` is required for `rgb` and rejected for `single`). It is display metadata: it does not change the job id or the channels the job processes. The saved selection stores the latest view it was sent as `view_mode` and `rgb_channels` (migration `0004`); a request without `view` keeps the recorded one, and selections saved before `0004` have both as `null`.

### Selection names

`PATCH /api/selections/{id}` with `{"name": "M101 core"}` sets the name shown in Records and returns the updated selection. The name is trimmed and limited to 80 characters (longer names get `422`); a blank name or `null` clears it, and the `name` key is required. Unknown ids get `404`. Job submissions never change the name, so selecting the same region again keeps it. Stored in `selection.name` (migration `0005`).

### Failure traceability

Every failed job records where, why and how it stopped. The job snapshot (`GET /api/jobs/{id}`) and the saved selection carry:

| Field            | Meaning                                                                                                                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failed_stage`   | Pipeline stage that was running: `discovering`, `downloading`, `extracting` or `rendering`.                                                                                                                                                   |
| `error_kind`     | Stable category: `no_coverage`, `discovery_unavailable`, `no_detector_coverage`, `download_failed`, `extraction_failed`, `render_failed` or `unexpected`.                                                                                     |
| `job_error`      | Human-readable message.                                                                                                                                                                                                                       |
| `error_trace`    | Traceback (file and line) for unexpected errors, trimmed to the innermost frames; empty for expected failures. It exposes server file paths, so treat it as development-only data.                                                            |
| `job_events`     | Timeline with epoch timestamps (selection only; the snapshot calls it `events`). Discovery retries add structured `discovery_attempt` events with provider, attempt number, outcome, error detail, and whether another retry will follow.     |

Every HTTP response has an `X-Request-ID` header. The request that created a job is stored as `request_id` in its snapshot and printed in the job's log lines (`job=<id> request=<request_id> ...`), so `grep <job_id>` on the server log returns the whole story. To query failures in the database:

```bash
docker compose exec db psql -U iris -P pager=off -c \
  "select job_id, failed_stage, error_kind, job_error from selection where job_status = 'failed';"
```

After changing the models in `app/selections/orm.py`, create a migration with `uv run alembic revision --autogenerate -m "<message>"` and review it before committing.

To run with a custom local spectral asset:

```bash
SPHEREX_SPECTRAL_FITS=/path/to/level2.fits uv run uvicorn app.main:app --reload
```

## Contextual assistant

A chat assistant (bubble in the bottom-right corner of the web app) that works with any model you choose behind an OpenAI-compatible Chat Completions API, through the official OpenAI SDK. Set `ASSISTANT_API_KEY` and `ASSISTANT_MODEL` in `.env`, plus `ASSISTANT_BASE_URL` for providers other than OpenAI (OpenRouter, Groq, Together, Ollama, vLLM, LM Studio…). The model must support tool calling. There is no default model; until both values are set the assistant endpoints answer `503` and nothing else changes. Limits are configurable (`ASSISTANT_*`, see `.env.example`). Restart the server after changing them.

| Endpoint | Purpose |
|----------|---------|
| `POST /api/assistant/chat` | One user turn: `{conversation_id, messages, context}` → `{reply, actions, cached, cache_kind, request_id}`. |
| `GET /api/assistant/logs?limit=&conversation_id=` | Logged events, newest first. |
| `POST /api/assistant/events` | The browser reports whether it executed or rejected an action. |
| `GET /api/assistant/status` | `{enabled, model}`. |

When introducing the app or answering questions about its authors, the assistant includes all four project authors with their GitHub profiles and the Iris repository link. Specific feature and navigation answers do not repeat the credits unless requested.

How it works (`app/assistant/`):

- **System prompt** (`prompt.py`): the general instruction for Planet X. It is a frozen string sent first, so providers with automatic prefix caching (such as OpenAI) can reuse it.
- **Tools** (`tools.py`): `search_catalog` and `list_saved_selections` run on the server and only read data; `navigate`, `show_region`, `set_channel` and `set_color_mode` are validated and returned as `actions` that the browser runs after the reply. No tool starts jobs, renames or deletes; `show_region` only draws a draft that the person confirms.
- **Guardrails** (`guardrails.py`, `service.py`): the UI context and tool results reach the model as delimited data (`<ui_context>`, `<tool_data>`); user-written names are sanitized; every tool input is validated against an allowlist and ranges (and again in the browser); detected instruction overrides and requests to modify/delete application code in any user turn are blocked before cache lookup, model calls or tools, with an empty action list and a `prompt_injection_blocked` log event. Matching handles case, accents and invisible format characters; tool-result injection patterns are still logged rather than blocked. These are heuristic checks, not complete protection against every rephrasing; a canary blocks replies that leak the system prompt; requests are limited in length (2000 characters), history (21 messages), tool rounds (6) and rate (20 per minute per client); refusals get a safe reply.
- **Response cache** (`cache.py`): equal requests (normalized text) and similar ones (≥ 0.85 word overlap with the same numbers) in the same context (workspace, channel, colour mode, selection, earlier turns) are answered from memory without calling the model, replaying their actions, for up to `ASSISTANT_CACHE_TTL_SECONDS`. Answers that read saved selections, refusals and truncated replies are not cached.
- **Logs** (`logbook.py`): an append-only JSONL file (`data/logs/assistant.jsonl`, git-ignored) with one line per request, model call (model served, finish reason, input/output and cached tokens when the provider reports them, latency), tool call, UI action, cache hit, guardrail event, error and UI outcome. It stores message previews (first 200 characters) but never the API key.

## Endpoints

All endpoints are mounted under `/api`:

- `GET /api/health`: Health status, supported products, and local asset availability.
- `GET /api/channels`: Authoritative 102-channel catalog derived from the official SPHEREx DR1 All-Sky Cube HiPS `properties`. Blank frames 50 and 51 are explicitly marked `available: false`.
- `GET /api/catalog`: Curated astronomical demo objects with `precomputed` cache indicators.
- `GET /api/spectrum?ra=&dec=`: Quick-look 102-channel spectrum (MJy/sr) at one ICRS position, sampled from the DR1 All-Sky Cube `fits-cube` HiPS tile (order 5) that contains it. The ~320 MB tile is never downloaded: the backend walks its FITS headers and reads the pixel's `IMAGE`, `NHITS` and `FLAGS` values with HTTP multipart byte-range requests. Channels without coverage return `value: null`, `available: false`. The payload is labelled `quick_look: true`, `calibrated: false`: it is a mosaic pixel profile, not forced photometry of a source. Tile layouts and spectra are cached under `data/cache/cube/` for 7 days; each pixel read also checks the tile size against the cached layout and rebuilds it if IRSA republished the tile. Returns 404 when no tile covers the position and 502 when IRSA fails, ignores range requests, answers with more than 1 MiB for a range read, or serves a tile that cannot be parsed.
- `GET /api/resolve?name=`: Position of an object name or catalogue code (`M31`, `NGC 224`, `Andromeda`, `HD 48915`, `IRAS 02341+0934`). J2000 coordinate designations (`J023650.95+094746.2`, `2MASS J05551028-0724254`) are parsed locally without any network. Otherwise the backend asks SIMBAD through the Harvard CfA mirror (`SIMBAD_SCRIPT_URL`; the CDS primary has been unavailable) and falls back to NED (`NED_LOOKUP_URL`, galaxies only). Answers are cached under `data/cache/names/` for 30 days (unknown names for 1 day); provider failures are never cached. Returns 404 only when SIMBAD answered "not found", 503 when no resolver could be reached, 422 for empty or unsafe input (newlines, quotes, `;`).
- `POST /api/regions/resolve`: Coordinate-based discovery of available detector products via IRSA TAP and local footprint matching. Capped at 30 arcmin. Returns 200 even on remote discovery warning; only definitive outcomes are cached for 6 hours.
- `POST /api/jobs`: Queue or deduplicate a spectral plate preparation job (`latest` or `history` mode, up to 8 channels, `image`, `variance`, `flags`). Blank channels and out-of-range indices are rejected with 422 before a job exists; resubmitting after a failure starts a fresh attempt.
- `GET /api/jobs/{id}`: Poll job status, progress, stage, discovery-attempt trace, and ready frame descriptors. Each upstream attempt is reported as it starts and finishes; failures state explicitly whether the job will retry.
- `GET /api/jobs/{id}/frames/{channel}/{product}.png`: Render 8-bit grayscale cutout (`mode=full`) or RGBA channel slice (`mode=slice`, opaque alpha 235 inside the LVF window, dim alpha 45 context). The window is `lambda_channel +/- bandwidth_um / 2`, where `bandwidth_um` is the local channel spacing. Supports `variance` and `flags` (with optional `bit` mask query).
- `GET /api/jobs/{id}/frames/{channel}/{product}.npy`: Export raw float32/int32 NumPy array (`image`, `variance`, `flags`, `wavelengths`, `bandwidths`).
- `GET /api/jobs/{id}/pixel?x=&y=&channel=&epoch=`: Per-pixel probe returning calibrated units, raw values, exact LVF wavelength/bandwidth, channel window inclusion, and set `MP_*` flag bit names.
- `GET /api/jobs/{id}/manifest`: Complete scientific provenance document for the plate inspector.
- `GET /api/selections?limit=&before=`: Saved selections (one per job request), most recently seen first, with `job_status` and, for failed jobs, `job_error` plus its traceability fields (see below). `next_before` is the cursor for the next page.
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

```console
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
