# TOCats catalogue layers
Objective: Integrate regional Gaia DR3 and CatWISE2020 catalogues while preserving SPHEREx, local featured objects, and SIMBAD HiPS.
Branch: `feature/tocats-catalog-layers` · Delivery: `ask-on-risk` · Test runner: `cd apps/web && ./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vite build`.
Engram mirror: `odd/tocats-catalog-layers/tasks` (sync from this file at each task transition).

## Specs

### S1 — Preserve existing layers
- Authorized scope: Keep the existing SPHEREx Aladin Lite image layer, local featured-object layer, and SIMBAD HiPS toggle/status/error behavior intact.
- Acceptance: The local layer remains offline-capable and enabled by default; SIMBAD remains independently toggleable; spectral channel switching continues to work.
- Exact requirement: “Mantén la integración SIMBAD existente, incluyendo su opción en la interfaz y su manejo de errores.”
- Checks: focused catalog tests; web typecheck/build; manual UI smoke check where browser tooling permits.

### S2 — TOCats service protocol
- Authorized scope: Use only verified regional endpoints and bounded response formats; no catalog-wide downloads or guessed HiPS compatibility.
- Acceptance: Both providers use TOCats catalogue names and a documented cone query; keep actual source identifiers and reported fields.
- Exact requirements: “Determina si ofrecen catálogos HiPS directamente compatibles con `A.catalogHiPS()` o si requieren consultas espaciales mediante una API HTTP.” “No asumas que TOCats es compatible directamente con HiPSCat.”
- Checks: tests for URL construction, JSON table decoding, validation, and empty/error payloads.

### S3 — Gaia DR3 layer
- Authorized scope: Add an independently toggleable Gaia DR3 layer with selectable sources and only available identifier, coordinate, photometric, proper-motion, and quality fields.
- Exact requirement: “Implementa primero Gaia DR3.”
- Checks: parser tests and manual layer/pop-up smoke check.

### S4 — CatWISE2020 layer
- Authorized scope: Reuse the same regional-query architecture for CatWISE2020, preserving W1/W2, proper-motion, uncertainty, and original identifier fields with their catalogue units.
- Exact requirement: “Integra CatWISE2020 reutilizando la arquitectura.”
- Checks: parser tests and manual layer/pop-up smoke check.

### S5 — Viewport request performance
- Authorized scope: Debounce viewport changes, cache bounded successful queries, abort/discard stale requests, cap returned/rendered markers, and keep remote work independent of channel changes.
- Exact requirements: “Consultar únicamente la región visible cuando sea necesario.” “Utilizar debouncing, caché y cancelación o descarte de solicitudes obsoletas.” “Evitar solicitudes redundantes cuando el usuario cambia únicamente el canal espectral.” “No bloquear el renderizado del mosaico esperando respuestas de los catálogos.”
- Checks: deterministic cache/query helpers and lifecycle smoke check; verify channel switch does not issue a query.

### S6 — Scientific and interface integrity
- Authorized scope: Preserve coordinate units/epochs and catalogue provenance, keep Gaia and WISE magnitudes distinct, do not cross-match catalogues by proximity (any local/SIMBAD duplicate suppression must use an exact identifier match), do not propagate positions, use distinct restrained markers, and expose loading/available/empty/error states without redesigning the sidebar.
- Exact requirements: “No inventes nombres, clasificaciones ni descripciones que el catálogo no proporcione.” “No asumas que dos fuentes de catálogos diferentes son el mismo objeto únicamente porque están próximas.” “No modifiques la posición de los marcadores según el tiempo de SPHEREx sin una transformación astrométrica justificada.” “No rediseñes el sidebar ni el visor. Haz únicamente los ajustes necesarios para integrar las nuevas capas.”
- Checks: safe popup formatting tests; structural UI readback and Impeccable detector.

