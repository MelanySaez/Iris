"""Curated catalog schemas."""

from __future__ import annotations

from pydantic import BaseModel


class CatalogObject(BaseModel):
    id: str
    name: str
    ra_deg: float
    dec_deg: float
    type: str
    default_size_arcmin: float
    description: str
    precomputed: bool


class CatalogResponse(BaseModel):
    objects: list[CatalogObject]
