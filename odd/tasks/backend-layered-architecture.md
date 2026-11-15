# Backend layered architecture refactor

Objective: reorganize `apps/server/app/` into layered architecture (api, core, exceptions, models, repositories, schemas, services, utils) and update every reference to `app.*` (tests, scripts, alembic, docs).
Branch: `main` (user explicitly requested direct local commits; no push or PR). Test runner: `.venv/bin/python -m pytest -q`. Lint: `.venv/bin/ruff check app tests scripts`.

## Specs

- S1: Target tree exists under `apps/server/app/`: `alembic/`, `api/`, `core/`, `exceptions/`, `models/`, `repositories/`, `schemas/`, `services/`, `utils/`, `initial_data.py`, `main.py`, `sql_prestart.py`.
- S2: `models/` holds SQLAlchemy ORM only; `schemas/` holds Pydantic request/response models only.
- S3: `services/` holds business logic and raises `app.exceptions.domain` errors, never `fastapi.HTTPException`.
- S4: `repositories/` holds persistence abstractions: selection records (PostgreSQL), job snapshots (JSON), assistant log (JSONL).
- S5: `api/` holds FastAPI routes, dependencies, middleware and the router; it maps domain errors to HTTP through `app.exceptions.handlers`.
- S6: HTTP paths, status codes, error details, and other response behavior remain unchanged; the obsolete `local_assets` health field is removed with the local FITS asset feature.
- S7: All application, test, script, migration, and documentation imports use the reorganized `app.*` module paths.
- S8: `uv run python -m app.sql_prestart`, `uv run python -m alembic upgrade head`, `uvicorn app.main:app` and `scripts/warm_catalog.py` keep working.
- S9: Backend regression suite stays green; tests dedicated only to the removed local FITS feature are deleted.
- S10: Environment configuration uses `pydantic-settings` to load `.env`, ignore empty and extra values, validate typed settings, and parse comma-separated CORS origins.
- S11: Remove local FITS configuration and processing; no `LOCAL_FITS_PATH`, `DEFAULT_FITS`, or local-FITS product behavior remains.

## Tasks

- T1 inline [complete]: scaffold dirs, move core/config/tracing/database and ORM, update imports. S1,S2,S7
- T2 inline [complete]: split Pydantic models into `schemas/`. S2,S6,S7
- T3 inline [complete]: repositories (selection, job snapshots, assistant log) + services split (jobs/queries). S3,S4
- T4 inline [complete]: exceptions layer and replace service-level HTTPException. S3,S5,S6
- T5 inline [complete]: api routes, deps, middleware, router, main, initial_data. S5,S6
- T6 inline [partial]: alembic env, scripts, README, tests references. S7,S8
- T7 inline [partial]: ruff + pytest verification. S9
- T8 inline [complete]: typed `.env` settings and removal of local FITS runtime/configuration references. S6,S10,S11
- T9 inline [complete]: update frontend catalog fallback and source types to match remote-only products. S6,S11

## Log

