# SPHEREx anonymous S3 proof of concept

Objective: validate anonymous S3 access, then integrate bounded fallback, calibrated large-field mosaics and temporal comparison.
Branch: feat/spherex-s3-poc. Delivery: auto-chain / feature-branch-chain (local work-unit slices only; no push or PR authorized; expansion actual ~3200 authored lines (cohesive scientific/provider units exceed the advisory slice budget)). Runner: uv run --no-sync pytest; anonymous bounded S3 live script.

## Specs

S1. "Primero valida el acceso remoto y la generación de un cutout real." "Si esos dos experimentos no funcionan, no construyas infraestructura adicional." Validate real DR1/QR3 headers, HTTP ranges, transfer counts, cutout WCS, retained science layers and existing extractor compatibility.
S2. "Para esta POC utiliza únicamente una muestra pequeña de archivos." "Distingue entre una región que no contiene observaciones y una región que todavía no ha sido indexada." Only after S1 works, test local coordinate discovery, ordering, limit and explicit incomplete coverage.
S3. "Mantén intacta la aplicación principal y documenta con precisión qué partes son funcionales, cuáles son experimentales y cuáles siguen pendientes." "Añade pruebas automatizadas para la lógica que pueda probarse sin red." "Documenta los comandos para ejecutar cada experimento mediante `uv run`." Produce a source-linked technical report and isolated scripts, with bounded timeouts/downloads, offline tests and opt-in live checks.

S4. "puedes hacer más pruebas para confirmar qué está funcionando bien, que el servicio de cutouts también, además de implementar mosaicos para recuadros más grandes." Accepted plan: 1–180 arcmin in all request surfaces, area overlap discovery with explicit completeness, outage-only IRSA-primary/S3 fallback with provider events. Unknown index coverage is never no observations.
S5. "puedes revisar notebooks/003 para revisar qué tanto se puede sacar de ahí" Accepted plan: exact product-associated CWAVE/CBAND verification; channel-specific, inverse-variance mosaics on shared celestial WCS, masks/flags/coverage/hit counts/provenance. Large-slew epochs remain separate; no calibrated output from WCS-WAVE alone.
S6. Accepted plan: "hasta 12 épocas del mismo detector y canal calibrado"; evenly sample in time, provide accessible interactive playback and GET /api/jobs/{job_id}/animation.gif?channel_id=<id>, common display stretch, 2 fps, max1024px. Fewer than two calibrated epochs has no animation.
S7. "Please implement the plan." Verify offline and opt-in live IRSA/S3 independently. Preserve existing work, report failed/unavailable checks, no fabricated calibration or coverage, no global bucket scan, no push or PR.

## Tasks

- T1 | S1, S3 | inline (one dependent behavior; no writer trigger) | complete | 7 offline tests and both live S3 cutouts observed | commit 339a242
- T2 | S2 | inline after T1 | complete | sample-only index | commit 339a242
- T3 | S3 | inline | complete | report, offline suite, live evidence, native review acknowledged | commit 339a242

- T4 | S4,S7 | delegated provider unit + parent discovery integration (parallel independent provider/mosaic/UI units) | implemented; provider candidate approved and acknowledged; integration candidate later escalated, not approved | commits f172c6c, 295f6dd
- T5 | S5,S6,S7 | delegated mosaic engine + parent job/API integration (disjoint engine surface) | implemented; focused tests and independent verifier passed; combined backend candidate review escalated, not approved | commits bfd6c84, 295f6dd
- T6 | S4,S6,S7 | delegated web timeline + limits (disjoint web surface) | implemented; focused web tests passed; full suite/build proof incomplete due to environment/dependency blockers | commit 2c21fb7
- T7 | S4-S7 | parent seam checks + independent high-risk verifier (item 3 shared contracts) | functional checks and independent verifier completed; feature closure pending the missing-channel product decision and unavailable frontend full-suite proof | no frontend commit; see L22

### Parallel handoff

