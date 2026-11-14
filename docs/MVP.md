# Planet X — MVP v2

**NASA Space Apps Challenge 2026 · SPHEREx**  
**Estado:** especificación de producto y plan técnico preliminar  
**Fecha:** 8 de noviembre de 2026  
**Equipo / restricción:** 4 integrantes, ventana de implementación aproximada de 48 horas.

> **Objetivo:** construir una aplicación web pública que permita explorar regiones arbitrarias del cielo con datos reales de SPHEREx, recorrer sus longitudes de onda, comparar observaciones de distintas épocas e identificar objetos mediante catálogos externos. La imagen inicial precalculada es únicamente una bienvenida: **la búsqueda y consulta dinámica son requisitos del MVP**.

## 1. Contexto y alcance

El reto *Planet X and SPHEREx* solicita una herramienta pública en la que los usuarios indiquen ascensión recta (RA) y declinación (Dec), visualicen imágenes de una región a distintas épocas y puedan reconocer cambios o movimientos. Recomienda aprovechar las 102 bandas infrarrojas de SPHEREx, metadatos de calidad y datos complementarios de otros observatorios. [R1]

La propuesta acordada se compone de **cuatro módulos obligatorios**:

1. **Exploración del cielo**: navegación, búsqueda dinámica y mosaicos multiespectrales.
2. **Máquina del tiempo**: selección temporal de observaciones y comparación *blink*.
3. **Laboratorio espectral**: navegación por canales espectrales y visualización de espectro exploratorio cuando existan datos suficientes.
4. **Catálogo cósmico inteligente**: fuentes conocidas, coincidencias espaciales y contexto WISE/unWISE/CatWISE.

**Fuera del MVP:** módulo independiente de IA/detección automática avanzada, contribuciones comunitarias complejas y funcionalidades extras no esenciales. «Inteligente» significa aquí catálogo consultable y contextual, **no** clasificación automática con IA.

### Principios no negociables

- La aplicación debe **consultar regiones elegidas por el usuario**, no limitarse a una demo pregrabada.
- Mantener la **procedencia científica**: misión, publicación (*release*), identificador de producto, detector/canal, fecha, unidad y banderas.
- Separar **mosaico combinado** de **FITS individual**: son productos con significados diferentes.
- No confundir **detector D1–D6** con **canal espectral**: los mosaicos pueden tener hasta 102 canales nominales y la longitud de onda depende de la posición en los detectores. [R2]
- La interfaz debe ser utilizable mientras se obtienen nuevos datos: mostrar primero información disponible y refinarla progresivamente.

## 2. Experiencia general del usuario

### Pantalla inicial

- Mostrar un **mosaico de bienvenida precalculado**, con coordenadas y créditos claros, como ejemplo navegable.
- Mantener visibles los controles de búsqueda por **RA (grados), Dec (grados), tamaño angular del campo** y opción de canal/banda.
- Ofrecer objetos o regiones sugeridos para comenzar, sin impedir búsquedas libres.

### Al buscar una región arbitraria

1. Validar coordenadas y campo angular; fijar el centro y escala de la cámara inmediatamente.
2. Consultar metadatos de cobertura SPHEREx vía **IRSA SIA2 o TAP**; devolver huellas `s_region`, productos, fechas, detector e identificadores.
3. Mostrar de inmediato la cobertura y, si está disponible, una imagen contextual de baja resolución. **No afirmar que esa vista contextual es ya un mosaico SPHEREx**.
4. Solicitar/recuperar un mosaico espectral dinámico para la región y canales seleccionados. Mostrar estados reales: `buscando`, `generando`, `previsualización disponible`, `listo`, `sin cobertura`, `error`.
5. Entregar una visualización inicial liviana y, después, niveles de resolución superiores conforme estén disponibles.
6. Permitir cambiar canales conservando centro y campo visual; cuando un canal carezca de cobertura, indicarlo, no simular una imagen.
7. Desde la vista general, seleccionar un producto para abrir el **inspector de FITS individual** y sus capas científicas.

