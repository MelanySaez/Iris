# Planet X v3 — Spectral Image Backend

High-performance spectral plate backend for SPHEREx DR1 Level-2 spectral images. Serves authenticated scientific cutouts discovered via IRSA TAP and sliced from local mission assets. Intentionally distinct from the SPHEREx DR1 All-Sky Cube HiPS used for the sky map.

## Large-field mosaics and temporal comparison

Regions now accept up to **180 arcmin (3°)**. IRSA remains primary with bounded,
experimental S3 fallback and visible provider status. Calibrated mosaics/history
require exact product-associated CWAVE/CBAND; WCS-WAVE alone is not sufficient.
See the [configuration, migration and API guide](../../docs/experiments/spherex-integration.md).

## Run

```bash
cd apps/server
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

## Database (selection records)

Job submissions are saved as selection records in PostgreSQL (SQLAlchemy + Alembic), one set of records per browser. There is no login: see **Cookie consent and record owners** below. Storage is optional: when `DATABASE_URL` is unset or invalid, jobs still work and `/api/selections` answers 503. A driverless `postgresql://` URL is accepted and uses psycopg 3. Saving runs inside `POST /api/jobs`, so an unreachable database can delay a submission by up to 3 seconds (connect timeout).

1. Create the two environment files from their templates. The root `.env` configures the container (`DB_PORT`, 5433 by default so it does not clash with a system PostgreSQL, plus `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`). `apps/server/.env` configures the backend (`DATABASE_URL`, `CORS_ORIGINS`, and optional assistant settings); keep its credentials and port in sync with the root file:

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
3. Apply the migrations. Pydantic Settings loads `apps/server/.env` when commands run from `apps/server`; process environment variables take precedence over values in the file:

   ```bash
   cd apps/server
   uv run alembic upgrade head
   ```

4. Start the server from `apps/server`; it reads the same `.env` settings automatically.

The project uses a single database. Selection tests use `DATABASE_URL` but never touch its data: each run creates a throwaway schema (`test_<random>`), applies the migrations there and drops it at the end. Without `DATABASE_URL` those tests are skipped.

```bash
uv run pytest -q   # in apps/server
```

### View mode

`POST /api/jobs` accepts an optional `view` describing how the Sky map showed the region: `{"mode": "single"}` or `{"mode": "rgb", "rgb": [r, g, b]}` (channels 0..101; `rgb` is required for `rgb` and rejected for `single`). It is display metadata: it does not change the job id or the channels the job processes. The saved selection stores the latest view it was sent as `view_mode` and `rgb_channels` (migration `0004`); a request without `view` keeps the recorded one, and selections saved before `0004` have both as `null`.

### Selection names

### Cookie consent and record owners

There is no login, so records belong to a browser. Accepting cookies (`necessary` or `all`; the records cookie counts as necessary) through `POST /api/consent` sets two cookies, both for one year, `SameSite=Lax` and `Path=/`. They are `Secure` when the request arrived over HTTPS; behind a proxy that terminates TLS, run uvicorn with `--forwarded-allow-ips` set to the proxy address so it sees the original scheme, or set `COOKIE_SECURE=true` (or `false`) to force the flag.

- `iris_owner`: a random UUID, `HttpOnly`. Selections are saved under it (`selection.owner_id`, migration `0006`), and every selection endpoint only reads or changes that owner's rows. It only counts while `iris_consent` is `necessary` or `all`. Choosing again keeps the existing owner, so records are never orphaned by a new choice. If the consent cookie accepts cookies but the owner cookie was lost, the next job submission, selection request or assistant chat issues a new owner (the earlier records stay with the lost one).
- `iris_consent`: the choice (`necessary`, `all` or `none`), readable by the web app so it knows whether to show the cookie bar.

Without accepted consent (`none`, or no choice yet) jobs still run, but `POST /api/jobs` saves nothing and the selection endpoints answer `403` with `Selections are saved only after accepting cookies. Accept the necessary cookies to keep your records.`. Choosing `none` keeps `iris_owner`: the browser's records stay in the database, hidden, and come back if it accepts again. The assistant's `list_saved_selections` tool reads only the asking browser's records.

When a browser accepts later, the web app sends the job ids it submitted before accepting to `POST /api/selections/claim`, which saves the ones the owner does not have yet with their current status and outcome (jobs are read from memory or their on-disk snapshot). Jobs the owner already has are left untouched, so claiming again never counts extra hits.

The same region selected by two browsers is two rows (unique `(owner_id, job_id)`); the job itself is shared, so its outcome reaches both. Migration `0006` deletes every selection saved before owners existed, since none can be attributed to a browser; shared region and product rows are kept, and the downgrade does not restore the deleted rows.

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

After changing the ORM models in `app/models/selection.py`, create a migration with `uv run alembic revision --autogenerate -m "<message>"` and review it before committing.

## Contextual assistant