- Read this document through `## Log` first, then the linked `docs/experiments/spherex-{provider,mosaics,integration}.md` reports before changing code. The reports and commit history contain the completed investigation; do not repeat S3 discovery or rebuild the implemented path from scratch.
- Current branch/head: `feat/spherex-s3-poc` at `2c21fb7`. Work-unit commits: `339a242` (original real-S3 POC), `f172c6c` (bounded provider fallback; its own native review approved/acknowledged), `bfd6c84` (mosaic engine), `295f6dd` (temporal/backend integration), `2c21fb7` (frontend timeline and 180-arcmin limits). Only the provider candidate has an approved native acknowledgement; the later engine/backend candidate is terminally escalated (L21).
- The web implementation is committed in `2c21fb7`: `apps/web/src/assistant.test.ts`, `assistant.ts`, `components/plate/EpochTimeline.test.tsx`, `EpochTimeline.tsx`, `components/plate/PlateWorkspace.tsx`, `components/sky/SkyWorkspace.tsx`, `region.test.ts`, `region.ts`, `style.css`, and `types.ts`. Treat these as existing work, not empty files or a fresh assignment.
- Preserve unrelated user edits in `apps/server/scripts/prestart.sh` and `apps/web/.env.example`; do not edit, stage, reset, or discard them. The task document itself already had staged history through L21 when this handoff was added; keep any new delta distinct and do not stage everything wholesale.
- **Current implementation gate:** do not change the behavior for explicitly requested channels missing calibration until the user chooses partial output with named unavailable channels versus failing the whole job. The review found that current strict-path jobs can be marked `ready` with a subset of requested channels, after which an omitted channel's frame lookup fails (L21). No native correction continuation exists; any future fix is a separate ordinary work unit.
- No parallel code writer is currently assigned. Read-only analysis may continue. After the product decision, keep backend channel/job semantics and corresponding API/UI handling together as one behavior; do not split a shared contract across competing writers. Provider review warnings R4-001/R3-001 are separate follow-ups, not approved fixes in this feature.
- Verification snapshot: backend suite `uv run --no-sync pytest tests scripts/tests -q` observed 294 passed, 7 skipped, 2 pre-existing assistant-disabled configuration failures. Web focused tests observed 37 passed; full run observed 352 passed but 3 suites, typecheck, and build were blocked by missing `react-joyride`/the incompatible pnpm binary in NixOS. TAP live smoke returned HTTP 502 through the proxy; real DR1/QR3 S3 cutouts, IRSA cutout, and SIA smoke passed. Real verified CWAVE/CBAND data is still unavailable, so no real calibrated temporal-science result is claimed.

## Log

L1. Original request (verbatim):

# PlanetX — Prueba de concepto: fallback SPHEREx con Amazon S3

## Contexto

Actualmente nuestro backend utiliza IRSA TAP para descubrir imágenes espectrales de SPHEREx y generar URLs de cutouts FITS.

Sin embargo, el servicio `https://irsa.ipac.caltech.edu/TAP/sync` está devolviendo errores HTTP 502 de forma persistente. También probamos SIA2 (`/SIA`), pero presenta problemas similares.

Queremos investigar la viabilidad de construir un **servicio de respaldo independiente del descubrimiento de IRSA**, utilizando los archivos FITS públicos de SPHEREx almacenados en Amazon S3.

No pretendemos replicar IRSA ni implementar un servidor TAP/ADQL completo. Queremos reproducir únicamente las operaciones que necesita PlanetX.

## 1. Arquitectura existente

El backend está desarrollado en Python y utiliza `uv`. Ya contamos con estos módulos:

- `app/services/discovery.py`: descubrimiento de imágenes y consultas TAP/SIA.
- `app/services/fits.py`: procesamiento de archivos FITS.
- `app/services/jobs.py` y `job_queries.py`: ejecución de trabajos y consultas.
- `app/services/cube_spectrum.py`: procesamiento espectral.
- `data/cache/`: sistema de caché existente.
- `notebooks/`: exploraciones científicas previas.
- `scripts/`: utilidades ejecutables.
- `tests/test_discovery.py`: pruebas de descubrimiento.

**Antes de implementar, inspecciona el código existente**, especialmente los contratos de datos entre descubrimiento, descarga de cutouts y procesamiento FITS.