### Durante zoom y desplazamiento

- **No lanzar la generación de un mosaico en cada evento de rueda o arrastre.** Hacer zoom local sobre la representación existente y solicitar únicamente las **teselas** o resoluciones que falten.
- Mantener una versión de menor resolución mientras llegan nuevas teselas; evitar pantallas en blanco.
- Debounce/cancelación de peticiones obsoletas al cambiar rápido de área o canal; caché por región, resolución, canal y versión de datos.
- El **cutout** se usa para inspección científica puntual y para disminuir transferencia de FITS, **no como motor de cada paso de zoom**. [R3]

## 3. Módulo I — Exploración del cielo

**Meta:** permitir investigar cualquier región cubierta por SPHEREx mediante un mapa del cielo interactivo, productos identificables y mosaicos espectrales.

**Mínimo demostrable**

- Entrada libre RA/Dec y tamaño angular; botón «Explorar» y URL compartible con parámetros.
- Visor celeste con pan/zoom y representación de huellas de observaciones mediante `s_region`.
- Mosaico de bienvenida precargado **más búsquedas reales y dinámicas**.
- Selección de detector D1–D6 como agrupación de interfaz; asociar cada vista a **canal(es) nominal(es)** concretos y mostrar λ efectiva. Un canal representativo por detector puede ser una simplificación de UI, nunca un sustituto de toda la banda.
- Lista de productos asociados a la búsqueda; cada resultado debe conservar `obs_id`, identificador único de producto, detector, fecha, cobertura y URL de acceso en backend.
- Vista individual de un producto con capas **IMAGE**, **VARIANCE** y **FLAGS**; valores de píxel, unidades y advertencias de calidad.
- Indicar huecos de cobertura y presencia de observaciones de épocas diferentes.

**Datos de FITS individual**

- `IMAGE`: intensidad calibrada (MJy/sr).
- `VARIANCE`: varianza por píxel, no «calidad» categórica.
- `FLAGS`: máscara de bits; interpretar bits, no usar gradiente numérico continuo como valor científico.
- `ZODI`, `PSF`, `WCS-WAVE`: preservar para análisis/procedencia; su exploración completa puede quedar posterior.
- Metadatos WCS espacial y espectral necesarios para ubicar y describir los píxeles. Para longitud de onda científicamente precisa usar los productos de calibración espectral adecuados (`CWAVE` y `CBAND`); `WCS-WAVE` es aproximado. [R4]

**Mosaico vs. imagen individual**

- Un mosaico es una **composición espacial/espectral reproyectada** de múltiples observaciones, no simplemente un ZIP ni una HDUList de recortes.
- El **Mosaic Tool de IRSA** genera cubos en hasta 102 canales nominales y contiene `IMAGE`, `NHITS`, `FLAGS`; no entrega automáticamente una capa de `VARIANCE` equivalente a la imagen individual. [R2]
- El **Cutout Service** extrae subconjuntos de un FITS existente, preservando su estructura MEF; varios cutouts no se convierten automáticamente en un mosaico. [R3]

## 4. Módulo II — Máquina del tiempo astronómica

**Meta:** hacer fácil reconocer cambios de posición o brillo entre observaciones reales de una misma zona.

**Mínimo demostrable**

- Al seleccionar un objeto/región o producto, buscar observaciones **espacialmente solapadas** de diferentes épocas; no agrupar solo por `obs_id` ni `target_name`.
- Línea de tiempo ordenada por la fecha real de observación (`t_min`/`t_max` o cabecera pertinente), distinta de `obs_release_date`.
- Elegir dos observaciones compatibles y ejecutar **blink** A/B, con intervalos seleccionables; ofrecer comparación lado a lado como respaldo.
- Alinear ambas imágenes mediante WCS sobre un campo común y mantener **el mismo canal o intervalos espectrales comparables** para reducir falsos cambios por diferencias de banda.
- Visualizar fecha, detector, λ aproximada, exposición y advertencias de calibración/saturación/flags.
- Ante falta de dos épocas adecuadas, mostrar explícitamente «sin datos comparables»; no inventar una secuencia temporal.

