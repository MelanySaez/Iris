"""Selection-record application service and the job observer that feeds it.

The service owns query semantics (pagination, not-found errors); the repository
owns PostgreSQL. Persistence is optional: without ``DATABASE_URL`` the service
is simply absent and the routers answer 503.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any

from app.core.database import make_session_factory, normalize_database_url
from app.exceptions.domain import SelectionNotFoundError, SelectionsDisabledError
from app.models.selection import Selection
from app.repositories.selection import SelectionRepository
from app.schemas.jobs import JobRequest, ManifestResponse
from app.services.job_queries import get_job_manifest
from app.services.jobs import JobManager, JobState

logger = logging.getLogger("uvicorn.error")

TERMINAL_STATUSES = ("ready", "failed")
DISABLED_DETAIL = "Selection records are disabled: set DATABASE_URL on the server."


class SelectionService:
    """Read and mutate saved selections through the repository."""

    def __init__(self, repository: SelectionRepository) -> None:
        self.repository = repository

    @property
    def engine_url(self) -> str:
        return self.repository.engine_url

    def list_selections(
        self, owner_id: uuid.UUID, limit: int, before: datetime | None = None
    ) -> tuple[list[Selection], datetime | None]:
        """One page of the owner's selections plus the cursor for the next page."""
        rows = self.repository.list(owner_id, limit=limit, before=before)
        next_before = rows[-1].last_seen_at if len(rows) == limit else None
        return rows, next_before

    def list_recent(self, owner_id: uuid.UUID, limit: int) -> list[Selection]:
        """The owner's most recently seen selections, newest first."""
        return self.repository.list(owner_id, limit=limit)

    def get(self, owner_id: uuid.UUID, selection_id: uuid.UUID) -> Selection:
        sel = self.repository.get(owner_id, selection_id)
        if sel is None:
            raise SelectionNotFoundError("Selection not found.")
        return sel

    def rename(
        self, owner_id: uuid.UUID, selection_id: uuid.UUID, name: str | None
    ) -> Selection:
        sel = self.repository.rename(owner_id, selection_id, name)
        if sel is None:
            raise SelectionNotFoundError("Selection not found.")
        return sel

    def delete(self, owner_id: uuid.UUID, selection_id: uuid.UUID) -> None:
        if not self.repository.delete(owner_id, selection_id):
            raise SelectionNotFoundError("Selection not found.")

    def claim(self, owner_id: uuid.UUID, jobs: list[JobState]) -> int:
        """Save, for a browser that just accepted cookies, the jobs it submitted
        before accepting. Each job is recorded as that browser's selection with
        its current status and, when finished, its outcome. Returns how many."""
        recorder = SelectionRecorder(self.repository)
        for job in jobs:
            recorder.on_submitted(job, False, job.request, owner_id)
        return len(jobs)


class SelectionRecorder:
    """Job observer that saves submissions, discoveries and outcomes."""

    def __init__(self, store: Any) -> None:
        self.store = store

    def on_submitted(
        self,
        job: JobState,
        is_new: bool,
        request: JobRequest | None = None,
        owner: uuid.UUID | None = None,
    ) -> None:
        if owner is None:
            # The browser did not accept cookies: nothing is saved for it.
            return
        # The submitted request carries the latest view; job.request may be an older one.
        result = self.store.record_submission(
            owner, job.id, request or job.request, job.status, new_attempt=is_new
        )
        if is_new or job.status not in TERMINAL_STATUSES:
            return
        # Cache hit on a finished job: it will not run again, so store its
        # outcome when the row lacks it, i.e. the row was just created (it had
        # been deleted) or its outcome write was lost and it is still stuck in
        # an intermediate status. Rows that hold an outcome are left untouched.
        if result.inserted or result.stored_status not in TERMINAL_STATUSES:
            self.on_finished(job)

    def on_discovered(self, job: JobState, discovery: dict[str, Any]) -> None:
        self.store.record_discovery(job.request, discovery)

    def on_finished(self, job: JobState) -> None:
        manifest = None
        if job.status == "ready":
            try:
                manifest = ManifestResponse(**get_job_manifest(job.id)).model_dump(
                    mode="json"
                )
            except Exception:
                logger.exception("selection manifest unavailable for job=%s", job.id)
        self.store.record_outcome(
            job.id,
            job.status,
            manifest,
            job.error,
            failed_stage=job.failed_stage,
            error_kind=job.error_kind,
            error_trace=job.error_trace,
            events=list(job.events),
        )


# -- wiring ---------------------------------------------------------------------

_repository: SelectionRepository | None = None
_recorder: SelectionRecorder | None = None


def current_selection_repository() -> SelectionRepository | None:
    """The configured repository, or ``None`` when records are disabled."""
    return _repository


def current_selection_service() -> SelectionService | None:
    """The configured service, or ``None`` when records are disabled."""
    return None if _repository is None else SelectionService(_repository)


def configure_selections(
    url: str | None, manager: JobManager
) -> SelectionRepository | None:
    """Enable (or, with ``url=None``, disable) selection persistence."""
    global _repository, _recorder
    if _recorder is not None:
        manager.remove_observer(_recorder)
    _repository, _recorder = None, None
    if url:
        try:
            repository = SelectionRepository(
                make_session_factory(normalize_database_url(url))
            )
        except Exception as exc:
            # A malformed URL must never stop the server; records stay disabled.
            # Log only the error type: the message or traceback could carry the
            # raw URL, password included.
            logger.error(
                "selection records disabled: invalid DATABASE_URL (%s)",
                type(exc).__name__,
            )
            return None
        _repository = repository
        _recorder = SelectionRecorder(repository)
        manager.add_observer(_recorder)
        logger.info("selection records enabled")
    else:
        logger.info("selection records disabled: DATABASE_URL is not set")
    return _repository


def get_selection_repository() -> SelectionRepository:
    """FastAPI dependency: the repository or a 503 when disabled."""
    if _repository is None:
        raise SelectionsDisabledError(DISABLED_DETAIL)
    return _repository


def get_selection_service() -> SelectionService:
    """FastAPI dependency: the service or a 503 when disabled."""
    return SelectionService(get_selection_repository())
