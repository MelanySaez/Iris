# Planet X v3 — Two-workspace foundation

Status: implementation contract for the first full rebuild.
Audience: backend and frontend implementers. All artifacts are English.

## 1. Product intent

Planet X is a public SPHEREx explorer with two deliberately different workspaces:

1. **Sky workspace** — an all-sky mosaic built from the official **SPHEREx DR1
   All-Sky Cube** PNG HiPS. Dark, map-first, pan/zoom, object search, coordinate
   entry, region selection.
2. **Spectral plate workspace** — a scientific plate viewer for the selected
   region. Paper-toned, still-image-first, per-pixel inspection, IMAGE /
   VARIANCE / FLAGS, per-pixel LVF wavelength, real epoch comparison.

The two workspaces must not share the same visual language. The sky is a map;
the plate is a document/instrument readout.

## 2. Non-negotiable data rules

- The sky mosaic is the **DR1 All-Sky Cube HiPS** served by IRSA:
  `https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube`.
  It is a visualization cube (102 frames, blank frames 50 and 51). Never present
  it as a calibrated scientific measurement.
- Spectral plates come from **individual Level-2 spectral images** discovered
  through IRSA TAP/SIA and downloaded as cutouts
  (`<access_url>?center=<ra>,<dec>d&size=<deg>`).
- A spectral image is a **detector** image, not a single wavelength. Wavelength
  varies per pixel because of the LVF. Every channel view must be derived from
  the per-pixel `WCS-WAVE` values, never from a single band label.
- `WCS-WAVE` is **approximate/visualization-grade**. Calibrated science needs
  product-associated `CWAVE`/`CBAND`, which this release does not have. All API
  payloads must carry `wavelength_status: "wcs_wave_approximate"` and
  `calibrated: false`.
- Flag bit names come from the `MP_*` keywords in the FITS `FLAGS` header. Do
  not invent semantics. Bit 21 (`MP_SOURCE`, pixel mapped to a known source) is
  normal and must not be described as a defect.
- Missing coverage is reported explicitly. Never synthesize data.
- A region larger than one detector product: the service caps at 30 arcmin and
  reports `multi_product_mosaic: "pending"`. No fake mosaicking.

## 3. Channel model

Source of truth: HiPS `properties` `data_cube_crval3_arr` (102 wavelengths in
micrometres), `hips_cube_depth=102`, blank frames 50 and 51.

- `index` 0..101.
- `band = floor(index / 17) + 1` → detector `D1..D6`.
- `available = index not in {50, 51}`.
- `bandwidth_um = (w[i+1] - w[i-1]) / 2` clamped at the edges.
- Channel → detector is a **grouping aid**, never a wavelength substitute.

## 4. Backend contract (FastAPI, `apps/server`)

Base path `/api`. CORS for the Vite origins. JSON unless stated.

### GET /api/health

```json
{
  "status": "ok",
  "version": "0.2.0",
  "products": ["DR1 All-Sky Cube HiPS", "Level-2 spectral image cutouts"],
  "local_assets": true,
  "network": "configured"
}
```

### GET /api/channels

```json
{
  "source": {
    "collection": "SPHEREx DR1 All-Sky Cube",
    "properties_url": "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube/properties",
    "depth": 102,
    "order": 5,
    "blank_channels": [50, 51]
  },
  "channels": [
    {"index": 0, "band": 1, "detector": "D1", "wavelength_um": 0.753,
     "bandwidth_um": 0.018, "available": true}
  ],
  "cached": true
}
```

Fetch the properties server-side with a 7-day disk cache; if the network fails,
fall back to the last cached copy; if none, return HTTP 503 with a clear detail.
Never hardcode a second, divergent channel table.

### GET /api/catalog

Curated, real objects only. Suggested set (coordinates from the project mockup
and notebooks):