- L1 (user, verbatim):
  > bueno brother, hazme un favor, refactoriza todo el codigo del backend app/ para que siga una arquitectura por capas, mas o menos como esto
  >
  > │   ├── alembic/        # Database migrations
  > │   ├── api/            # FastAPI routes and dependencies
  > │   ├── core/           # Configuration and database setup
  > │   ├── exceptions/     # Domain and HTTP exceptions
  > │   ├── models/         # SQLAlchemy models
  > │   ├── repositories/   # Persistence abstractions
  > │   ├── schemas/        # Pydantic schemas
  > │   ├── services/       # Business logic layer
  > │   ├── utils/          # Shared helpers
  > │   ├── initial_data.py  # Initial data bootstrap
  > │   ├── main.py         # Application entry point
  > │   └── sql_prestart.py # Prestart SQL/bootstrap helpers
  >
  > Y actualiza todas las referencias para que utilicen "app."
  >
  > Ya las primeras migraciones se han estado haciendo, pero quisiera que implementaras algo como esto para leer las variables de entorno
  >
  > ```python
  > from typing import Annotated, Any, Optional
  >
  > from dotenv import load_dotenv
  > from pydantic import (
  >     AmqpDsn,
  >     BeforeValidator,
  >     PostgresDsn,
  >     computed_field,
  > )
  > from pydantic_core import MultiHostUrl
  > from pydantic_settings import BaseSettings, SettingsConfigDict
  >
  > load_dotenv(override=True)
  >
  >
  > def split_list(v: Any) -> list[str] | str:
  >     """
  >     Function to split strings into a list in text format.
  >
  >     Args:
  >         v (Any): Value that can be a string or list.
  >
  >     Returns:
  >         list[str] | str: List or the original string if it's already a list or string respectively.
  >
  >     Raises:
  >         ValueError: If the value is not of a valid type.
  >     """
  >     if isinstance(v, str) and not v.startswith("["):
  >         return [i.strip() for i in v.split(",")]
  >     elif isinstance(v, list | str):
  >         return v
  >     raise ValueError(v)
  >
  >
  > class Settings(BaseSettings):
  >     model_config = SettingsConfigDict(
  >         env_file=".env",
  >         env_ignore_empty=True,
  >         extra="ignore",
  >     )
  >     # API Configuration
  >     API_V1_STR: str
  >     CORS_ORIGINS: Annotated[list[str] | str, BeforeValidator(split_list)]
  >     SERVER_HOST: str
  >     SERVER_PORT: int
  >     SERVER_DEBUG: bool
  >
  >     AUTH_INFO: str
  >     SECRET_KEY: str
  >
  >     # Encryption configuration for database credentials in projects
  >     CREDENTIALS_SECRET_KEY: str
  >     CREDENTIALS_SIGN: str
  >
  >     # OTel Configuration
  >     OTEL_SERVICE_NAME: str = "api-server"
  >     OTEL_SERVICE_VERSION: str = "1.0.0"
  >
  >     # For pending status
  >     IDEMPOTENCY_TTL_DEFAULT_SECONDS: int = 60 * 10  # 10 minutes
  >     IDEMPOTENCY_TTL_RETRY_DELAY_SECONDS: int = 60 * 1  # 1 minute
  >     IDEMPOTENCY_TTL_PUBLISHED_SECONDS: int = 60 * 30  # 30 minutes
  >
  >     FIRST_SUPERUSER_NAME: str
  >     FIRST_SUPERUSER_EMAIL: str
  >     FIRST_SUPERUSER_PASSWORD: str
  >
  >     # RabbitMQ Configuration
  >     RABBITMQ_HOST: str
  >     RABBITMQ_PORT: int
  >     RABBITMQ_VHOST: str
  >     RABBITMQ_USER: str
  >     RABBITMQ_PASSWORD: str
  >     RABBITMQ_MAX_RETRIES: int = 5
  >     RABBITMQ_RETRY_DELAY_SECONDS: float = 1.0
  >     RABBITMQ_BACKOFF_MULTIPLIER: float = 2.0
  >
  >     @computed_field
  >     @property
  >     def RABBITMQ_URI(self) -> AmqpDsn:
  >         return MultiHostUrl.build(  # type: ignore
  >             scheme="amqp",
  >             username=self.RABBITMQ_USER,
  >             password=self.RABBITMQ_PASSWORD,
  >             host=self.RABBITMQ_HOST,
  >             port=self.RABBITMQ_PORT,
  >             path=self.RABBITMQ_VHOST,
  >         )
  >
  >     # PostgreSQL Configuration
  >     POSTGRES_HOST: str
  >     POSTGRES_PORT: int = 5432
  >     POSTGRES_USER: Optional[str] = None
  >     POSTGRES_PASSWORD: Optional[str] = None
  >     POSTGRES_DB: Optional[str] = None
  >
  >     @computed_field
  >     @property
  >     def POSTGRES_URI(self) -> PostgresDsn:
  >         return MultiHostUrl.build(  # type: ignore
  >             scheme="postgresql+psycopg2",
  >             username=self.POSTGRES_USER,
  >             password=self.POSTGRES_PASSWORD,
  >             host=self.POSTGRES_HOST,
  >             port=self.POSTGRES_PORT,
  >             path=self.POSTGRES_DB,
  >         )
  >
  >     DEFAULT_PROJECT_POSTGRES_HOST: Optional[str] = None
  >     DEFAULT_PROJECT_POSTGRES_PORT: Optional[int] = None
  >     DEFAULT_PROJECT_POSTGRES_USER: Optional[str] = None
  >     DEFAULT_PROJECT_POSTGRES_PASSWORD: Optional[str] = None
  >     DEFAULT_PROJECT_POSTGRES_DB: Optional[str] = None
  >
  >     @computed_field
  >     @property
  >     def DEFAULT_PROJECT_POSTGRES_URI(self) -> PostgresDsn:
  >         return MultiHostUrl.build(  # type: ignore
  >             scheme="postgresql",
  >             username=self.DEFAULT_PROJECT_POSTGRES_USER,
  >             password=self.DEFAULT_PROJECT_POSTGRES_PASSWORD,
  >             host=self.DEFAULT_PROJECT_POSTGRES_HOST,
  >             port=self.DEFAULT_PROJECT_POSTGRES_PORT,
  >             path=self.DEFAULT_PROJECT_POSTGRES_DB,
  >         )
  >
  >     # Database Connection Configuration
  >     DATABASE_CONNECTION_HOST: str
  >     DATABASE_CONNECTION_PORT: int
  >     DATABASE_MAX_RETRIES: int = 5
  >     DATABASE_RETRY_DELAY_SECONDS: float = 1.0
  >     DATABASE_BACKOFF_MULTIPLIER: float = 2.0
  >     DATABASE_TRACE_CONTEXT_ENABLED: bool = True
  >
  >     @computed_field
  >     @property
  >     def DATABASE_CONNECTION_CHANNEL(self) -> str:
  >         return f"{self.DATABASE_CONNECTION_HOST}:{self.DATABASE_CONNECTION_PORT}"
  >
  >     # Excel-Reader configuration
  >     EXCEL_READER_HOST: str = "localhost"
  >     EXCEL_READER_PORT: int = 8001
  >     EXCEL_READER_TIMEOUT_SECONDS: int = 30
  >
  >     @computed_field
  >     @property
  >     def EXCEL_READER_URL(self) -> str:
  >         return f"http://{self.EXCEL_READER_HOST}:{self.EXCEL_READER_PORT}"
  >
  >
  > settings = Settings()  # type: ignore
  > ```
  >
  > De paso, borra todas las referencias de los assets locales, esa guevonada ya no existe: LOCAL_FITS_PATH, DEFAULT_FITS
