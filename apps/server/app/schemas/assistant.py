"""Contextual assistant request and response schemas."""

from __future__ import annotations

import json
import uuid
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_MESSAGE_CHARS = 2000
# Assistant turns echoed back as history may be longer than a question: a reply
# the server produced must never make the next request fail.
MAX_HISTORY_REPLY_CHARS = 20000
MAX_MESSAGES = 21  # ten earlier exchanges plus the current question

# UI actions the assistant may queue for the browser (single source of truth).
UI_ACTION_TYPES = frozenset({"navigate", "show_region", "set_channel", "set_color_mode"})


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
        if self.action.get("type") not in UI_ACTION_TYPES:
            raise ValueError("action.type must be one of the assistant's UI actions")
        if len(json.dumps(self.action)) > 500:
            raise ValueError("action is too large")
        return self
