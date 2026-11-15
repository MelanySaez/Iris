"""HTTP endpoints for the contextual assistant."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, Query, Request, Response

from app.api.deps import assistant_settings, get_assistant
from app.api.routes.consent import resolve_owner
from app.schemas.assistant import ChatRequest, ChatResponse, UiOutcome
from app.services.assistant.service import Assistant
from app.services.assistant.tools import selection_owner

router = APIRouter(prefix="/api/assistant", tags=["assistant"])


@router.get("/status")
def assistant_status() -> dict[str, Any]:
    """Whether the assistant has a key and a model configured."""
    settings = assistant_settings()
    return {"enabled": settings is not None, "model": settings[1] if settings else None}


@router.post("/chat", response_model=ChatResponse)
def assistant_chat(
    body: ChatRequest,
    request: Request,
    assistant: Assistant = Depends(get_assistant),
    owner: uuid.UUID | None = Depends(resolve_owner),
) -> dict[str, Any]:
    """Answer one question, executing read-only tools the model asks for."""
    token = selection_owner.set(owner)
    try:
        return assistant.chat(
            conversation_id=str(body.conversation_id),
            messages=[m.model_dump() for m in body.messages],
            context=body.context.model_dump(exclude_none=True),
            client_key=request.client.host if request.client else "unknown",
        )
    finally:
        selection_owner.reset(token)


@router.get("/logs")
def assistant_logs(
    limit: int = Query(default=200, ge=1, le=1000),
    conversation_id: uuid.UUID | None = None,
    assistant: Assistant = Depends(get_assistant),
) -> dict[str, Any]:
    """Recent assistant events, newest last."""
    items = assistant.log.read(
        limit=limit, conversation_id=str(conversation_id) if conversation_id else None
    )
    return {"items": items}


@router.post("/events", status_code=204)
def assistant_event(
    body: UiOutcome, assistant: Assistant = Depends(get_assistant)
) -> Response:
    """Record the browser's report on an action it executed or refused."""
    assistant.log.write(
        "ui_outcome",
        conversation_id=str(body.conversation_id),
        request_id=body.request_id,
        action=body.action,
        status=body.status,
        detail=body.detail,
    )
    return Response(status_code=204)
