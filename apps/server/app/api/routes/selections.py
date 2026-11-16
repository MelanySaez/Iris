"""HTTP endpoints for saved selection records.

Every endpoint is scoped to the browser's owner cookie (see ``consent``): a
browser only sees and changes its own selections, and while it has not
accepted cookies the endpoints answer 403.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query, Response

from app.api.routes.consent import require_owner
from app.exceptions.domain import NotFoundError
from app.schemas.consent import ClaimRequest, ClaimResponse
from app.schemas.selections import (
    SelectionDetail,
    SelectionListResponse,
    SelectionRename,
    SelectionSummary,
)
from app.services.jobs import job_manager
from app.services.selections import SelectionService, get_selection_service

router = APIRouter(prefix="/api/selections", tags=["selections"])


@router.get("", response_model=SelectionListResponse)
def list_selections(
    limit: int = Query(50, ge=1, le=200),
    before: datetime | None = None,
    service: SelectionService = Depends(get_selection_service),
    owner: uuid.UUID = Depends(require_owner),
) -> SelectionListResponse:
    """The browser's saved selections, most recently seen first."""
    rows, next_before = service.list_selections(owner, limit=limit, before=before)
    return SelectionListResponse(
        items=[SelectionSummary.from_model(row) for row in rows],
        next_before=next_before,
    )


@router.post("/claim", response_model=ClaimResponse)
def claim_selections(
    body: ClaimRequest,
    service: SelectionService = Depends(get_selection_service),
    owner: uuid.UUID = Depends(require_owner),
) -> ClaimResponse:
    """Save the jobs this browser submitted before it accepted cookies.

    ``claimed`` counts the selections added: unknown job ids and jobs the
    browser already has are skipped.
    """
    jobs = []
    for job_id in dict.fromkeys(body.job_ids):
        try:
            jobs.append(job_manager.get_job(job_id))
        except NotFoundError:
            continue
    return ClaimResponse(claimed=service.claim(owner, jobs, body.names))


@router.get("/{selection_id}", response_model=SelectionDetail)
def get_selection(
    selection_id: uuid.UUID,
    service: SelectionService = Depends(get_selection_service),
    owner: uuid.UUID = Depends(require_owner),
) -> SelectionDetail:
    """One saved selection with its discovered products and manifest."""
    return SelectionDetail.from_model(service.get(owner, selection_id))


@router.patch("/{selection_id}", response_model=SelectionSummary)
def rename_selection(
    selection_id: uuid.UUID,
    body: SelectionRename,
    service: SelectionService = Depends(get_selection_service),
    owner: uuid.UUID = Depends(require_owner),
) -> SelectionSummary:
    """Set or clear the name shown for a saved selection."""
    return SelectionSummary.from_model(service.rename(owner, selection_id, body.name))


@router.delete("/{selection_id}", status_code=204)
def delete_selection(
    selection_id: uuid.UUID,
    service: SelectionService = Depends(get_selection_service),
    owner: uuid.UUID = Depends(require_owner),
) -> Response:
    """Delete one saved selection (its shared region data is kept)."""
    service.delete(owner, selection_id)
    return Response(status_code=204)
