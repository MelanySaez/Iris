"""Storage must accept the same region/provider contracts as the public API."""

from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateTable

from app.models.selection import SkyRegion, SpectralProduct


def test_storage_accepts_180_arcmin_and_s3_sources():
    ddl = str(CreateTable(SkyRegion.__table__).compile(dialect=postgresql.dialect()))
    assert "size_arcmin BETWEEN 1 AND 180" in ddl
    assert "NUMERIC(6, 3)" in ddl
    products = str(
        CreateTable(SpectralProduct.__table__).compile(dialect=postgresql.dialect())
    )
    assert "'s3'" in products
