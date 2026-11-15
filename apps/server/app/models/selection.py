"""SQLAlchemy ORM mapping for selection records (three tables).

Derived values are intentionally not stored: ``fov_deg`` (``size_arcmin / 60``),
``band`` (``SPHEREx-D{detector}``) and ISO dates (from MJD).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    CHAR,
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Identity,
    Index,
    Numeric,
    SmallInteger,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

COVERAGE_VALUES = ("available", "none", "unknown")


class Base(DeclarativeBase):
    """Declarative base for selection-record tables."""


coverage_enum = Enum(*COVERAGE_VALUES, name="coverage_status")


class SkyRegion(Base):
    """A sky region (center + size) shared by every selection over it."""

    __tablename__ = "sky_region"
    __table_args__ = (
        UniqueConstraint(
            "ra_deg", "dec_deg", "size_arcmin", name="sky_region_center_size"
        ),
        CheckConstraint("ra_deg >= 0 AND ra_deg < 360", name="sky_region_ra_range"),
        CheckConstraint("dec_deg BETWEEN -90 AND 90", name="sky_region_dec_range"),
        CheckConstraint("size_arcmin BETWEEN 1 AND 60", name="sky_region_size_range"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    ra_deg: Mapped[Decimal] = mapped_column(Numeric(8, 5))
    dec_deg: Mapped[Decimal] = mapped_column(Numeric(7, 5))
    size_arcmin: Mapped[Decimal] = mapped_column(Numeric(5, 3))
    coverage: Mapped[str] = mapped_column(coverage_enum, server_default="unknown")
    checked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    products: Mapped[list[SpectralProduct]] = relationship(
        back_populates="region",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="SpectralProduct.date_mjd",
    )


class SpectralProduct(Base):
    """A Level-2 spectral image product discovered for a region."""

    __tablename__ = "spectral_product"
    __table_args__ = (
        CheckConstraint(
            "detector BETWEEN 1 AND 6", name="spectral_product_detector_range"
        ),
        CheckConstraint("source IN ('local', 'remote')", name="spectral_product_source"),
        Index("spectral_product_detector_date", "detector", "date_mjd"),
    )

    region_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("sky_region.id", ondelete="CASCADE"), primary_key=True
    )
    product_id: Mapped[str] = mapped_column(Text, primary_key=True)
    detector: Mapped[int] = mapped_column(SmallInteger)
    source: Mapped[str] = mapped_column(Text)
    obs_id: Mapped[str] = mapped_column(Text)
    uri: Mapped[str] = mapped_column(Text)
    date_mjd: Mapped[float]

    region: Mapped[SkyRegion] = relationship(back_populates="products")


class Selection(Base):
    """One user selection record; ``job_id`` is the deterministic request hash."""

    __tablename__ = "selection"
    __table_args__ = (
        CheckConstraint(
            "cardinality(channels) BETWEEN 1 AND 8 "
            "AND NOT channels && ARRAY[50, 51]::smallint[]",
            name="selection_channels_valid",
        ),
        CheckConstraint(
            "cardinality(products) >= 1 "
            "AND products <@ ARRAY['image', 'variance', 'flags']::text[]",
            name="selection_products_valid",
        ),
        CheckConstraint(
            "(view_mode IS NULL AND rgb_channels IS NULL) "
            "OR (view_mode = 'single' AND rgb_channels IS NULL) "
            "OR (view_mode = 'rgb' AND cardinality(rgb_channels) = 3)",
            name="selection_view_valid",
        ),
        CheckConstraint(
            "name IS NULL OR char_length(name) BETWEEN 1 AND 80",
            name="selection_name_length",
        ),
        CheckConstraint("mode IN ('latest', 'history')", name="selection_mode"),
        CheckConstraint("stretch IN ('asinh', 'linear')", name="selection_stretch"),
        UniqueConstraint("owner_id", "job_id", name="selection_owner_job"),
        Index("selection_last_seen_at", text("last_seen_at DESC")),
        Index("selection_owner_last_seen_at", "owner_id", text("last_seen_at DESC")),
        Index("selection_job_id", "job_id"),
        Index("selection_region_id", "region_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    # The browser that saved the record (its owner cookie); see app.api.routes.consent.
    owner_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    region_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("sky_region.id"))
    job_id: Mapped[str] = mapped_column(CHAR(20))
    channels: Mapped[list[int]] = mapped_column(ARRAY(SmallInteger))
    products: Mapped[list[str]] = mapped_column(ARRAY(Text))
    mode: Mapped[str] = mapped_column(Text)
    stretch: Mapped[str] = mapped_column(Text)
    job_status: Mapped[str] = mapped_column(Text)
    job_error: Mapped[str | None] = mapped_column(Text)
    # Failure traceability: where (stage), why (stable kind), how (traceback
    # for unexpected errors) and when (stage timeline with epoch seconds).
    failed_stage: Mapped[str | None] = mapped_column(Text)
    error_kind: Mapped[str | None] = mapped_column(Text)
    error_trace: Mapped[str | None] = mapped_column(Text)
    job_events: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB)
    manifest: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    # How the Sky map showed the region at the latest submission that sent it.
    view_mode: Mapped[str | None] = mapped_column(Text)
    rgb_channels: Mapped[list[int] | None] = mapped_column(ARRAY(SmallInteger))
    # User label shown in Records; never set by job submissions.
    name: Mapped[str | None] = mapped_column(Text)
    hits: Mapped[int] = mapped_column(server_default="1")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    region: Mapped[SkyRegion] = relationship()
