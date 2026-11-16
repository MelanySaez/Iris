# Plate: open the user's own SPHEREx FITS

Objective: Plate opens without a Sky selection and lets the user load their own SPHEREx FITS (Level-2 image/cutout or a DR1 All-Sky Cube tile, the fallback's format); the Sky selection flow keeps working unchanged.
Branch: feat/plate-fits-upload (from main 40c8706). Delivery: local work-unit commits; merge/push only on request. Runner: `uv run --no-sync pytest` (apps/server), `npx vitest run` (apps/web).

## Specs

S1. "la actualizacion implica que se puedan cargar archivos .fits en la vista de plate, es decir, que de primeras la vista de plates no este restringida y que permita si se pasa directamente a la misma cargar el propio .fits del usuario, de lo contrario sigue funcionando el flujo de seleccion desde la pestaña sky". The Plate tab is always enabled; `#/plate` without a job shows a FITS loader; `#/plate/<id>` and the Sky → Plate flow behave as before.
S2. Accepted formats (user's answer, verbatim): "que sea con spherex y con el formato que usa el fallback". (a) SPHEREx Level-2 image or cutout: IMAGE, VARIANCE, FLAGS HDUs and the key-W WCS-WAVE lookup (existing extractor; full plate features for its detector). (b) DR1 All-Sky Cube tile (`Npix*_cube.fits`): IMAGE/FLAGS/NHITS 3-D cubes + SPECTRAL_CHANNELS (+ WCS-WAVE); one cutout per channel, no VARIANCE, no epochs, nominal wavelengths. Anything else is rejected with a message naming what is missing.
S3. Assumptions (not user requirements): uploads are processed by the backend from a raw request body (no new multipart dependency), capped in size, deduplicated by content hash, kept in the server cache, and not saved as Records (Records describe Sky regions). Job id `upload-<hash>`.

Fix found while exploring (part of S1's "plate works"): cube cutouts are per channel, but Plate treats a channel as loaded when any cutout of its detector exists (PlateWorkspace.handleSelectChannel), so switching channels within a detector of a cube job shows no image.

## Tasks

- T1 | S2, S3 | inline | complete (commit 8974c59) | backend: upload service (format detection, L2 + cube tile → job with frames/cutouts), POST /api/uploads, schema source "upload", snapshot `upload` metadata; offline tests
- T2 | S1, S2 | inline | complete (next commit) | web: router `#/plate` without id, TopBar Plate always enabled, FITS loader view (file picker + drop, upload progress), upload labels/notes in Plate, channel switching for uploads and per-channel cutouts; tests
- T3 | S1–S3 | inline | pending | docs + browser check

## Log

L1. User request (verbatim): "necesito implementar una funcionalidad nueva, abre una rama para esto y la actualizacion implica que se puedan cargar archivos .fits en la vista de plate, es decir, que de primeras la vista de plates no este restringida y que permita si se pasa directamente a la misma cargar el propio .fits del usuario, de lo contrario sigue funcionando el flujo de seleccion desde la pestaña sky"
L2. User answer to the format question (verbatim): "que sea con spherex y con el formato que usa el fallback".
L3. Evidence: TopBar.tsx:70 disables Plate without activeJobId; router.ts plate route requires jobId; no python-multipart installed; JobRequest caps size at 180′ and channels at 1–8 (an uploaded L2 is ~210′, a cube tile has 102 channels), so the upload job's request carries a clamped size and one default channel, and true extent/format go in `job.upload`.
L4. T1: backend 345 passed (2 known assistant .env failures), 8 new upload tests; real POC cutout dr1-cutout.fits opened as spherex_l2 D1, 51 frames, 0.09 s. Route hang found (thread/queue sentinel on empty body) and replaced by a streaming UploadWriter.
L5. T2: router #/plate, TopBar always enabled, PlateFitsLoader (upload progress, processing, errors, drop), App wiring, Open FITS button, UploadNotice, per-channel cutout check + upload channel guard. Web 60 files / 482 passed; tsc 0. Pending (T3): docs, browser check, real cube-tile upload timing.
