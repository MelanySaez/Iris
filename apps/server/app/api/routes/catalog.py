"""Curated catalog endpoint."""

from __future__ import annotations

from fastapi import APIRouter

from app.schemas.catalog import CatalogResponse
from app.services.catalog import get_catalog

router = APIRouter(tags=["catalog"])


@router.get("/api/catalog", response_model=CatalogResponse)
def catalog() -> CatalogResponse:
    """Return curated objects list with precomputed cache indicators."""
    return CatalogResponse(**get_catalog())