| id | name | ra | dec | type | note |
| --- | --- | --- | --- | --- | --- |
| `local-dr1-sample` | Local DR1 sample | 270.693033 | 61.876516 | SPHEREx field | Covered by the local D2 FITS |
| `m81-field` | M81 field | 210.80227 | 54.34895 | Galaxy field | Notebook TAP demo field |
| `spherex-demo-field` | SPHEREx demo field | 304.693509 | 42.443687 | SPHEREx field | Notebook SIA demo field |
| `wise-0855` | WISE 0855−0714 | 133.7951 | −7.2451 | Brown dwarf | Coldest known brown dwarf |
| `barnard` | Barnard's Star | 269.4521 | 4.6934 | Red dwarf | Highest known proper motion |
| `epsilon-indi` | Epsilon Indi Ba/Bb | 330.8471 | −56.7892 | Brown dwarf pair | Nearby binary |
| `rw-aur` | RW Aurigae | 77.8981 | 30.3974 | Variable star | Young T Tauri star |
| `r-dra` | R Draconis | 248.1676 | 66.7550 | Variable star | Mira variable |

Response:

```json
{"objects": [{"id": "m81-field", "name": "M81 field", "ra_deg": 210.80227,
  "dec_deg": 54.34895, "type": "Galaxy field", "default_size_arcmin": 6,
  "description": "...", "precomputed": false}]}
```

`precomputed` is true when a warmed job exists for that object in the disk cache.

### POST /api/regions/resolve

Request `{ra_deg, dec_deg, size_arcmin}` (size 1..30).

Does discovery only: local asset coverage plus IRSA TAP. Cached per rounded
region for 6 hours. Returns 200 even when discovery fails, with a `warning`.

```json
{
  "region": {"ra_deg": 210.80227, "dec_deg": 54.34895,
             "size_arcmin": 6, "fov_deg": 0.1},
  "coverage": "available",
  "cached": false,
  "query_ms": 4200,
  "warning": null,
  "products": [
    {"id": "remote:...", "source": "remote", "detector": 2, "band": "SPHEREx-D2",
     "obs_id": "2025W19_2B_0346_2", "uri": "https://...",
     "date_mjd": 60805.711548, "date_iso": "2025-09-18T05:04:37Z"}
  ],
  "detectors": [
    {"detector": 2, "band": "SPHEREx-D2", "count": 12,
     "epochs": [{"date_mjd": 60805.711548, "date_iso": "...", "product_id": "..."}]}
  ],
  "notes": ["Discovery via IRSA TAP; individual detector products, not a mosaic."]
}
```

`coverage`: `available` | `none` | `unknown`. Only definitive outcomes
(`available`, `none`) are written to the 6-hour cache; a transient TAP failure
returns `unknown` and is retried on the next request instead of poisoning the
region for six hours.

### POST /api/jobs

Request:

```json
{
  "ra_deg": 210.80227, "dec_deg": 54.34895, "size_arcmin": 6,
  "channels": [44],
  "products": ["image"],
  "mode": "latest",
  "stretch": "asinh"
}
```

- `channels`: 1..8 channel indices.
- `products`: subset of `["image", "variance", "flags"]`; `image` always included.
- `mode`: `latest` (one epoch per detector) or `history` (first + last epoch per
  detector, at most 2).
- `stretch`: `asinh` | `linear`.

Response `202` with a job snapshot:

```json
{
  "id": "…", "status": "queued",
  "progress": 0, "stage": "Queued",
  "error": null,
  "request": {…},
  "region": {"ra_deg": …, "dec_deg": …, "size_arcmin": …, "fov_deg": …},
  "channels": [{"index": 44, "wavelength_um": 2.089, "bandwidth_um": 0.046,
                "detector": 3, "available": true}],
  "products": ["image"],
  "frames": [],
  "cutouts": [],
  "cache": {"hit": false},
  "wavelength_status": "wcs_wave_approximate",
  "calibrated": false,
  "multi_product_mosaic": "pending"
}
```

Statuses: `queued → discovering → downloading → extracting → rendering → ready`
or `failed`. `progress` 0..100. `stage` is human-readable and includes counts,
e.g. `Downloading DR1 cutouts 2/3`.

