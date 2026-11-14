"""Job observer that saves every selection automatically."""

from __future__ import annotations

import logging
from typing import Any

from app.jobs import JobState, get_job_manifest
from app.models import ManifestResponse
from app.selections.store import SelectionStore

logger = logging.getLogger("uvicorn.error")

TERMINAL_STATUSES = ("ready", "failed")


class SelectionRecorder:
    """Persists job submissions, discoveries and outcomes as selection records."""

    def __init__(self, store: SelectionStore) -> None:
        self.store = store

    def on_submitted(self, job: JobState, is_new: bool) -> None:
        inserted = self.store.record_submission(
            job.id, job.request, job.status, new_attempt=is_new
        )
        if not is_new and inserted and job.status in TERMINAL_STATUSES:
            # Cache hit on a row that did not exist (e.g. it was deleted): the
            # job will not run again, so store its outcome now. An existing row
            # already holds it, so repeated hits skip the manifest rebuild.
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
        self.store.record_outcome(job.id, job.status, manifest, job.error)
