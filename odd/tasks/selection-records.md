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
| T1 | S1, S2, S6 | inline | done | 5f18541 |
| T2 | S3, S4, S7 | inline | done | 0d64d27 |
| T3 | S5 | inline | done | 2cce791 |
| T4 | S3, S7 | inline | done | (this commit) |

Route evidence: one sequential feature (T3 depends on T2's API contract); no parallel independent units, so no writer trigger.

## Log

- **L1** (2026-11-14) — User request: "Adelante, implementalo, al igual dime los pasos para crear la db en local"
- **L2** (2026-11-14) — User correction: "en este caso necesito que se use sqlalchemy  y postgres"
- **L3** — Design history agreed in conversation: auto-save always, hard delete, 3-table schema after de-normalizing 2-column tables.
- **L4** — T1: teammate commit 2919865 already scaffolded Alembic in `app/alembic`; reused it (env.py reads `DATABASE_URL`, `prepend_sys_path = .`). Migration 0001 upgrade/downgrade round-trip and `alembic check` (no drift) verified on Postgres 18.
- **L5** — Known environmental failures (also on base): 11 tests in `test_api.py`/`test_fits_assets.py` need the missing local FITS sample.
- **L6** — T2: `JobObserver` port in `jobs.py`; `SelectionRecorder` saves submit/discovery/outcome; failures logged, never raised. `tests/test_selections.py`: 9 tests (6 need `TEST_DATABASE_URL`), all pass against Postgres. Note: tests were written after the code (no RED observed first). Differential check of `POST /api/jobs` vs base: identical output.
- **L7** — T3: RED observed first (4 api tests, router test, missing `records.ts`), then GREEN: 75/75 web tests, typecheck and build pass. `Records` tab at `#/records` lists, reopens ready jobs in Plate, deletes with confirm, paginates with `next_before`.
- **L8** — End-to-end smoke with real uvicorn + Postgres: POST /api/jobs 202 → record listed (hits 1) → DELETE 204 → list empty. Commits under_budget for native review (risk medium).
- **L9** — Independent verifier (Risk item 5, psycopg dependency): S1–S7 PASS, no blockers. Advisories: cache-hit jobs never store a manifest; on_submitted could race job completion; pagination ties on equal last_seen_at; sync DB latency on submit.
- **L10** — Native review (reliability lens) granted by user, approved and acknowledged (lineage review-d8b98913e111bfea). Non-blocking findings: startup crash on driverless/invalid DATABASE_URL, status race, pagination ties, sync DB latency.
- **L11** — T4 follow-up: RED observed for 3 new tests, then fixed: driverless `postgresql://` normalized to psycopg and invalid URLs disable records instead of crashing; `on_submitted` now fires before the job is scheduled; cache hits in a terminal state store their outcome/manifest on submit. Pagination ties and sync DB latency remain known limitations (connect timeout 3s).
