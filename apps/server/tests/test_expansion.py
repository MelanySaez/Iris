"""Request/discovery contract regression tests for large calibrated fields."""

import io

import httpx
import pytest
from astropy.table import Table
from pydantic import ValidationError

from app.schemas.jobs import JobRequest
from app.schemas.regions import ResolveRequest
from app.services import discovery


@pytest.mark.parametrize("size", [1, 60, 180])
def test_region_limits_across_requests(size):
    for schema in (JobRequest, ResolveRequest):
        assert schema(ra_deg=1, dec_deg=1, size_arcmin=size).size_arcmin == size


@pytest.mark.parametrize("size", [180.01, float("nan"), float("inf")])
def test_invalid_sizes_rejected(size):
    for schema in (JobRequest, ResolveRequest):
        with pytest.raises(ValidationError):
            schema(ra_deg=1, dec_deg=1, size_arcmin=size)


def votable(rows):
    data = Table(
        rows=rows,
        names=[
            "uri",
            "time_bounds_lower",
            "energy_bandpassname",
            "planeid",
            "source_uri",
        ],
    )
    stream = io.BytesIO()
    data.write(stream, format="votable")
    return stream.getvalue()


def test_area_discovery_pages_and_marks_complete(monkeypatch):
    queries = []
    rows = [
        ("https://irsa.ipac.caltech.edu/a?size=3", 60000.0, "SPHEREx-D1", "a", "a"),
        ("https://irsa.ipac.caltech.edu/b?size=3", 60001.0, "SPHEREx-D1", "b", "b"),
    ]

    class Client:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def post(self, url, data):
            queries.append(data["QUERY"])
            return httpx.Response(
                200,
                content=votable(rows if len(queries) == 1 else []),
                request=httpx.Request("POST", url),
            )

    monkeypatch.setattr(discovery, "TAP_PAGE_SIZE", 2)
    monkeypatch.setattr(discovery.httpx, "Client", lambda **kw: Client())
    events = []
    products, error = discovery.query_irsa_tap(359.9, 1, 180, on_attempt=events.append)
    assert error is None and len(products) == 2
    assert len(queries) == 2
    assert "INTERSECTS" in queries[0] and "BOX" in queries[0]
    assert "a.uri > 'b'" in queries[1]
    assert events[-1]["coverage_complete"] is True


@pytest.mark.parametrize(
    "warning,expected",
    [
        (None, False),
        ("IRSA TAP returned HTTP 404", False),
        ("IRSA TAP returned HTTP 400", False),
        ("IRSA TAP returned HTTP 502", True),
        ("ReadTimeout: timeout", True),
    ],
)
def test_only_provider_outages_attempt_s3(monkeypatch, tmp_path, warning, expected):
    monkeypatch.setattr(discovery, "DISCOVERY_CACHE_DIR", tmp_path)
    monkeypatch.setattr(discovery, "query_irsa_tap", lambda *a, **kw: ([], warning))
    called = []

    def fallback(*args, **kw):
        called.append(True)
        return {
            "products": [],
            "coverage_state": "unknown_not_indexed",
            "coverage_complete": False,
        }

    monkeypatch.setattr(discovery, "query_index", fallback)
    result = discovery.resolve_region(1, 1, 180, force_refresh=True)
    assert bool(called) is expected
    assert result["coverage"] == ("none" if warning is None else "unknown")
    if expected:
        assert result["coverage_state"] == "unknown_not_indexed"
        assert result["provider_trace"][-1]["fallback"] is True
