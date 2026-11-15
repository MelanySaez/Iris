"""Shared test setup."""

from __future__ import annotations

import pytest

from app.core.config import ensure_runtime_directories
from app.services.jobs import job_manager
from app.services.selections import configure_selections


@pytest.fixture(scope="session", autouse=True)
def runtime_directories():
    """Create the cache directories the app lifespan creates in production.

    ``TestClient(app)`` without a ``with`` block never runs the lifespan, so a
    fresh checkout would otherwise have no cache directories to write into.
    """
    ensure_runtime_directories()


@pytest.fixture(scope="session", autouse=True)
def isolate_selection_records():
    """Keep tests from writing selection records into the developer database.

    Importing ``app.main`` enables persistence when ``DATABASE_URL`` is set;
    tests that need it enable it explicitly against a throwaway schema.
    """
    configure_selections(None, job_manager)
    yield
    configure_selections(None, job_manager)