**Criterio científico:** un desplazamiento o variación aparente **no equivale automáticamente a descubrimiento**. Diferencias de PSF, cobertura, ruido, canal, calibración o fechas pueden producir artefactos. La medición de movimiento propio a lo largo de años puede requerir corrección por época y/o efemérides.

**Extensión si hay tiempo:** diferencia A−B con escalado comparable y advertencias, como sugiere el reto. [R1]

## 5. Módulo III — Laboratorio espectral

**Meta:** explorar cómo cambia una región u objeto con la longitud de onda.

**Mínimo demostrable**

- Selector/slider de **canal espectral** y visualización de λ central y, cuando esté disponible, ancho de banda; accesos rápidos por detector D1–D6.
- Conservar la misma posición y campo angular al cambiar de canal.
- Representar un canal del cubo mosaico como imagen y permitir comparar dos canales con vista dividida o alternancia.
- Para un píxel o coordenada seleccionada, mostrar un **perfil espectral exploratorio** si el cubo tiene cobertura suficiente, dejando explícito que no es un espectro fotométrico científico de fuente.
- Mostrar `NHITS` y advertencias de cobertura/flags cuando se use un mosaico.

**Ruta para espectros de mayor calidad:** investigar integración del **SPHEREx Spectrophotometry Tool**, que estima flujos mediante fotometría forzada y PSF, distinto de recorrer verticalmente el cubo mosaico. [R5]

**Límite de alcance:** no construir en 48 horas una tubería propia de extracción espectral rigurosa con corrección instrumental completa.

## 6. Módulo IV — Catálogo cósmico inteligente

**Meta:** contextualizar la región observada y relacionar SPHEREx con objetos y datos históricos de infrarrojo.

**Mínimo demostrable**

- Consultar un catálogo real de fuentes por posición y radio/campo: **unWISE Catalog** como punto de partida. [R6]
- Mostrar marcadores de fuentes con posición, identificador, magnitudes W1/W2 y campos adicionales disponibles; abrir tarjeta del objeto sin abandonar la vista.
- Al seleccionar una fuente: centrar la vista SPHEREx, consultar productos que la cubran y mostrar información de su identificación/catálogo.
- Añadir imagen histórica WISE/unWISE cuando haya un producto de imagen accesible; mantener separados **catálogo de fuentes** e **imagen histórica**.
- Considerar **CatWISE2020** como complemento especialmente valioso para movimientos propios y comparaciones temporales; integra observaciones WISE/NEOWISE. [R7]
- Registrar cuándo una coincidencia es solo **proximidad angular** y no una identificación astronómica confirmada; usar radios de asociación apropiados y considerar movimientos propios/épocas.

**Precisión conceptual:** WISE es una misión, NEOWISE una fase/extensión de sus observaciones, unWISE proporciona coadds y un catálogo derivado, CatWISE es otro catálogo basado en datos WISE/NEOWISE. No presentarlos como cuatro telescopios independientes.

**Ejemplo de UX:** seleccionar una fuente del catálogo → ver la región SPHEREx en canales disponibles → abrir tarjeta con identificación, magnitudes y una imagen WISE/unWISE (cuando exista) → acceder a la comparación temporal si tiene épocas compatibles. **El Sol no es un buen ejemplo de fuente extragaláctica o de objeto accesible en estas búsquedas de cielo profundo**; utilizar objetos del reto u otras fuentes con cobertura comprobada.

## 7. Arquitectura propuesta

