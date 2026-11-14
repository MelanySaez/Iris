"""SQLAlchemy repository for selection records (PostgreSQL)."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from decimal import ROUND_HALF_EVEN, Decimal
from typing import Any

from sqlalchemy import delete, func, literal_column, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session, selectinload, sessionmaker

from app.models import JobRequest
from app.selections.orm import Selection, SkyRegion, SpectralProduct

# Same precision used by JobManager.compute_job_id, so one region row maps to
# exactly the coordinates hashed into the job id.
_RA_DEC_QUANTUM = Decimal("0.00001")
_SIZE_QUANTUM = Decimal("0.001")


def _quantize(value: float, quantum: Decimal) -> Decimal:
    return Decimal(repr(value)).quantize(quantum, rounding=ROUND_HALF_EVEN)


def normalize_region(
    ra_deg: float, dec_deg: float, size_arcmin: float
) -> dict[str, Decimal]:
    """Canonical region key: RA wrapped to [0, 360) and fixed decimal precision."""
    ra = _quantize(ra_deg % 360.0, _RA_DEC_QUANTUM)
    if ra >= Decimal(360):
        ra = Decimal("0.00000")
    return {
        "ra_deg": ra,
        "dec_deg": _quantize(dec_deg, _RA_DEC_QUANTUM),
        "size_arcmin": _quantize(size_arcmin, _SIZE_QUANTUM),
    }


@dataclass(frozen=True)
class SubmissionResult:
    """Outcome of ``record_submission``."""

    inserted: bool  # the row was created by this call
    stored_status: str  # job_status held by the row after the write


class SelectionStore:
    """Persistence operations over the three selection-record tables."""

    def __init__(self, session_factory: sessionmaker) -> None:
        self._sessions = session_factory

    @property
    def engine_url(self) -> str:
        """Database URL in use, with the password hidden."""
        return self._sessions.kw["bind"].url.render_as_string(hide_password=True)

    # -- writes ---------------------------------------------------------------

    def _region_id(self, session: Session, key: dict[str, Decimal]) -> int:
        """Return the region id for ``key``, creating the row if needed."""
        stmt = (
            insert(SkyRegion)
            .values(**key)
            .on_conflict_do_nothing(constraint="sky_region_center_size")
        )
        session.execute(stmt)
        return session.execute(select(SkyRegion.id).filter_by(**key)).scalar_one()

    def record_submission(
        self, job_id: str, req: JobRequest, status: str, *, new_attempt: bool
    ) -> SubmissionResult:
        """Insert the selection or, when it already exists, count another hit.

        Only a new attempt resets ``job_status`` and clears ``job_error``; a cache
        hit never touches them, so a late duplicate write cannot overwrite a
        recorded outcome. Reports whether the row was created and the status it
        holds, so callers can repair a row whose outcome write was lost.
        """
        with self._sessions.begin() as session:
            region_id = self._region_id(
                session, normalize_region(req.ra_deg, req.dec_deg, req.size_arcmin)
            )
            stmt = insert(Selection).values(
                region_id=region_id,
                job_id=job_id,
                channels=sorted(set(req.channels)),
                products=sorted(set(req.products)),
                mode=req.mode,
                stretch=req.stretch,
                job_status=status,
            )
            changes: dict[str, Any] = {
                "hits": Selection.hits + 1,
                "last_seen_at": func.now(),
            }
            if new_attempt:
                changes["job_status"] = stmt.excluded.job_status
                changes["job_error"] = None
            stmt = stmt.on_conflict_do_update(
                index_elements=[Selection.job_id], set_=changes
            ).returning(literal_column("(xmax = 0)"), Selection.job_status)
            # PostgreSQL: xmax = 0 only for a freshly inserted row version.
            inserted, stored_status = session.execute(stmt).one()
            return SubmissionResult(inserted=bool(inserted), stored_status=stored_status)

    def record_discovery(self, req: JobRequest, discovery: dict[str, Any]) -> None:
        """Store the region coverage and its discovered products."""
        with self._sessions.begin() as session:
            region_id = self._region_id(
                session, normalize_region(req.ra_deg, req.dec_deg, req.size_arcmin)
            )
            session.execute(
                update(SkyRegion)
                .where(SkyRegion.id == region_id)
                .values(coverage=discovery["coverage"], checked_at=func.now())
            )
            rows = [
                {
                    "region_id": region_id,
                    "product_id": str(p["id"]),
                    "detector": int(p["detector"]),
                    "source": p["source"],
                    "obs_id": str(p["obs_id"]),
                    "uri": str(p["uri"]),
                    "date_mjd": float(p["date_mjd"]),
                }
                for p in discovery.get("products", [])
            ]
            if rows:
                stmt = insert(SpectralProduct).values(rows)
                stmt = stmt.on_conflict_do_update(
                    index_elements=[
                        SpectralProduct.region_id,
                        SpectralProduct.product_id,
                    ],
                    set_={
                        col: stmt.excluded[col]
                        for col in ("detector", "source", "obs_id", "uri", "date_mjd")
                    },
                )
                session.execute(stmt)

    def record_outcome(
        self,
        job_id: str,
        status: str,
        manifest: dict[str, Any] | None,
        error: str | None,
    ) -> None:
        """Store the final job status, its error and, when ready, the manifest."""
        values: dict[str, Any] = {"job_status": status, "job_error": error}
        if manifest is not None:
            values["manifest"] = manifest
        with self._sessions.begin() as session:
            session.execute(
                update(Selection).where(Selection.job_id == job_id).values(**values)
            )

    # -- reads / delete -------------------------------------------------------

    def list(self, limit: int, before: datetime | None = None) -> list[Selection]:
        """Most recently seen selections first; ``before`` paginates by last_seen_at."""
        stmt = (
            select(Selection)
            .options(selectinload(Selection.region))
            .order_by(Selection.last_seen_at.desc(), Selection.id)
            .limit(limit)
        )
        if before is not None:
            stmt = stmt.where(Selection.last_seen_at < before)
        with self._sessions() as session:
            return list(session.execute(stmt).scalars())

    def get(self, selection_id: uuid.UUID) -> Selection | None:
        """One selection with its region and the region's products."""
        stmt = (
            select(Selection)
            .where(Selection.id == selection_id)
            .options(selectinload(Selection.region).selectinload(SkyRegion.products))
        )
        with self._sessions() as session:
            return session.execute(stmt).scalar_one_or_none()

    def delete(self, selection_id: uuid.UUID) -> bool:
        """Hard-delete one selection; its shared region and products remain."""
        with self._sessions.begin() as session:
            result = session.execute(
                delete(Selection).where(Selection.id == selection_id)
            )
            return result.rowcount > 0
