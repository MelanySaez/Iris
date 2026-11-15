"""FastAPI application entry point."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.middleware import register_middleware
from app.api.router import router
from app.core.config import APP_NAME, APP_VERSION
from app.core.database import get_database_url
from app.exceptions.handlers import register_exception_handlers
from app.initial_data import init
from app.services.jobs import job_manager
from app.services.selections import configure_selections


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Create runtime cache directories before serving requests."""
    init()
    yield


app = FastAPI(title=APP_NAME, version=APP_VERSION, lifespan=lifespan)
configure_selections(get_database_url(), job_manager)
register_exception_handlers(app)
register_middleware(app)
app.include_router(router)
