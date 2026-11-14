"""Planet X v3 FastAPI backend."""

from __future__ import annotations

import io
import logging
import time
import uuid

import numpy as np
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from app.catalog import get_catalog
from app.channels import get_channel, get_channel_catalog, get_channel_window
from app.config import (
    LOCAL_FITS_PATH,
    MAX_REGION_SIZE_ARCMIN,
    MIN_REGION_SIZE_ARCMIN,
    WAVELENGTH_STATUS,
)
from app.cube_spectrum import get_cube_spectrum
from app.discovery import resolve_region
from app.jobs import (
    get_job_manifest,
    get_pixel_probe,
    job_manager,
    resolve_cutout,
)
from app.models import (
    CatalogResponse,
    ChannelsResponse,
    CubeSpectrumResponse,
    HealthResponse,
    JobRequest,
    JobSnapshot,
    ManifestResponse,
    PixelResponse,
    ResolveRequest,
    ResolveResponse,
)
from app.render import compute_cutout_percentiles, render_frame_product
from app.selections.api import configure_selections
from app.selections.api import router as selections_router
from app.selections.db import get_database_url
from app.tracing import request_id_var

app = FastAPI(title="Planet X v3 Spectral Service", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

configure_selections(get_database_url(), job_manager)
app.include_router(selections_router)


@app.middleware("http")
async def trace_request(request: Request, call_next):
    request_id = uuid.uuid4().hex[:12]
    token = request_id_var.set(request_id)
    started = time.monotonic()
    try:
        response = await call_next(request)
    finally:
        request_id_var.reset(token)
    response.headers["X-Request-ID"] = request_id
    logging.getLogger("uvicorn.error").info(
        "request=%s method=%s path=%s status=%s elapsed_ms=%.1f",
        request_id,
        request.method,
        request.url.path,
        response.status_code,
        (time.monotonic() - started) * 1000,
    )
    return response


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Return backend health and capability metadata."""
    return HealthResponse(
        status="ok",
        version="0.2.0",
        products=["DR1 All-Sky Cube HiPS", "Level-2 spectral image cutouts"],
        local_assets=LOCAL_FITS_PATH.is_file(),
        network="configured",
    )


@app.get("/api/channels", response_model=ChannelsResponse)
def channels(refresh: bool = False) -> ChannelsResponse:
    """Return authoritative 102-channel catalog derived from HiPS properties."""
    catalog_data = get_channel_catalog(force_refresh=refresh)
    return ChannelsResponse(**catalog_data)


@app.get("/api/catalog", response_model=CatalogResponse)
def catalog() -> CatalogResponse:
    """Return curated objects list with precomputed cache indicators."""
    return CatalogResponse(**get_catalog())


@app.get("/api/spectrum", response_model=CubeSpectrumResponse)
def cube_spectrum(
    ra: float = Query(..., description="ICRS right ascension in degrees"),
    dec: float = Query(..., ge=-90.0, le=90.0, description="ICRS declination in degrees"),
) -> CubeSpectrumResponse:
    """Return the 102-channel quick-look spectrum sampled from the All-Sky Cube."""
    return CubeSpectrumResponse(**get_cube_spectrum(ra, dec))


@app.post("/api/regions/resolve", response_model=ResolveResponse)
def resolve(req: ResolveRequest) -> ResolveResponse:
    """Discover available spectral image products across local asset and IRSA TAP."""
    if req.size_arcmin > MAX_REGION_SIZE_ARCMIN:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Region size {req.size_arcmin} arcmin exceeds limit of "
                f"{MAX_REGION_SIZE_ARCMIN} arcmin; multi-product mosaicking is pending."
            ),
        )
    if req.size_arcmin < MIN_REGION_SIZE_ARCMIN:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Region size {req.size_arcmin} arcmin must be at least "
                f"{MIN_REGION_SIZE_ARCMIN} arcmin."
            ),
        )
    result = resolve_region(req.ra_deg, req.dec_deg, req.size_arcmin)
    return ResolveResponse(**result)


@app.post("/api/jobs", status_code=202, response_model=JobSnapshot)
def create_job(req: JobRequest) -> JobSnapshot:
    """Submit a spectral plate preparation job or return deduplicated existing job."""
    job = job_manager.submit(req)
    return JobSnapshot(**job.to_snapshot())


@app.get("/api/jobs/{job_id}", response_model=JobSnapshot)
def get_job_status(job_id: str) -> JobSnapshot:
    """Poll job snapshot by ID."""
    job = job_manager.get_job(job_id)
    return JobSnapshot(**job.to_snapshot())


@app.get("/api/jobs/{job_id}/frames/{channel}/{product}.png")
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
    job = job_manager.get_job(job_id)
    if job.status != "ready":
        raise HTTPException(
            status_code=409,
            detail=job.error or f"Job {job_id} is in status '{job.status}'",
        )

    valid_products = ("image", "variance", "flags")
    if product not in valid_products:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown product '{product}'. Must be one of {valid_products}.",
        )

    if product not in job.request.products:
        raise HTTPException(
            status_code=404,
            detail=f"Product '{product}' was not requested in job {job_id}.",
        )

    if mode not in ("full", "slice"):
        raise HTTPException(
            status_code=422,
            detail=f"mode must be 'full' or 'slice', got '{mode}'.",
        )
    if stretch is not None and stretch not in ("asinh", "linear"):
        raise HTTPException(
            status_code=422,
            detail=f"stretch must be 'asinh' or 'linear', got '{stretch}'.",
        )

    ch_info = get_channel(channel)
    det = (channel // 17) + 1
    cutout = resolve_cutout(job, det, epoch)
    if cutout is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"No cutout available for channel {channel} "
                f"(detector {det}) epoch {epoch}; the derived cache entry may "
                "have been evicted. Re-run the job to rebuild it."
            ),
        )

    active_stretch = stretch or job.request.stretch
    target_prod = product if product in ("image", "variance") else "image"
    percentiles = job.percentiles.get((det, epoch, target_prod))
    if percentiles is None:
        arr = getattr(cutout, target_prod)
        percentiles = compute_cutout_percentiles(arr, is_variance=(product == "variance"))
        job.percentiles[(det, epoch, target_prod)] = percentiles

    win_min, win_max = get_channel_window(channel)
    half_window = (win_max - win_min) / 2.0

    arrays = {
        "image": cutout.image,
        "variance": cutout.variance,
        "flags": cutout.flags,
        "wavelength": cutout.wavelength,
        "bandwidth": cutout.bandwidth,
    }

    png_bytes = render_frame_product(
        product=product,
        arrays=arrays,
        channel_wavelength=ch_info["wavelength_um"],
        half_window=half_window,
        percentiles=percentiles,
        mode=mode,
        stretch=active_stretch,
        bit=bit,
    )

    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={"Cache-Control": "private, max-age=3600"},
    )


@app.get("/api/jobs/{job_id}/frames/{channel}/{product}.npy")
def get_frame_npy(
    job_id: str,
    channel: int,
    product: str,
    epoch: int = Query(0),
) -> Response:
    """Return raw NumPy array (.npy) for image, variance, flags, or wavelengths."""
    job = job_manager.get_job(job_id)
    if job.status != "ready":
        raise HTTPException(
            status_code=409,
            detail=job.error or f"Job {job_id} is in status '{job.status}'",
        )

    valid_products = ("image", "variance", "flags", "wavelengths", "bandwidths")
    if product not in valid_products:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown product '{product}'. Must be one of {valid_products}.",
        )

    if product in ("image", "variance", "flags") and product not in job.request.products:
        raise HTTPException(
            status_code=404,
            detail=f"Product '{product}' was not requested in job {job_id}.",
        )

    det = (channel // 17) + 1
    cutout = resolve_cutout(job, det, epoch)
    if cutout is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"No cutout loaded for channel {channel} "
                f"(detector {det}) epoch {epoch}; the derived cache entry may "
                "have been evicted. Re-run the job to rebuild it."
            ),
        )

    if product == "image":
        arr = cutout.image
    elif product == "variance":
        arr = cutout.variance
    elif product == "flags":
        arr = cutout.flags
    elif product == "wavelengths":
        arr = cutout.wavelength
    elif product == "bandwidths":
        arr = cutout.bandwidth
    else:
        raise HTTPException(status_code=404, detail="Invalid product")

    bio = io.BytesIO()
    np.save(bio, arr, allow_pickle=False)
    headers = {"Cache-Control": "private, max-age=3600"}
    if product in ("wavelengths", "bandwidths"):
        headers["X-Wavelength-Status"] = WAVELENGTH_STATUS

    return Response(
        content=bio.getvalue(),
        media_type="application/octet-stream",
        headers=headers,
    )


@app.get("/api/jobs/{job_id}/pixel", response_model=PixelResponse)
def get_pixel(
    job_id: str,
    x: int = Query(...),
    y: int = Query(...),
    channel: int = Query(...),
    epoch: int = Query(0),
) -> PixelResponse:
    """Probe single pixel values and active flag bits."""
    result = get_pixel_probe(job_id, x=x, y=y, channel=channel, epoch=epoch)
    return PixelResponse(**result)


@app.get("/api/jobs/{job_id}/manifest", response_model=ManifestResponse)
def get_manifest(job_id: str) -> ManifestResponse:
    """Return complete scientific provenance document for this job."""
    result = get_job_manifest(job_id)
    return ManifestResponse(**result)
