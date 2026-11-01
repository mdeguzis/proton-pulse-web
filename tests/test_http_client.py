"""Shared pipeline HTTP client (#411): pacing, retries, Retry-After, the
per-host breaker, error shape and secret masking. Everything runs against a
fake opener, clock and sleep, so nothing touches the network or waits."""
from __future__ import annotations

import json
import urllib.error

import pytest

from scripts.pipeline import http_client as hc

STEAM = "https://store.steampowered.com/api/appdetails?appids=10"
OTHER = "https://api.example.com/v1/thing"


class FakeResp:
    def __init__(self, body=b"{}", status=200, headers=None):
        self.body = body
        self.status = status
        self.headers = headers if headers is not None else {"Content-Type": "application/json"}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self.body


def http_error(code, headers=None, url=OTHER):
    return urllib.error.HTTPError(url, code, f"status {code}", headers if headers is not None else {}, None)


class Harness:
    """Scripted opener plus a clock that only moves when the client sleeps."""

    def __init__(self, script, profiles=None, rand=0.0, epoch=1_000_000.0):
        self.script = list(script)
        self.calls = []
        self.sleeps = []
        self.now = 100.0
        self.client = hc.HttpClient(
            profiles=profiles, opener=self.open, sleep=self.sleep,
            clock=lambda: self.now, wall_clock=lambda: epoch, rand=lambda: rand,
        )

    def open(self, req, timeout):
        self.calls.append((req, timeout))
        step = self.script.pop(0)
        if isinstance(step, BaseException):
            raise step
        return step

    def sleep(self, seconds):
        self.sleeps.append(round(seconds, 3))
        self.now += seconds


@pytest.fixture
def logs(monkeypatch):
    lines = []
    monkeypatch.setattr(hc, "log", lines.append)
    return lines


# -- mask_url -------------------------------------------------------------

def test_mask_url_hides_secret_params_and_keeps_the_rest():
    masked = hc.mask_url("https://api.steampowered.com/x?key=ABC123&appid=10&access_token=t&sig=s")
    assert "ABC123" not in masked and "=t&" not in masked
    assert "key=***" in masked and "access_token=***" in masked and "sig=***" in masked
    assert "appid=10" in masked


def test_mask_url_without_query_is_unchanged():
    assert hc.mask_url(OTHER) == OTHER


def test_error_message_never_carries_the_secret():
    err = hc.HttpStatusError("GET", "https://x.test/a?api_key=SECRET", "HTTP 500", status=500, attempts=3, elapsed=2.25)
    assert "SECRET" not in str(err)
    assert str(err) == "GET https://x.test/a?api_key=*** failed: HTTP 500 (attempts=3, elapsed=2.2s)"
    assert (err.status, err.attempts) == (500, 3)


# -- success path ---------------------------------------------------------

def test_get_returns_response_and_sends_user_agent_and_headers():
    h = Harness([FakeResp(b"hello", headers={"X-Thing": "1"})])
    resp = h.client.get(OTHER, headers={"Accept": "text/plain"}, timeout=3)
    assert (resp.status, resp.body, resp.text(), resp.attempts) == (200, b"hello", "hello", 1)
    assert resp.headers == {"x-thing": "1"}
    req, timeout = h.calls[0]
    assert timeout == 3
    assert req.get_header("User-agent") == hc.USER_AGENT
    assert req.get_header("Accept") == "text/plain"
    assert req.get_method() == "GET"


def test_profile_timeout_is_the_default():
    h = Harness([FakeResp()])
    h.client.get(STEAM)
    assert h.calls[0][1] == hc.PROFILES["store.steampowered.com"].timeout


def test_response_without_status_or_headers_defaults_to_200():
    class Bare:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b"[1]"

    h = Harness([Bare()])
    assert h.client.get_json(OTHER) == [1]


def test_get_json_parses_and_sets_accept():
    h = Harness([FakeResp(json.dumps({"a": 1}).encode())])
    assert h.client.get_json(OTHER) == {"a": 1}
    assert h.calls[0][0].get_header("Accept") == "application/json"


@pytest.mark.parametrize("resp, reason", [
    (FakeResp(b"{}", headers={"Content-Type": "text/html; charset=utf-8"}), "expected JSON, got HTML"),
    (FakeResp(b"  <!doctype html><p>busy", headers={}), "expected JSON, got HTML"),
    (FakeResp(b"{not json"), "invalid JSON"),
    (FakeResp(b"\xff\xfe"), "invalid JSON"),
])
def test_get_json_rejects_html_and_bad_json(resp, reason):
    h = Harness([resp])
    with pytest.raises(hc.ResponseFormatError) as ei:
        h.client.get_json(OTHER)
    assert reason in ei.value.reason
    assert ei.value.status == 200


