# Iris

Nasa Space Challenge 2026

## Open your own SPHEREx FITS

Open **Plate** directly and choose a FITS file, or drop it onto the loader.
You do not need to select a region in Sky first. Upload progress is shown while
the file transfers, followed by a reading indicator until the plate is ready.
The existing Sky → Plate workflow is also available.

Plate accepts SPHEREx Level-2 images/cutouts and DR1 All-Sky Cube tiles
(`Npix…_cube.fits`), up to 350 MB per file. Level-2 files expose their detector's
17 channels, image, variance and flags. Cube tiles expose their channel planes
and flags, with nominal wavelengths, no variance and no temporal information.
Files are uploaded to the backend cache and are **not saved in Records**.
Use **Open FITS** in an existing plate to open another file.

See the [backend guide](apps/server/README.md#user-fits-uploads) for required
FITS extensions, the upload API and cache behavior.

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
| `apps/server/.env.example` | backend, migrations, tests | `DATABASE_URL`, `CORS_ORIGINS`, assistant settings |
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
uv run alembic upgrade head
```

### Run

In one terminal, start the backend from `apps/server`:

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

For VS Code notebooks, select `apps/server/.venv/bin/python` as the kernel.
Run `nix develop` from the repository root after `uv sync` if VS Code was
started outside the Nix shell; this patches native Python extensions so the
kernel can load Nix-provided shared libraries without inheriting the shell's
`LD_LIBRARY_PATH`. Do not install packages into the immutable Nix Python;
declare them in `apps/server/pyproject.toml` and run `uv sync` instead.
