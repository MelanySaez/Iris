"""Region discovery endpoint."""

from __future__ import annotations

from fastapi import APIRouter

from app.schemas.regions import ResolveRequest, ResolveResponse
from app.services.discovery import resolve_region, validate_region_size

router = APIRouter(tags=["regions"])


@router.post("/api/regions/resolve", response_model=ResolveResponse)
def resolve(req: ResolveRequest) -> ResolveResponse:
    """Discover available spectral image products through IRSA TAP."""
    validate_region_size(req.size_arcmin)
    return ResolveResponse(**resolve_region(req.ra_deg, req.dec_deg, req.size_arcmin))
