"""add selection view mode

Records how the Sky map showed a selected region: a single channel or an RGB
composite with its three channels. Both columns are nullable, so existing
selections stay valid and simply have no recorded view.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-14 17:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0004"
down_revision: str | Sequence[str] | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("selection", sa.Column("view_mode", sa.Text(), nullable=True))
    op.add_column(
        "selection",
        sa.Column("rgb_channels", postgresql.ARRAY(sa.SmallInteger()), nullable=True),
    )
    op.create_check_constraint(
        "selection_view_valid",
        "selection",
        "(view_mode IS NULL AND rgb_channels IS NULL) "
        "OR (view_mode = 'single' AND rgb_channels IS NULL) "
        "OR (view_mode = 'rgb' AND cardinality(rgb_channels) = 3)",
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint("selection_view_valid", "selection", type_="check")
    op.drop_column("selection", "rgb_channels")
    op.drop_column("selection", "view_mode")
