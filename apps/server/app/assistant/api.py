"""HTTP endpoints for the contextual assistant."""

from __future__ import annotations

import json
import os
import threading
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.assistant.cache import ResponseCache
from app.assistant.guardrails import RateLimiter
from app.assistant.logbook import AssistantLog
from app.assistant.service import Assistant, ModelUnavailable, RateLimited
from app.assistant.tools import UI_TOOLS
from app.config import (
    ASSISTANT_CACHE_MAX_ENTRIES,
    ASSISTANT_CACHE_TTL_SECONDS,
    ASSISTANT_LOG_PATH,
    ASSISTANT_RATE_LIMIT_PER_MINUTE,
)

MAX_MESSAGE_CHARS = 2000
# Assistant turns echoed back as history may be longer than a question: a reply
# the server produced must never make the next request fail.
MAX_HISTORY_REPLY_CHARS = 20000
MAX_MESSAGES = 21  # ten earlier exchanges plus the current question
SIMILARITY_THRESHOLD = 0.85

router = APIRouter(prefix="/api/assistant", tags=["assistant"])

_assistant: Assistant | None = None
_assistant_settings: tuple[str, str, str | None] | None = None
_lock = threading.Lock()

DISABLED_DETAIL = (
    "The assistant is disabled: set ASSISTANT_API_KEY and ASSISTANT_MODEL on the server "
    "(and ASSISTANT_BASE_URL for an OpenAI-compatible provider other than OpenAI)."
)


def _settings() -> tuple[str, str, str | None] | None:
    """(api key, model, base URL) from the environment, or None until both are set."""
    key = os.environ.get("ASSISTANT_API_KEY", "").strip()
    model = os.environ.get("ASSISTANT_MODEL", "").strip()
    if not key or not model:
        return None
    return key, model, os.environ.get("ASSISTANT_BASE_URL", "").strip() or None


def get_assistant() -> Assistant:
    """The shared assistant; 503 while the key or the model is missing."""
    global _assistant, _assistant_settings
    settings = _settings()
    if settings is None:
        raise HTTPException(status_code=503, detail=DISABLED_DETAIL)
    with _lock:
        if _assistant is None or settings != _assistant_settings:
            import openai

            key, model, base_url = settings
            _assistant = Assistant(
                client=openai.OpenAI(api_key=key, base_url=base_url),
                log=AssistantLog(ASSISTANT_LOG_PATH),
                cache=ResponseCache(
                    max_entries=ASSISTANT_CACHE_MAX_ENTRIES,
                    ttl_seconds=ASSISTANT_CACHE_TTL_SECONDS,
                    similarity=SIMILARITY_THRESHOLD,
                ),
                rate_limiter=RateLimiter(ASSISTANT_RATE_LIMIT_PER_MINUTE),
                model=model,
            )
            _assistant_settings = settings
        return _assistant


# -- request and response models --------------------------------------------------


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=MAX_HISTORY_REPLY_CHARS)

    @model_validator(mode="after")
    def _user_turns_are_short(self) -> ChatMessage:
        if self.role == "user" and len(self.content) > MAX_MESSAGE_CHARS:
            raise ValueError(
                f"user messages are limited to {MAX_MESSAGE_CHARS} characters"
            )
        return self


class Region(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ra_deg: float = Field(ge=0, lt=360)
    dec_deg: float = Field(ge=-90, le=90)
    size_arcmin: float = Field(ge=1, le=60)


class UiContext(BaseModel):
    """What the browser reports about the interface; treated as untrusted data."""

    model_config = ConfigDict(extra="forbid")

    workspace: Literal["sky", "plate", "spectral", "records"]
    channel: int | None = Field(default=None, ge=0, le=101)
    color_mode: Literal["single", "rgb"] | None = None
    rgb: list[int] | None = Field(default=None, min_length=3, max_length=3)
    selected_region: Region | None = None
    region_confirmed: bool | None = None
    center: list[float] | None = Field(default=None, min_length=2, max_length=2)
    fov_deg: float | None = Field(default=None, gt=0, le=360)
    active_job_id: str | None = Field(
        default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"
    )


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conversation_id: uuid.UUID
    messages: list[ChatMessage] = Field(min_length=1, max_length=MAX_MESSAGES)
    context: UiContext

    @field_validator("messages")
    @classmethod
    def _alternating_and_ends_with_user(
        cls, value: list[ChatMessage]
    ) -> list[ChatMessage]:
        for index, message in enumerate(value):
            expected = "user" if index % 2 == 0 else "assistant"
            if message.role != expected:
                raise ValueError(
                    "messages must alternate user/assistant, starting with user"
                )
        if value[-1].role != "user":
            raise ValueError("the last message must be the user's question")
        return value


class ChatResponse(BaseModel):
    conversation_id: str
    request_id: str
    reply: str
    actions: list[dict[str, Any]]
    cached: bool
    cache_kind: Literal["exact", "similar"] | None


class UiOutcome(BaseModel):
    """The browser's report on an action it executed or refused."""

    model_config = ConfigDict(extra="forbid")

    conversation_id: uuid.UUID
    request_id: str | None = Field(
        default=None, max_length=32, pattern=r"^[A-Za-z0-9_-]+$"
    )
    action: dict[str, Any]
    status: Literal["executed", "rejected", "failed"]
    detail: str = Field(default="", max_length=300)

    @model_validator(mode="after")
    def _known_small_action(self) -> UiOutcome:
        if self.action.get("type") not in UI_TOOLS:
            raise ValueError("action.type must be one of the assistant's UI actions")
        if len(json.dumps(self.action)) > 500:
            raise ValueError("action is too large")
        return self


# -- endpoints ----------------------------------------------------------------------


@router.get("/status")
def assistant_status() -> dict[str, Any]:
    settings = _settings()
    return {"enabled": settings is not None, "model": settings[1] if settings else None}


@router.post("/chat", response_model=ChatResponse)
def assistant_chat(
    body: ChatRequest, request: Request, assistant: Assistant = Depends(get_assistant)
) -> dict[str, Any]:
    try:
        return assistant.chat(
            conversation_id=str(body.conversation_id),
            messages=[m.model_dump() for m in body.messages],
            context=body.context.model_dump(exclude_none=True),
            client_key=request.client.host if request.client else "unknown",
        )
    except RateLimited:
        raise HTTPException(
            status_code=429, detail="Too many assistant requests; wait a minute."
        ) from None
    except ModelUnavailable as exc:
        raise HTTPException(
            status_code=502, detail=f"The assistant could not reach the model ({exc})."
        ) from None


@router.get("/logs")
def assistant_logs(
    limit: int = Query(default=200, ge=1, le=1000),
    conversation_id: uuid.UUID | None = None,
    assistant: Assistant = Depends(get_assistant),
) -> dict[str, Any]:
    items = assistant.log.read(
        limit=limit, conversation_id=str(conversation_id) if conversation_id else None
    )
    return {"items": items}


@router.post("/events", status_code=204)
def assistant_event(
    body: UiOutcome, assistant: Assistant = Depends(get_assistant)
) -> Response:
    assistant.log.write(
        "ui_outcome",
        conversation_id=str(body.conversation_id),
        request_id=body.request_id,
        action=body.action,
        status=body.status,
        detail=body.detail,
    )
    return Response(status_code=204)
