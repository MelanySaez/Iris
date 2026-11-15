"""Health endpoint schema."""

from __future__ import annotations

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str = "ok"
    version: str = "0.2.0"
    products: list[str] = [
        "DR1 All-Sky Cube HiPS",
        "Level-2 spectral image cutouts",
    ]
    network: str = "configured"
