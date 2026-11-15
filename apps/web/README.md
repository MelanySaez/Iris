# Planet X — SPHEREx discovery lab

The application now has **two separate workspaces**. The all-sky view uses authentic DR1 All-Sky Cube PNG HiPS tiles through the existing Aladin Lite service-worker adapter. Selecting a small region begins a backend coverage check and prefetch for a local DR1 individual spectral-image FITS. The spectral-image view uses that FITS, not the All-Sky PNG tile.

## Run both services

```bash
cd apps/server
uv sync
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

```bash
cd apps/web
pnpm install
pnpm dev
```

Open the Vite localhost URL. The frontend needs IRSA network access for the official HiPS and localhost/HTTPS for its service worker. Vite proxies `/api` to the FastAPI server on port 8000.

## Assistant

The round button in the bottom-right corner opens the Planet X assistant (any OpenAI-compatible model, called by the backend; see `apps/server/README.md` → Contextual assistant). Ask about the app or give instructions such as “show M101 in RGB” or “open Records”. Each question carries the current interface state (workspace, channel, colour mode, selected region, map centre and zoom). The reply's actions run in the browser after a second validation (`src/assistant.ts`): opening a workspace, drawing a draft region in Sky (it never starts a job; press **Confirm region**), changing channel or colour mode. Each action shows under the reply, and the browser reports whether it ran. **Activity** lists the logged events of the conversation (model calls with tokens and latency, tools, cache hits, guardrails). Replies answered from the cache show **From cache**. **New** starts a new conversation. Without `ASSISTANT_API_KEY` and `ASSISTANT_MODEL` on the server the panel says the assistant is disabled.

## Saved selections (Records)

Every region selected in Sky creates a job, and the backend saves it as a selection record. Open **Records** in the top bar to list them, open a ready plate, inspect a pending or failed job in Plate, or delete it. Plate shows discovery attempts and retry timing in the spectral rail; failed jobs offer an explicit retry.

The **Name** column labels a selection: click the name or **Untitled** (or press **✎**), then edit in place without resizing the grid. Press **Enter** or leave the field to save; **Escape** discards the draft, and an empty name removes it. Names are stored by the backend (up to 80 characters), so every browser sees them.

The **View** column shows how the map looked when the region was selected: `Single` or `RGB · 16/32/46` (the evaluated channel is in **Channels**). It reads this browser's saved view first (when it belongs to the same evaluated channel) and otherwise the view the backend recorded; selections made before views were recorded show `—`. The **Channels** column is always the channel the job evaluated, which in RGB mode is the last single channel, not the composite.

**Show in Sky** rebuilds a record's selection box on the Sky map. When the region was selected in this browser, the map returns to the view it had then (centre, zoom, projection, channel or RGB composite), read from a plain-text entry in `localStorage` (`planetx_selection_view:<ra>,<dec>,<size>`). If there is no saved view, or it cannot be read, the box is rebuilt from the record's coordinates with the default framing.

Records need the backend database; see `apps/server/README.md` (Database). Without `DATABASE_URL`, the Records view shows the backend's 503 message.

## Try the first real spectral-image slice

1. Select **Open local DR1 sample** in the sidebar. This moves Aladin to the footprint of the one local FITS and starts prefetch before opening the result.
2. Open **Spectral image** while it loads to see progress and a skeleton; the image appears only once the FITS job is ready.
3. IMAGE is loaded by default. Opt into VARIANCE and FLAGS in the inspector; each request is deduplicated by coordinates, size and product set.
4. Click a detector pixel for its raw values and position-dependent wavelength lookup.

The per-pixel `WCS-WAVE` value is **visualization-only**, not calibrated CWAVE/CBAND. The All-Sky Cube channel index does not automatically identify a unique wavelength across an individual LVF image.

The mockup supplies layout direction only. Its generated stars, epochs, historical effects and catalog are not used. Arbitrary-region SIA discovery, calibrated per-pixel channel association, multi-FITS mosaics, precomputed object assets and real historical comparison remain pending. Regions outside the local FITS explicitly report unavailable coverage.

## Search by name or catalogue code

Type an object name or code in **Search objects** (for example `M31`, `NGC 224`,
`Betelgeuse`, `HD 48915`, `IRAS 02341+0934` or a `J…` designation). When typing
pauses, the object SIMBAD/NED knows by that name appears as the first suggestion
under the box (official name, type, position and source), above the matching
featured objects. Click it, or press **Enter** to take the first suggestion
right away. Partial names are not completed: SIMBAD only resolves full names or
codes. If every resolver is down, use **Go to coordinates**.

## Sky RGB composite

In the Sky channel dock, switch from **Single channel** to **RGB composite** to
paint three SPHEREx channels red, green and blue and blend them additively over
the whole sky (Aladin overlay layers). Pick each band from the selectors, or use
a preset: **Stars** (1.1 / 1.6 / 2.2 µm), **Organic dust** (3.3 µm PAH feature in
red) or **Full range** (0.9 / 2.6 / 4.6 µm). The three channels must differ and
the blank channels 50/51 are not offered. This is false colour built from the
8-bit display tiles: use it to see where bands differ, not to measure.
**Single channel** removes the colour overlays and restores the slider.

## Spectral Lab

Open **Spectral Lab** in the top bar (`#/spectral`), or select a region in Sky
and press **View spectrum →** to open the Lab with the spectrum at the centre of
the selection already added. Add up to 8 spectra from the
curated catalog or by typing RA/Dec in degrees; each is fetched from
`GET /api/spectrum` and plotted as wavelength (µm) against surface brightness
(MJy/sr) on one shared axis. Hover the chart for per-channel values and hit
counts; switch the brightness axis between **Linear** and **Log** to compare
bright and faint targets (values ≤ 0 cannot be drawn on a log axis: they
appear as gaps and the chart says how many); hide or remove a spectrum from
the sidebar (each keeps its colour);
expand **Data table** for the numbers.

