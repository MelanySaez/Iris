"""All-Sky Cube quick-look spectrum schemas."""

from __future__ import annotations

from pydantic import BaseModel


class CubeSpectrumPoint(BaseModel):
    channel: int
    detector: int
    subchannel: int
    wavelength_um: float
    bandwidth_um: float
    wl_min_um: float
    wl_max_um: float
    value: float | None
    nhits: int
    flags: int
    available: bool


class CubeTile(BaseModel):
    order: int
    npix: int
    x: int
    y: int
    url: str


class CubeSpectrumResponse(BaseModel):
    ra_deg: float
    dec_deg: float
    unit: str
    source: str
    tile: CubeTile
    date_beg: str
    date_end: str
    quick_look: bool = True
    calibrated: bool = False
    notes: list[str]
    points: list[CubeSpectrumPoint]
