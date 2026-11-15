"""Health endpoint."""

from __future__ import annotations

from fastapi import APIRouter

from app.core.config import APP_VERSION
from app.schemas.health import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Return backend health and capability metadata."""
    return HealthResponse(
        status="ok",
        version=APP_VERSION,
        products=["DR1 All-Sky Cube HiPS", "Level-2 spectral image cutouts"],
        network="configured",
    )