### S7 — Wide-field density and retained viewport data
- Authorized scope: Use TOCats HEALPix child tables for clearly identified density summaries at broad FOV, then query individual sources only in sufficiently sparse fields; retain previously loaded entries across small pans and network failures.
- Acceptance: Adaptive tile order keeps a wide-field response bounded; summary cells and real sources have separate identities and popups; successful queries merge into bounded in-memory coverage instead of replacing old markers; rendering proceeds from center outward without extra per-pan HTTP requests.
- Exact requirements: “me parecería una cagada que cada que se moviera ligeramente la vista se pierdan de vista los ya existentes” “Por qué esperar a tan pequeño FOV para cargar?” “comience a buscar desde el centro y de ahí vayan cargando el resto progresivamente”
- Approved direction: “Densidad → fuentes” at broad-to-narrow FOV, with defaults of 500 visible summary cells, 2,000 estimated sources before mother-table access, 300 source markers, and 3,000 cached entries of each kind per catalogue.
- Checks: child-table parser fixtures, adaptive-order and coverage tests, stale/error retention tests, web suite/typecheck/build, and manual browser smoke when available.

## Tasks
- T1 — S2: Inspect TOCats docs and probe bounded Gaia/CatWISE queries; inline; complete (docs and live responses recorded in L2); commit: pending feature close.
- T2 — S3, S5, S6: Add/test the shared regional TOCats query, response parser, bounded cache, and request lifecycle; inline; complete (9 TOCats unit tests pass); commit: pending delivery strategy.
- T3 — S3: Integrate Gaia DR3 toggle, visible-region loading, selection metadata, and status; inline; complete (full suite, typecheck, and build pass; interactive browser smoke unavailable); commit: pending delivery strategy.
- T4 — S4, S5, S6: Integrate CatWISE2020 using the shared adapter; inline; complete (full suite, typecheck, build, and independent lifecycle probes pass); commit: pending delivery strategy.
- T5 — S1, S3–S6: Run focused tests, typecheck/build, detector, UI smoke check if available, and close feature; inline; pending decision (implementation checks pass; the native review candidate needs an explicit intended-untracked selection; interactive visual smoke remains unavailable); commit: pending delivery strategy.
- T6 — S2, S5–S7: Implement adaptive TOCats density, source drill-down, retained bounded coverage, and center-out rendering; inline (one dependent behavior); complete (93 web tests, typecheck, build, live child-table probes, independent scoped recheck passed; interactive browser smoke unavailable); commit: pending delivery strategy.

## Log

### L1 — Original user request (verbatim)

