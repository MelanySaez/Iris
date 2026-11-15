"""Channel catalog endpoint."""

from __future__ import annotations

from fastapi import APIRouter

from app.schemas.channels import ChannelsResponse
from app.services.channels import get_channel_catalog

router = APIRouter(tags=["channels"])


@router.get("/api/channels", response_model=ChannelsResponse)
def channels(refresh: bool = False) -> ChannelsResponse:
    """Return authoritative 102-channel catalog derived from HiPS properties."""
    return ChannelsResponse(**get_channel_catalog(force_refresh=refresh))
