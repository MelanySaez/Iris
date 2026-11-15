"""Object-name resolution schemas."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class ResolvedAlternative(BaseModel):
    """The same name as answered by another catalogue."""

    name: str
    ra_deg: float
    dec_deg: float
    object_type: str | None = None
    size_arcmin: float | None = None
    source: Literal["simbad", "ned"]


class ResolveNameResponse(BaseModel):
    query: str
    name: str
    ra_deg: float
    dec_deg: float
    object_type: str | None = None
    size_arcmin: float | None = None  # major axis; None for point sources
    source: Literal["simbad", "ned", "designation"]
    # Other catalogues that also know the name (SIMBAD's answer is the main one).
    alternatives: list[ResolvedAlternative] = []
    cached: bool = False