```text
[Frontend React / TypeScript]
  |-- búsqueda RA/Dec/FOV, URL compartible
  |-- Aladin Lite + HiPS para navegación y contexto
  |-- capas: cobertura / mosaico / producto individual
  |-- canal espectral, timeline, blink, catálogo
  |-- WebGL o canvas para escalas de visualización
  |-- Web Worker para tareas locales pesadas (si se requiere)
             |
             v
[API FastAPI / Python]
  |-- consulta SIA2/TAP -> metadatos de productos
  |-- orquestación de mosaicos (alternativas A / B)
  |-- cutouts de FITS individuales, metadatos WCS
  |-- consulta de catálogo unWISE / CatWISE
  |-- cache, estado de trabajos, limitación de concurrencia
             |
        +----+-------------------------+
        |                              |
        v                              v
[IRSA SPHEREx]                  [IRSA WISE/unWISE]
  |-- QR2 inicial                  |-- catálogos
  |-- Mosaic Tool                  |-- imágenes históricas
  |-- Cutout Service
  |-- SIA2/TAP / cloud_access
             |
             v
[Cache: mosaicos, thumbnails, tiles y respuestas JSON]
             |
             v
[Frontend: entrega progresiva, pan/zoom fluido]
```

**Stack preferente (sujeto a pruebas):** React + TypeScript; **Aladin Lite** para mapa astronómico y superposiciones de footprints; **HiPS** para servir imágenes jerárquicas si puede generarse/servirse en tiempo razonable; FastAPI; NumPy + Astropy (`fits`, `wcs`, `coordinates`); PyVO o Astroquery para consulta IVOA; `reproject` en el plan B; `Pillow`/librería de imágenes o un generador de tiles; almacenamiento de caché local u objeto. **WebGL y Web Workers son optimizaciones opcionales, no bloqueadores del MVP.**

**Acceso a datos:** evaluar enlaces de IRSA on-prem para cutouts y el campo `cloud_access`/copia en la nube para procesamiento voluminoso. No suponer que la URL en la nube acepta la misma sintaxis de cutout on-prem. [R3] [R8]

### Contrato API orientativo (propuesta, no endpoints existentes)

| Ruta | Propósito |
| --- | --- |
| `GET /api/coverage?ra=&dec=&fov=` | Metadatos y polígonos de cobertura; búsqueda real SIA2/TAP. |
| `POST /api/mosaics` | Crear o recuperar un trabajo de mosaico por geometría, rango/canales y release. |
| `GET /api/jobs/{job_id}` | Estado y manifiesto de recursos disponibles. |
| `GET /api/mosaics/{id}/manifest` | Canales, cobertura, resoluciones y URLs de teselas. |
| `GET /api/products/{id}` | Metadatos y procedencia de producto individual. |
| `GET /api/products/{id}/cutout?...` | Recorte científico de un producto concreto. |
| `GET /api/objects?ra=&dec=&radius=` | Catálogo externo contextual. |

**Nota:** el protocolo de entrega de teselas y el identificador canónico del trabajo deben fijarse después del experimento de mosaicos. Validar límites de campo angular y coste de procesamiento por búsqueda.

## 8. Dos alternativas para la generación dinámica del mosaico

### Alternativa A — IRSA Mosaic Tool (preferida si puede automatizarse)

**Flujo:** solicitud de región/canales → envío de trabajo a IRSA → seguimiento del resultado → descarga del cubo → extracción/representación de planos → generación de preview y teselas → caché → frontend.

**Ventajas:** reutiliza composición espectral y espacial desarrollada por IRSA; reduce el riesgo de crear un mosaico científicamente incorrecto. [R2]

**Riesgos que deben verificarse:** interfaz programática y autenticación/servicio de jobs, tiempos de ejecución, límites, manejo de concurrencia, tamaño de salida y capacidad de descargar el producto automatizadamente. La herramienta documentada está integrada en el Data Explorer; **no dar por confirmada una API pública de mosaicos hasta probarla**. Tamaño máximo indicado por IRSA: 5° × 5°; escala mínima: 6,15 segundos de arco por píxel. [R2]

**Criterio de selección:** usar A si un script puede enviar una región, recuperar un resultado real y preparar una vista navegable en condiciones aceptables para una demo interactiva. Nunca prometer latencia sin mediciones.

### Alternativa B — Pipeline propio con cutouts + WCS + reproyección