A chat assistant (bubble in the bottom-right corner of the web app) that works with any model you choose behind an OpenAI-compatible Chat Completions API, through the official OpenAI SDK. Set `ASSISTANT_API_KEY` and `ASSISTANT_MODEL` in `.env`, plus `ASSISTANT_BASE_URL` for providers other than OpenAI (OpenRouter, Groq, Together, Ollama, vLLM, LM Studio…). The model must support tool calling. There is no default model; until both values are set the assistant endpoints answer `503` and nothing else changes. Limits are configurable (`ASSISTANT_*`, see `.env.example`). Restart the server after changing them.

| Endpoint | Purpose |
| ---------- | --------- |
| `POST /api/assistant/chat` | One user turn: `{conversation_id, messages, context}` → `{reply, actions, cached, cache_kind, request_id}`. |
| `GET /api/assistant/logs?limit=&conversation_id=` | Logged events, newest first. |
| `POST /api/assistant/events` | The browser reports whether it executed or rejected an action. |
| `GET /api/assistant/status` | `{enabled, model}`. |

When introducing the app or answering questions about its authors, the assistant includes all four project authors with their GitHub profiles and the Iris repository link. Specific feature and navigation answers do not repeat the credits unless requested.

How it works (`app/assistant/`):

- **System prompt** (`prompt.py`): the general instruction for Planet X. It is a frozen string sent first, so providers with automatic prefix caching (such as OpenAI) can reuse it.
- **Tools** (`tools.py`): `show_object`, `search_catalog`, `resolve_object_name` and `list_saved_selections` run on the server and only read data. `show_object` is how the model shows a named object: one call looks it up in the curated catalog (every word of the name in its id or name) and otherwise through SIMBAD/NED, and queues the `show_region` action itself. When every tool call of a round is a successful `show_object` (or a UI action), the server writes the reply ("Showing **M 31** in Sky: RA …") instead of calling the model again, so showing an object costs one model call. `resolve_object_name` resolves any object name SIMBAD or NED knows (Andromeda, M31, NGC 224…) through the same resolver as `GET /api/resolve`, and returns a `suggested_size_arcmin` clamped to what `show_region` accepts (1–60′, 6′ when the size is unknown or not a finite number); the prompt tells the model to call `show_object` once, without asking for confirmation, and to keep `search_catalog`/`resolve_object_name` for questions. Tool results are scanned for injection before they are wrapped in `<tool_data>`, so only text inside the data can raise the flag; `navigate`, `show_region`, `set_channel` and `set_color_mode` are validated and returned as `actions` that the browser runs after the reply. No tool starts jobs, renames or deletes; `show_region` only draws a draft that the person confirms.
- **Guardrails** (`guardrails.py`, `service.py`): the UI context and tool results reach the model as delimited data (`<ui_context>`, `<tool_data>`); user-written names are sanitized; every tool input is validated against an allowlist and ranges (and again in the browser); detected instruction overrides and requests to modify/delete application code in any user turn are blocked before cache lookup, model calls or tools, with an empty action list and a `prompt_injection_blocked` log event. Matching handles case, accents and invisible format characters; tool-result injection patterns are still logged rather than blocked. These are heuristic checks, not complete protection against every rephrasing; a canary blocks replies that leak the system prompt; requests are limited in length (2000 characters), history (21 messages), tool rounds (6) and rate (20 per minute per client); refusals get a safe reply.
- **Provider rate limits**: when the model provider answers 429, the call is retried once after the wait it asks for (`retry-after-ms` or `retry-after`), or after 1 s when it gives none, as long as that wait is at most 5 s. If it still fails, or asks for longer, `/api/assistant/chat` answers `503` with `The model provider is limiting requests right now. Try again in about N seconds.` (or `in a moment`), and the `error` log line keeps the provider's message and `retry_after`. Free shared models hit these limits quickly; a model with its own quota avoids them.
- **Response cache** (`cache.py`): equal requests (normalized text) and similar ones (≥ 0.85 word overlap with the same numbers in the same order) in the same context (all reported UI state, including map centre, field of view, selection confirmation, active job identity and earlier turns) are answered from memory without calling the model, for up to `ASSISTANT_CACHE_TTL_SECONDS`. Only exact requests replay cached UI actions; similarity matching applies to replies without actions. Answers that read saved selections, answers built after a failed tool call (for example a name resolver that is briefly unreachable), refusals and truncated replies are not cached.
- **Logs** (`logbook.py`): an append-only JSONL file (`data/logs/assistant.jsonl`, git-ignored) with one line per request, model call (model served, finish reason, input/output and cached tokens when the provider reports them, latency), tool call, UI action, cache hit, guardrail event, error and UI outcome. It stores message previews (first 200 characters) but never the API key.

## Endpoints

All endpoints are mounted under `/api`:

- `GET /api/health`: Health status and supported products.
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
- `POST /api/consent` with `{"level": "necessary" | "all" | "none"}`: Stores the cookie choice and answers `{level, records_enabled}`. See **Cookie consent and record owners**.
- `POST /api/selections/claim` with `{"job_ids": [...]}` (at most 100): Saves, for a browser that just accepted cookies, the jobs it submitted before accepting. Answers `{claimed}`, the number of selections added; unknown job ids and jobs the browser already has are skipped.
- `GET /api/selections?limit=&before=`: The browser's saved selections (one per job request), most recently seen first, with `job_status` and, for failed jobs, `job_error` plus its traceability fields (see below). `next_before` is the cursor for the next page.
- `GET /api/selections/{id}`: One saved selection with its discovered spectral products and, for ready jobs, the provenance manifest.
- `DELETE /api/selections/{id}`: Delete one saved selection (204). Shared region data is kept. All selection endpoints answer 503 when `DATABASE_URL` is unset and 403 while the browser has not accepted cookies (consent cookie not `necessary` or `all`).

## User FITS uploads

Plate can open a local file without a Sky job. The browser sends the file to
`POST /api/uploads?filename=my-spherex.fits` as the raw request body with
`Content-Type: application/octet-stream` (no multipart form). A successful
request returns a ready `JobSnapshot`, usable with the existing frame, pixel
and manifest endpoints.

```bash
curl --fail-with-body -X POST \
  'http://127.0.0.1:8000/api/uploads?filename=my-spherex.fits' \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @my-spherex.fits
```

| Format | Required content | Available products |
|--------|------------------|--------------------|
| SPHEREx Level-2 image/cutout | 2-D `IMAGE`, `VARIANCE`, `FLAGS`; key-W `WCS-WAVE` lookup and detector metadata | The detector's 17 channels, image, variance, flags and approximate per-pixel wavelengths |
| DR1 All-Sky Cube tile (`Npix…_cube.fits`) | 3-D `IMAGE`, `FLAGS`, `NHITS`; `SPECTRAL_CHANNELS` table and celestial WCS | One cutout per channel, image, flags and hit counts; nominal wavelengths; no variance or epochs |

The size limit is 350 MB (350,000,000 bytes); oversized requests return **413**.
Empty, unreadable or unsupported FITS files return **422** with a reason,
including missing extensions or layers whose dimensions do not match `IMAGE`.
The filename is a display label,
not a server path. Files are stored under `data/cache/uploads/<sha256>.fits`;
job IDs use `upload-` plus the first 20 hash characters. Uploading the same
bytes reopens the cached plate, retaining its original filename label while it
is ready in memory. Derived arrays and ready snapshots use the existing cache.
Uploads are not selection Records and do not require cookie consent or a
selection database. Cached files are held on the backend; this is not a local-only
browser viewer or permanent file storage.

## Provenance & Scientific Limitations

- **Visualization-Grade Wavelengths**: Per-pixel wavelength and bandwidth maps are derived from the FITS `WCS-WAVE` table. Calibrated science-grade `CWAVE`/`CBAND` products are not available in this release. Every payload touching spectral data carries `wavelength_status: "wcs_wave_approximate"` and `calibrated: false`.
- **Flag Semantics**: Bit names and descriptions are extracted directly from the `MP_*` keywords in the FITS `FLAGS` header. Bit 21 (`MP_SOURCE`) indicates a known astronomical source and is never represented as an instrument defect.
- **Multi-Product Mosaics**: Regions exceeding 30 arcmin or requiring multi-file mosaic assembly report `multi_product_mosaic: "pending"`. The service never synthesizes artificial data.
- **Honest Failure States**: A TAP failure is reported as `coverage: "unknown"` and as an explicit discovery error on the job, never as "no coverage".
- **Cache-Only Recovery**: A ready job snapshot stores the exact source `uri` per cutout, so frames and pixel probes reload from the derived disk cache after an LRU eviction or restart. The backend never re-downloads from a reconstructed or guessed URL; an evicted entry returns 404 with a "re-run the job" message.
- **Security**: Region requests accept celestial coordinates, region sizes, channel indices, and product selections. FITS uploads accept bounded file bytes. Client-supplied filesystem paths or arbitrary URLs are rejected.

## Cache Layout

All caching is stored under `apps/server/data/`:

```console
data/
└── cache/
    ├── hips-properties.json            # 7-day cached HiPS cube properties
    ├── discovery/<sha1>.json           # 6-hour cached IRSA TAP discovery results
    ├── cutouts/<sha1>.fits             # Atomically streamed remote cutout FITS files
    ├── uploads/<sha256>.fits           # User-uploaded SPHEREx FITS files
    ├── derived/
    │   ├── <sha1>.npz                  # Float32/int32 extracted arrays (compressed)
    │   └── <sha1>.meta.json            # Cutout footprint, dates, units, and flag bits
    └── jobs/<sha1>.json                # Ready job snapshot cache
```

## Warm Script

To precompute and warm the derived cache for curated catalog objects without running the HTTP server:

```bash
uv run python scripts/warm_catalog.py --objects m101-field,m81 --channels 20,44 --mode latest
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