A ready snapshot adds `frames`:

```json
[{"channel": 44, "product": "image", "detector": 3, "epoch": 0,
  "obs_id": "...", "date_iso": "...", "source": "remote",
  "width": 29, "height": 29,
  "url": "/api/jobs/{id}/frames/44/image.png?mode=full&epoch=0",
  "slice_url": "/api/jobs/{id}/frames/44/image.png?mode=slice&epoch=0",
  "wavelengths_url": "/api/jobs/{id}/frames/44/wavelengths.npy?epoch=0",
  "window_um": [2.043, 2.135]}]
```

and `cutouts` with per-cutout metadata:

```json
[{"detector": 3, "epoch": 0, "obs_id": "...", "date_iso": "...",
  "source": "remote", "uri": "https://...",
  "version": "7.0.5", "shape": [29, 29], "pixel_scale_arcsec": 6.13,
  "wavelength_min_um": 1.63, "wavelength_max_um": 2.41,
  "bandwidth_median_um": 0.03, "image_unit": "MJy / sr",
  "variance_unit": "MJy2 / sr2", "flags_defined": true,
  "flag_bits": [{"bit": 0, "name": "MP_TRANSIENT",
                 "description": "Transient detected during SUR"}]}]
```

`uri` is the exact source cutout URI (or the `local:<file>` pseudo-URI) and is
what lets a job reload its derived arrays after an LRU eviction or a restart.
`version` is the FITS primary-header processing version when the cache recorded
it; an empty string means unknown, never a guessed value.

`window_um` in frames and pixel readouts is `[λ − b/2, λ + b/2]`, where `b` is
the local channel spacing (`bandwidth_um` from `/api/channels`). The slice rule
is therefore `|λ_pixel − λ_channel| ≤ b/2`, exactly as in §4. A cutout whose
LVF range does not overlap that window contains no opaque slice pixels; the
snapshot already exposes both ranges so the plate can say so explicitly.

A request for a blank channel (50, 51) or an out-of-range index is rejected with
422 before a job is created. Resubmitting the same request after a failure
creates a fresh attempt; only `ready` jobs are treated as cache entries.

### GET /api/jobs/{id}

Same snapshot; poll target.

### GET /api/jobs/{id}/frames/{channel}/{product}.png

Query: `mode=full|slice` (default `full`), `epoch` (default 0),
`stretch` (default job stretch), `bit` (flags only).

- `full`: detector cutout rendered as 8-bit grayscale PNG. Robust percentiles
  [1, 99] computed on the whole cutout and cached; asinh or linear stretch.
- `slice`: RGBA PNG. Pixels inside the channel window are opaque and bright
  (alpha 235); pixels outside are dim context (alpha 45). The window is
  `|λ_pixel − λ_channel| ≤ 0.5 × local channel spacing`. This is the LVF
  selection, not a band label.
- `product=variance`: same rendering rules over the variance array.
- `product=flags`: with `bit=N`, opaque pixels where bit N is set; without
  `bit`, grayscale by count of set bits (0..n), plus the flag definitions in
  the manifest. Never call a flag value a quality score.

Missing product → 404 with `{"detail": "..."}`. Not ready → 409.

### GET /api/jobs/{id}/frames/{channel}/{product}.npy?epoch=0

Raw float32/int32 array (NumPy `.npy`). For `wavelengths.npy` and
`bandwidths.npy` use the same route with `product=wavelengths|bandwidths`.

### GET /api/jobs/{id}/pixel?x=&y=&channel=&epoch=

```json
{"x": 14, "y": 14, "channel": 44, "epoch": 0,
 "wavelength_um": 2.091, "bandwidth_um": 0.031, "window_um": [2.043, 2.135],
 "in_channel": true,
 "image": 0.42, "variance": 0.0011, "flags": 2097152,
 "flag_bits": [{"bit": 21, "name": "MP_SOURCE",
                "description": "Pixel mapped to a known source"}]}
```

Unknown/expired job → 404.

### GET /api/jobs/{id}/manifest

