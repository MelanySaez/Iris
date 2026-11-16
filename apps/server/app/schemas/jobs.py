"""Job submission, snapshot and derived-product schemas."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, model_validator

from app.schemas.regions import RegionDescriptor


class JobView(BaseModel):
    """How the Sky map showed the region when it was selected (display only).

    ``rgb`` holds the R, G and B channels of the composite and is required
    exactly when ``mode`` is ``"rgb"``. It never affects which channels the
    job processes (that is ``JobRequest.channels``).
    """

    mode: Literal["single", "rgb"]
    rgb: list[Annotated[int, Field(ge=0, le=101)]] | None = Field(
        default=None, min_length=3, max_length=3
    )

    @model_validator(mode="after")
    def _rgb_matches_mode(self) -> JobView:
        if (self.mode == "rgb") != (self.rgb is not None):
            raise ValueError(
                "rgb channels are required for mode 'rgb' and only allowed there"
            )
        return self


class JobRequest(BaseModel):
    ra_deg: float
    dec_deg: float = Field(ge=-90.0, le=90.0)
    size_arcmin: float = Field(default=6.0, ge=1.0, le=180.0)
    channels: list[int] = Field(default_factory=lambda: [44], min_length=1, max_length=8)
    products: list[Literal["image", "variance", "flags"]] = Field(
        default_factory=lambda: ["image"]
    )
    mode: Literal["latest", "history"] = "latest"
    stretch: Literal["asinh", "linear"] = "asinh"
    # Display metadata for the selection record; excluded from the job id.
    view: JobView | None = None


class FlagBitDef(BaseModel):
    bit: int
    name: str
    description: str


class CutoutMetadata(BaseModel):
    detector: int
    epoch: int
    obs_id: str
    date_iso: str
    source: Literal["remote", "s3", "mixed", "cube", "upload"]
    channel: int | None = None
    calibrated: bool = False
    wavelength_status: str = "wcs_wave_approximate"
    provenance: list[dict[str, Any]] = Field(default_factory=list)
    epoch_id: str = ""
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
    source: Literal["remote", "s3", "mixed", "cube", "upload"]
    calibrated: bool = False
    wavelength_status: str = "wcs_wave_approximate"
    provenance: list[dict[str, Any]] = Field(default_factory=list)
    epoch_id: str = ""
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
    animation_reason: str | None = None
    activity: dict[str, Any] | None = None
    # Set when the plate was opened from the user's own FITS file.
    upload: dict[str, Any] | None = None
    discovery: dict[str, Any] = Field(default_factory=dict)
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
    source: Literal["remote", "s3", "mixed", "cube", "upload"]
    channel: int | None = None
    calibrated: bool = False
    wavelength_status: str = "wcs_wave_approximate"
    provenance: list[dict[str, Any]] = Field(default_factory=list)
    epoch_id: str = ""
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
