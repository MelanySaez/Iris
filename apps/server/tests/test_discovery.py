from __future__ import annotations

from app.services import discovery


def test_tap_query_reports_each_retry(monkeypatch):
    calls = 0

    class TimedOutClient:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, *args, **kwargs):
            nonlocal calls
            calls += 1
            raise discovery.httpx.ReadTimeout("The read operation timed out")

    monkeypatch.setattr(discovery.httpx, "Client", lambda **kwargs: TimedOutClient())
    delays = []
    monkeypatch.setattr(discovery.time, "sleep", delays.append)
    attempts = []

    products, warning = discovery.query_irsa_tap(
        36.9, 62.26, 1.0, on_attempt=attempts.append
    )

    assert products == []
    assert "ReadTimeout" in warning
    assert calls == discovery.TAP_QUERY_RETRIES + 1
    assert [(event["attempt"], event["outcome"]) for event in attempts] == [
        (1, "started"),
        (1, "failed"),
        (2, "started"),
        (2, "failed"),
    ]
    assert attempts[1]["will_retry"] is True
    assert attempts[1]["retry_after_seconds"] == 0.5
    assert delays == [0.5]
    assert attempts[-1]["will_retry"] is False


def test_resolve_region_forwards_discovery_attempts(monkeypatch, tmp_path):
    event = {
        "event_type": "discovery_attempt",
        "provider": "IRSA TAP",
        "attempt": 1,
        "max_attempts": 1,
        "outcome": "failed",
        "will_retry": False,
        "detail": "HTTP 502",
    }

    def fail_query(ra_deg, dec_deg, size_arcmin, on_attempt=None):
        on_attempt(event)
        return [], "IRSA TAP returned HTTP 502"

    monkeypatch.setattr(discovery, "DISCOVERY_CACHE_DIR", tmp_path)
    monkeypatch.setattr(discovery, "query_irsa_tap", fail_query)
    attempts = []

    result = discovery.resolve_region(
        36.9, 62.26, 1.0, force_refresh=True, on_attempt=attempts.append
    )

    assert attempts[0] == event
    assert attempts[-1]["fallback"] is True
    assert result["coverage"] == "unknown"


def test_tap_http_failures_use_exponential_backoff(monkeypatch):
    class BadGatewayClient:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, *args, **kwargs):
            return type("Response", (), {"status_code": 502, "text": "Proxy Error"})()

    delays = []
    attempts = []
    monkeypatch.setattr(discovery, "TAP_QUERY_RETRIES", 2)
    monkeypatch.setattr(discovery.httpx, "Client", lambda **kwargs: BadGatewayClient())
    monkeypatch.setattr(discovery.time, "sleep", delays.append)

    products, warning = discovery.query_irsa_tap(
        36.9, 62.26, 1.0, on_attempt=attempts.append
    )

    assert products == []
    assert "HTTP 502" in warning
    assert delays == [0.5, 1.0]
    assert [
        event["retry_after_seconds"] for event in attempts if event["outcome"] == "failed"
    ] == [0.5, 1.0, None]