No asumas que conocemos todos los detalles de los productos SPHEREx. Verifica las cabeceras y extensiones reales de los archivos.

## 2. Fuente de datos

NASA/IPAC publica archivos SPHEREx en un bucket público de Amazon S3:

`s3://nasa-irsa-spherex/`

Queremos investigar especialmente los productos espectrales Level 2 de:

- DR1.
- QR3.

Referencias:

- <https://irsa.ipac.caltech.edu/cloud_access/>
- <https://docs.astropy.org/en/stable/io/fits/usage/cloud.html>

Investiga la estructura real del bucket, la organización de los archivos y las alternativas para obtener sus metadatos sin descargarlos completamente.

Utiliza acceso público sin credenciales cuando sea posible.

## 3. POC 1 — Leer FITS remotamente desde S3

Implementa un experimento independiente que:

1. Verifique conectividad al bucket público.
2. Localice un archivo FITS espectral Level 2 real de DR1 o QR3.
3. Intente abrirlo mediante `astropy.io.fits` y `fsspec` sin descargarlo por completo.
4. Inspeccione sus cabeceras, extensiones HDU y dimensiones.
5. Extraiga metadatos relevantes:
   - Coordenadas y WCS.
   - Fecha o intervalo de observación.
   - Detector y banda espectral.
   - Identificadores disponibles.
   - Versión de procesamiento y release.
6. Documente si es viable leer estos datos mediante solicitudes parciales HTTP/S3.

Evita recorrer recursivamente todo el bucket. Limita las operaciones a unos pocos archivos representativos.

Si no puedes localizar un archivo válido, documenta el bloqueo; no inventes rutas ni datos.

## 4. POC 2 — Generar cutouts FITS sin IRSA

A partir de un FITS real accesible en S3, intenta generar un recorte utilizando Astropy.

El experimento debe:

1. Recibir RA, Dec y tamaño angular.
2. Utilizar WCS para calcular la región correspondiente en píxeles.
3. Leer únicamente la sección necesaria del archivo, cuando su organización permita hacerlo.
4. Generar un FITS recortado con WCS actualizado.
5. Verificar que el centro y las dimensiones del recorte sean correctos.
6. Comprobar cuánto se transfiere realmente desde S3 y si existe algún beneficio respecto a descargar el archivo completo.

Investiga específicamente cómo funcionan `fits.open(use_fsspec=True)`, las secciones FITS y `WCS.slice()`.

**Importante:** revisa cómo funciona actualmente `app/services/fits.py` y qué extensiones consume.

Comienza con la extensión `IMAGE`, pero determina si necesitamos conservar `FLAGS`, `VARIANCE`, `ZODI`, `EPSF` y `WCS-WAVE` para que el cutout sea compatible con el procesamiento científico actual.

No presentes un recorte únicamente visual como equivalente al cutout científico completo de IRSA.

## 5. POC 3 — Índice espacial local

Queremos investigar cómo reproducir esta funcionalidad específica del descubrimiento actual:

```sql
SELECT TOP 400
    a.uri,
    p.time_bounds_lower,
    p.energy_bandpassname,
    p.planeid
FROM spherex.artifact a
JOIN spherex.plane p
    ON a.planeid = p.planeid
WHERE 1 = CONTAINS(
    POINT('ICRS', :ra, :dec),
    p.poly
)
ORDER BY p.time_bounds_lower
```

No necesitamos interpretar ADQL dinámicamente.

Queremos una función Python equivalente en comportamiento:

```python
query_spherex_s3(
    ra_deg: float,
    dec_deg: float,
    size_arcmin: float
)
```

Investiga la posibilidad de construir un índice con:

- Ruta original del archivo S3.
- Identificador del producto.
- Release (DR1/QR3).
- Fecha de observación.
- Detector/banda.
- Cobertura espacial real mediante WCS.

Evalúa SQLite + RTree, HEALPix u otra solución ligera.

**Para esta POC utiliza únicamente una muestra pequeña de archivos.** No intentes indexar toda la misión.

Comprueba cómo validar que una coordenada se encuentra realmente dentro de la huella de una imagen, teniendo en cuenta rotaciones, bordes y posibles distorsiones.

