"""Shared test setup."""

from __future__ import annotations

import pytest

from app.services.jobs import job_manager
from app.services.selections import configure_selections


@pytest.fixture(scope="session", autouse=True)
def isolate_selection_records():
    """Keep tests from writing selection records into the developer database.

    Importing ``app.main`` enables persistence when ``DATABASE_URL`` is set;
    tests that need it enable it explicitly against a throwaway schema.
    """
    configure_selections(None, job_manager)
    yield
    configure_selections(None, job_manager)
