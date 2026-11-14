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

Selection records need PostgreSQL. Start it and apply the migrations once
(details in `apps/server/README.md`):

```bash
podman compose up -d db        # or: docker compose up -d db
cd apps/server
export DATABASE_URL=postgresql+psycopg://iris:iris@127.0.0.1:5432/iris
uv run alembic upgrade head
```

In one terminal, start the backend (with `DATABASE_URL` exported):

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