Distingue entre una región que no contiene observaciones y una región que todavía no ha sido indexada.

La dificultad principal que quiero que investigues es cómo generar un índice global en el futuro sin descargar todos los FITS completos ni realizar una cantidad desproporcionada de solicitudes S3.

## 6. Requisitos de implementación

- Prioriza scripts experimentales dentro de `scripts/` o módulos aislados que puedan reutilizarse después.
- No modifiques inicialmente los endpoints existentes.
- No sustituyas todavía `query_irsa_tap()` ni `query_irsa_sia()`.
- Reutiliza las dependencias actuales cuando sea posible.
- Añade pruebas automatizadas para la lógica que pueda probarse sin red.
- Separa las pruebas que necesitan conexión real a S3.
- Incluye tiempos de espera, límites de descarga y gestión de errores.
- Evita búsquedas masivas, descargas innecesarias y operaciones costosas sobre el bucket.
- Documenta los comandos para ejecutar cada experimento mediante `uv run`.
- Conserva las unidades científicas y los metadatos originales.
- No simules resultados para declarar exitosas las pruebas reales de conectividad.

Puedes añadir dependencias como `s3fs`, `fsspec` o similares si están justificadas.

## 7. Resultado esperado

Al finalizar, quiero un pequeño informe técnico con:

**POC 1 — Acceso S3**

- ¿Funcionó?
- ¿Qué archivo real utilizaste?
- ¿Qué metadatos se pudieron extraer?
- ¿Fue necesario descargar el archivo completo?

**POC 2 — Cutout**

- ¿Funcionó?
- ¿Qué extensiones se conservaron?
- ¿El WCS es correcto?
- ¿Es compatible con el pipeline actual de PlanetX?
- ¿Qué limitaciones encontraste?

**POC 3 — Descubrimiento**

- ¿Podemos encontrar archivos por RA/Dec utilizando un índice local?
- ¿Qué estructura de datos recomendarías?
- ¿Cómo podríamos construir y actualizar un índice de cobertura global?
- ¿Qué limitaciones de rendimiento, almacenamiento o coste existen?

Finalmente, explica qué tan viable sería implementar un fallback automático:

`IRSA TAP/SIA → índice local → S3 → cutout FITS`

Y qué trabajo faltaría para conseguirlo.

## Prioridad

Estamos trabajando en un hackathon y necesitamos resultados prácticos.

**Primero valida el acceso remoto y la generación de un cutout real.** Si esos dos experimentos no funcionan, no construyas infraestructura adicional.

Si funcionan, realiza la prueba de indexación espacial con una muestra reducida.

Mantén intacta la aplicación principal y documenta con precisión qué partes son funcionales, cuáles son experimentales y cuáles siguen pendientes.

L2. User continuation: "Ya está. Dale con todo. Sigue" authorizes available gpt-6.1-sol explorer after configured model unavailable.
L3. Bounded read-only explorer confirmed DR1 and QR3 actual objects via 11 limited LIST requests and two HEAD requests. Native review is enabled by default. Existing pipeline reads IMAGE/FLAGS/VARIANCE and alternate key-W WCS, not ZODI/EPSF directly. Official documentation warns WCS-WAVE fidelity is for visualization; full scientific wavelength calibration remains distinct from current pipeline compatibility.
L4. No application dependency changes planned: reuse installed Astropy, fsspec, httpx. Use a measured, bounded fsspec byte-range backend over anonymous S3 HTTPS to avoid introducing s3fs/aiohttp into application dependencies. Offline test scratch and live outputs stay outside worktree.

L5. T1: RED observed missing experiment module, then GREEN six offline tests. Actual DR1 and QR3 headers transferred 89,600 body bytes each (15 range GETs + HEAD). Central one-arcmin cutouts were 10x10; retained IMAGE/FLAGS/VARIANCE/ZODI/EPSF/WCS-WAVE, transferred 4,163,133 and 4,166,032 bytes. Existing extractor produced all five finite arrays and checksums passed. Off-center real-network tests: 2 passed in 22.55s; compared all four spatial arrays and both full tables to remote source, serialized spatial and spectral WCS, center and dimensions.
L6. T2: RED missing build_index, then GREEN seven offline tests including rotated/SIP/RA-wrap/border/order/unknown coverage. Two real header reports indexed in SQLite; DR1 center matched, (0,0) returned unknown_not_indexed. Full WCS scan is deliberate for two products, not a global accelerator.
L7. Virtualenv Ruff failed due to mismatched Nix glibc loader/RPATH; no environment mutation. System Ruff 0.14.6 used for successful normalization/lint instead. Original uv Ruff failure must remain disclosed.

