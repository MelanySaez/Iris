"""All-Sky Cube quick-look spectrum endpoint."""

from __future__ import annotations

from fastapi import APIRouter, Query

from app.schemas.spectrum import CubeSpectrumResponse
from app.services.cube_spectrum import get_cube_spectrum

router = APIRouter(tags=["spectrum"])


@router.get("/api/spectrum", response_model=CubeSpectrumResponse)
def cube_spectrum(
    ra: float = Query(..., description="ICRS right ascension in degrees"),
    dec: float = Query(..., ge=-90.0, le=90.0, description="ICRS declination in degrees"),
) -> CubeSpectrumResponse:
    """Return the 102-channel quick-look spectrum sampled from the All-Sky Cube."""
    return CubeSpectrumResponse(**get_cube_spectrum(ra, dec))