# -- pacing ---------------------------------------------------------------

def test_paced_host_waits_out_min_interval_and_other_hosts_do_not():
    h = Harness([FakeResp(), FakeResp(), FakeResp(), FakeResp()])
    h.client.get(STEAM)
    assert h.sleeps == []
    h.now += 0.5
    h.client.get(STEAM)
    assert h.sleeps == [1.5]          # 2.0 interval minus the 0.5 that passed
    h.client.get(OTHER)
    h.client.get(OTHER)
    assert h.sleeps == [1.5]          # default profile has no pacing


def test_no_wait_when_interval_already_passed():
    h = Harness([FakeResp(), FakeResp()])
    h.client.get(STEAM)
    h.now += 10
    h.client.get(STEAM)
    assert h.sleeps == []


# -- retries --------------------------------------------------------------

def test_503_is_retried_with_backoff_then_succeeds(logs):
    h = Harness([http_error(503), FakeResp(b"ok")], rand=0.0)
    resp = h.client.get(OTHER)
    assert resp.attempts == 2
    assert h.sleeps == [0.5]          # base 1.0, equal jitter with rand=0 is half
    assert any("HTTP 503, retry 1/2 in 0.5s" in line for line in logs)


def test_retry_after_seconds_is_honored_and_capped():
    profiles = {"api.example.com": hc.HostProfile("ex", retries=2, backoff_cap=10.0)}
    h = Harness([http_error(429, {"Retry-After": "7"}), http_error(429, {"Retry-After": "120"}), FakeResp()],
                profiles=profiles, rand=0.0)
    h.client.get(OTHER)
    assert h.sleeps == [7.0, 10.0]


def test_retry_after_http_date():
    epoch = 1_000_000.0
    when = "Mon, 12 Jan 1970 13:46:49 GMT"   # epoch 1_000_009
    h = Harness([http_error(503, {"Retry-After": when}), FakeResp()], epoch=epoch)
    h.client.get(OTHER)
    assert h.sleeps == [9.0]


def test_unparseable_retry_after_falls_back_to_backoff():
    h = Harness([http_error(503, {"Retry-After": "soon"}), FakeResp()], rand=1.0)
    h.client.get(OTHER)
    assert h.sleeps == [1.0]


def test_retry_after_helper_edges():
    assert hc._retry_after_seconds(None, 0) is None
    assert hc._retry_after_seconds("", 0) is None
    assert hc._retry_after_seconds("Thu, 01 Jan 1970 00:00:00 GMT", 50.0) == 0.0


def test_backoff_doubles_and_caps():
    c = hc.HttpClient(rand=lambda: 1.0)
    p = hc.HostProfile("x", backoff_base=2.0, backoff_cap=5.0)
    assert [c._backoff(p, n) for n in (1, 2, 3)] == [2.0, 4.0, 5.0]


def test_retries_exhausted_raises_status_error(logs):
    h = Harness([http_error(500), http_error(502), http_error(504)])
    with pytest.raises(hc.HttpStatusError) as ei:
        h.client.get(OTHER)
    assert (ei.value.status, ei.value.attempts) == (504, 3)
    assert len(h.calls) == 3


def test_transport_errors_are_retried_then_raised():
    h = Harness([urllib.error.URLError("dns"), ConnectionResetError("reset"), TimeoutError("slow")])
    with pytest.raises(hc.HttpTransportError) as ei:
        h.client.get(OTHER)
    assert ei.value.status is None
    assert ei.value.attempts == 3
    assert "TimeoutError" in ei.value.reason


def test_transport_error_then_success():
    h = Harness([urllib.error.URLError("dns"), FakeResp()])
    assert h.client.get(OTHER).attempts == 2


def test_definitive_4xx_is_not_retried_and_resets_the_failure_streak():
    h = Harness([http_error(503), http_error(503), http_error(503), http_error(404)])
    with pytest.raises(hc.HttpStatusError):
        h.client.get(OTHER)
    assert h.client._state(OTHER).consecutive_failures == 1
    with pytest.raises(hc.HttpStatusError) as ei:
        h.client.get(OTHER)
    assert (ei.value.status, ei.value.attempts) == (404, 1)
    assert h.client._state(OTHER).consecutive_failures == 0


