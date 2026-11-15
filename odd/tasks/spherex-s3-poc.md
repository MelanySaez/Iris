# SPHEREx anonymous S3 proof of concept

Objective: validate real remote access and scientific cutouts before a small spatial index; application unchanged.
Branch: feat/spherex-s3-poc. Delivery: ask-on-risk (forecast ~650 authored lines; chain strategy unresolved before committing). Runner: uv run --no-sync pytest; anonymous bounded S3 live script.

## Specs

S1. "Primero valida el acceso remoto y la generación de un cutout real." "Si esos dos experimentos no funcionan, no construyas infraestructura adicional." Validate real DR1/QR3 headers, HTTP ranges, transfer counts, cutout WCS, retained science layers and existing extractor compatibility.
S2. "Para esta POC utiliza únicamente una muestra pequeña de archivos." "Distingue entre una región que no contiene observaciones y una región que todavía no ha sido indexada." Only after S1 works, test local coordinate discovery, ordering, limit and explicit incomplete coverage.
S3. "Mantén intacta la aplicación principal y documenta con precisión qué partes son funcionales, cuáles son experimentales y cuáles siguen pendientes." "Añade pruebas automatizadas para la lógica que pueda probarse sin red." "Documenta los comandos para ejecutar cada experimento mediante `uv run`." Produce a source-linked technical report and isolated scripts, with bounded timeouts/downloads, offline tests and opt-in live checks.

## Tasks

- T1 | S1, S3 | inline (one dependent behavior; no writer trigger) | complete | 7 offline tests and both live S3 cutouts observed | commit pending
- T2 | S2 | inline after T1 | complete | sample-only index | commit pending
- T3 | S3 | inline | complete | report, offline suite, live evidence, native review acknowledged | commit pending

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

- https://irsa.ipac.caltech.edu/cloud_access/
- https://docs.astropy.org/en/stable/io/fits/usage/cloud.html

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
