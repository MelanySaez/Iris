"""HTTP endpoints and wiring for selection records."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any, Literal

from astropy.time import Time
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel

from app.jobs import JobManager
from app.selections.db import make_session_factory
from app.selections.orm import Selection, SkyRegion, SpectralProduct
from app.selections.recorder import SelectionRecorder
from app.selections.store import SelectionStore

logger = logging.getLogger("uvicorn.error")


class SelectionRegionOut(BaseModel):
    ra_deg: float
    dec_deg: float
    size_arcmin: float
    fov_deg: float
    coverage: Literal["available", "none", "unknown"]
    checked_at: datetime


class SelectionSummary(BaseModel):
    id: uuid.UUID
    job_id: str
    region: SelectionRegionOut
    channels: list[int]
    products: list[str]
    mode: str
    stretch: str
    job_status: str
    hits: int
    created_at: datetime
    last_seen_at: datetime


class SelectionProductOut(BaseModel):
    product_id: str
    detector: int
    band: str
    source: str
    obs_id: str
    uri: str
    date_mjd: float
    date_iso: str


class SelectionDetail(SelectionSummary):
    spectral_products: list[SelectionProductOut]
    manifest: dict[str, Any] | None


class SelectionListResponse(BaseModel):
    items: list[SelectionSummary]
    next_before: datetime | None


def _region_out(region: SkyRegion) -> SelectionRegionOut:
    size = float(region.size_arcmin)
    return SelectionRegionOut(
        ra_deg=float(region.ra_deg),
        dec_deg=float(region.dec_deg),
        size_arcmin=size,
        fov_deg=round(size / 60.0, 4),
        coverage=region.coverage,
        checked_at=region.checked_at,
    )


def _summary_fields(sel: Selection) -> dict[str, Any]:
    return {
        "id": sel.id,
        "job_id": sel.job_id,
        "region": _region_out(sel.region),
        "channels": list(sel.channels),
        "products": list(sel.products),
        "mode": sel.mode,
        "stretch": sel.stretch,
        "job_status": sel.job_status,
        "hits": sel.hits,
        "created_at": sel.created_at,
        "last_seen_at": sel.last_seen_at,
    }


def _mjd_to_iso(mjd: float) -> str:
    """Same ISO format as discovery (``Time(mjd).isot + "Z"``)."""
    return Time(mjd, format="mjd").isot + "Z"


def _product_out(p: SpectralProduct) -> SelectionProductOut:
    return SelectionProductOut(
        product_id=p.product_id,
        detector=p.detector,
        band=f"SPHEREx-D{p.detector}",
        source=p.source,
        obs_id=p.obs_id,
        uri=p.uri,
        date_mjd=p.date_mjd,
        date_iso=_mjd_to_iso(p.date_mjd),
    )


# -- wiring -------------------------------------------------------------------

_store: SelectionStore | None = None
_recorder: SelectionRecorder | None = None


def configure_selections(url: str | None, manager: JobManager) -> SelectionStore | None:
    """Enable (or, with ``url=None``, disable) selection persistence."""
    global _store, _recorder
    if _recorder is not None:
        manager.remove_observer(_recorder)
    _store, _recorder = None, None
    if url:
        _store = SelectionStore(make_session_factory(url))
        _recorder = SelectionRecorder(_store)
        manager.add_observer(_recorder)
        logger.info("selection records enabled")
    else:
        logger.info("selection records disabled: DATABASE_URL is not set")
    return _store


def get_store() -> SelectionStore:
    if _store is None:
        raise HTTPException(
            status_code=503,
            detail="Selection records are disabled: set DATABASE_URL on the server.",
        )
    return _store


router = APIRouter(prefix="/api/selections", tags=["selections"])


@router.get("", response_model=SelectionListResponse)
def list_selections(
    limit: int = Query(50, ge=1, le=200),
    before: datetime | None = None,
    store: SelectionStore = Depends(get_store),
) -> SelectionListResponse:
    """Saved selections, most recently seen first."""
    rows = store.list(limit=limit, before=before)
    items = [SelectionSummary(**_summary_fields(s)) for s in rows]
    next_before = rows[-1].last_seen_at if len(rows) == limit else None
    return SelectionListResponse(items=items, next_before=next_before)


@router.get("/{selection_id}", response_model=SelectionDetail)
def get_selection(
    selection_id: uuid.UUID, store: SelectionStore = Depends(get_store)
) -> SelectionDetail:
    """One saved selection with its discovered products and manifest."""
    sel = store.get(selection_id)
    if sel is None:
        raise HTTPException(status_code=404, detail="Selection not found.")
    return SelectionDetail(
        **_summary_fields(sel),
        spectral_products=[_product_out(p) for p in sel.region.products],
        manifest=sel.manifest,
    )


@router.delete("/{selection_id}", status_code=204)
def delete_selection(
    selection_id: uuid.UUID, store: SelectionStore = Depends(get_store)
) -> Response:
    """Delete one saved selection (its shared region data is kept)."""
    if not store.delete(selection_id):
        raise HTTPException(status_code=404, detail="Selection not found.")
    return Response(status_code=204)