def test_http_error_without_headers():
    err = urllib.error.HTTPError(OTHER, 503, "x", None, None)
    h = Harness([err, FakeResp()])
    assert h.client.get(OTHER).attempts == 2


# -- Steam profile + breaker -----------------------------------------------

def test_steam_403_is_not_retried_but_counts_toward_the_breaker(logs):
    limit = hc.PROFILES["store.steampowered.com"].breaker_limit
    h = Harness([http_error(403, url=STEAM) for _ in range(limit)])
    for _ in range(limit):
        with pytest.raises(hc.HttpStatusError) as ei:
            h.client.get(STEAM)
        assert ei.value.attempts == 1
    assert len(h.calls) == limit
    assert any("steam-store circuit open for 300s after 8 consecutive failures" in line for line in logs)

    # Open: fails fast without touching the network.
    with pytest.raises(hc.CircuitOpenError) as ei:
        h.client.get(STEAM)
    assert ei.value.attempts == 0
    assert len(h.calls) == limit
    # Other hosts are unaffected.
    h.script.append(FakeResp())
    h.client.get(OTHER)


def test_breaker_lets_a_trial_through_after_cooldown():
    profiles = {"api.example.com": hc.HostProfile("ex", retries=0, breaker_limit=2, breaker_cooldown=60)}
    h = Harness([http_error(503), http_error(503), http_error(503), FakeResp(), FakeResp()], profiles=profiles)
    for _ in range(2):
        with pytest.raises(hc.HttpStatusError):
            h.client.get(OTHER)
    with pytest.raises(hc.CircuitOpenError):
        h.client.get(OTHER)
    h.now += 61
    # The trial fails: the circuit re-opens at once.
    with pytest.raises(hc.HttpStatusError):
        h.client.get(OTHER)
    with pytest.raises(hc.CircuitOpenError):
        h.client.get(OTHER)
    h.now += 61
    # The trial succeeds: closed again, streak cleared.
    h.client.get(OTHER)
    h.client.get(OTHER)
    state = h.client._state(OTHER)
    assert (state.consecutive_failures, state.circuit_opened, state.short_circuited) == (0, 2, 2)


def test_breaker_disabled_by_default():
    h = Harness([http_error(503)] * 30)
    for _ in range(10):
        with pytest.raises(hc.HttpStatusError):
            h.client.get(OTHER)
    assert h.client._state(OTHER).circuit_opened == 0


# -- summary + default client ----------------------------------------------

def test_summary_counts_per_host(logs):
    h = Harness([http_error(429), FakeResp(), http_error(404)])
    assert h.client.summary() == []
    h.client.get(OTHER)
    with pytest.raises(hc.HttpStatusError):
        h.client.get(OTHER)
    (line,) = h.client.summary()
    assert line == ("[http] api.example.com: 3 requests, 1 retries, 0 failures, circuit opened 0x, "
                    "0 short-circuited; statuses 200x1, 404x1, 429x1")
    h.client.log_summary()
    assert logs[-1] == line


def test_summary_with_no_statuses():
    h = Harness([urllib.error.URLError("x")] * 3)
    with pytest.raises(hc.HttpTransportError):
        h.client.get(OTHER)
    assert h.client.summary()[0].endswith("statuses none")


def test_default_client_is_a_shared_singleton():
    hc.reset_default_client()
    a = hc.default_client()
    assert hc.default_client() is a
    mine = hc.HttpClient()
    hc.reset_default_client(mine)
    assert hc.default_client() is mine


def test_default_dependencies_resolve_at_call_time(monkeypatch):
    """Tests elsewhere patch urllib.request.urlopen and time.sleep; the
    default client must pick those up rather than binding them at import."""
    import time
    import urllib.request
    calls, sleeps = [], []
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout: calls.append(req) or FakeResp())
    monkeypatch.setattr(time, "sleep", sleeps.append)
    c = hc.HttpClient(rand=lambda: 0.0)
    c.get(STEAM)
    c.get(STEAM)
    assert len(calls) == 2
    assert len(sleeps) == 1 and 0 < sleeps[0] <= 2.0
    c._wait(0)
    assert len(sleeps) == 1
    assert 0.0 <= hc.HttpClient()._random() < 1.0
    assert hc.HttpClient()._epoch() > 0