**Flujo:** SIA2/TAP → productos que intersectan campo → selección de canal espectral con información de calibración → cutouts por producto → homogeneizar unidades/quality masks → reproyectar a WCS destino → combinar con ponderaciones, cobertura y propagación de flags → vistas/teselas → caché.

**Ventajas:** control sobre tiempos, escala, formatos, procesamiento incremental, caché y depuración.

**Riesgos:** el LVF hace que una imagen completa **no corresponda a una longitud de onda única**. Filtrar por detector no basta; hay que seleccionar correctamente píxeles/canales, considerar respuesta espectral, píxeles inválidos, pesos, PSF, solapes, ruido y procedencia. `reproject` **alinea geometría**, pero no resuelve por sí solo calibración ni combinación científica. [R2] [R4]

**Criterio de selección:** activar B si A no puede automatizarse o tarda demasiado, y **reducir honestamente el alcance de la composición propia** (por ejemplo, una primera versión con huellas, productos individuales y mosaicos experimentales debidamente etiquetados). No presentar una superposición visual rudimentaria como un mosaico científico calibrado.

### Decisión pendiente

**A vs. B no está decidida.** Primero hacer prueba reproducible con A; en paralelo probar cutouts y WCS. Elegir por evidencia: latencia, costo, accesibilidad programática, calidad y complejidad.

## 9. Fluidez, almacenamiento y transferencia

- **Vista de bienvenida:** precalculada, cargada desde caché/CDN si se dispone. No restringe las búsquedas dinámicas.
- **Primera respuesta a la búsqueda:** cobertura `s_region` y catálogo ligero, sin descargar decenas de FITS enteros.
- **Vista solicitada:** una imagen de previsualización de baja resolución tan pronto exista; mejorar progresivamente a través de teselas/LOD.
- **Zoom:** actualización inmediata de la cámara local; nuevas teselas solo cuando cambia el nivel requerido. **Nunca recrear el mosaico en cada tick del mouse.**
- **Bandas/canales:** carga diferida, precarga limitada de canales vecinos y caché con clave por región + release + canal + proyección + escala + versión de procesamiento.
- **FITS individual:** cutout bajo demanda; capa IMAGE primero, VARIANCE y FLAGS cuando se soliciten.
- **Datos numéricos:** mantener `float32` cuando provengan así del FITS; no convertir por defecto a `float64` ni degradar a `float16` sin validar error. Para exploración, imágenes 8 bits son **previews**, no sustitutos científicos de la matriz original.
- **FLAGS:** bitmask de enteros y decodificación por categoría; no tratar el número entero como una escala física continua.
- **Procesamiento costoso:** trabajos asíncronos **en la infraestructura de la aplicación**, no en el hilo principal del navegador; estado consultable, timeout y errores visibles.
- **Optimización progresiva:** iniciar con previsualizaciones + caché y solo implementar una pirámide HiPS completa si las pruebas demuestran que cabe en el plazo.

## 10. Datos, metadatos y compatibilidad temporal

Para cada producto encontrado, conservar al menos:

| Campo | Uso |
| --- | --- |
| `obs_id` y `obs_publisher_did` | Agrupación de observación e identidad de producto; no asumir unicidad de `obs_id` por fila. |
| `s_ra`, `s_dec`, `s_region` | Centro y footprint celeste real. |
| `s_fov`, `s_resolution`, `s_pixel_scale` | Geometría y resolución de cobertura. |
| `energy_bandpassname`, `em_min`, `em_max`, `em_res_power` | Contexto de detector/espectro. |
| `t_min`, `t_max`, `t_exptime` | Fecha/intervalo y exposición. |
| `calib_level`, colección/release | Calibración y procedencia. |
| `access_url`, `access_estsize`, `cloud_access` | Recuperación, transferencia y planificación de trabajo. |
| `target_name` | Etiqueta orientativa, **no** identificador espacial único. |

**Para la máquina del tiempo:** seleccionar observaciones por **solapamiento espacial, fecha y compatibilidad espectral**, no por igualdad de nombre de objetivo. Un mosaico combinado de varias épocas no reemplaza una secuencia de observaciones individuales para detectar movimiento.

