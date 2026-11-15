"""Configuration paths, timeouts, caps, and cache layouts for Planet X v3 backend."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Any

from pydantic import BeforeValidator, Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# Application metadata
APP_NAME = "Planet X v3 Spectral Service"
APP_VERSION = "0.2.0"
CORS_ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]

# Base directories
APP_DIR = Path(__file__).resolve().parent
SERVER_DIR = APP_DIR.parent
DATA_DIR = SERVER_DIR / "data"
CACHE_DIR = DATA_DIR / "cache"


def split_list(value: Any) -> list[str]:
    """Parse a JSON or comma-separated environment value into a string list."""
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        value = value.strip()
        if value.startswith("["):
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return parsed
            raise ValueError("Expected a JSON list")
        return [item.strip() for item in value.split(",") if item.strip()]
    raise ValueError("Expected a string or list")


CommaSeparated = Annotated[list[str], NoDecode, BeforeValidator(split_list)]


class Settings(BaseSettings):
    """Typed application settings loaded from process environment and `.env`."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_ignore_empty=True,
        extra="ignore",
    )

    DATABASE_URL: str | None = None
    CORS_ORIGINS: CommaSeparated = Field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"]
    )
    SIMBAD_SCRIPT_URL: str = "https://simbad.cfa.harvard.edu/simbad/sim-script"
    NED_LOOKUP_URL: str = "https://ned.ipac.caltech.edu/srs/ObjectLookup"

    ASSISTANT_API_KEY: str | None = None
    ASSISTANT_MODEL: str | None = None
    ASSISTANT_BASE_URL: str | None = None
    ASSISTANT_MAX_TOKENS: int | None = None
    ASSISTANT_MAX_TOOL_ROUNDS: int = 6
    ASSISTANT_RATE_LIMIT_PER_MINUTE: int = 20
    ASSISTANT_CACHE_TTL_SECONDS: int = 3600
    ASSISTANT_CACHE_MAX_ENTRIES: int = 256
    ASSISTANT_LOG_PATH: Path = DATA_DIR / "logs" / "assistant.jsonl"

    @field_validator("ASSISTANT_MAX_TOKENS", mode="before")
    @classmethod
    def zero_max_tokens_uses_provider_default(cls, value: Any) -> Any:
        """Preserve the existing convention that zero means no explicit limit."""
        return None if value == 0 or value == "0" else value

    @field_validator("ASSISTANT_LOG_PATH")
    @classmethod
    def resolve_assistant_log_path(cls, value: Path) -> Path:
        return value.expanduser().resolve()


settings = Settings()
CORS_ALLOWED_ORIGINS = settings.CORS_ORIGINS

# Cache subdirectories
DISCOVERY_CACHE_DIR = CACHE_DIR / "discovery"
CUTOUT_CACHE_DIR = CACHE_DIR / "cutouts"
DERIVED_CACHE_DIR = CACHE_DIR / "derived"
JOBS_CACHE_DIR = CACHE_DIR / "jobs"
HIPS_PROPERTIES_CACHE_PATH = CACHE_DIR / "hips-properties.json"

# Upstream IRSA URLs
HIPS_PROPERTIES_URL = (
    "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube/properties"
)
TAP_SYNC_URL = "https://irsa.ipac.caltech.edu/TAP/sync"
CUBE_BASE_URL = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube"
CUBE_ORDER = 5  # order of the published fits-cube tiles (custom_tile_format_order)
CUBE_FETCH_TIMEOUT = 30.0
CUBE_CACHE_DIR = CACHE_DIR / "cube"
CUBE_SPECTRUM_CACHE_DIR = CUBE_CACHE_DIR / "spectra"

# Object-name resolution (SIMBAD mirror, then NED). The CDS primary SIMBAD has
# been unavailable; SIMBAD_SCRIPT_URL can point back to it once it recovers.
SIMBAD_SCRIPT_URL = settings.SIMBAD_SCRIPT_URL
NED_LOOKUP_URL = settings.NED_LOOKUP_URL
NAME_RESOLVER_TIMEOUT = 5.0  # per provider; keeps a hung mirror from pinning workers
NAME_CACHE_DIR = CACHE_DIR / "names"
NAME_CACHE_TTL_SECONDS = 30 * 86400  # positions of named objects rarely change
NAME_NOT_FOUND_TTL_SECONDS = 86400  # retry unknown names daily
CUBE_CACHE_TTL_SECONDS = 7 * 86400  # re-check tiles weekly, like the HiPS properties
# Cap on any single range response: a server that ignores or coalesces the
# pixel ranges must never make us stream the ~320 MB tile.
MAX_RANGE_RESPONSE_BYTES = 1024 * 1024

# Caps and constraints
MIN_REGION_SIZE_ARCMIN = 1.0
MAX_REGION_SIZE_ARCMIN = 60.0
MAX_CHANNELS_PER_JOB = 8
MAX_CUTOUT_DOWNLOADS_PER_JOB = 12
MAX_DOWNLOAD_WORKERS = 4
JOB_WORKERS = 4
JOB_SNAPSHOT_LRU_SIZE = 32

# Timeouts & retries
HIPS_FETCH_TIMEOUT = 10.0
TAP_QUERY_TIMEOUT = 30.0
TAP_QUERY_RETRIES = 1
CUTOUT_CONNECT_TIMEOUT = 10.0
CUTOUT_READ_TIMEOUT = 90.0
CUTOUT_DOWNLOAD_RETRIES = 2

# Cache TTLs
HIPS_PROPERTIES_TTL_SECONDS = 7 * 86400  # 7 days
DISCOVERY_TTL_SECONDS = 6 * 3600  # 6 hours

# Scientific and provenance status tags
WAVELENGTH_STATUS = "wcs_wave_approximate"
CALIBRATED = False
MULTI_PRODUCT_MOSAIC = "pending"

RUNTIME_DIRECTORIES = (
    CACHE_DIR,
    DISCOVERY_CACHE_DIR,
    CUTOUT_CACHE_DIR,
    DERIVED_CACHE_DIR,
    JOBS_CACHE_DIR,
    CUBE_CACHE_DIR,
    CUBE_SPECTRUM_CACHE_DIR,
    NAME_CACHE_DIR,
)


def ensure_runtime_directories() -> None:
    """Create every runtime cache directory (idempotent)."""
    for directory in RUNTIME_DIRECTORIES:
        directory.mkdir(parents=True, exist_ok=True)


# Contextual assistant: any OpenAI-compatible chat model, through the OpenAI SDK.
# Credentials are read by the API dependency at request time; stable tuning
# defaults are exported here for the service layer.
ASSISTANT_MAX_TOKENS = settings.ASSISTANT_MAX_TOKENS
ASSISTANT_MAX_TOOL_ROUNDS = settings.ASSISTANT_MAX_TOOL_ROUNDS
ASSISTANT_RATE_LIMIT_PER_MINUTE = settings.ASSISTANT_RATE_LIMIT_PER_MINUTE
ASSISTANT_CACHE_TTL_SECONDS = settings.ASSISTANT_CACHE_TTL_SECONDS
ASSISTANT_CACHE_MAX_ENTRIES = settings.ASSISTANT_CACHE_MAX_ENTRIES
ASSISTANT_LOG_PATH = settings.ASSISTANT_LOG_PATH
