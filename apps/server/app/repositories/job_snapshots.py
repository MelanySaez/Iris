"""JSON snapshot persistence for finished jobs.

A ready job snapshot lets frames and manifests be rebuilt after the in-memory
LRU evicts the job or the server restarts.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from app.core import config

logger = logging.getLogger("uvicorn.error")


class JobSnapshotRepository:
    """Read and write job snapshots as JSON files."""

    def __init__(self, directory: Path | None = None) -> None:
        self._directory = directory

    @property
    def directory(self) -> Path:
        """Directory holding the snapshots (resolved per access)."""
        return self._directory or config.JOBS_CACHE_DIR

    def path_for(self, job_id: str) -> Path:
        return self.directory / f"{job_id}.json"

    def read(self, job_id: str) -> dict[str, Any] | None:
        """Return the stored snapshot, or ``None`` when absent or unreadable."""
        path = self.path_for(job_id)
        if not path.is_file():
            return None
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None

    def write(self, job_id: str, snapshot: dict[str, Any]) -> None:
        """Persist one snapshot; a write failure never breaks the job."""
        try:
            target = self.path_for(job_id)
            with open(target, "w", encoding="utf-8") as f:
                json.dump(snapshot, f, indent=2)
        except Exception as exc:
            logger.warning("Failed to persist job %s snapshot: %s", job_id, exc)