Provenance document used by the plate's “Provenance” sheet:

```json
{"job_id": "...", "request": {...}, "region": {...},
 "products": ["image"],
 "release": "SPHEREx DR1 level-2 (7.0.5)",
 "dates": ["2025-05-09T03:33:55.152Z"],
 "units": {"image": "MJy / sr", "variance": "MJy2 / sr2"},
 "lvf_status": "wcs_wave_approximate", "wavelength_status": "wcs_wave_approximate",
 "calibrated": false,
 "flag_definitions": [{"bit": 21, "name": "MP_SOURCE", "description": "..."}],
 "cache": {"hit": true}, "multi_product_mosaic": "pending",
 "collection": "SPHEREx DR1 Level-2 spectral image cutouts",
 "cutouts": [{"detector": 3, "epoch": 0, "obs_id": "...", "source": "remote",
              "uri": "https://...", "version": "7.0.5", "date_obs": "...",
              "date_mjd": 60804.14, "units": {...}, "flag_bits": [...],
              "pixel_scale_arcsec": 6.13, "shape": [29, 29]}],
 "notes": ["..."]}
```

`release` is derived from the recorded FITS processing versions; when an older
cache entry predates version capture it reads `SPHEREx DR1 level-2`, never a
fabricated release identifier. `dates` is sorted and deduplicated from the
cutouts. `flag_definitions` is the union of per-cutout `MP_*` definitions.

## 5. Backend implementation map

```
apps/server/app/
  __init__.py
  config.py        # paths, timeouts, caps, cache dirs
  channels.py      # HiPS properties fetch/parse/cache
  catalog.py       # curated objects + precomputed detection
  discovery.py     # local footprint + IRSA TAP + JSON cache
  fits_assets.py   # cutout download cache, FITS → arrays, WCS-WAVE, flag bits
  render.py        # PNG rendering, stretch, slice alpha, flag masks
  jobs.py          # job manager, stages, thread pool, job cache
  models.py        # pydantic request/response models
  main.py          # FastAPI routes
scripts/warm_catalog.py   # precompute demo objects into the same disk cache
tests/                    # pytest, no network
```

Storage under `apps/server/data/`:

```
data/cache/hips-properties.json
data/cache/discovery/<sha1>.json
data/cache/cutouts/<sha1>.fits
data/cache/derived/<sha1>.npz
data/cache/jobs/<sha1>.json          # optional snapshot
data/level2_*.fits                   # local asset (read-only)
```

Caps: max 8 channels, max 12 cutout downloads per job, 4 download workers,
connect 10 s, read 90 s, 2 retries. Job registry LRU 32 in memory.

The local FITS is registered as a product for detector 2 when the requested
box is fully inside its footprint. Prefer the local asset over a remote download
for the same detector in `latest` mode.

## 6. Frontend contract (`apps/web`)

Rewrite `apps/web/src` completely. Keep Vite + React + TypeScript + Aladin Lite.
No new runtime dependencies. Hash routes:

- `#/sky` (default)
- `#/plate/{jobId}`

### Shared shell

- Top bar: `Planet X` wordmark, `SPHEREx · DR1` provenance chip, workspace
  switch (`Sky` / `Plate`), “Data notes” popover.
- Backend client in `src/api.ts` with typed responses.
- Job poller with staged progress; cancel on unmount.
- All loading states are skeletons with named stages; never a bare spinner.

### Sky workspace (`#/sky`)

Visual language: near-black map, thin lines, glass panels, blue accent
`#9db2ff`, warm accent `#ffb27a`. Layout: 56 px top bar, 280 px left rail,
full-bleed Aladin canvas.

- Aladin Lite with the DR1 All-Sky Cube via the existing service-worker adapter
  (`public/hips-adapter.js`, unchanged behaviour) and channel switching.
- Left rail: object search (filters `/api/catalog`), object list, coordinate
  form (RA/Dec + size), recent selections.
- Bottom-center channel dock: 102-channel slider, current index, λ (µm), band.
  Blank channels 50/51 are skipped.