**Releases:** arrancar con **SPHEREx Quick Release 2 (QR2)** como referencia de trabajo. Investigar QR3 según cobertura y estabilidad; cualquier cambio de release debe quedar expuesto en el resultado y participar en la clave de caché. No interpretar que una consulta sin filas demuestra ausencia global de QR3.

## 11. Recorrido integrado de los cuatro módulos

1. El usuario abre Planet X y ve un mosaico inicial ilustrativo o real preconstruido de bienvenida.
2. Introduce RA/Dec/FOV → la app devuelve cobertura real y prepara la región SPHEREx solicitada.
3. Navega por canales espectrales en el **Laboratorio espectral**.
4. Selecciona una zona u objeto de unWISE → abre su ficha en **Catálogo cósmico**.
5. Explora observaciones individuales y solicita cutouts con sus capas científicas.
6. Si existen dos épocas compatibles, abre **Máquina del tiempo** y ejecuta blink con las imágenes alineadas.
7. Comparte un enlace con coordenadas, campo y selección activa (cuando estos parámetros estén disponibles).

**Escenarios de validación del reto:** Barnard’s Star, Epsilon Indi B, WISE 0855, RW Aurigae y R Draconis. La disponibilidad de productos SPHEREx y épocas comparables **debe comprobarse**, no asumirse por figurar en el enunciado. [R1]

## 12. Criterios de aceptación del MVP

- [ ] Cualquier usuario puede introducir coordenadas válidas y tamaño angular; el sistema realiza una consulta real al archivo SPHEREx.
- [ ] La bienvenida incluye un mosaico inicial, sin limitar los resultados a él.
- [ ] La búsqueda muestra cobertura real y metadatos de los productos devueltos.
- [ ] Al menos una búsqueda de región no precalculada se completa en una demo reproducible y muestra datos SPHEREx auténticos.
- [ ] Existen controles para seleccionar y distinguir canal espectral, detector y fecha.
- [ ] Hay vista de producto individual y cutout con IMAGE; VARIANCE y FLAGS accesibles en el inspector.
- [ ] El visor permite zoom/pan sin iniciar una nueva generación científica por cada movimiento.
- [ ] El comparador blink funciona para dos observaciones reales compatibles; si no hay dos, informa esa limitación.
- [ ] El laboratorio permite explorar varios canales y al menos una visualización espectral exploratoria basada en datos reales, con etiquetas de unidades y cobertura.
- [ ] El catálogo devuelve fuentes reales desde unWISE o CatWISE y permite inspeccionar al menos una asociación contextual.
- [ ] Cada visualización identifica origen, release, fecha/canal y distingue producto original de mosaico procesado.
- [ ] Los errores, límites de cobertura y tareas lentas se muestran de forma explícita; ningún resultado científico es simulado sin etiquetarlo.

## 13. Orden recomendado de trabajo (48 horas / cuatro integrantes)

**Prioridad 0 — riesgo bloqueante:** verificar automáticamente el camino «RA/Dec/FOV → producto SPHEREx → vista», y probar si el Mosaic Tool de IRSA admite el flujo programático que requiere el backend. Si no, decidir inmediatamente un plan B acotado.

**Paralelización sugerida:**

| Línea | Responsable sugerido | Entregable |
| --- | --- | --- |
| Frontend + mapa | Persona 1 | Búsqueda, visor, zoom, overlays de `s_region`, interfaz de estados. |
| Backend + adquisición | Persona 2 | Consulta SIA2/TAP, cutouts, modelos, caché, endpoints. |
| Mosaicos + espectro | Persona 3 | Prueba A/B, preparación de visualizaciones multicanal y laboratorio. |
| Tiempo + catálogos | Persona 4 | Selección temporal, blink WCS, consulta unWISE/CatWISE y tarjetas. |

**Secuencia de integración:**

