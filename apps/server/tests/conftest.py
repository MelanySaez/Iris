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


@pytest.fixture(autouse=True)
def no_cube_network(monkeypatch):
    """The All-Sky Cube fallback never reaches S3 in tests unless a test opts in.

    Without it, every simulated IRSA outage would continue to the real cube
    tiles. Tests that exercise the fallback patch ``discover_cube`` themselves.
    """
    from app.services import discovery
    from app.services.cube_fallback import CubeUpstreamError

    def offline(*args, **kwargs):
        raise CubeUpstreamError("S3 cube access is disabled in tests")

    monkeypatch.setattr(discovery, "discover_cube", offline)
