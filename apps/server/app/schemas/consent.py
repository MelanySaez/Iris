"""Cookie consent schemas."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

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


class ClaimResponse(BaseModel):
    claimed: int
