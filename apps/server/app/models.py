"""Pydantic request and response schemas for Planet X v3 backend."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str = "ok"
    version: str = "0.2.0"
    products: list[str] = [
        "DR1 All-Sky Cube HiPS",
        "Level-2 spectral image cutouts",
    ]
    local_assets: bool = True
    network: str = "configured"


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


class CatalogObject(BaseModel):
    id: str
    name: str
    ra_deg: float
    dec_deg: float
    type: str
    default_size_arcmin: float
    description: str
    precomputed: bool


class CatalogResponse(BaseModel):
    objects: list[CatalogObject]


class ResolveRequest(BaseModel):
    ra_deg: float
    dec_deg: float = Field(ge=-90.0, le=90.0)
    size_arcmin: float = Field(default=6.0, ge=1.0, le=60.0)


class RegionDescriptor(BaseModel):
    ra_deg: float
    dec_deg: float
    size_arcmin: float
    fov_deg: float


class ProductDescriptor(BaseModel):
    id: str
    source: Literal["local", "remote"]
    detector: int
    band: str
    obs_id: str
    uri: str
    date_mjd: float
    date_iso: str


class EpochDescriptor(BaseModel):
    date_mjd: float
    date_iso: str
    product_id: str


class DetectorSummary(BaseModel):
    detector: int
    band: str
    count: int
    epochs: list[EpochDescriptor]


class ResolveResponse(BaseModel):
    region: RegionDescriptor
    coverage: Literal["available", "none", "unknown"]
    cached: bool
    query_ms: int
    warning: str | None = None
    products: list[ProductDescriptor]
    detectors: list[DetectorSummary]
    notes: list[str]


class JobRequest(BaseModel):
    ra_deg: float
    dec_deg: float = Field(ge=-90.0, le=90.0)
    size_arcmin: float = Field(default=6.0, ge=1.0, le=60.0)
    channels: list[int] = Field(default_factory=lambda: [44], min_length=1, max_length=8)
    products: list[Literal["image", "variance", "flags"]] = Field(
        default_factory=lambda: ["image"]
    )
    mode: Literal["latest", "history"] = "latest"
    stretch: Literal["asinh", "linear"] = "asinh"


class FlagBitDef(BaseModel):
    bit: int
    name: str
    description: str


class CutoutMetadata(BaseModel):
    detector: int
    epoch: int
    obs_id: str
    date_iso: str
    source: Literal["local", "remote"]
    uri: str = ""
    version: str = ""
    shape: list[int]
    pixel_scale_arcsec: float
    wavelength_min_um: float
    wavelength_max_um: float
    bandwidth_median_um: float
    image_unit: str = "MJy / sr"
    variance_unit: str = "MJy2 / sr2"
    flags_defined: bool = True
    flag_bits: list[FlagBitDef]


class FrameDescriptor(BaseModel):
    channel: int
    product: Literal["image", "variance", "flags"]
    detector: int
    epoch: int
    obs_id: str
    date_iso: str
    source: Literal["local", "remote"]
    width: int
    height: int
    url: str
    slice_url: str
    wavelengths_url: str
    window_um: list[float]


class JobSnapshot(BaseModel):
    id: str
    status: Literal[
        "queued",
        "discovering",
        "downloading",
        "extracting",
        "rendering",
        "ready",
        "failed",
    ]
    progress: int
    stage: str
    events: list[dict[str, Any]] = Field(default_factory=list)
    error: str | None = None
    failed_stage: str | None = None
    error_kind: str | None = None
    error_trace: str | None = None
    request_id: str | None = None
    request: dict[str, Any]
    region: RegionDescriptor
    channels: list[dict[str, Any]]
    products: list[str]
    frames: list[FrameDescriptor] = Field(default_factory=list)
    cutouts: list[CutoutMetadata] = Field(default_factory=list)
    cache: dict[str, bool] = Field(default_factory=lambda: {"hit": False})
    wavelength_status: str = "wcs_wave_approximate"
    calibrated: bool = False
    multi_product_mosaic: str = "pending"


class PixelResponse(BaseModel):
    x: int
    y: int
    channel: int
    epoch: int
    wavelength_um: float | None = None
    bandwidth_um: float | None = None
    window_um: list[float]
    in_channel: bool
    image: float | None = None
    variance: float | None = None
    flags: int | None = None
    flag_bits: list[FlagBitDef]
    wavelength_status: str = "wcs_wave_approximate"
    calibrated: bool = False


class ManifestCutout(BaseModel):
    detector: int
    epoch: int
    obs_id: str
    source: str
    uri: str
    version: str = ""
    date_obs: str
    date_mjd: float
    units: dict[str, str]
    flag_bits: list[FlagBitDef]
    pixel_scale_arcsec: float
    shape: list[int]


class ManifestResponse(BaseModel):
    job_id: str
    request: dict[str, Any]
    region: RegionDescriptor
    products: list[str] = Field(default_factory=list)
    release: str = "SPHEREx DR1 level-2"
    dates: list[str] = Field(default_factory=list)
    units: dict[str, str] = Field(default_factory=dict)
    lvf_status: str = "wcs_wave_approximate"
    wavelength_status: str = "wcs_wave_approximate"
    calibrated: bool = False
    flag_definitions: list[FlagBitDef] = Field(default_factory=list)
    cache: dict[str, bool] = Field(default_factory=lambda: {"hit": False})
    multi_product_mosaic: str = "pending"
    collection: str = "SPHEREx DR1 Level-2 spectral image cutouts"
    cutouts: list[ManifestCutout]
    notes: list[str]


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
