"""Bounded anonymous NASA S3 cutouts and an explicitly incomplete local index.

Only positively verified full-product WCS records enter the index. A missing
record never proves that observations do not exist. No bucket enumeration,
credentials, proxy environment, redirects, or calibration inference is used.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import math
import os
import re
import sqlite3
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import unquote, urlsplit

import httpx
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from app.core.config import CACHE_DIR, CUTOUT_CACHE_DIR

BUCKET_URL = "https://nasa-irsa-spherex.s3.amazonaws.com/"
MAX_TRANSFER_BYTES = 128 * 1024**2
MAX_RANGE_REQUESTS = 2000
DEADLINE_SECONDS = 90
SAMPLE_KEYS = (
    "dr1/level2/2025W17_4B/l2b-v27-2026-196/1/"
    "level2_2025W17_4B_0001_1D1_spx_l2b-v27-2026-196.fits",
    "qr3/level2/2026W20_2A/l2b-v27-2026-267/1/"
    "level2_2026W20_2A_0001_1D1_spx_l2b-v27-2026-267.fits",
)
_cache_lock = threading.Lock()
logger = logging.getLogger(__name__)


def canonical_s3_url(uri: str) -> str:
    """Allow only canonical DR1/QR3 FITS keys on the fixed public NASA bucket."""
    parsed = urlsplit(uri)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("S3 URLs cannot contain credentials, query, or fragments")
    if not (
        (parsed.scheme == "s3" and parsed.netloc == "nasa-irsa-spherex")
        or (
            parsed.scheme == "https"
            and parsed.netloc == "nasa-irsa-spherex.s3.amazonaws.com"
        )
    ):
        raise ValueError("Only the public nasa-irsa-spherex bucket is allowed")
    key = unquote(parsed.path).lstrip("/")
    if not re.fullmatch(r"(?:dr1|qr3)/level2/[A-Za-z0-9_./-]+\.fits", key) or any(
        part in ("", ".", "..") for part in key.split("/")
    ):
        raise ValueError("Invalid SPHEREx Level-2 object key")
    return BUCKET_URL + key


def original_to_s3_url(uri: str) -> str | None:
    """Translate only the documented IRSA SPHEREx IBE data namespace.

    This identifies the corresponding object key, not proof of object existence;
    a failed/404 object read is reported, never treated as verified data.
    """
    try:
        parsed = urlsplit(uri)
        if parsed.scheme == "s3" or parsed.netloc == "nasa-irsa-spherex.s3.amazonaws.com":
            return canonical_s3_url(uri)
        if (
            parsed.scheme != "https"
            or parsed.netloc != "irsa.ipac.caltech.edu"
            or parsed.username
            or parsed.password
            or parsed.fragment
            or not parsed.path.startswith("/ibe/data/spherex/")
        ):
            return None
        return canonical_s3_url(
            BUCKET_URL + parsed.path.removeprefix("/ibe/data/spherex/")
        )
    except ValueError:
        return None


def is_provider_unavailable(exc: BaseException) -> bool:
    """Classify provider outages, never client/validation/not-found errors."""
    if isinstance(exc, httpx.HTTPStatusError):
        return 500 <= exc.response.status_code < 600
    return isinstance(exc, (httpx.TransportError, TimeoutError))


def _client() -> httpx.Client:
    return httpx.Client(
        timeout=httpx.Timeout(30, connect=10), trust_env=False, follow_redirects=False
    )


class RangeReader(io.RawIOBase):
    """Seekable, measured HTTP-range file, using the proven POC range checks."""

    def __init__(self, client, url, max_bytes=MAX_TRANSFER_BYTES):
        super().__init__()
        self.client, self.url = client, canonical_s3_url(url)
        self.max_bytes, self.transferred, self.requests = max_bytes, 0, 0
        self.deadline = time.monotonic() + DEADLINE_SECONDS
        response = client.head(self.url, headers={"Accept-Encoding": "identity"})
        response.raise_for_status()
        self.size = int(response.headers["content-length"])
        if self.size <= 0:
            raise ValueError("Empty S3 object")
        self.etag = response.headers.get("etag")
        self.position = 0
        self.buffer_start, self.buffer = 0, b""

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        position = offset + (
            self.position if whence == 1 else self.size if whence == 2 else 0
        )
        if whence not in (0, 1, 2) or position < 0:
            raise ValueError("Invalid file seek")
        self.position = position
        return position

    def read(self, size=-1):
        start = min(self.position, self.size)
        end = self.size if size is None or size < 0 else min(self.size, start + size)
        if end <= start:
            return b""
        if self.buffer_start <= start and end <= self.buffer_start + len(self.buffer):
            data = self.buffer[start - self.buffer_start : end - self.buffer_start]
        else:
            stop = min(self.size, max(end, start + 4096))
            if time.monotonic() > self.deadline:
                raise TimeoutError("S3 cutout deadline exceeded")
            if (
                stop - start > self.max_bytes - self.transferred
                or self.requests >= MAX_RANGE_REQUESTS
            ):
                raise ValueError("S3 transfer/request budget exceeded")
            headers = {
                "Range": f"bytes={start}-{stop - 1}",
                "Accept-Encoding": "identity",
            }
            if self.etag:
                headers["If-Match"] = self.etag
            self.requests += 1
            with self.client.stream("GET", self.url, headers=headers) as response:
                response.raise_for_status()
                if (
                    response.status_code != 206
                    or response.headers.get("content-range")
                    != f"bytes {start}-{stop - 1}/{self.size}"
                ):
                    raise ValueError("Expected HTTP 206 and exact Content-Range")
                chunks = bytearray()
                for chunk in response.iter_raw(chunk_size=4096):
                    self.transferred += len(chunk)
                    if (
                        self.transferred > self.max_bytes
                        or len(chunks) + len(chunk) > stop - start
                    ):
                        raise ValueError("S3 response exceeds range/transfer budget")
                    if time.monotonic() > self.deadline:
                        raise TimeoutError("S3 cutout deadline exceeded")
                    chunks.extend(chunk)
                if len(chunks) != stop - start:
                    raise ValueError("Truncated S3 range response")
            self.buffer_start, self.buffer = start, bytes(chunks)
            data = self.buffer[: end - start]
        self.position = end
        return data


def _validate_region(ra, dec, size):
    if not (
        all(math.isfinite(v) for v in (ra, dec, size))
        and -90 <= dec <= 90
        and 1 <= size <= 180
    ):
        raise ValueError("Need finite RA/Dec, Dec [-90,90], size [1,180] arcmin")


def _clip_polygon(points, axis, bound, sign):
    """Clip an ordered pixel polygon against one detector edge."""
    out = []
    for previous, current in zip(points[-1:] + points[:-1], points):
        old_inside = sign * (previous[axis] - bound) >= 0
        inside = sign * (current[axis] - bound) >= 0
        if old_inside != inside:
            t = (bound - previous[axis]) / (current[axis] - previous[axis])
            out.append(previous + t * (current - previous))
        if inside:
            out.append(current)
    return out


def region_slices(hdu, ra_deg, dec_deg, size_arcmin):
    """Clip a sky-aligned tangent square to a rotated/SIP detector footprint.

    Densified edges account for projection curvature. The one-pixel conservative
    margin is intentionally masked by the common output WCS during mosaicking.
    The request center does not have to fall inside the source detector.
    """
    _validate_region(ra_deg, dec_deg, size_arcmin)
    target = WCS(naxis=2)
    target.wcs.crval = [ra_deg % 360, dec_deg]
    target.wcs.crpix = [1, 1]
    target.wcs.cdelt = [-size_arcmin / 60, size_arcmin / 60]
    target.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    t = np.linspace(-0.5, 0.5, 65)
    xx = np.concatenate([t, np.full(65, 0.5), t[::-1], np.full(65, -0.5)])
    yy = np.concatenate([np.full(65, -0.5), t, np.full(65, 0.5), t[::-1]])
    sky = target.pixel_to_world(xx, yy)
    spatial = WCS(hdu.header).celestial
    x, y = spatial.world_to_pixel(sky)
    if not np.isfinite([x, y]).all():
        raise ValueError("No finite overlap with requested sky region")
    points = list(np.column_stack((x, y)))
    ny, nx = hdu.shape
    for axis, bound, sign in (
        (0, -0.5, 1),
        (0, nx - 0.5, -1),
        (1, -0.5, 1),
        (1, ny - 0.5, -1),
    ):
        points = _clip_polygon(points, axis, bound, sign)
        if not points:
            raise ValueError("No overlap with requested sky region")
    points = np.asarray(points)
    x0, y0 = np.floor(points.min(axis=0) - 1).astype(int)
    x1, y1 = np.ceil(points.max(axis=0) + 2).astype(int)
    return slice(max(0, y0), min(ny, y1)), slice(max(0, x0), min(nx, x1))


def _index_path(index_path=None):
    return Path(
        index_path
        or os.environ.get("SPHEREX_S3_INDEX_PATH")
        or CACHE_DIR / "spherex-s3.sqlite"
    )


def _record(product):
    url = canonical_s3_url(
        product.get("s3_url")
        or original_to_s3_url(
            product.get("original_product_uri")
            or product.get("source_uri")
            or product.get("uri", "")
        )
        or ""
    )
    header = product.get("spatial_header") or product["wcs_header"]
    header = header.tostring(sep="\n") if isinstance(header, fits.Header) else header
    if isinstance(header, dict):
        header = fits.Header(header).tostring(sep="\n")
    if len(header) > 1024**2:
        raise ValueError("Index header exceeds 1 MiB")
    wcs = WCS(fits.Header.fromstring(header, sep="\n")).celestial
    if not wcs.has_celestial:
        raise ValueError("Index requires celestial WCS")
    shape = list(map(int, product["shape"]))
    if len(shape) != 2 or not all(0 < n <= 8192 for n in shape):
        raise ValueError("Index requires bounded full-product image shape")
    return {**product, "s3_url": url, "spatial_header": header, "shape": shape}


def remember_products(products, index_path=None):
    """Learn only explicitly supplied verified NASA WCS footprints, no network.

    IRSA metadata without a spatial_header/shape is deliberately ignored.
    A cutout header indexes only that conservative sub-footprint, not a full image.
    This cache is never promoted to complete sky/time coverage.
    """
    records = []
    for product in products:
        try:
            record = _record(product)
            footprint_id = hashlib.sha256(
                (record["spatial_header"] + repr(record["shape"])).encode()
            ).hexdigest()[:20]
            records.append(
                (
                    record["s3_url"] + "#" + footprint_id,
                    float(record["date_mjd"]),
                    json.dumps(record),
                )
            )
        except (ValueError, KeyError, TypeError):
            continue
    if not records:
        return
    path = _index_path(index_path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path, timeout=10) as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS products "
                "(uri TEXT PRIMARY KEY, mjd REAL, report TEXT)"
            )
            db.executemany("INSERT OR REPLACE INTO products VALUES (?,?,?)", records)
    except (OSError, sqlite3.Error):
        logger.warning(
            "Optional SPHEREx S3 footprint index could not be updated", exc_info=True
        )


def _from_poc_report(uri, mjd, report):
    if "hdus" not in report:
        return _record(report)
    image = next(h for h in report["hdus"] if h["name"] == "IMAGE")
    header = fits.Header.fromstring(image["header"], sep="\n")
    return _record(
        {
            "s3_url": uri,
            "spatial_header": image["header"],
            "shape": image["shape"],
            "date_mjd": mjd,
            "date_iso": header.get("DATE-OBS", ""),
            "detector": int(header["DETECTOR"]),
            "obs_id": header.get("OBSID", ""),
            "release": report.get("release", ""),
            "version": report.get("processing", ""),
        }
    )


def _index_rows(path):
    if not path.is_file():
        return
    try:
        with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) as db:
            yield from db.execute(
                "SELECT uri,mjd,report FROM products ORDER BY mjd,uri LIMIT 10000"
            )
    except (OSError, sqlite3.Error):
        logger.warning(
            "Optional SPHEREx S3 footprint index could not be read", exc_info=True
        )


def query_index(ra_deg, dec_deg, size_arcmin, index_path=None):
    """Return positive overlaps from an incomplete local index, never absence."""
    _validate_region(ra_deg, dec_deg, size_arcmin)
    path, products = _index_path(index_path), []
    seen = set()
    for uri, mjd, text in _index_rows(path):
        try:
            product = _from_poc_report(uri, mjd, json.loads(text))
            if product["s3_url"] in seen:
                continue
            header = fits.Header.fromstring(product["spatial_header"], sep="\n")
            hdu = SimpleNamespace(header=header, shape=product["shape"])
            region_slices(hdu, ra_deg, dec_deg, size_arcmin)
        except (ValueError, KeyError, TypeError, StopIteration):
            continue
        token = f"{product['s3_url']}:{ra_deg % 360:.8f}:{dec_deg:.8f}:{size_arcmin:.6f}"
        cache_uri = "s3-cutout:" + hashlib.sha256(token.encode()).hexdigest()
        seen.add(product["s3_url"])
        products.append(
            {
                **product,
                "uri": cache_uri,
                "id": "s3:" + hashlib.sha1(token.encode()).hexdigest()[:16],
                "source": "s3",
                "date_mjd": mjd,
                "band": f"SPHEREx-D{product['detector']}",
            }
        )
        if len(products) == 400:
            break
    return {
        "products": products,
        "coverage_complete": False,
        "coverage_state": "indexed_matches" if products else "unknown_not_indexed",
    }


def inspect_product(s3_url, max_bytes=1024**2):
    """Read one explicitly selected object's headers; never enumerate a bucket."""
    url = canonical_s3_url(s3_url)
    with (
        _client() as client,
        RangeReader(client, url, max_bytes) as remote,
        fits.open(remote, memmap=False, lazy_load_hdus=True) as hdul,
    ):
        image = hdul["IMAGE"]
        record = {
            "s3_url": url,
            "spatial_header": image.header.tostring(sep="\n"),
            "shape": list(image.shape),
            "detector": int(image.header["DETECTOR"]),
            "obs_id": str(image.header.get("OBSID", "")),
            "date_mjd": float(image.header["MJD-OBS"]),
            "date_iso": str(image.header.get("DATE-OBS", "")),
            "version": str(hdul[0].header.get("VERSION", "")),
            "release": url.removeprefix(BUCKET_URL).split("/")[0],
        }
        return record