- Floating data card: center RA/Dec, FOV, active channel, scale bar.
- Toolbar: pan / region select / all-sky. Region select drags a box, then
  immediately calls `POST /api/jobs` for the current channel (image only).
- A “Preparing plate” card lists stages with checkmarks and progress:
  `Discovering products`, `Downloading cutout 1/1`, `Extracting LVF map`,
  `Rendering frames`. When ready, a primary “Open spectral plate” action.
- If the region exceeds 30 arcmin or discovery says no coverage, show the exact
  reason and keep the sky usable.

### Spectral plate workspace (`#/plate/{jobId}`)

Visual language: **paper and instrument**, deliberately different from the sky.
Background `#ece9e1`, panel `#f6f4ee`, ink `#1c1b18`, rules `#cfc9bb`, rust
accent `#8a3b2e`, teal accent `#1f4e5f`, serif display (Georgia) + monospace
numerals. A thin dark ribbon at the top with `← Sky` and the plate id.

Three columns:

1. **Plate sheet (left, 260 px)** — object/region name, RA/Dec, FOV, detector,
   obs_id, observation date, source (`local`/`remote`), units, LVF statement,
   flag-bit legend, provenance disclosure.
2. **Plate stage (center)** — the cutout on a charcoal matte, displayed as an
   inverted grayscale plate (black sources on white) like a photographic plate.
   Zoom, pan, reset; crosshair pixel probe; fixed FOV label top-left. Product
   tabs `IMAGE / VARIANCE / FLAGS` as underlined text tabs. Mode switch
   `Detector / Channel slice`. Stretch select. Channel slice shows the LVF
   stripe over a dim context.
3. **Spectral rail (right, 300 px)** — vertical channel list (index, λ, band,
   disabled blanks), current channel, window, and the pixel readout card:
   `x, y`, `λ`, `Δλ`, `IMAGE` (MJy/sr), `VARIANCE`, `FLAGS` raw + bit names.
   A note: “WCS-WAVE approximate; not calibrated CWAVE/CBAND.”

Bottom of the center stage: **epoch strip** from the job's cutouts. One epoch →
“One epoch discovered — no comparison”; two or more → select A/B, `Blink`
toggle, and a split divider view. Use real dates and obs ids.

Optional products: the plate starts with IMAGE only. `VARIANCE` and `FLAGS`
tabs are enabled only when loaded; a “Load variance / flags” action creates a
job for the same region with the extra products. Show the prepare state inline.

### Interaction rules

- Coordinate entry, object click, or region select triggers backend prefetch
  immediately, before the plate is opened.
- Changing channel in the plate reuses the same job when the detector is already
  loaded; otherwise it requests the missing detector (with the same cache).
- Keep the sky view alive when navigating to the plate, so “← Sky” is instant.
- All numbers are tabular; RA/Dec shown to 5 decimals, λ to 4 decimals (µm).

## 7. Checks

Backend: `uv run ruff check app tests`, `uv run pytest -q`.

- Channel parsing from a fixture properties file.
- Flag-bit extraction from the local FITS header.
- Local footprint coverage + cutout slice + WCS-WAVE per-pixel map.
- Render: full PNG, slice RGBA, flags bit mask.
- API: health, channels (fixture), catalog, job lifecycle against the local
  asset, pixel probe, manifest, 404/409 paths. No network in tests.
- Smoke test with real TAP is manual and reported honestly.

Frontend: `pnpm typecheck`, `pnpm test`, `pnpm build`.

- Channel/format helpers (λ formatting, band math, window math).
- Region→job request mapping.
- API client error handling.
- Render smoke test is not required (no browser harness).

## 8. Non-goals for this slice

- Multi-FITS mosaic assembly for regions larger than one product (pending;
  cap + explicit message).
- Calibrated CWAVE/CBAND ingestion.
- AI classification or source detection.
- Authentication, persistence beyond the local cache, deployment.
- Exact reproduction of mockup-generated stars/epochs: the mockup supplies
  layout and interaction only.
