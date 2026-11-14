# Iris

Nasa Space Challenge 2026

## Local development with Nix flakes

The repository includes a reproducible development shell with Node, pnpm,
Python 3.12, and uv:

```bash
nix develop
```

If you use direnv, allow the environment once with `direnv allow`; the
repository's `.envrc` will automatically load the same flake.

### Environment files

The root file configures `docker compose`; each service has its own file for
local settings, so a local change touches only that service. Copy them once
(the `.env` copies are git-ignored):

| Template | Used by | Declares |
|----------|---------|----------|
| `.env.example` | `docker compose` / `podman compose` | `DB_PORT` (5433), `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` |
| `apps/server/.env.example` | backend, migrations, tests | `DATABASE_URL`, `TEST_DATABASE_URL`, optional `SPHEREX_SPECTRAL_FITS` |
| `apps/web/.env.example` | Vite | `NODE_ENV` |

```bash
cp .env.example .env
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
```

Keep the credentials and port in `apps/server/.env` (`DATABASE_URL`) in sync
with the root `.env`.

### Database

Selection records need PostgreSQL. Start it and apply the migrations once
(details in `apps/server/README.md`):

```bash
docker compose up -d --wait db   # or: podman compose up -d --wait db
cd apps/server
set -a && source .env && set +a  # export DATABASE_URL and TEST_DATABASE_URL
uv run alembic upgrade head
```

### Run

In one terminal, start the backend (in a shell where `apps/server/.env` was sourced):

```bash
cd apps/server
uv sync
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

In another terminal, start the frontend:

```bash
cd apps/web
pnpm install --frozen-lockfile
pnpm dev
```

`uv` uses the Python 3.12 provided by Nix and creates the environment in
`apps/server/.venv`. Python dependencies are resolved from `uv.lock`, and
frontend dependencies are resolved from `apps/web/pnpm-lock.yaml`.
