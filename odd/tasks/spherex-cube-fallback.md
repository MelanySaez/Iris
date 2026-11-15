# SPHEREx DR1 All-Sky Cube fallback

Objective: when IRSA TAP discovery is unavailable and the indexed S3 L2 fallback has no products, build job cutouts/mosaics from the DR1 HiPS spectral cube tiles on S3, tell the user exactly what happened (including the lack of temporal information), and make the plate view work with both sources.
Branch: feat/spherex-s3-poc. Delivery: feature-branch-chain, local work-unit commits only (no push/PR). Runner: `uv run --no-sync pytest` (apps/server), `vitest` (apps/web).

## Specs

S1. "requiero que implementes esta solucion en esta rama, esta solucion seria un fallback al metodo irsa tap: coutouts, mosaicos, retroalimentacion al usuario para que comprenda que sucede,ajustar el apartado de plate para que funcione con ambos metodos". Fallback order: IRSA TAP → indexed S3 L2 (existing, keeps temporal epochs) → DR1 cube on S3. Cube regions of 1–180 arcmin, one or several HEALPix order-5 tiles reprojected onto one north-up TAN grid (cutout and mosaic). Existing IRSA/L2 behavior unchanged.
S2. "la retroalimentacion al usuario debe avisar que este fallback carece de informacion temporal". Job events, discovery summary, animation reason and the plate UI state that the cube combines all DR1 observations (date range from the tile) into one image; epochs, timeline comparison and animation are unavailable.
S3. "unicamente necesitamos los campos de IMAGE,FLAGS Y WCS-WAVE y opcionalmente el NHITS" "Pensamos en cargar x canal especifico y no todos de golpe para los campos descritos". Read only the requested channel plane, only the needed row span, per HDU, with HTTP range requests; never download a whole tile. Cube has no VARIANCE: variance frames are not produced and the UI says so. Wavelength comes from the cube channel table (nominal per channel), never presented as calibrated.

Assumptions (verified 2026-11-15 on tile Npix7416): S3 key `dr1/hips5_cube/hips_20261026/Norder5/Dir{(n//10000)*10000}/Npix{n}_cube.fits`; IMAGE/NHITS/FLAGS uncompressed 512×512×102; channel plane = 1 MiB contiguous; `BLANKCH` lists all-NaN planes.

## Tasks

- T1 | S1, S3 | inline (one dependent behavior; no writer trigger) | complete | cube cutout service; RED (missing module) → GREEN 8 offline tests | commit e8f65a8
- T2 | S1, S2 | inline | complete | discovery fallback + job cube path + schema `source="cube"` + per-channel percentiles + notices; 7 more offline tests | commit e8f65a8
- T3 | S1, S2 | inline | complete | web plate notice, timeline chip, variance n/a, trace; RED → GREEN 6 tests | commit ef7acec
- T4 | S1–S3 | inline | complete | docs/experiments/spherex-cube-fallback.md + opt-in live test | docs commit

## Log

L1. User request (verbatim): "bueno, dadas las consideraciones, requiero que implementes esta solucion en esta rama, esta solucion seria un fallback al metodo irsa tap: coutouts, mosaicos, retroalimentacion al usuario para que comprenda que sucede,ajustar el apartado de plate para que funcione con ambos metodos"
L2. User addition (verbatim): "la retroalimentacion al usuario debe avisar que este fallback carece de informacion temporal"
L3. Prior user constraint (verbatim): "que manera tenemos para optimizar la carga de los fits considerando que unicamente necesitamos los campos de IMAGE,FLAGS Y WCS-WAVE y opcionalmente el NHITS. Pensamos en cargar x canal especifico y no todos de golpe para los campos descritos"
L4. Evidence: real tile reads — headers 11 GETs/31.7 KB; one channel IMAGE/FLAGS/NHITS one GET each (1 MiB); 3.2 MB total of 320.9 MB. Existing `cube_spectrum.py` already walks cube layouts over IRSA HTTP; reuse it with an S3 URL and separate layout cache. Explorer map: job seam after `query_index` in `discovery.resolve_region`; `resolve_cutout` supports per-channel keys; percentiles of non-calibrated cutouts are keyed per detector (would collide across cube channels).
L5. Decisions: fallback order TAP → indexed L2 → cube (L2 keeps epochs). Cube discovery returns one synthetic product per detector; the job builds one cutout per requested channel (percentiles keyed per channel). Synthetic cube products are skipped by the selection recorder to avoid a DB `source` CHECK violation and a migration (high-risk item 1) and to never record fallback as coverage. `submit` always adds `image`, so a variance-only cube job cannot exist (dead branch removed). Pixel scale measured from the tile WCS (12.88″), not assumed.
L6. Evidence: backend `uv run --no-sync pytest tests scripts/tests -q` → 309 passed, 7 skipped, 2 known pre-existing assistant `.env` failures. Ruff 0.17.4 (venv now works) check/format clean on changed files. Web `npx vitest run` → 48 files / 376 passed (previously blocked suites now pass); `tsc --noEmit` exit 0; `npm run build` exit 0. Live: cube pixels identical to IRSA cube reader at 3 off-centre pixels (ch 88); channel centres inside app windows (ch 20/50/88); live job 4′ 19×19 1 tile 0.32 MB 2.1 s; 180′ 839×839 8 tiles 31.2 MB 18–20 s. RDD assess of e8f65a8: medium, under_budget (slice open over e8d1678).
L7. Open: sequential tile reads (parallel is an optimization, not done); no browser screenshot of the plate notice; untracked user files `package.json`, `pnpm-lock.yaml`, `docs/experiments/spherex-cutout-layers.md` left untouched. Risk: none (additive source value and discovery keys; no persisted-format change; existing paths covered by the unchanged suite).
