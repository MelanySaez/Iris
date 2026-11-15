"""Object-name resolution: SIMBAD mirror, then NED, then errors (no network)."""

from __future__ import annotations

import json
from urllib.parse import parse_qs

import httpx
import pytest
from fastapi.testclient import TestClient

import app.name_resolver as resolver
from app.main import app

SIMBAD_HOST = "simbad.cfa.harvard.edu"
NED_HOST = "ned.ipac.caltech.edu"


class FakeResolvers:
    """Answers SIMBAD sim-script and NED ObjectLookup requests from canned data."""

    def __init__(self):
        self.simbad: (
            dict[str, str] | str
        ) = {}  # name -> "MAIN_ID|ra dec|otype", or "down"
        self.ned: (
            dict[str, dict] | str
        ) = {}  # name -> {"name", "ra", "dec", "type"}, or "down"
        self.calls: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        host = request.url.host
        self.calls.append(host)
        body = request.content.decode()
        if host == SIMBAD_HOST:
            if self.simbad == "down":
                return httpx.Response(503, text="Service Unavailable")
            script = parse_qs(body)["script"][0]
            name = script.rsplit("query id ", 1)[1].strip()
            row = self.simbad.get(name)
            if row is None:
                return httpx.Response(
                    200,
                    text=f"::error::::::::\n\n[3] '{name}': No known catalog\n",
                )
            return httpx.Response(200, text=row + "\n")
        if host == NED_HOST:
            if self.ned == "down":
                raise httpx.ConnectError("NED offline", request=request)
            name = json.loads(parse_qs(body)["json"][0])["name"]["v"]
            hit = self.ned.get(name)
            if hit is None:
                return httpx.Response(200, json={"StatusCode": 100, "ResultCode": 0})
            return httpx.Response(
                200,
                json={
                    "ResultCode": 3,
                    "Preferred": {
                        "Name": hit["name"],
                        "Position": {"RA": hit["ra"], "Dec": hit["dec"]},
                        "ObjType": {"Value": hit["type"]},
                    },
                },
            )
        return httpx.Response(404)


@pytest.fixture
def fake(tmp_path, monkeypatch):
    server = FakeResolvers()
    monkeypatch.setattr(resolver, "NAME_CACHE_DIR", tmp_path)
    monkeypatch.setattr(
        resolver,
        "_make_client",
        lambda: httpx.Client(transport=httpx.MockTransport(server)),
    )
    return server


def get(name: str):
    return TestClient(app, raise_server_exceptions=False).get(
        "/api/resolve", params={"name": name}
    )


def test_resolves_a_catalogue_code_through_the_simbad_mirror(fake):
    fake.simbad = {"M31": "M  31|010.684708 +41.268750|AGN"}
    resp = get("M31")
    assert resp.status_code == 200
    assert resp.json() == {
        "query": "M31",
        "name": "M 31",
        "ra_deg": pytest.approx(10.684708),
        "dec_deg": pytest.approx(41.26875),
        "object_type": "AGN",
        "source": "simbad",
        "cached": False,
    }


def test_second_lookup_is_served_from_the_cache(fake):
    fake.simbad = {"Betelgeuse": "* alf Ori|088.79293899 +07.40706400|RedSG"}
    assert get("Betelgeuse").json()["cached"] is False
    calls = len(fake.calls)
    again = get("Betelgeuse")
    assert again.status_code == 200
    assert again.json()["cached"] is True
    assert again.json()["name"] == "* alf Ori"
    assert len(fake.calls) == calls  # no provider was asked again


def test_falls_back_to_ned_when_simbad_does_not_know_the_name(fake):
    fake.ned = {
        "Arp 220": {"name": "UGC 09913", "ra": 233.738, "dec": 23.5032, "type": "G"}
    }
    resp = get("Arp 220")
    assert resp.status_code == 200
    assert resp.json()["source"] == "ned"
    assert resp.json()["name"] == "UGC 09913"
    assert fake.calls == [SIMBAD_HOST, NED_HOST]


def test_falls_back_to_ned_when_the_simbad_mirror_is_down(fake):
    fake.simbad = "down"
    fake.ned = {
        "M31": {"name": "MESSIER 031", "ra": 10.6848, "dec": 41.2691, "type": "G"}
    }
    resp = get("M31")
    assert resp.status_code == 200
    assert resp.json()["source"] == "ned"


def test_unknown_name_everywhere_is_404_and_remembered_briefly(fake):
    resp = get("zzqqnotreal")
    assert resp.status_code == 404
    assert (
        resp.json()["detail"]
        == "No object named 'zzqqnotreal' was found in SIMBAD or NED."
    )
    calls = len(fake.calls)
    assert get("zzqqnotreal").status_code == 404
    assert len(fake.calls) == calls  # the miss is cached, providers are not hammered