1. **Inicio:** definir contrato API y objetos de datos, probar IRSA y obtener un FITS/cutout real.
2. **Primer flujo vertical:** búsqueda arbitraria → huellas → imagen real → pan/zoom.
3. **Segundo flujo:** dos canales → selección espectral → calidad/procedencia.
4. **Tercero:** selección de dos épocas compatibles → blink.
5. **Cuarto:** consulta unWISE/CatWISE → marcador → ficha → referencia WISE cuando esté disponible.
6. **Cierre:** fallbacks, medición de rendimiento real, créditos, ejemplos reproducibles, demo y README.

**Regla de recorte del alcance:** reducir sofisticación de UI o análisis antes que eliminar una búsqueda dinámica real. Si el mosaico dinámico no es viable, conservar explícitamente búsqueda dinámica + cobertura + cutouts y presentar el mosaico experimental como una capacidad limitada, sin afirmar que está resuelto.

## 14. Riesgos y preguntas abiertas

| Riesgo/pregunta | Experimento/decisión |
| --- | --- |
| ¿El Mosaic Tool admite una API de trabajos que podamos usar? | Probar envío y recuperación de un trabajo desde Python, documentar resultado y latencia. |
| ¿Cuánto tarda una búsqueda y generación real? | Medir región pequeña, varios canales, caché fría/caliente. |
| ¿Podemos preparar previews antes de terminar un trabajo de mosaico? | No asumirlo: si IRSA solo entrega resultado final, ofrecer cobertura mientras procesa o ejecutar previews separados. |
| ¿Cómo servir imágenes en distintos niveles de zoom? | Probar previews y teselas; evaluar HiPS/Aladin Lite vs. raster overlays por WCS. |
| ¿Qué intervalos temporales se pueden comparar? | Consultar fecha + banda + footprint; probar objetivos del enunciado. |
| ¿Qué perfil espectral podemos ofrecer con rigor? | Distinguir quick-look del cubo y espectrofotometría oficial. |
| ¿Cuánto aporta el catálogo a la experiencia? | Medir consulta unWISE/CatWISE por área y validar una coincidencia visual real. |
| ¿Qué ocurre al no haber cobertura? | Mensaje claro, mostrar huellas/contexto, permitir cambiar campo o canal. |

## 15. Referencias y fuentes

**Fuente del reto suministrada por el proyecto**

- **[R1]** *Planet X and SPHEREx*, enunciado de NASA Space Apps Challenge compartido en el proyecto (`Planet-X-and-SPHEREx.txt`).

**Documentación externa revisada el 8 de noviembre de 2026**

- **[R2]** IRSA — [SPHEREx Mosaic Tool](https://irsawebops2.ipac.caltech.edu/onlinehelp/spherex/spherex/mosaic.html). Geometría, canales, límites y estructura del producto.
- **[R3]** IRSA — [SPHEREx Cutout Tool](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/cutout_tool.html) y [tutorial de cutouts](https://caltech-ipac.github.io/irsa-tutorials/spherex-cutouts/).
- **[R4]** IRSA — [SPHEREx Data Products](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/). FITS, espectro/WCS y capas.
- **[R5]** IRSA — [SPHEREx Spectrophotometry Tool](https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html).
- **[R6]** [unWISE Catalog](https://catalog.unwise.me/) y [NASA Open Data: unWISE](https://data.nasa.gov/dataset/unwise-catalog).
- **[R7]** NASA — [CatWISE2020 Catalog](https://data.nasa.gov/dataset/catwise2020-catalog).
- **[R8]** IRSA — [SPHEREx FAQ: nube y acceso](https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/faq.html).
- **[R9]** CDS — [Aladin Lite](https://aladin.cds.unistra.fr/AladinLite/).

---

**Estado de decisión:** módulos y experiencia de búsqueda dinámica **acordados**; arquitectura de tiles/cache **propuesta**; elección del generador de mosaicos **pendiente de prueba técnica**. Este documento define el MVP objetivo, no garantiza que todas las integraciones hayan sido implementadas ni validadas.
