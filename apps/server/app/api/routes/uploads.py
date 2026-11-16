"""Open the user's own SPHEREx FITS in Plate.

The file is the raw request body (``application/octet-stream``), so no
multipart parser is needed; the name comes from the ``filename`` query.
"""

from __future__ import annotations

from fastapi import APIRouter, Query, Request
from starlette.concurrency import run_in_threadpool

from app.schemas.jobs import JobSnapshot
from app.services.fits_upload import UploadWriter, open_upload

router = APIRouter(prefix="/api/uploads", tags=["uploads"])


@router.post("", response_model=JobSnapshot)
async def upload_fits(
    request: Request,
    filename: str = Query("upload.fits", max_length=255),
) -> JobSnapshot:
    """Store the FITS, open it as a ready plate and return its job snapshot."""
    with UploadWriter() as writer:
        async for chunk in request.stream():
            if chunk:
                writer.write(chunk)
        path, content_hash = writer.finish()
    job = await run_in_threadpool(
        open_upload, path, content_hash, filename.strip() or "upload.fits"
    )
    return JobSnapshot(**job.to_snapshot())
