"""HTTP middleware registration for the application."""

from __future__ import annotations

import logging
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import CORS_ALLOWED_ORIGINS
from app.utils.tracing import request_id_var


def register_middleware(app: FastAPI) -> None:
    """Install CORS and request tracing middleware."""
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ALLOWED_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def trace_request(request: Request, call_next):
        request_id = uuid.uuid4().hex[:12]
        token = request_id_var.set(request_id)
        started = time.monotonic()
        try:
            response = await call_next(request)
        finally:
            request_id_var.reset(token)
        response.headers["X-Request-ID"] = request_id
        logging.getLogger("uvicorn.error").info(
            "request=%s method=%s path=%s status=%s elapsed_ms=%.1f",
            request_id,
            request.method,
            request.url.path,
            response.status_code,
            (time.monotonic() - started) * 1000,
        )
        return response
