"""Configuration paths, timeouts, caps, and cache layouts for Planet X v3 backend."""

from __future__ import annotations

import os
from pathlib import Path

# Base directories
APP_DIR = Path(__file__).resolve().parent
SERVER_DIR = APP_DIR.parent
DATA_DIR = SERVER_DIR / "data"
CACHE_DIR = DATA_DIR / "cache"

# Cache subdirectories
DISCOVERY_CACHE_DIR = CACHE_DIR / "discovery"
CUTOUT_CACHE_DIR = CACHE_DIR / "cutouts"
DERIVED_CACHE_DIR = CACHE_DIR / "derived"
JOBS_CACHE_DIR = CACHE_DIR / "jobs"
HIPS_PROPERTIES_CACHE_PATH = CACHE_DIR / "hips-properties.json"

# Local asset
DEFAULT_FITS = DATA_DIR / "level2_2025W18_1B_0001_1D2_spx_l2b-v20-2025-240.fits"
LOCAL_FITS_PATH = Path(os.environ.get("SPHEREX_SPECTRAL_FITS", DEFAULT_FITS)).resolve()

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

# Ensure runtime cache directories exist
for directory in (
    CACHE_DIR,
    DISCOVERY_CACHE_DIR,
    CUTOUT_CACHE_DIR,
    DERIVED_CACHE_DIR,
    JOBS_CACHE_DIR,
    CUBE_CACHE_DIR,
    CUBE_SPECTRUM_CACHE_DIR,
):
    directory.mkdir(parents=True, exist_ok=True)


# Contextual assistant: any OpenAI-compatible chat model, through the OpenAI SDK.
# ASSISTANT_API_KEY and ASSISTANT_MODEL enable it (read at request time in
# app/assistant/api.py); ASSISTANT_BASE_URL points to a compatible provider.
def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


# Sent as `max_tokens` only when set; leave unset to use the provider default.
ASSISTANT_MAX_TOKENS = _env_int("ASSISTANT_MAX_TOKENS", 0) or None
ASSISTANT_MAX_TOOL_ROUNDS = _env_int("ASSISTANT_MAX_TOOL_ROUNDS", 6)
ASSISTANT_RATE_LIMIT_PER_MINUTE = _env_int("ASSISTANT_RATE_LIMIT_PER_MINUTE", 20)
ASSISTANT_CACHE_TTL_SECONDS = _env_int("ASSISTANT_CACHE_TTL_SECONDS", 3600)
ASSISTANT_CACHE_MAX_ENTRIES = _env_int("ASSISTANT_CACHE_MAX_ENTRIES", 256)
ASSISTANT_LOG_PATH = Path(
    os.environ.get("ASSISTANT_LOG_PATH", DATA_DIR / "logs" / "assistant.jsonl")
).resolve()
