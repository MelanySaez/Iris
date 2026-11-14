# Selection records

Objective: persist every sky selection (job submission) in Postgres via SQLAlchemy and expose a records section where they can be listed and deleted.
Branch: `feat/selection-records` · Delivery: ask-on-risk · Runners: `uv run pytest -q` (server), `pnpm test --run` (web).

## Specs

- **S1** — Storage uses SQLAlchemy and Postgres: "en este caso necesito que se use sqlalchemy  y postgres". Schema managed with Alembic migrations.
- **S2** — Three tables, not over-normalized: "las tablas que solo contienen 2 valores como id y otro campo mas pueden perfectamente ser incluidas como atributos de otra entidad y solamente quedarnos con las tablas que continen un grueso de informacion considerable". Tables: `sky_region`, `spectral_product` (N:1 region), `selection` (N:1 region), as agreed in the conversation design. `fov_deg`, `band` and `date_iso` are derived and not stored.
- **S3** — Saving is automatic: "la intencion es que siempre haga el guardado". Every `POST /api/jobs` upserts the selection keyed by `job_id`; repeats increment `hits` and refresh `last_seen_at`. Discovery updates region coverage and products; job completion updates `job_status` and `manifest`.
- **S4** — Records can be deleted: "que se puedan eliminar de ser requerido". `DELETE /api/selections/{id}` hard-deletes the selection only (regions/products remain as shared cache). Also `GET /api/selections` (paginated by `last_seen_at`) and `GET /api/selections/{id}`.
- **S5** — A frontend section ("una sección para la parte del guardado de registros") lists records and lets the user delete them and reopen a ready one in the plate view.
- **S6** — Local DB setup steps: "dime los pasos para crear la db en local".
- **S7** (assumption) — Persistence must never break job processing: when `DATABASE_URL` is unset or the DB fails, jobs keep working; selection endpoints answer 503 when storage is not configured.

## Tasks

| ID | Specs | Route | Status | Commit |
|----|-------|-------|--------|--------|
| T1 | S1, S2, S6 | inline | pending | |
| T2 | S3, S4, S7 | inline | pending | |
| T3 | S5 | inline | pending | |

Route evidence: one sequential feature (T3 depends on T2's API contract); no parallel independent units, so no writer trigger.

## Log

- **L1** (2026-11-14) — User request: "Adelante, implementalo, al igual dime los pasos para crear la db en local"
- **L2** (2026-11-14) — User correction: "en este caso necesito que se use sqlalchemy  y postgres"
- **L3** — Design history agreed in conversation: auto-save always, hard delete, 3-table schema after de-normalizing 2-column tables.