L8. User review consent (verbatim): "1, granted". Executed the exact native granted invocation for target sha256:de868359579a8fb3ac11732f3e09390d7838e61d30869f4a340c91ad14ee3ecb. Three native reviewer captures ran concurrently in provider order (resilience, readability, reliability); all returned no findings. Final capture approved; bound STATUS replayed the same acknowledgement; exact acknowledgement returned gentle-ai.review-acknowledged/v1 with action=acknowledged and authority=burned. No code correction or source change occurred during review. Reviewers inspected immutable patches; they did not replace the already-observed functional tests.
L9. T3 implementation and verification complete. Combined-suite assistant failures and original uv Ruff executable failure remain disclosed in the report. Risk: none (new isolated experiments; existing application contracts unchanged). Native assessment high is recorded separately, not used to invent a high-risk verifier requirement. Post-ack edit is this passive task-log update only.
L10. Delivery remains pending the ask-on-risk chain-strategy decision before any commit. Current authored range: 1266 lines before this passive log update, including 327 evidence JSON lines and the verbatim user request. No commits, pushes or PRs made. A cohesive cutout/transport work unit with tests exceeds the advisory 400-line slice; do not split code from its tests or shrink artifacts for line count. Preserve source and evidence; choose chain strategy with the user before local work-unit commits. PR creation, publishing and merge are not authorized.

L11. User authorized the accepted plan: "Please implement the plan." Plan Mode ended. Delivery choice recovered: feature-branch-chain. Existing staged POC and prestart.sh changes preserved. No installed calibration manifest or CWAVE/CBAND exists; verified-calibration unavailable is a real, explicit output state, not a reason to fake science data. Runtime lacks configured gpt-6.1-luna; use previously authorized available inherited gpt-6.1-sol workers.
L12. Expansion route: parallel provider adapter, isolated mosaic engine, and frontend behavior units, each with tests/docs and disjoint surfaces; parent owns orchestration/schema/config integration and git. Risk: item 3 (shared request/result contracts). RED before each deterministic behavior, focused GREEN then full seam suites. Existing assistant configuration test failures and venv Ruff loader failure are known baseline; use system Ruff if necessary. GIF is a display derivative, not calibrated FITS.

L13. Provider live checks: 4 passed, 1 failed in 60.92s. Real DR1/QR3 S3 partial cutouts, IRSA cutout HTTP200 and SIA HTTP200 passed extraction/smoke checks; TAP returned HTTP502 Proxy Error. The default ignored index was initialized using only two bounded real header reads (<1MiB each). Both centers are indexed_matches; (0,0) remains unknown_not_indexed; completeness always false.
L14. Storage prerequisite found: the old database check capped60 and Numeric(5,3) cannot represent180. Added0007 to widen numeric precision/check and provider source checks without deleting existing records; incompatible downgrade refuses before mutations. Real throwaway-schema tests passed, including saved180-arcmin requests. No deployed database migration was run. Risk: items1 and3.
L15. Independent verifier reproduced three defects: RAM cap confused persisted completeness for6+epochs; manifest-only job hashing missed calibration FITS mutations; calibrated NPY headers reported approximate. One bounded correction batch addressed all three. Independent recheck passed6epochs×2channels resurrection with≤4RAM objects, missing artifact detection, calibration content/missing invalidation, calibrated/legacy headers, PNG/GIF shared-stretch parity. No new sweep.
L16. Backend final full command uv run --no-sync pytest tests scripts/tests -q:294passed,7skipped,2known pre-existing assistant disabled-.env failures. Feature focused tests and system Ruff pass. Web focused37pass; full352pass with3suites/tsc/build blocked by missing pre-existing react-joyride. A frozen-lockfile dependency restore is being attempted, without manifest/lock upgrades or installation scripts. Browser screenshots unavailable. Real calibrated temporal science remains unproven until exact CWAVE/CBAND products are supplied.
L17. Local delivery slices: previous reviewed POC339a242; then provider adapter+tests/docs; isolated scientific engine+tests/docs; additive persistence/backend integration+tests/docs; frontend timeline+tests. No push/PR/merge. Provider/engine units exceed400 advisory authored lines; do not omit tests or minify to meet the budget. A future PR needs coherent further slicing or an explicit size exception. Native new-candidate assessment/review remains separate from previous acknowledged POC; earlier consent does not authorize this candidate.

