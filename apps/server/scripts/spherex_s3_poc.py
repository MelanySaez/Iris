#!/usr/bin/env python3
"""Isolated anonymous SPHEREx S3 experiments; never imported by the application."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sqlite3
import sys
import time
from pathlib import Path

import fsspec
import httpx
import numpy as np
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.nddata import overlap_slices
from astropy.wcs import WCS, NoConvergence
from astropy.wcs.utils import proj_plane_pixel_scales
from fsspec.spec import AbstractBufferedFile, AbstractFileSystem

BUCKET = "https://nasa-irsa-spherex.s3.amazonaws.com/"
SAMPLES = {
    "dr1": "dr1/level2/2025W17_4B/l2b-v27-2026-196/1/"
    "level2_2025W17_4B_0001_1D1_spx_l2b-v27-2026-196.fits",
    "qr3": "qr3/level2/2026W20_2A/l2b-v27-2026-267/1/"
    "level2_2026W20_2A_0001_1D1_spx_l2b-v27-2026-267.fits",
}


class RangeFile(AbstractBufferedFile):
    """Measured fsspec reads: body-byte/request budgets; reject ignored ranges.

    Uses existing httpx instead of optional aiohttp/s3fs. Counts response body
    bytes, not TLS/HTTP overhead. Each open has a cold 4 KiB read-ahead cache.
    """

    def __init__(self, client, url, max_bytes=16 * 1024**2, max_requests=500):
        self.client, self.url = client, url
        self.transferred, self.requests = 0, 0
        self.max_bytes, self.max_requests = max_bytes, max_requests
        self.deadline = time.monotonic() + 120
        response = client.head(url)
        response.raise_for_status()
        self.etag = response.headers.get("etag")
        super().__init__(
            fs=None,
            path=url,
            size=int(response.headers["content-length"]),
            block_size=4096,
            cache_type="readahead",
        )

    def _fetch_range(self, start, end):
        if time.monotonic() > self.deadline:
            raise TimeoutError("120 second experiment deadline exceeded")
        if (
            end - start > self.max_bytes - self.transferred
            or self.requests >= self.max_requests
        ):
            raise ValueError("Transfer/request budget exceeded")
        headers = {"Range": f"bytes={start}-{end - 1}", "Accept-Encoding": "identity"}
        if self.etag:
            headers["If-Match"] = self.etag
        self.requests += 1
        with self.client.stream("GET", self.url, headers=headers) as response:
            response.raise_for_status()
            expected = f"bytes {start}-{end - 1}/{self.size}"
            if (
                response.status_code != 206
                or response.headers.get("content-range") != expected
            ):
                raise ValueError(
                    "Expected HTTP 206 and exact Content-Range; refusing body"
                )
            data = bytearray()
            for chunk in response.iter_raw(chunk_size=4096):
                self.transferred += len(chunk)
                if (
                    self.transferred > self.max_bytes
                    or len(data) + len(chunk) > end - start
                ):
                    raise ValueError(
                        "Response exceeds transfer budget or requested range"
                    )
                data.extend(chunk)
            if len(data) != end - start:
                raise ValueError("Truncated range response")
            return bytes(data)

    def stats(self):
        return dict(
            object_bytes=self.size,
            body_bytes=self.transferred,
            range_gets=self.requests,
            head_requests=1,
            fraction=self.transferred / self.size,
        )


class PublicSpherexFS(AbstractFileSystem):
    """Experiment-only fsspec protocol, fixed public S3 host, no credentials."""

    protocol = "spxpoc"
    cachable = False

    def __init__(self, client, max_bytes, **kwargs):
        super().__init__(**kwargs)
        self.client, self.max_bytes = client, max_bytes
        self.opened = []

    def _open(self, path, mode="rb", **kwargs):
        key = self._strip_protocol(path)
        if mode != "rb" or key not in SAMPLES.values():
            raise ValueError("Only the two verified anonymous sample objects are allowed")
        remote = RangeFile(self.client, BUCKET + key, self.max_bytes)
        self.opened.append(remote)
        return remote


fsspec.register_implementation("spxpoc", PublicSpherexFS, clobber=True)


def validate_region(ra_deg, dec_deg, size_arcmin):
    if (
        not all(math.isfinite(v) for v in (ra_deg, dec_deg, size_arcmin))
        or not -90 <= dec_deg <= 90
        or not 0 < size_arcmin <= 60
    ):
        raise ValueError("Need finite RA/Dec, Dec in [-90,90], size in (0,60] arcmin")


def region_slices(hdu, ra_deg, dec_deg, size_arcmin):
    """Detector-aligned square angular size, rounded up and clipped at edges."""
    validate_region(ra_deg, dec_deg, size_arcmin)
    spatial = WCS(hdu.header).celestial
    x, y = spatial.world_to_pixel(SkyCoord(ra_deg * u.deg, dec_deg * u.deg))
    ny, nx = hdu.shape
    if not (np.isfinite([x, y]).all() and -0.5 <= x < nx - 0.5 and -0.5 <= y < ny - 0.5):
        raise ValueError("Coordinate lies outside image footprint")
    scales = proj_plane_pixel_scales(spatial)  # degrees/pixel, x then y
    shape = tuple(int(np.ceil(size_arcmin / 60 / s)) for s in scales[::-1])
    return overlap_slices(hdu.shape, shape, (float(y), float(x)), mode="partial")[0]


def cutout_hdul(source, view):
    """Keep science layers and complete tables; shift all alternate pixel WCS."""
    result = fits.HDUList([source[0].copy()])
    for hdu in source[1:]:
        if hdu.name in ("IMAGE", "FLAGS", "VARIANCE", "ZODI"):
            if hdu.shape != source["IMAGE"].shape:
                raise ValueError(f"Unexpected spatial shape: {hdu.name}")
            header = hdu.header.copy()
            if "CTYPE1" in header:
                header.update(WCS(header).celestial.slice(view).to_header(relax=True))
            # -TAB keeps its original lookup grid; shifted CRPIXW maps new pixels
            # to that grid. Also retain original detector coordinates for ePSF.
            for key in list(header):
                match = re.fullmatch(r"CRPIX([12])[A-Z]", key)
                if match:
                    header[key] -= view[2 - int(match[1])].start
            header["POCX0"], header["POCY0"] = view[1].start, view[0].start
            result.append(
                fits.ImageHDU(np.array(hdu.section[view]), header, name=hdu.name)
            )
        else:
            result.append(hdu.copy())  # EPSF and WCS-WAVE tables stay complete
        for key in ("CHECKSUM", "DATASUM"):
            result[-1].header.remove(key, ignore_missing=True, remove_all=True)
    return result


def describe(hdul, key):
    selected = (
        "OBS_ID",
        "OBSID",
        "DATE-OBS",
        "DATE-BEG",
        "DATE-END",
        "MJD-OBS",
        "MJD-BEG",
        "MJD-END",
        "DETECTOR",
        "BAND",
        "VERSION",
        "SPXVER",
    )
    header = hdul["IMAGE"].header
    center = WCS(header).celestial.pixel_to_world(
        (hdul["IMAGE"].shape[1] - 1) / 2, (hdul["IMAGE"].shape[0] - 1) / 2
    )
    return dict(
        uri="s3://nasa-irsa-spherex/" + key,
        release=key.split("/")[0],
        processing=key.split("/")[3],
        center=[center.ra.deg, center.dec.deg],
        hdus=[
            dict(
                name=h.name,
                kind=type(h).__name__,
                shape=list(h.shape) if h.is_image else None,
                metadata={k: h.header[k] for k in selected if k in h.header},
                header=h.header.tostring(sep="\n"),
            )
            for h in hdul
        ],
    )


def verify_cutout(source, result, view):
    yy, xx = np.mgrid[
        0 : result["IMAGE"].shape[0] : 3j, 0 : result["IMAGE"].shape[1] : 3j
    ]
    xx = np.clip(xx, 0, result["IMAGE"].shape[1] - 1)
    yy = np.clip(yy, 0, result["IMAGE"].shape[0] - 1)
    before = WCS(source["IMAGE"].header).celestial.pixel_to_world(
        xx + view[1].start, yy + view[0].start
    )
    after = WCS(result["IMAGE"].header).celestial.pixel_to_world(xx, yy)
    error = float(np.max(before.separation(after).arcsec))
    if error > 1e-5:
        raise ValueError(f"Spatial WCS mismatch: {error} arcsec")
    old_wave = WCS(source["IMAGE"].header, fobj=source, key="W")
    new_wave = WCS(result["IMAGE"].header, fobj=result, key="W")
    old_wave.sip = new_wave.sip = None  # matches the existing extractor
    for a, b in zip(
        old_wave.pixel_to_world_values(xx + view[1].start, yy + view[0].start),
        new_wave.pixel_to_world_values(xx, yy),
    ):
        np.testing.assert_allclose(a, b, rtol=1e-10, atol=1e-12)
    return dict(spatial_error_arcsec=error, spectral_wcs_matches=True)


def build_index(reports, index_path):
    """Create a disposable sample database from <=8 inspected header reports."""
    if not 1 <= len(reports) <= 8 or Path(index_path).exists():
        raise ValueError("Need 1-8 reports and a new database path")
    records = []
    for path in reports:
        if Path(path).stat().st_size > 1024**2:
            raise ValueError("Header report exceeds 1 MiB")
        report = json.loads(Path(path).read_text())
        image = next(h for h in report["hdus"] if h["name"] == "IMAGE")
        header = fits.Header.fromstring(image["header"], sep="\n")
        records.append((report["uri"], float(header["MJD-OBS"]), json.dumps(report)))
    with sqlite3.connect(index_path) as db:
        db.execute("CREATE TABLE products (uri TEXT PRIMARY KEY, mjd REAL, report TEXT)")
        db.executemany("INSERT INTO products VALUES (?,?,?)", records)


def query_spherex_s3(
    ra_deg: float,
    dec_deg: float,
    size_arcmin: float,
    *,
    index_path=Path("spherex-sample.sqlite"),
):
    """Point containment, observation order, TOP 400; never claim global absence.

    Full scan is intentional for <=8 rows. Inverse SIP WCS + pixel bounds avoid
    rotated-rectangle false positives and RA wrap; forward roundtrip checks the
    inversion. Size describes the future cutout, NOT an overlapping cone query.
    """
    validate_region(ra_deg, dec_deg, size_arcmin)
    point = SkyCoord(ra_deg * u.deg, dec_deg * u.deg)
    products = []
    with sqlite3.connect(
        Path(index_path).resolve().as_uri() + "?mode=ro", uri=True
    ) as db:
        for uri, mjd, text in db.execute("SELECT * FROM products ORDER BY mjd,uri"):
            report = json.loads(text)
            image = next(h for h in report["hdus"] if h["name"] == "IMAGE")
            header = fits.Header.fromstring(image["header"], sep="\n")
            spatial = WCS(header).celestial
            try:
                x, y = spatial.all_world2pix(ra_deg, dec_deg, 0, quiet=False)
            except NoConvergence:
                continue  # Never claim absence from this incomplete sample
            ny, nx = image["shape"]
            if not (
                np.isfinite([x, y]).all()
                and -0.5 <= x < nx - 0.5
                and -0.5 <= y < ny - 0.5
            ):
                continue
            if spatial.pixel_to_world(x, y).separation(point).arcsec > 0.001:
                raise ValueError("Footprint inversion failed its forward roundtrip")
            products.append(
                dict(
                    id="s3:" + hashlib.sha1(uri.encode()).hexdigest()[:16],
                    uri=uri,
                    source="s3-experimental",
                    date_mjd=mjd,
                    date_iso=header.get("DATE-OBS"),
                    obs_id=header.get("OBSID"),
                    release=report["release"],
                    processing=report["processing"],
                    detector=int(header["DETECTOR"]),
                    band=f"SPHEREx-D{header['DETECTOR']}",
                )
            )
            if len(products) == 400:
                break
    return dict(
        products=products,
        index_complete=False,
        coverage="sample_matches" if products else "unknown_not_indexed",
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("experiment", choices=["inspect", "cutout", "index", "query"])
    parser.add_argument("--release", choices=SAMPLES, default="dr1")
    parser.add_argument(
        "--output", type=Path, required=True, help="New output file; never overwritten"
    )
    parser.add_argument(
        "--ra", type=float, help="ICRS degrees; default: real image center"
    )
    parser.add_argument(
        "--dec", type=float, help="ICRS degrees; default: real image center"
    )
    parser.add_argument("--size-arcmin", type=float, default=1.0)
    parser.add_argument(
        "--max-mib", type=float, default=16.0, help="Response body budget per open"
    )
    parser.add_argument(
        "--headers", nargs="+", type=Path, help="1-8 inspect JSON reports for index"
    )
    parser.add_argument("--index", type=Path, help="Sample SQLite database for query")
    args = parser.parse_args()
    if args.output.exists() or (args.ra is None) != (args.dec is None):
        parser.error("Output must not exist; RA and Dec must be supplied together")
    if not math.isfinite(args.max_mib) or not 0 < args.max_mib <= 64:
        parser.error("--max-mib must be in (0,64]")
    if args.experiment == "index":
        if not args.headers:
            parser.error("index requires --headers")
        build_index(args.headers, args.output)
        print("Created incomplete sample index: " + str(args.output))
        return
    if args.experiment == "query":
        if args.index is None or args.ra is None:
            parser.error("query requires --index, --ra and --dec")
        result = query_spherex_s3(
            args.ra, args.dec, args.size_arcmin, index_path=args.index
        )
        args.output.write_text(json.dumps(result, indent=2))
        print(json.dumps(result, indent=2))
        return
    if args.experiment == "cutout" and args.output.with_suffix(".json").exists():
        parser.error("Cutout JSON report must not exist")
    key, start = SAMPLES[args.release], time.monotonic()
    with httpx.Client(timeout=20.0, trust_env=False) as client:
        with fits.open(
            "spxpoc://" + key,
            use_fsspec=True,
            memmap=False,
            fsspec_kwargs={"client": client, "max_bytes": int(args.max_mib * 1024**2)},
        ) as source:
            report = describe(source, key)
            # Access the exact fsspec file used by Astropy, not a separate probe.
            remote = source._file._file
            if args.experiment == "cutout":
                ra, dec = report["center"] if args.ra is None else (args.ra, args.dec)
                view = region_slices(source["IMAGE"], ra, dec, args.size_arcmin)
                with cutout_hdul(source, view) as result:
                    report["verification"] = verify_cutout(source, result, view)
                    report["shape"] = list(result["IMAGE"].shape)
                    report["origin_xy"] = [view[1].start, view[0].start]
                    report["requested_center"] = [ra, dec]
                    result.writeto(args.output, checksum=True)
                report["cutout_path"] = str(args.output)
            report["transfer"] = remote.stats()
        report["elapsed_seconds"] = time.monotonic() - start
    report_path = (
        args.output if args.experiment == "inspect" else args.output.with_suffix(".json")
    )
    if report_path.exists():
        raise ValueError(f"Report already exists: {report_path}")
    with report_path.open("x") as stream:
        json.dump(report, stream, indent=2)
    print(json.dumps({k: v for k, v in report.items() if k != "hdus"}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, httpx.HTTPError) as exc:
        print(f"Experiment failed: {exc}", file=sys.stderr)
        sys.exit(1)
