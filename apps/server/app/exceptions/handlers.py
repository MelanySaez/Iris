"""Map domain errors to the HTTP contract.

The response shape is exactly FastAPI's own: ``{"detail": "<message>"}``.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.exceptions.domain import AppError


def register_exception_handlers(app: FastAPI) -> None:
    """Register one handler for every :class:`AppError` subclass."""

    @app.exception_handler(AppError)
    async def _handle_app_error(_request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