- L2: baseline pytest 192 passed, 17 skipped (DATABASE_URL unset).
- L3: decision: keep external-provider caches (IRSA/SIMBAD/cube) inside their services; only DB, job snapshots and assistant log become repositories. Reason: caches are provider adapters, splitting them adds indirection with no layering gain.
- L4 (user): "Ya las primeras migraciones se han estado haciendo, pero quisiera que implementaras algo como esto para leer las variables de entorno"; "De paso, borra todas las referencias de los assets locales, esa guevonada ya no existe: LOCAL_FITS_PATH, DEFAULT_FITS".
- L5: Environment settings now use `pydantic-settings` with `.env`, ignored empty/extra values, typed fields, and comma-separated CORS parsing. Kept environment variables authoritative over `.env` instead of calling `load_dotenv(override=True)`.
- L6: Removed local FITS discovery, extraction preference, catalog entry, configuration, and API source options. Historical selection rows and the already-applied migration constraint still accept `local` for backward compatibility; new products are remote-only.
- L7: Verification: settings/discovery/channels/warm-catalog subset 15 passed; frontend Vitest 319 passed and typecheck passed; live Uvicorn `/api/health` and `/api/catalog` returned 200. Full backend pytest timed out after 30s in the TestClient-based suite; prior diagnostic showed even a minimal FastAPI TestClient request hangs in this environment. Ruff could not start because its Nix-linked executable fails with `GLIBC_PRIVATE` symbol lookup error. `git diff --check` and Python compileall passed.
- L8: Alembic upgrade and SQL prestart were not executed to avoid mutating the configured database; runtime import/compile and live HTTP smoke checks passed instead.
- L9 (user, 2026-11-15): "varios commits a main y ya está, nada del otro mundo".
