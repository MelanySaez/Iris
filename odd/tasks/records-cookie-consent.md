# Records per browser through cookie consent

Objective: save Records per browser through a consent cookie (no login), with a footer consent bar and recovery of the selections made before consent.
Branch: `feat/records-cookie-consent` · Delivery: `ask-on-risk` (chain strategy asked before any PR) · Runners: `uv run pytest` (server, DB tests need `DATABASE_URL`), `pnpm vitest run` (web).

## Specs

- **S1** Records are saved through cookies so each browser keeps its own records without login: "para el guardado de los records se haga por medio de cookies para que se puedan conservar tus registros de los records dado que no tenemos sistema login o registro".
  - A server-issued, HttpOnly owner cookie (random UUID) identifies the browser. Selections are stored and listed per owner; one browser never sees, renames or deletes another browser's records.
  - The assistant's saved-selections tool only reads the requesting browser's records.
- **S2** Without consent nothing is saved: "si no se acepta el uso de cookies entonces mencionar que no se puede hacer un guardado de las selecciones (records)".
  - Job submission still works without consent; no selection row is written for it.
  - The Records view states that selections cannot be saved without cookies; the selection endpoints refuse requests without an owner cookie.
- **S3** Footer consent bar: "colocar el mensaje para aceptar las necesarias, todas o ninguna en una barra inferior similar a un pie de pagina".
  - Decision (L2): "Necesarias" includes the records cookie, so "Necesarias" and "Todas" both enable saving; "Todas" also records consent for future optional cookies. "Ninguna" disables saving.
  - The bar shows until a choice is made; the choice is remembered in a consent cookie.
  - Decision (L10): "Reject all" after accepting keeps the browser's records hidden ("Conservarlos ocultos"): the owner cookie is kept, saving and reading pause, and accepting again shows the same records. The server only honours the owner cookie while the consent cookie says `necessary` or `all`.
- **S4** Later acceptance recovers earlier work: "si la persona usa la app y las acepta posteriormente al guardado de los records recuperar aquellas operaciones antiguas de la seccion".
  - Selections submitted in the current page session before consent are claimed for the new owner when the user accepts.
  - Assumption: "la seccion" is the current browser session (page lifetime, kept in memory); selections from a previous visit without consent are not recoverable because nothing identified them.
- **S5** Existing ownerless records are deleted (L3: "Borrarlos"). The migration removes every selection row that predates owners; shared region and product data stay.

## Tasks

| ID | Specs | Route | Status | Commit |
|----|-------|-------|--------|--------|
| T1 | S1, S5 | inline | done (RED→GREEN) | 617e071 |
| T2 | S1, S2, S4 | inline | done (tests after code, see L6) | 617e071 |
| T3 | S2, S3, S4 | inline | done (RED→GREEN) | 5861650 |
| T4 | S1, S3, S4 | inline | done (RED→GREEN) | 8b28ebb |
| T5 | S4 | inline | done (RED→GREEN) | 720b7ab |

- T1: migration 0006 (delete ownerless selections, `owner_id` NOT NULL, unique `(owner_id, job_id)`), model, owner-scoped repository and service. Risk: item 1 (deletes stored data).
- T2: consent and claim endpoints, owner cookie, job submission records only with an owner, owner-scoped selection routes and assistant tool. Risk: item 3 (selection API now requires the owner cookie, requested).
- T3: web consent bar, consent cookie, pending-selection tracking and claim on accept, Records message without consent, docs.
- T4 (server, verifier advisories 2-5): owner honoured only with an accepting consent cookie, kept on reject (L10); claims insert missing rows only and count new rows; owner cookie re-issued when consent is accepted but the owner cookie is missing; `COOKIE_SECURE` setting for TLS proxies. Risk: item 2 (cookies) and item 3.
- T5 (web, advisory 1): a job sent before consent is recovered even when its response arrives after the visitor accepted.

## Log

- **L1** (2026-11-15, user): "necesito que para el guardado de los records se haga por medio de cookies para que se puedan conservar tus registros de los records dado que no tenemos sistema login o registro, si no se acepta el uso de cookies entonces mencionar que no se puede hacer un guardado de las selecciones (records), colocar el mensaje para aceptar las necesarias, todas o ninguna en una barra inferior similar a un pie de pagina, si la persona usa la app y las acepta posteriormente al guardado de los records recuperar aquellas operaciones antiguas de la seccion"
- **L2** (2026-11-15, user decision): "Necesarias incluye records" — the records cookie counts as necessary.
- **L3** (2026-11-15, user decision): existing ownerless records → "Borrarlos" (irreversible).
- **L4** Analysis: `selection.job_id` is unique today, so two browsers selecting the same region share one row; ownership needs a unique `(owner_id, job_id)`. Jobs stay shared (job ids are deterministic); outcome and discovery writes keep updating every row of a job id. The owner reaches the recorder through `JobManager.submit(req, owner=...)` so the existing "submitted before the job can finish" ordering holds. Forecast ~700 authored lines.
- **L5** (2026-11-15, user): "espera, que piensas cambiar del schema, no continues hasta contestarme" → plan explained (delete rows, `owner_id`, unique `(owner_id, job_id)`, index); user: "sigue el plan , adelante con eso".
- **L6** T1 RED observed (2 owner tests failed) then GREEN. T1 and T2 share one commit (617e071) because the repository signature change breaks the service and routes until T2 lands; a T1-only commit would not be green. T2's HTTP tests were written after the code, so no RED was observed for them. Server suite: 223 passed, 2 failed (`test_assistant_is_disabled_until_key_and_model_are_set[...]`, also failing at the baseline because of the local assistant env). Ruff: 29 findings, same as the baseline.
- **L7** T3 RED observed (missing modules) then GREEN. Web: 358 tests passed, `tsc --noEmit` clean, `vite build` OK. Not checked in a real browser. Existing App tests now set `iris_consent=necessary` because Records needs consent.
- **L8** Risk: item 1 (migration 0006 deletes stored selections) and item 3 (selection API now requires the owner cookie, requested). Independent verifier launched over the whole feature. The developer database still needs `alembic upgrade head`, which deletes its current selections; not run by the agent.
- **L9** (2026-11-15, user): "necesito que atendamos a los 5 avisos identificados" — verifier advisories: (1) job in flight while accepting is lost; (2) rejecting after accepting orphans records; (3) repeat claims add hits; (4) `Secure` flag wrong behind a TLS proxy; (5) consent cookie without owner cookie shows a 403 error in Records.
- **L10** (2026-11-15, user decision on advisory 2): "Conservarlos ocultos".
- **L11** First verifier (whole feature, after 5861650): S1–S5 PASS, no blockers, 5 advisories (L9). Scratch copies removed.
- **L12** T4: 8 RED tests observed, then GREEN. The reject test now gets every cookie from the server (the test client kept duplicate `iris_owner` cookies when one was set by hand). Server: 234 passed, 2 known env failures; ruff 29 (baseline). Advisory 5 is solved server-side: a lost owner cookie is re-issued while consent accepts, so Records no longer gets a 403 there. T5: 5 RED, then GREEN; web 359 passed, tsc clean. Risk: item 2 (consent-gated access to records) → second verifier scoped to T4/T5.

- **L13** Second verifier (T4/T5): 7/7 PASS, no blockers. Stale 403 docs fixed in 8fd937c. Open advisory: a browser that lost its owner cookie (consent kept) and sends parallel requests can mint two owners; the last Set-Cookie wins. Untested but probed: owner re-issue on assistant chat and the three web interleavings.