def _crop_hdul(source, view):
    """Preserve POC science layers/tables and shift spatial/alternate WCS."""
    result = fits.HDUList([source[0].copy()])
    for hdu in source[1:]:
        if hdu.name in ("IMAGE", "VARIANCE", "FLAGS", "ZODI"):
            if hdu.shape != source["IMAGE"].shape:
                raise ValueError(f"Unexpected spatial shape: {hdu.name}")
            header = hdu.header.copy()
            if "CTYPE1" in header:
                header.update(WCS(header).celestial.slice(view).to_header(relax=True))
            for key in list(header):
                match = re.fullmatch(r"CRPIX([12])[A-Z]", key)
                if match:
                    header[key] -= view[2 - int(match[1])].start
            header["POCX0"], header["POCY0"] = view[1].start, view[0].start
            result.append(
                fits.ImageHDU(np.array(hdu.section[view]), header, name=hdu.name)
            )
        else:
            result.append(hdu.copy())
        for key in ("CHECKSUM", "DATASUM"):
            result[-1].header.remove(key, ignore_missing=True, remove_all=True)
    return result


def download_s3_cutout(product, ra_deg, dec_deg, size_arcmin):
    """Download bounded clipped sections into the existing URI-keyed FITS cache."""
    url = canonical_s3_url(product["s3_url"])
    token = hashlib.sha1(product["uri"].encode()).hexdigest()
    path = CUTOUT_CACHE_DIR / f"{token}.fits"
    _validate_region(ra_deg, dec_deg, size_arcmin)
    with _cache_lock:
        if path.is_file() and path.stat().st_size > 0:
            return path
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f".fits.tmp.{os.getpid()}.{threading.get_ident()}")
        try:
            with (
                _client() as client,
                RangeReader(client, url) as remote,
                fits.open(remote, memmap=False, lazy_load_hdus=True) as source,
            ):
                view = region_slices(source["IMAGE"], ra_deg, dec_deg, size_arcmin)
                with _crop_hdul(source, view) as result:
                    result.writeto(temporary, checksum=True)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    return path
