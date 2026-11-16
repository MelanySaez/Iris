"""Cookie consent schemas."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.selections import normalize_selection_name

ConsentLevel = Literal["necessary", "all", "none"]


class ConsentRequest(BaseModel):
    """The choice made in the cookie bar."""

    level: ConsentLevel


class ConsentResponse(BaseModel):
    level: ConsentLevel
    # True when the browser now holds an owner cookie, so selections are saved.
    records_enabled: bool


class ClaimRequest(BaseModel):
    """Jobs the browser submitted before accepting cookies."""

    job_ids: list[str] = Field(max_length=100)
    names: dict[str, str | None] = Field(default_factory=dict, max_length=100)

    @field_validator("names")
    @classmethod
    def _normalize_names(cls, value: dict[str, str | None]) -> dict[str, str | None]:
        return {job_id: normalize_selection_name(name) for job_id, name in value.items()}


class ClaimResponse(BaseModel):
    claimed: int