L18. User consent (verbatim): "1, granted" authorized only provider target sha256:7bb144ca5714009c9c0eb8504a07ba99599a70ae88fc9db0ceb5bc6ca2ebce46. Exact captured invocation executed once. Four native capture-result operations ran concurrently in frozen order. All admitted; native approved with two nonblocking WARNING advisories: global cache lock serializes unrelated downloads (R4-001), and an overlapping index record missing detector can raise KeyError (R3-001). These are separate later work; no correction transition was offered. Bound STATUS replayed the exact acknowledgement; acknowledgement returned action=acknowledged, authority=burned. Review lifecycle closed for f172c6c only. Parent spot check: provider tests9passed.
L19. Engine committed bfd6c84 with tests/docs; parent spot check26passed. Native assessment over f172c6c returned medium, review_due=false, under_budget. The reviewed boundary stays f172c6c. Backend/persistence integration committed295f6dd with its tests/docs; focused request/mosaic/cache/schema/selection command68passed. Its accumulated open slice over f172c6c is26paths/2379authored changed lines, high through explicit migration item1 escalation. Fresh candidate consent is required; no previous grant is reused. No source changes were made during provider review.
L20. Frozen frontend dependency restore failed127: pnpm-native generic Linux executable cannot run in NixOS; no retry, manifest/lock changes or dependency upgrades. Existing source/full suite counts remain the last observed evidence. User changes apps/server/scripts/prestart.sh and apps/web/.env.example remain unstaged and untouched; frontend implementation remains staged. No push, PR, or deployment. Future checks/remaining commits follow the selected feature-branch-chain strategy.

L21. User consent (verbatim): "1, granted" authorized engine/backend target sha256:6bc2b5b1199a2829771fc2c8665817bd02a76c15da3ba04167907e4d41f3c44f only. Exact captured invocation executed once; four native reviewer captures ran concurrently in frozen order. Final admitted capture returned gentle-ai.review-last-event-closure/v1 state=escalated, cause=unknown_causality, store_revision sha256:fb967278d1e868a622c5156ebbe407b6ba74db5fd481a3f6cd68e5444faec2bc. It did not approve, acknowledge or offer a correction continuation. The corroborated finding R3-001: the strict mosaic path may omit explicitly requested channels without calibration, yet mark the job ready; missing-channel frame routes then fail. R4-retry-transfer-budget was unverified_location/unknown causality, not an established defect. No production code was changed or correction attempted. Needs a focused product decision: explicitly partial success with named unavailable channels, versus all-or-nothing failure. Preserve frontend staging and unrelated user files. Earlier acknowledged S3 provider review remains closed and valid for its own candidate.

L22. User request (verbatim): "porfa, documenta todo lo que estamos haciendo con el estado actual en el odd para que otros modelos también puedan trabajar en paralelo". Added the current parallel handoff above and reconciled task status with branch `feat/spherex-s3-poc`, HEAD `295f6dd`, staged web files, user-owned unstaged files, exact test limitations, native review state, and the open channel-semantics decision. Documentation-only update: no production files changed, no worktree staging changed, and no code task was assigned to another model.

L23. User requested commits (verbatim): "haz unos commits porfa". Created frontend work-unit commit `2c21fb7` (`feat(web): add calibrated epoch timeline controls`) from the web implementation only. Updated this ODD handoff to point at the new HEAD and commit status; unrelated user files remain unstaged. Documentation commit follows separately.
