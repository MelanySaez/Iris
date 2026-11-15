"""Application bootstrap: runtime directories and initial data.

Run standalone (``python -m app.initial_data``) from the prestart script, or
let ``app.main`` call :func:`init` while the process starts.
"""

from __future__ import annotations

import logging

from app.core.config import ensure_runtime_directories

logger = logging.getLogger(__name__)


def init() -> None:
    """Prepare the runtime state the application expects on startup."""
    ensure_runtime_directories()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    logger.info("Initializing runtime directories")
    init()
    logger.info("Runtime directories ready")


if __name__ == "__main__":
    main()
