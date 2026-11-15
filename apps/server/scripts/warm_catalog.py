#!/usr/bin/env python3
"""Precompute and warm derived disk cache for curated catalog objects."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

# Add server root to sys.path so app modules import cleanly
SERVER_ROOT = Path(__file__).resolve().parent.parent
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

from app.services.catalog import CURATED_OBJECTS  # noqa: E402
from app.services.jobs import job_manager  # noqa: E402
from app.schemas.jobs import JobRequest  # noqa: E402

# Old catalog ids and the id that replaced them, so stale commands fail loudly.
RENAMED_IDS = {
    "m81-field": (
        "'m81-field' was renamed to 'm101-field' (the field is M101); "
        "use 'm81' for M81 itself."
    ),
}


def select_objects(objects: list[dict], ids_arg: str) -> list[dict]:
    """Objects named in ``--objects`` (all when empty), in catalog order.

    Exits with an explanation when an id is unknown, instead of silently
    warming nothing for it.
    """
    target_ids = {o.strip() for o in ids_arg.split(",") if o.strip()}
    if not target_ids:
        return list(objects)
    known = [obj["id"] for obj in objects]
    unknown = sorted(target_ids - set(known))
    if unknown:
        hints = [RENAMED_IDS[i] for i in unknown if i in RENAMED_IDS]
        detail = " ".join(hints) if hints else f"Valid ids: {', '.join(known)}."
        raise SystemExit(f"Unknown catalog object id(s): {', '.join(unknown)}. {detail}")
    return [obj for obj in objects if obj["id"] in target_ids]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Warm Planet X derived cache for catalog objects without running the "
            "HTTP server."
        )
    )
    parser.add_argument(
        "--objects",
        type=str,
        default="",
        help="Comma-separated list of object IDs (e.g. m101-field,m81).",
    )
    parser.add_argument(
        "--channels",
        type=str,
        default="20",
        help="Comma-separated list of channel indices (default: '20' for D2).",
    )
    parser.add_argument(
        "--products",
        type=str,
        default="image",
        help="Comma-separated products (subset of image,variance,flags; default: image).",
    )
    parser.add_argument(
        "--mode",
        type=str,
        choices=["latest", "history"],
        default="latest",
        help="Cutout epoch mode (latest or history; default: 'latest').",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Optional maximum number of catalog objects to process.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    channels = [int(c.strip()) for c in args.channels.split(",") if c.strip()]
    products = [p.strip() for p in args.products.split(",") if p.strip()]
    if "image" not in products:
        products.append("image")

    objects_to_process = select_objects(CURATED_OBJECTS, args.objects)

    if args.limit is not None and args.limit > 0:
        objects_to_process = objects_to_process[: args.limit]

    print(
        f"Warming cache for {len(objects_to_process)} catalog object(s) "
        f"[channels={channels}, products={products}, mode={args.mode}]...\n"
    )

    total_start = time.time()
    success_count = 0

    for idx, obj in enumerate(objects_to_process, 1):
        obj_id = obj["id"]
        obj_name = obj["name"]
        ra = obj["ra_deg"]
        dec = obj["dec_deg"]
        size = obj.get("default_size_arcmin", 6.0)

        header = (
            f"[{idx}/{len(objects_to_process)}] {obj_name} ({obj_id}) "
            f"at RA={ra:.4f}, Dec={dec:.4f}..."
        )
        print(header, end=" ", flush=True)
        t0 = time.time()

        try:
            req = JobRequest(
                ra_deg=ra,
                dec_deg=dec,
                size_arcmin=size,
                channels=channels,
                products=products,  # type: ignore[arg-type]
                mode=args.mode,
            )
            job = job_manager.submit(req)

            # Wait for job completion
            max_wait_seconds = 120.0
            elapsed_wait = 0.0
            while (
                job.status not in ("ready", "failed")
                and elapsed_wait < max_wait_seconds
            ):
                time.sleep(0.05)
                elapsed_wait += 0.05

            dur = time.time() - t0
            if job.status == "ready":
                success_count += 1
                hit_str = " (cache hit)" if job.cache_hit else ""
                print(
                    f"READY in {dur:.2f}s{hit_str} "
                    f"[cutouts={len(job.cutouts)}, frames={len(job.frames)}]"
                )
            else:
                print(f"FAILED in {dur:.2f}s: {job.error}")

        except Exception as exc:
            dur = time.time() - t0
            print(f"ERROR in {dur:.2f}s: {exc}")

    total_dur = time.time() - total_start
    print(
        f"\nDone. {success_count}/{len(objects_to_process)} "
        f"objects ready in {total_dur:.2f}s."
    )


if __name__ == "__main__":
    main()
