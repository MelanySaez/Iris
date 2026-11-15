"""Object-name resolution endpoint."""

from __future__ import annotations

from fastapi import APIRouter, Query

from app.schemas.names import ResolveNameResponse
from app.services.names import resolve_name

router = APIRouter(tags=["names"])


@router.get("/api/resolve", response_model=ResolveNameResponse)
def resolve_object_name(
    name: str = Query(..., description="Object name or catalogue code, e.g. M31"),
) -> ResolveNameResponse:
    """Position of a named object: SIMBAD mirror, then NED; J designations offline."""
    return ResolveNameResponse(**resolve_name(name))