\## PlanetX — Integración experimental de TOCats (Gaia DR3 y CatWISE2020)\
\
La implementación anterior funciona correctamente: el visor SPHEREx con Aladin Lite, el catálogo local precargado y los controles de capas están operativos.\
\
Ahora queremos experimentar con proveedores alternativos de catálogos astronómicos.\
\
\### 1. Problema actual\
\
El servidor de SIMBAD HiPS:\
\
https\://hipscat.cds.unistra.fr/HiPSCatService/Simbad/\
\
no está respondiendo. Hemos comprobado que incluso una petición \`curl\` directa termina con un timeout de conexión TCP al puerto 443.\
\
Parece tratarse de un problema externo del CDS, no necesariamente de nuestra implementación.\
\
\*\*Mantén la integración SIMBAD existente\*\*, incluyendo su opción en la interfaz y su manejo de errores. No necesitamos eliminarla ni seguir intentando arreglar un servidor externo que no responde.\
\
\### 2. Nuevo objetivo: probar TOCats\
\
Queremos investigar e integrar los catálogos astronómicos ofrecidos por INAF mediante TOCats.\
\
Referencias:\
\
\- https\://catsweb.oas.inaf.it/\
\- https\://cats.oas.inaf.it/\
\
Catálogos prioritarios:\
\
\- \*\*Gaia DR3:\*\* posiciones, identificadores, fotometría y movimientos propios.\
\- \*\*CatWISE2020:\*\* fuentes infrarrojas, magnitudes W1/W2 y movimientos propios.\
\
Antes de implementar, investiga cómo se consumen realmente estos servicios.\
\
Determina si ofrecen catálogos HiPS directamente compatibles con \`A.catalogHiPS()\` o si requieren consultas espaciales mediante una API HTTP.\
\
\*\*No asumas que TOCats es compatible directamente con HiPSCat.\*\* Verifica sus endpoints, formatos de respuesta, disponibilidad y restricciones.\
\
\### 3. Integración con la arquitectura existente\
\
Inspecciona primero el código actual y reutiliza los componentes, servicios y mecanismos de carga de catálogos que ya existen.\
\
En la sección \`CATALOG LAYERS\` queremos conservar:\
\
\- Featured objects (catálogo local, activado por defecto).\
\- SIMBAD HiPS (mantener como opción existente).\
\- Gaia DR3 (nuevo).\
\- CatWISE2020 (nuevo).\
\
Cada catálogo debe poder activarse y desactivarse independientemente.\
\
Cuando el usuario seleccione una fuente, muestra los datos disponibles en el sistema de selección o panel de información existente.\
\
Prioriza identificador, RA/Dec, tipo de fuente si está disponible, magnitudes, movimiento propio y calidad de las mediciones. No inventes nombres, clasificaciones ni descripciones que el catálogo no proporcione.\
\
\### 4. Rendimiento: prioridad absoluta\
\
La navegación del mosaico SPHEREx actualmente es muy fluida. \*\*No queremos sacrificar esa experiencia por añadir catálogos.\*\*\
\
Requisitos:\
\
\- Evitar descargar catálogos completos.\
\- Consultar únicamente la región visible cuando sea necesario.\
\- Utilizar debouncing, caché y cancelación o descarte de solicitudes obsoletas.\
\- Limitar la cantidad de marcadores renderizados.\
\- Evitar solicitudes redundantes cuando el usuario cambia únicamente el canal espectral.\
\- No bloquear el renderizado del mosaico esperando respuestas de los catálogos.\
\- Mantener funcional el catálogo local aunque fallen los servicios externos.\
\- Evitar consultas remotas excesivas cuando el usuario hace zoom o arrastra el mapa.\
\
Si TOCats ofrece acceso progresivo mediante teselas, priorízalo. Si solo ofrece consultas regionales, implementa un adaptador ligero y evalúa su rendimiento.\
\
Si aparecen problemas de CORS, analiza si es conveniente un proxy mínimo utilizando el servidor que ya existe. No construyas infraestructura adicional sin necesidad.\
\
\### 5. Consideraciones científicas\
\
\- Utiliza coordenadas ICRS cuando corresponda y conserva las unidades.\
\- No confundas magnitudes Gaia con magnitudes WISE.\
\- Conserva la procedencia del catálogo y los identificadores originales.\
\- No asumas que dos fuentes de catálogos diferentes son el mismo objeto únicamente porque están próximas.\
\- Ten en cuenta que los movimientos propios y las posiciones pueden estar referidos a épocas distintas.\
\- No modifiques la posición de los marcadores según el tiempo de SPHEREx sin una transformación astrométrica justificada.\
\
\### 6. Interfaz\
\
Mantén el diseño visual actual de PlanetX.\
\
Añade Gaia DR3 y CatWISE2020 a \`CATALOG LAYERS\`, siguiendo el estilo de los controles existentes.\
\
Cada capa debería mostrar estados claros: cargando, disponible, sin resultados o error.\
\
Utiliza colores distinguibles para los marcadores de cada catálogo y evita saturar visualmente el mosaico.\
\
No rediseñes el sidebar ni el visor. Haz únicamente los ajustes necesarios para integrar las nuevas capas.\
\
\### 7. Estrategia de implementación\
\
Trabaja incrementalmente:\
\
1\. Inspecciona la implementación actual.\
2\. Investiga y prueba la conectividad y los formatos de TOCats.\
3\. Implementa primero Gaia DR3.\
4\. Verifica que la capa se dibuja correctamente y no degrada la navegación.\
5\. Integra CatWISE2020 reutilizando la arquitectura.\
6\. Comprueba la gestión de errores, la selección de objetos y la independencia de las capas.\
\
Si algún servicio no funciona o su integración resulta incompatible, documenta el problema y conserva la aplicación estable. No simules resultados remotos para aparentar que la integración funciona.\
\
\### Resultado esperado\
\
Una implementación experimental pero funcional de Gaia DR3 y CatWISE2020, conservando SIMBAD HiPS y el catálogo local.\
\
Al finalizar, indica:\
\
\- Qué endpoints y protocolos utilizaste.\
\- Qué servicios responden realmente.\
\- Qué archivos modificaste.\
\- Cómo se gestionan la caché, el límite de objetos y las solicitudes obsoletas.\
\- Qué limitaciones técnicas o científicas encontraste.\
\- Cómo probar cada capa desde la interfaz.\
\
\*\*Prioridad final: mantener la fluidez del visor SPHEREx y reutilizar al máximo la arquitectura existente.\*\*

### L2 — Service research and live probes
- Official TOCats documentation describes HTTP cone queries using `/{catalogue}/radius=X&ra=Y&dec=Z`; VOTable is default and JSON/TSV/CSV are optional. The Gaia parent is `gaiadr3`; the CatWISE2020 base catalogue is `catwise_mini`.
- Live bounded probes from this environment (2026-11-14) returned HTTP 200 JSON for `gaiadr3/...&limit=1&json` (3.565 s) and `catwise_mini/...&limit=1&json` (1.329 s), with `Access-Control-Allow-Origin: *`. Responses expose `metadata` plus ordered `data.objs` arrays; Gaia fields include `source_id`, `ra`, `dec`, `pmra`, `pmdec`, Gaia G/BP/RP magnitudes, `ruwe`, and astrometric errors/counts; CatWISE fields include `source_name`, `ra`, `dec`, `PMRA`, `PMDec`, `w1mpro`, `w2mpro`, uncertainties, and `w1mJDmean`.
- `/gaiadr3_hips9/properties` returned a VOTable cone/table response, not HiPSCat `properties` metadata; Gaia query metadata reports `is_hips:false`. Therefore use TOCats regional API, not `A.catalogHiPS()`.
- No proxy is needed for these observed JSON endpoints because CORS is `*`; failed requests remain a client-side status only. Do not propagate positions or conflate the different proper-motion units.

### L3 — Route and implementation direction
- The user explicitly requested direct inline continuation after the configured explorer model was unavailable. TOCats HTTP queries are simple bounded cone requests with working cross-origin GETs, so the web app can use a lightweight client; do not add a server proxy or change the SPHEREx image path.

### L4 — Shared TOCats adapter
- Added `apps/web/src/tocats.ts` with a typed allowlisted provider map, bounded cone URL builder, TOCats row-array parser, marker cap, safe popup formatter, 5-minute/24-entry LRU cache, and abort-aware client. Test-first RED was the missing-module failure; GREEN is `./node_modules/.bin/vitest run src/tocats.test.ts` (7 tests passed).
- `pnpm` is declared by the project but is not installed in this environment; the already-installed local Vitest binary is available and is used for checks. No source files are formatted or normalized yet.

### L5 — Gaia DR3 layer
- Added an independent Gaia checkbox/status and a viewport-only cone query, with 850 ms idle debounce, 15 s timeout, 300-source cap, cached API results, and stale-request cancellation. Gaia markers use Aladin's selectable popup path; the popup labels Gaia G/BP/RP as optical magnitudes and uses Gaia's documented ICRS reference epoch without propagating positions.
- `./node_modules/.bin/vitest run src/tocats.test.ts src/catalogs.test.ts`: 10 tests passed. `./node_modules/.bin/tsc --noEmit`: passed after removing one unused local. Interactive drawing/pan performance remain for the final smoke-check step.

### L6 — CatWISE, scientific identity rule, and final verification
- Completed CatWISE2020 as an independent layer over the shared regional client. The independent verifier found that the pre-existing SIMBAD/local duplicate filter treated any source within 5 arcseconds as the same object. Added an S6 regression test, observed RED (`expected false, received true`), then changed SIMBAD suppression to require a normalized exact `main_id` match to a featured-object name; proximity and coordinate-only rows are retained. Gaia/CatWISE do not use cross-catalog proximity suppression.
- Independent verifier completed S1–S6; all were met after the S6 correction. Isolated probes passed for debounce, out-of-order responses, independent layer cancellation, timeout/error/empty states, radius/marker limits, cache TTL/LRU, and identifier-only suppression. No verifier edits were made.
- Final checks: `./node_modules/.bin/vitest run` — 9 files, 78 tests passed; `./node_modules/.bin/tsc --noEmit` — passed; `./node_modules/.bin/vite build` — passed with a >500 kB bundle warning; Impeccable detector — `[]`.
- Live probes returned HTTP 200 JSON and `Access-Control-Allow-Origin: *` for both `gaiadr3` and `catwise_mini`. No proxy or backend change was needed. Headless Firefox could not capture a screenshot (`RenderCompositorSWGL failed mapping default framebuffer`); no Playwright/browser automation dependency is installed, so direct checkbox/popup interaction and pan smoothness remain unverified.
- Native risk assessment of the explicit candidate returned `medium`, `review_due:false`, `under_budget`; no native review was started. The candidate is 1,497 changed lines and delivery strategy is `ask-on-risk`, so work-unit commits remain pending the user's chain choice (`stacked-to-main` or `feature-branch-chain`). No commit was created.

### L7 — User-reported browser fetch error
“Por qué esperar a tan pequeño FOV para cargar? De igual manera, mira lo que me sale, error de fetch y ya”

### L8 — Fetch binding fix and broader-field investigation
- The supplied screenshot shows FOV 7.50° and the `fetch called on an object that does not implement interface Window` error. The viewport guard only emits the zoom message; reaching this error proves the current field passed the guard and attempted a request.
- Root cause: `TocatsCatalogClient` stored the global Fetch function and invoked it as `this.fetcher(...)`, binding `this` to the client instance instead of `Window`. Added a regression test that observed this receiver mismatch (RED), then bound injected/default fetchers to `globalThis`; the regression test now passes.
- The 5° query radius is a conservative application guard (about 10° field diameter), not a proven universal API maximum. TOCats' own browser shows a maximum 10° FoV for its SIMBAD overlay, while live cone probes from this environment found Gaia/CatWISE 1° queries around 4 s, 2° queries around 9/14 s, 3° queries timing out at 15 s, and a CatWISE 4° query returning HTTP 500. At 5° and 7.5° the tested limit=300 parent-catalogue queries returned HTTP 500. Do not widen the parent-table query radius without another access strategy.
- Both `gaiadr3_hips9` and `catwise_mini_hips9` returned fast regional results at order 9, but their rows are HEALPix-cell summaries (`Nobjs`, representative coordinates, mean magnitude), not individual source records. This could support a separately labeled coarse-density overview; it cannot replace selectable source markers without changing what the layer represents. No such UI behavior was added pending product direction.
- Final checks after the fetch fix: `./node_modules/.bin/vitest run` — 9 files, 79 tests passed; `./node_modules/.bin/tsc --noEmit` — passed; `./node_modules/.bin/vite build` — passed with a >500 kB bundle warning. Interactive browser recheck remains unavailable in this environment.

### L9 — TOCats marker visibility correction (2026-11-14)
- User report: “Fíjate que los recursos supuestamente cargan (algunos pues) pero no se ven nada. Podríamos revisar esa parte?” User authorized the focused adjustment with “dale pa ve”.
- Confirmed from the installed Aladin Lite 3.8.1 renderer that `A.marker()` defaults to `useMarkerDefaultIcon: true`; this bypasses each catalog's configured circle/diamond shape. With both TOCats catalogs using `sourceSize: 6`, the marker's catalog-colored fill is only about a 1 px radius and blends into the dense SPHEREx field. The displayed source count reports fetched/added rows, not visible rendering.
- Reopen T5 / S6 to use Aladin's catalog-colored source shape for TOCats markers and a modestly larger size while preserving the 300-source cap, no labels, local objects, SIMBAD, and SPHEREx. Add a focused regression test; run web tests, typecheck, build, and the Impeccable detector. Browser interaction remains unavailable unless tooling is found.

### L10 — Marker style implementation and verification
- Added a focused test-first marker-presentation check: RED observed for both 6 px layer sizes and missing default-icon override; GREEN after setting both TOCats layer sizes to 10 px, adding `getTocatsMarkerOptions`, and passing `useMarkerDefaultIcon: false`. Aladin now uses each layer's configured provider color and circle/diamond shape while retaining popup titles/descriptions.
- Verification: focused marker tests passed; full Vitest suite passed (9 files / 81 tests); `tsc --noEmit` passed; `vite build` passed with the existing >500 kB bundle warning; Impeccable detector returned `[]`; `git diff --check` passed. No interactive browser screenshot was available (`playwright` CLI absent; prior headless Firefox capture failed in this environment).
- Native assessment is pending: RDD is on by default, but `review assess` cannot classify the current workspace while seven feature files are untracked. Native STATUS returned a `collect` transition for `intended_untracked_selection`; its `external.select_intended_untracked` capture operation is not exposed in the current tool surface. Do not invent a selection or submit a different capture; ask which eligible paths belong in the candidate. No review START or commit was run.
- Pending selector context: target `sha256:25b3ae2aa371cab1005fad0e43ddee82c67c8bb88c057290bae2c1dda5c775fb`; inventory `sha256:f826a81220b746db132dbd4de44e784a94062665823f9ac364016d8ac30859c1`; eligible paths: `apps/web/src/catalogs.test.ts`, `apps/web/src/catalogs.ts`, `apps/web/src/data/featured-objects.json`, `apps/web/src/hooks/useTocatsCatalogViewport.ts`, `apps/web/src/tocats.test.ts`, `apps/web/src/tocats.ts`, `odd/tasks/tocats-catalog-layers.md`.
- Risk: none — the change only affects TOCats marker presentation and retains existing request limits and selection metadata.

### L11 — Wide-field plan authorization (2026-11-14)
- User request (verbatim): “Please implement the plan.”
- This authorizes the immediately preceding proposed plan for adaptive TOCats density summaries, bounded source drill-down, merged viewport retention, and center-out drawing. Preserve the pre-existing user edits and do not add a proxy for HTTP 500.
- T6 route: inline; the data-flow change is dependent across the TOCats adapter and viewport hook, so parallel writers would overlap. Risk item 4 (async ordering/cancellation); require an independent verifier after focused and full checks.

### L12 — Progressive density implementation and verification
- Added explicit five-column parsing for TOCats HEALPix child-table aliases, adaptive orders 3–9, bounded 500-tile queries, source drill-down under 2,000 represented objects, selectable density popups, and distinct source/density Aladin layers. Both `gaiadr3_hips3` and `catwise_mini_hips3` returned HTTP 200 at radius 90.01° with 385 and 383 rows respectively.
- Live metadata revealed that child `n_objs` counts returned HEALPix cells while `n_objs_found` counts represented catalogue sources. A regression test observed the incorrect interpretation as RED; the parser now uses the correct fields and treats a 500-row response as potentially truncated. Gaia/CatWISE child queries at order 7 also returned HTTP 200 with the expected five aliases and provider-specific Gaia G / WISE W1 representative magnitudes.
- A viewport cache merges records by catalogue-specific source ID or HEALPix cell ID, tracks successful cone coverage, caps each data kind at 3,000 entries, and only changes marker instances when the visible bounded set changes. Marker additions are center-sorted and drawn in batches of 50; stale requests are discarded, while network errors retain previously visible markers.
- Independent verifier reproduced two async/zoom blockers: coarse coverage suppressed narrow refinement, and source HTTP 500 hid previously visible sources after a density-mode switch. Both probes were imported as regressions, observed RED, fixed, and passed the verifier's scoped recheck (2 passed, 5 intentionally skipped). A separate real-response probe found that a tile representative can lie outside the narrow cone even when its tile intersects it; the cache now uses a HEALPix cell-width margin.
- Checks after correction: `./node_modules/.bin/vitest run` — 10 files / 93 tests passed; `./node_modules/.bin/tsc --noEmit` — passed; `./node_modules/.bin/vite build` — passed with the existing >500 kB chunk warning; `git diff --check` — passed. The Impeccable detector returned `[]`. Interactive browser smoke and native review remain pending under the prior worktree/delivery limitations.

