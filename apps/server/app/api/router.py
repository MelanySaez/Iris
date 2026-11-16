"""Composition root for the HTTP route modules."""

from fastapi import APIRouter

from app.api.routes import (
    assistant,
    catalog,
    channels,
    consent,
    health,
    jobs,
    names,
    regions,
    selections,
    spectrum,
    uploads,
)

router = APIRouter()
for route_module in (
    assistant,
    catalog,
    channels,
    consent,
    health,
    jobs,
    names,
    regions,
    selections,
    spectrum,
    uploads,
):
    router.include_router(route_module.router)
