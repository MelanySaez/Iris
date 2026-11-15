"""HTTP endpoints for saved selection records."""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query, Response

from app.schemas.selections import (
    SelectionDetail,
    SelectionListResponse,
    SelectionRename,
    SelectionSummary,
)
from app.services.selections import SelectionService, get_selection_service

router = APIRouter(prefix="/api/selections", tags=["selections"])


@router.get("", response_model=SelectionListResponse)
def list_selections(
    limit: int = Query(50, ge=1, le=200),
    before: datetime | None = None,
    service: SelectionService = Depends(get_selection_service),
) -> SelectionListResponse:
    """Saved selections, most recently seen first."""
    rows, next_before = service.list_selections(limit=limit, before=before)
    return SelectionListResponse(
        items=[SelectionSummary.from_model(row) for row in rows],
        next_before=next_before,
    )


@router.get("/{selection_id}", response_model=SelectionDetail)
def get_selection(
    selection_id: uuid.UUID,
    service: SelectionService = Depends(get_selection_service),
) -> SelectionDetail:
    """One saved selection with its discovered products and manifest."""
    return SelectionDetail.from_model(service.get(selection_id))


@router.patch("/{selection_id}", response_model=SelectionSummary)
def rename_selection(
    selection_id: uuid.UUID,
    body: SelectionRename,
    service: SelectionService = Depends(get_selection_service),
) -> SelectionSummary:
    """Set or clear the name shown for a saved selection."""
    return SelectionSummary.from_model(service.rename(selection_id, body.name))


@router.delete("/{selection_id}", status_code=204)
def delete_selection(
    selection_id: uuid.UUID,
    service: SelectionService = Depends(get_selection_service),
) -> Response:
    """Delete one saved selection (its shared region data is kept)."""
    service.delete(selection_id)
    return Response(status_code=204)
