"""Region discovery schemas."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ResolveRequest(BaseModel):
    ra_deg: float
    dec_deg: float = Field(ge=-90.0, le=90.0)
    size_arcmin: float = Field(default=6.0, ge=1.0, le=60.0)


class RegionDescriptor(BaseModel):
    ra_deg: float
    dec_deg: float
    size_arcmin: float
    fov_deg: float


class ProductDescriptor(BaseModel):
    id: str
    source: Literal["remote"]
    detector: int
    band: str
    obs_id: str
    uri: str
    date_mjd: float
    date_iso: str


class EpochDescriptor(BaseModel):
    date_mjd: float
    date_iso: str
    product_id: str


class DetectorSummary(BaseModel):
    detector: int
    band: str
    count: int
    epochs: list[EpochDescriptor]


class ResolveResponse(BaseModel):
    region: RegionDescriptor
    coverage: Literal["available", "none", "unknown"]
    cached: bool
    query_ms: int
    warning: str | None = None
    products: list[ProductDescriptor]
    detectors: list[DetectorSummary]
    notes: list[str]
