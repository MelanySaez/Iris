"""Channel catalog schemas."""

from __future__ import annotations

from pydantic import BaseModel


class ChannelSource(BaseModel):
    collection: str
    properties_url: str
    depth: int
    order: int
    blank_channels: list[int]


class ChannelItem(BaseModel):
    index: int
    band: int
    detector: str
    wavelength_um: float
    bandwidth_um: float
    available: bool


class ChannelsResponse(BaseModel):
    source: ChannelSource
    channels: list[ChannelItem]
    cached: bool
