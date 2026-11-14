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

In one terminal, start the backend:

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
