"""Job submission, polling and derived-product endpoints."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, Response

from app.api.routes.consent import resolve_owner
from app.schemas.jobs import JobRequest, JobSnapshot, ManifestResponse, PixelResponse
from app.services.job_queries import (
    get_frame_npy,
    get_job_manifest,
    get_pixel_probe,
    render_animation_gif,
    render_frame_png,
)
from app.services.jobs import job_manager

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


@router.post("", status_code=202, response_model=JobSnapshot)
def create_job(
    req: JobRequest, owner: uuid.UUID | None = Depends(resolve_owner)
) -> JobSnapshot:
    """Submit a spectral plate preparation job or return deduplicated existing job.

    The selection is saved only for a browser that accepted cookies.
    """
    job = job_manager.submit(req, owner=owner)
    return JobSnapshot(**job.to_snapshot())


@router.get("/{job_id}", response_model=JobSnapshot)
def get_job_status(job_id: str) -> JobSnapshot:
    """Poll job snapshot by ID."""
    job = job_manager.get_job(job_id)
    return JobSnapshot(**job.to_snapshot())


@router.get("/{job_id}/frames/{channel}/{product}.png")
def get_frame_png(
    job_id: str,
    channel: int,
    product: str,
    mode: str = Query("full"),
    epoch: int = Query(0),
    stretch: str | None = Query(None),
    bit: int | None = Query(None),
) -> Response:
    """Render frame PNG for a requested channel and product."""
    png_bytes = render_frame_png(
        job_id,
        channel,
        product,
        mode=mode,
        epoch=epoch,
        stretch=stretch,
        bit=bit,
    )
    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={"Cache-Control": "private, max-age=3600"},
    )


@router.get("/{job_id}/frames/{channel}/{product}.npy")
def get_frame_npy_route(
    job_id: str,
    channel: int,
    product: str,
    epoch: int = Query(0),
) -> Response:
    """Return raw NumPy array (.npy) for image, variance, flags, or wavelengths."""
    body = get_frame_npy(job_id, channel, product, epoch=epoch)
    headers = {"Cache-Control": "private, max-age=3600"}
    if product in ("wavelengths", "bandwidths"):
        headers["X-Wavelength-Status"] = job_manager.get_job(job_id).to_snapshot()[
            "wavelength_status"
        ]
    return Response(
        content=body,
        media_type="application/octet-stream",
        headers=headers,
    )


@router.get("/{job_id}/pixel", response_model=PixelResponse)
def get_pixel(
    job_id: str,
    x: int = Query(...),
    y: int = Query(...),
    channel: int = Query(...),
    epoch: int = Query(0),
) -> PixelResponse:
    """Probe single pixel values and active flag bits."""
    return PixelResponse(
        **get_pixel_probe(job_id, x=x, y=y, channel=channel, epoch=epoch)
    )


@router.get("/{job_id}/manifest", response_model=ManifestResponse)
def get_manifest(job_id: str) -> ManifestResponse:
    """Return complete scientific provenance document for this job."""
    return ManifestResponse(**get_job_manifest(job_id))


@router.get("/{job_id}/animation.gif")
def get_animation_gif(
    job_id: str, channel_id: int = Query(..., ge=0, le=101)
) -> Response:
    """Download 2–12 verified same-channel epoch mosaics as a display-only GIF."""
    return Response(
        content=render_animation_gif(job_id, channel_id),
        media_type="image/gif",
        headers={
            "Cache-Control": "private, max-age=3600",
            "Content-Disposition": (
                f'attachment; filename="{job_id}-channel-{channel_id}.gif"'
            ),
        },
    )
