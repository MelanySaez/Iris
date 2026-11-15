"""Selection record schemas and their ORM mapping helpers."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from astropy.time import Time
from pydantic import BaseModel, field_validator

from app.models.selection import Selection, SkyRegion, SpectralProduct

MAX_SELECTION_NAME_LENGTH = 80


class SelectionRegionOut(BaseModel):
    ra_deg: float
    dec_deg: float
    size_arcmin: float
    fov_deg: float
    coverage: Literal["available", "none", "unknown"]
    checked_at: datetime

    @classmethod
    def from_model(cls, region: SkyRegion) -> SelectionRegionOut:
        size = float(region.size_arcmin)
        return cls(
            ra_deg=float(region.ra_deg),
            dec_deg=float(region.dec_deg),
            size_arcmin=size,
            fov_deg=round(size / 60.0, 4),
            coverage=region.coverage,
            checked_at=region.checked_at,
        )


class SelectionSummary(BaseModel):
    id: uuid.UUID
    job_id: str
    region: SelectionRegionOut
    channels: list[int]
    products: list[str]
    mode: str
    stretch: str
    job_status: str
    job_error: str | None
    failed_stage: str | None
    error_kind: str | None
    error_trace: str | None
    job_events: list[dict[str, Any]] | None
    view_mode: Literal["single", "rgb"] | None
    rgb_channels: list[int] | None
    name: str | None
    hits: int
    created_at: datetime
    last_seen_at: datetime

    @classmethod
    def from_model(cls, sel: Selection) -> SelectionSummary:
        return cls(
            id=sel.id,
            job_id=sel.job_id,
            region=SelectionRegionOut.from_model(sel.region),
            channels=list(sel.channels),
            products=list(sel.products),
            mode=sel.mode,
            stretch=sel.stretch,
            job_status=sel.job_status,
            job_error=sel.job_error,
            failed_stage=sel.failed_stage,
            error_kind=sel.error_kind,
            error_trace=sel.error_trace,
            job_events=sel.job_events,
            view_mode=sel.view_mode,
            rgb_channels=(
                list(sel.rgb_channels) if sel.rgb_channels is not None else None
            ),
            name=sel.name,
            hits=sel.hits,
            created_at=sel.created_at,
            last_seen_at=sel.last_seen_at,
        )


class SelectionProductOut(BaseModel):
    product_id: str
    detector: int
    band: str
    source: str
    obs_id: str
    uri: str
    date_mjd: float
    date_iso: str

    @classmethod
    def from_model(cls, product: SpectralProduct) -> SelectionProductOut:
        return cls(
            product_id=product.product_id,
            detector=product.detector,
            band=f"SPHEREx-D{product.detector}",
            source=product.source,
            obs_id=product.obs_id,
            uri=product.uri,
            date_mjd=product.date_mjd,
            date_iso=mjd_to_iso(product.date_mjd),
        )


class SelectionRename(BaseModel):
    """New name for a selection; blank or null clears it (the key is required)."""

    name: str | None

    @field_validator("name")
    @classmethod
    def _normalize(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if len(value) > MAX_SELECTION_NAME_LENGTH:
            raise ValueError(
                f"name must be at most {MAX_SELECTION_NAME_LENGTH} characters"
            )
        return value or None


class SelectionDetail(SelectionSummary):
    spectral_products: list[SelectionProductOut]
    manifest: dict[str, Any] | None

    @classmethod
    def from_model(cls, sel: Selection) -> SelectionDetail:
        summary = SelectionSummary.from_model(sel)
        return cls(
            **summary.model_dump(),
            spectral_products=[
                SelectionProductOut.from_model(p) for p in sel.region.products
            ],
            manifest=sel.manifest,
        )


class SelectionListResponse(BaseModel):
    items: list[SelectionSummary]
    next_before: datetime | None


def mjd_to_iso(mjd: float) -> str:
    """Same ISO format as discovery (``Time(mjd).isot + "Z"``)."""
    return Time(mjd, format="mjd").isot + "Z"
