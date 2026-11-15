"""add selection owner

Records belong to the browser that saved them, identified by the owner cookie
it receives after accepting cookies. Selections saved before owners existed
cannot be attributed to anyone, so they are deleted; the shared region and
product rows stay. The deletion cannot be undone by the downgrade.

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-15 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0006"
down_revision: str | Sequence[str] | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.execute("DELETE FROM selection")
    op.add_column(
        "selection", sa.Column("owner_id", postgresql.UUID(as_uuid=True), nullable=False)
    )
    # Created unnamed in 0001, so PostgreSQL named it <table>_<column>_key.
    op.drop_constraint("selection_job_id_key", "selection", type_="unique")
    op.create_unique_constraint(
        "selection_owner_job", "selection", ["owner_id", "job_id"]
    )
    op.create_index(
        "selection_owner_last_seen_at",
        "selection",
        ["owner_id", sa.text("last_seen_at DESC")],
        unique=False,
    )
    # Outcome writes update every owner's row of a job by job_id.
    op.create_index("selection_job_id", "selection", ["job_id"], unique=False)


def downgrade() -> None:
    """Downgrade schema (deleted selections are not restored)."""
    op.drop_index("selection_job_id", table_name="selection")
    op.drop_index("selection_owner_last_seen_at", table_name="selection")
    op.drop_constraint("selection_owner_job", "selection", type_="unique")
    # Rows of different owners can share a job id; keep one per job.
    op.execute(
        "DELETE FROM selection a USING selection b "
        "WHERE a.job_id = b.job_id AND a.id > b.id"
    )
    op.create_unique_constraint("selection_job_id_key", "selection", ["job_id"])
    op.drop_column("selection", "owner_id")