def test_all_resolvers_down_is_503_and_not_cached(fake):
    fake.simbad = "down"
    fake.ned = "down"
    resp = get("M31")
    assert resp.status_code == 503
    assert "unavailable" in resp.json()["detail"]
    fake.simbad = {"M31": "M  31|010.684708 +41.268750|AGN"}
    assert (
        get("M31").status_code == 200
    )  # a later recovery is not masked by a cached failure


def test_simbad_down_and_ned_miss_is_not_reported_as_unknown(fake):
    """NED only knows galaxies: without SIMBAD a miss cannot be called definitive."""
    fake.simbad = "down"
    resp = get("Betelgeuse")
    assert resp.status_code == 503


@pytest.mark.parametrize(
    ("designation", "ra", "dec"),
    [
        ("CatWISE2020 J023650.95+094746.2", 39.2122917, 9.7961667),
        ("J004244.3+411608", 10.684583, 41.268889),
        ("2MASS J05551028-0724254", 88.792833, -7.4070556),
    ],
)
def test_coordinate_designations_resolve_without_any_network(fake, designation, ra, dec):
    resp = get(designation)
    assert resp.status_code == 200
    body = resp.json()
    assert body["source"] == "designation"
    assert body["ra_deg"] == pytest.approx(ra, abs=1e-5)
    assert body["dec_deg"] == pytest.approx(dec, abs=1e-5)
    assert fake.calls == []


@pytest.mark.parametrize(
    "name",
    ["", "   ", "M31\nquery coo 0 0", "M31\rformat", "x" * 101, "M31; DROP", 'NGC "224"'],
)
def test_invalid_names_are_rejected_before_any_lookup(fake, name):
    assert get(name).status_code == 422
    assert fake.calls == []


# --- Review follow-ups: degraded answers must not look like definitive misses ---


def test_empty_simbad_answer_is_an_outage_not_an_unknown_name(fake):
    fake.simbad = {"M31": ""}  # degraded mirror: HTTP 200 with an empty body
    resp = get("M31")
    assert resp.status_code == 503
    fake.simbad = {"M31": "M  31|010.684708 +41.268750|AGN"}
    assert get("M31").status_code == 200  # nothing was cached as "unknown"


def test_object_known_without_coordinates_says_so(fake):
    fake.simbad = {"Mystery": "NAME Mystery||Unknown"}
    resp = get("Mystery")
    assert resp.status_code == 404
    assert resp.json()["detail"] == (
        "SIMBAD knows 'Mystery' as 'NAME Mystery' but has no coordinates for it."
    )


@pytest.mark.parametrize(
    "payload",
    [["not", "an", "object"], {"Preferred": {"Position": {"RA": "x", "Dec": 1}}}],
)
def test_malformed_ned_answer_is_an_outage_not_a_crash(fake, monkeypatch, payload):
    fake.simbad = "down"
    original = fake.__call__

    def ned_garbage(request):
        if request.url.host == NED_HOST:
            fake.calls.append(NED_HOST)
            return httpx.Response(200, json=payload)
        return original(request)

    monkeypatch.setattr(
        resolver,
        "_make_client",
        lambda: httpx.Client(transport=httpx.MockTransport(ned_garbage)),
    )
    assert get("M31").status_code == 503


def test_designation_with_impossible_seconds_is_not_parsed_locally(fake):
    fake.simbad = {}  # SIMBAD gets the name and does not know it
    resp = get("J023675.95+094746.2")
    assert resp.status_code == 404
    assert SIMBAD_HOST in fake.calls


# --- Second review: only definitive answers may be cached; bounded waits ---


def test_simbad_miss_with_ned_down_is_404_but_not_remembered(fake):
    fake.ned = "down"
    resp = get("Arp 220")
    assert resp.status_code == 404
    fake.ned = {
        "Arp 220": {"name": "UGC 09913", "ra": 233.738, "dec": 23.5032, "type": "G"}
    }
    assert (
        get("Arp 220").status_code == 200
    )  # NED recovered: no stale "unknown" in the way


def test_simbad_internal_error_is_an_outage_not_an_unknown_name(fake, monkeypatch):
    original = fake.__call__

    def simbad_script_error(request):
        if request.url.host == SIMBAD_HOST:
            fake.calls.append(SIMBAD_HOST)
            return httpx.Response(
                200, text="::error::::::::\n\n[1] internal error, try later\n"
            )
        return original(request)

    monkeypatch.setattr(
        resolver,
        "_make_client",
        lambda: httpx.Client(transport=httpx.MockTransport(simbad_script_error)),
    )
    assert (
        get("M31").status_code == 503
    )  # NED does not know it either; SIMBAD never answered


def test_resolver_waits_are_bounded():
    with resolver._make_client() as client:
        assert client.timeout.read <= 5
        assert client.timeout.connect <= 5
