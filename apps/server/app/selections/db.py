"""SQLAlchemy engine and session factory configured from ``DATABASE_URL``."""

from __future__ import annotations

import os
from functools import lru_cache

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import sessionmaker

DATABASE_URL_ENV = "DATABASE_URL"
CONNECT_TIMEOUT_SECONDS = 3


def get_database_url() -> str | None:
    """Return the configured database URL, or ``None`` when storage is disabled."""
    url = os.environ.get(DATABASE_URL_ENV, "").strip()
    return url or None


@lru_cache(maxsize=4)
def get_engine(url: str) -> Engine:
    """Create (once per URL) a pooled engine that validates stale connections.

    A short connect timeout keeps job submission responsive when the database
    is unreachable; persistence failures are logged, never raised to clients.
    """
    return create_engine(
        url,
        pool_pre_ping=True,
        connect_args={"connect_timeout": CONNECT_TIMEOUT_SECONDS},
    )


def make_session_factory(url: str) -> sessionmaker:
    """Session factory bound to the engine for ``url``."""
    return sessionmaker(bind=get_engine(url), expire_on_commit=False)
