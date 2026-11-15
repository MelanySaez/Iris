# Contextual assistant

Objective: a contextual chatbot that lives behind an icon in the bottom-right corner of the app, can inspect and drive the interface through tool calling, is protected by guardrails, logs every action and model call, and caches equal or similar requests.
Branch: `feat/contextual-assistant` · Delivery: ask-on-risk · Runners: `uv run pytest -q` (server, `.env` sourced), `pnpm exec vitest run` (web).

## Specs

- **S1** — Placement: "una especie de chatbot contextual que va a vivir con su icono en la parte inferior derecha de la aplicación". A launcher icon fixed bottom-right opens a chat panel on every workspace.
- **S2** — System prompt: "Quiero que contenga un system prompt que sea como la instrucción general para nuestro proyecto". A frozen server-side system prompt describing Planet X (SPHEREx DR1 explorer: Sky, Plate, Spectral Lab, Records) and how the assistant behaves.
- **S3** — Tool calling over the UI: "que permita tener un tool calling para poder hacer cambios sobre la interfaz y poder consultar y movernos a lo largo de la interfaz a partir de las instrucciones que se den". Tools to read UI state, search the catalog, list saved selections, navigate between workspaces, move the Sky map to a region, change channel and colour mode.
- **S4** — Guardrails: "necesito que tenga guardrails para proteger y mitigar problemas como el prompt injection". Untrusted content (UI context, tool results, user-named records) is delimited as data; tool inputs are validated server- and client-side against an allowlist and ranges; prompt-leak canary; input length/turn limits; loop cap; refusals handled; costly or destructive actions are not exposed to the model (no job confirmation, no rename/delete).
- **S5** — Traceability logs: "necesito que me deje un sistema de logs en el que muestre pues todos los movimientos, todos los usos del modelo y demás, para poder tenerlos de referencia". Append-only log of every request, model call (model, tokens, cache usage, latency, stop reason), tool call, UI action, cache hit, guardrail event and error, readable through the API and shown in the chat panel.
- **S6** — Response cache: "necesito que maneje caché para cuando se realicen solicitudes iguales, poder consultar en este espacio sin necesidad de tener que hacer la consulta completa nuevamente" / "también debe tener sistema para utilizar caché en el caso de que existan solicitudes iguales o similares, para evitar tener que hacer la consulta directa nuevamente al modelo vía API". Equal (normalized) and similar (token-overlap) requests in the same context are answered from cache, replaying the stored UI actions; Anthropic prompt caching on the stable prefix lowers the cost of misses.
- **S7** — API key: "Puedes colocar en el environment.example la línea para definir la API key que se va a utilizar del modelo del chatbot". `ANTHROPIC_API_KEY` (and optional assistant settings) in `apps/server/.env.example`.
- **S8** (assumption) — Provider and model: Anthropic Claude through the official Python SDK on the server (the key never reaches the browser), default model `claude-opus-5-5` with server-side refusal fallbacks, configurable via `ASSISTANT_MODEL`. Without a key the assistant answers 503 and the rest of the app keeps working.

## Tasks

| ID | Specs | Route | Status | Commit |
|----|-------|-------|--------|--------|
| T1 | S2, S3, S4, S5, S6, S7, S8 | inline | pending | |
| T2 | S1, S3, S4, S5 | inline | pending | |

Route evidence: T2 (web widget) depends on T1's API contract, so the units are not independent; no writer trigger.

## Log

- **L1** (2026-11-14, user): "Oye, Claude, necesito que abras una rama nueva para poder trabajar en una especie de chatbot contextual que va a vivir con su icono en la parte inferior derecha de la aplicación. Y necesito que tenga lo siguiente. Quiero que contenga un system prompt que sea como la instrucción general para nuestro proyecto, que además de esto permita tener un tool calling para poder hacer cambios sobre la interfaz y poder consultar y movernos a lo largo de la interfaz a partir de las instrucciones que se den. Además de eso, necesito que tenga guardrails para proteger y mitigar problemas como el prompt injection. Y además de eso, para tener la trazabilidad, necesito que me deje un sistema de logs en el que muestre pues todos los movimientos, todos los usos del modelo y demás, para poder tenerlos de referencia."
- **L2** (2026-11-14, user): "Algo que se me olvidó mencionarte es que además necesito que maneje caché para cuando se realicen solicitudes iguales, poder consultar en este espacio sin necesidad de tener que hacer la consulta completa nuevamente."
- **L3** (2026-11-14, user): "Necesito que desarrolles lo que te estoy mencionando del chatbot. Además de eso, como te mencionaba arriba, también debe tener sistema para utilizar caché en el caso de que existan solicitudes iguales o similares, para evitar tener que hacer la consulta directa nuevamente al modelo vía API. Puedes colocar en el environment.example la línea para definir la API key que se va a utilizar del modelo del chatbot."
- **L4** Design: server runs a manual tool loop (one HTTP request per user turn). Server tools (catalog search, saved selections) run on the server; UI tools are validated, queued as actions and acknowledged to the model, then executed by the browser after the reply. UI state travels with each request as delimited data. Logs are JSONL (append-only, no migration). Response cache is in-memory LRU with TTL, keyed by context.
