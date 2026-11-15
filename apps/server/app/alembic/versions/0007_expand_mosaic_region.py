"""Allow 180-arcmin regions and indexed S3 product provenance.

Revision ID: 0007
Revises: 0006
"""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Numeric(5,3) tops out at 99.999, independent of the old check constraint.
    op.alter_column(
        "sky_region",
        "size_arcmin",
        existing_type=sa.Numeric(5, 3),
        type_=sa.Numeric(6, 3),
    )
    op.drop_constraint("sky_region_size_range", "sky_region", type_="check")
    op.create_check_constraint(
        "sky_region_size_range", "sky_region", "size_arcmin BETWEEN 1 AND 180"
    )
    op.drop_constraint("spectral_product_source", "spectral_product", type_="check")
    op.create_check_constraint(
        "spectral_product_source",
        "spectral_product",
        "source IN ('local', 'remote', 's3', 'mixed')",
    )


def downgrade() -> None:
    # Refuse an incompatible rollback instead of deleting or truncating records.
    connection = op.get_bind()
    oversized = connection.execute(
        sa.text("SELECT 1 FROM sky_region WHERE size_arcmin > 60 LIMIT 1")
    ).first()
    s3 = connection.execute(
        sa.text(
            "SELECT 1 FROM spectral_product WHERE source "
            "NOT IN ('local', 'remote') LIMIT 1"
        )
    ).first()
    if oversized or s3:
        raise RuntimeError(
            "Cannot downgrade while large regions or S3 provenance records exist"
        )
    op.drop_constraint("spectral_product_source", "spectral_product", type_="check")
    op.create_check_constraint(
        "spectral_product_source", "spectral_product", "source IN ('local', 'remote')"
    )
    op.drop_constraint("sky_region_size_range", "sky_region", type_="check")
    op.create_check_constraint(
        "sky_region_size_range", "sky_region", "size_arcmin BETWEEN 1 AND 60"
    )
    op.alter_column(
        "sky_region",
        "size_arcmin",
        existing_type=sa.Numeric(6, 3),
        type_=sa.Numeric(5, 3),
    )