These are quick-look profiles of a single All-Sky Cube mosaic pixel, not
calibrated source photometry. Gaps are channels with no coverage at that pixel.
Band selection, RGB composites and the SPHEREx Spectrophotometry Tool are pending.

## Checks

```bash
cd apps/server && uv run ruff check app tests && uv run pytest -q
cd ../web && pnpm test --run && pnpm typecheck && pnpm build
```

## Current audit update
The mounted UI is `App` / `SkyWorkspace` / `PlateWorkspace`, using `/api/jobs`.
Sky tiles now use a browser cache (128 entries / 64 MiB); after settling, up to
16 neighbour requests warm recently observed tile paths, skipping channels 50/51.
Prefetch is cancelled on navigation and disabled with Save-Data. The 8 MiB batch
budget stops after the current response; one tile may exceed the remaining budget.
This caches compressed tiles, not decoded GPU textures; instant switching is not guaranteed.
Selected regions retain sky coordinates while moving between Sky and Plate; hover
or keyboard-focus the selection to remove it. Cutouts retain native pixels, with
no silent 512-pixel crop. Region limit: 60 arcmin; multi-FITS mosaicking is pending.
Backend logs expose request IDs/timing and job IDs/stages/cache hits; job snapshots
include an execution trace. WCS-WAVE remains approximate.
Validation: 65 frontend tests, typecheck/build pass. Backend: 15 pass / 11 fail
because the configured local FITS fixture is absent; real cutout size/hover and
multi-FITS behavior are NOT verified. Desktop screenshot covers loading UI only,
not live sky interaction or mobile. Large Aladin bundle warning remains.

Sky view update: the channel control now passes the selected virtual HiPS URL
through Aladin Lite's documented `setImageLayer(url)` API. The stage reports
which channel's real tile request succeeds/fails; distinct URL invocation is
covered by unit tests, but this is not a browser proof that the rendered pixels
differ. Projection choices are orthographic, Aitoff, Mollweide and tangent.
The data card distinguishes center from live cursor ICRS coordinates. Sky region
selection still starts backend preparation, but its detailed progress is shown
in the Plate workspace only; Sky offers an explicit **Open spectral plate** action.

Assistant replies render Markdown, including headings, lists, links, code blocks and tables. Wide tables and code blocks scroll within the reply. User messages remain plain text. Raw HTML from replies is ignored.
