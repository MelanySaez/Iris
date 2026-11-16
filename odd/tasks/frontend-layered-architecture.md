# Frontend layered architecture refactor

Objective: reorganize `apps/web/src/` into layers that mirror the backend (`app`, `core`, `api`, `services`, `hooks`, `components`, `types`, `utils`, `data`, `styles`) without changing behaviour.
Branch: `refactor/frontend-layers`. Delivery: work-unit commits on the branch; push, PR and merge only when the user asks. Test runner: `npx -y pnpm@12.11.2 exec vitest run` (plus `tsc --noEmit`, `vite build`).

## Specs

- S1: Target tree under `apps/web/src/` (user choice "Espejo del backend"):
  `app/` (App.tsx, main.tsx, SpherexApp.tsx), `core/` (router, consent, service worker, config), `api/` (HTTP and external services), `services/` (pure logic), `hooks/`, `components/` (UI per workspace), `types/` (types.ts, aladin-lite.d.ts), `utils/`, `data/` (featured-objects.json), `styles/` (style.css).
- S2: Placement follows what each module does (verified by reading imports and side effects):
  - `api/`: api.ts, hips.ts, tocats.ts, nearbyCatalogs.ts, simbadViewport.ts, aladinView.ts, catalogPopup.ts (Aladin Lite adapters and remote catalog access).
  - `services/`: spectrum, spectrumLabel, channels, region, rgb, records, selectionView, lookupView, assistant, catalogs, labFeatured.
  - `core/`: router, consent, serviceWorkerControl.
  - `utils/`: format, searchEnter, catalogMarker.
  - Assumption: `assistant.ts` goes to `services/` (pure validation, no network) and `catalogMarker.ts` to `utils/` (canvas drawing helper), deviating from the first sketch that listed assistant under `api/`.
- S3: Each test file moves with the module it tests; tests not tied to one module (App tests, progressive) move with App or stay with their subject.
- S4: Every import, `vi.mock` path, dynamic import and `?raw` import is updated; `index.html` loads the new entry point; `test/*.js` read the moved files.
- S5: No behaviour change: same tests pass (count unchanged), `tsc --noEmit` and `vite build` clean, and the app runs.

## Tasks

- T1 inline [complete, uncommitted]: 56 files moved with `git mv`, 143 relative specifiers rewritten (imports, vi.mock, dynamic and ?raw imports), none unresolved; progressive.test.ts moved to hooks/ next to useTocatsCatalogViewport. S1,S2,S3,S4
- T2 inline [complete, uncommitted]: index.html loads /src/app/main.tsx; test/style.test.js and test/sky-interaction.test.js read src/styles/style.css. S4
- T3 inline [complete]: 53 test files / 440 tests pass (same as baseline), tsc --noEmit and vite build clean; Chrome smoke run of #/, #/sky, #/spectral, #/records rendered every workspace with no error boundary and no console errors. S5

## Log

- L1 (user, verbatim): "refactoriza el frontend utilizando layer pattern"
- L2 (user choice, 2026-11-15): "Espejo del backend (Recommended)" with the tree in S1.
- L3: baseline before the refactor: 53 test files, 440 tests passing on main 25d36cb.
- L4: refactor applied and verified (T1-T3); behaviour unchanged. Not committed: the user commits only on explicit request.
