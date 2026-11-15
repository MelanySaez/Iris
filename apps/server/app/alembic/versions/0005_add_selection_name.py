"""add selection name

A user label for a saved selection, shown in Records. Nullable, so existing
selections stay valid and simply have no name.

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-14 18:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0005"
down_revision: str | Sequence[str] | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("selection", sa.Column("name", sa.Text(), nullable=True))
    op.create_check_constraint(
        "selection_name_length",
        "selection",
        "name IS NULL OR char_length(name) BETWEEN 1 AND 80",
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint("selection_name_length", "selection", type_="check")
    op.drop_column("selection", "name")
