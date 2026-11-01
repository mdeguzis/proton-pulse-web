"""Shared HTTP client for the pipeline (#411).

Every pipeline module used to carry its own urlopen wrapper, sleep and retry
loop. The ones that hit the same host never knew about each other: finalize
runs release_years (0.3s spacing), steam_type (2.0s), game_images and the
content-descriptor lookup back to back against store.steampowered.com, and
the fastest of them trips Steam's rolling-window throttle for all the rest.

This module owns that once:

  * per-host pacing that every caller in the process shares
  * retries with exponential backoff and jitter, honoring Retry-After
  * a per-host circuit breaker, so once a host is throttling us the next
    module fails fast instead of spending its whole budget on 403s
  * one error type with the method, masked URL, status, attempts and elapsed
    time, and one log shape for every failure
  * a per-host summary line for the end of a run

Callers declare nothing but the URL; the host picks the profile. Hosts with
no profile get DEFAULT_PROFILE (no pacing, two retries on 429/5xx).

Failures raise. A caller that wants best-effort behaviour catches HttpError
and decides; nothing here turns a failure into an empty result.
"""
from __future__ import annotations

import email.utils
import json
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable

from .common import log

# The contact form flightless_benchmarks.py already sends. A real UA keeps
# Cloudflare-fronted hosts from flagging the default urllib one as a bot.
USER_AGENT = "proton-pulse-pipeline/1.0 (+https://www.proton-pulse.com; github.com/mdeguzis/proton-pulse-web)"

RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})


@dataclass(frozen=True)
class HostProfile:
    """How to talk to one host.

    min_interval      seconds between request starts to this host, shared by
                      every caller in the process
    retries           extra attempts after the first
    retry_statuses    statuses worth retrying (always plus transport errors)
    failure_statuses  statuses that count toward the breaker without being
                      retried; Steam answers a throttled client with 403, and
                      retrying a 403 only deepens the ban
    breaker_limit     consecutive failures that open the circuit (0 = never)
    breaker_cooldown  seconds the circuit stays open before one trial request
    """
    name: str
    min_interval: float = 0.0
    retries: int = 2
    retry_statuses: frozenset = RETRY_STATUSES
    failure_statuses: frozenset = frozenset()
    backoff_base: float = 1.0
    backoff_cap: float = 60.0
    breaker_limit: int = 0
    breaker_cooldown: float = 300.0
    timeout: float = 15.0


DEFAULT_PROFILE = HostProfile(name="default")

PROFILES: dict[str, HostProfile] = {
    # appdetails soft-throttles at roughly 200 requests per 5 minutes. 2.0s
    # is the spacing steam_type.py measured as safe; 0.3s got banned within
    # seconds. One retry only: a 429 is worth one patient retry, a 403 is
    # the ban itself.
    "store.steampowered.com": HostProfile(
        name="steam-store",
        min_interval=2.0,
        retries=1,
        failure_statuses=frozenset({403}),
        backoff_base=5.0,
        breaker_limit=8,
        breaker_cooldown=300.0,
        timeout=10.0,
    ),
}

# Query parameters whose values never reach a log line.
_SECRET_PARAM = re.compile(r"(key|token|secret|password|passwd|sig|signature|auth)", re.I)


def mask_url(url: str) -> str:
    """The URL with secret-looking query values replaced by ***."""
    parts = urllib.parse.urlsplit(url)
    if not parts.query:
        return url
    query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    masked = [(k, "***" if _SECRET_PARAM.search(k) else v) for k, v in query]
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(masked, safe="*,:")))


class HttpError(Exception):
    """Any failed request. str() is the one-line log shape."""

    def __init__(self, method: str, url: str, reason: str, *, status: int | None = None,
                 attempts: int = 1, elapsed: float = 0.0):
        self.method = method
        self.url = mask_url(url)
        self.reason = reason
        self.status = status
        self.attempts = attempts
        self.elapsed = elapsed
        super().__init__(
            f"{method} {self.url} failed: {reason} "
            f"(attempts={attempts}, elapsed={elapsed:.1f}s)"
        )


class HttpStatusError(HttpError):
    """The host answered with a non-2xx status."""


class HttpTransportError(HttpError):
    """No usable answer: connection, DNS, TLS or timeout."""


class CircuitOpenError(HttpError):
    """The host's breaker is open; the request was not sent."""


class ResponseFormatError(HttpError):
    """2xx, but the body is not what the caller asked for (HTML, bad JSON)."""


@dataclass
class Response:
    url: str
    status: int
    headers: dict[str, str]
    body: bytes
    attempts: int
    elapsed: float

    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")


@dataclass
class _HostState:
    last_start: float | None = None
    consecutive_failures: int = 0
    open_until: float = 0.0
    requests: int = 0
    failures: int = 0
    retries: int = 0
    circuit_opened: int = 0
    short_circuited: int = 0
    statuses: dict[int, int] = field(default_factory=dict)


def _retry_after_seconds(value: str | None, now_epoch: float) -> float | None:
    """Retry-After is either delta-seconds or an HTTP date."""
    if not value:
        return None
    value = value.strip()
    if value.isdigit():
        return float(value)
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, when.timestamp() - now_epoch)


class HttpClient:
    """Thread-unsafe by design: the pipeline is sequential per process.

    opener, sleep, clock, wall_clock and rand are injectable for tests. The
    defaults are resolved at call time, so tests that monkeypatch
    urllib.request.urlopen or time.sleep reach this client too.
    """

    def __init__(self, profiles: dict[str, HostProfile] | None = None, *,
                 opener: Callable | None = None, sleep: Callable[[float], None] | None = None,
                 clock: Callable[[], float] | None = None, wall_clock: Callable[[], float] | None = None,
                 rand: Callable[[], float] | None = None, user_agent: str = USER_AGENT):
        self.profiles = dict(PROFILES if profiles is None else profiles)
        self._opener = opener
        self._sleep = sleep
        self._clock = clock
        self._wall_clock = wall_clock
        self._rand = rand
        self.user_agent = user_agent
        self._hosts: dict[str, _HostState] = {}

    # -- injectable dependencies ------------------------------------------
    def _open(self, req, timeout):
        # The one urlopen call for every migrated caller. URLs come from
        # module constants plus validated ids, as they did at each call site.
        return (self._opener or urllib.request.urlopen)(req, timeout=timeout)  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected

    def _now(self) -> float:
        return (self._clock or time.monotonic)()

    def _epoch(self) -> float:
        return (self._wall_clock or time.time)()

    def _wait(self, seconds: float) -> None:
        if seconds > 0:
            (self._sleep or time.sleep)(seconds)

    def _random(self) -> float:
        return (self._rand or random.random)()

    # -- helpers -----------------------------------------------------------
    def profile_for(self, url: str) -> HostProfile:
        host = (urllib.parse.urlsplit(url).hostname or "").lower()
        return self.profiles.get(host, DEFAULT_PROFILE)

    def _state(self, url: str) -> _HostState:
        host = (urllib.parse.urlsplit(url).hostname or "").lower()
        return self._hosts.setdefault(host, _HostState())

    def _pace(self, profile: HostProfile, state: _HostState) -> None:
        if profile.min_interval and state.last_start is not None:
            self._wait(state.last_start + profile.min_interval - self._now())
        state.last_start = self._now()

    def _backoff(self, profile: HostProfile, attempt: int) -> float:
        # Equal jitter: half fixed, half random, so retries from different
        # callers do not land in lockstep.
        ceiling = min(profile.backoff_cap, profile.backoff_base * (2 ** (attempt - 1)))
        return ceiling / 2 + self._random() * ceiling / 2

    def _record_failure(self, profile: HostProfile, state: _HostState, url: str) -> None:
        state.failures += 1
        state.consecutive_failures += 1
        if profile.breaker_limit and state.consecutive_failures >= profile.breaker_limit \
                and state.open_until <= self._now():
            state.open_until = self._now() + profile.breaker_cooldown
            state.circuit_opened += 1
            log(f"[http] WARN: {profile.name} circuit open for {profile.breaker_cooldown:.0f}s after "
                f"{state.consecutive_failures} consecutive failures (last: {mask_url(url)})")

    # -- public API --------------------------------------------------------
    def request(self, method: str, url: str, *, headers: dict[str, str] | None = None,
                data: bytes | None = None, timeout: float | None = None) -> Response:
        profile = self.profile_for(url)
        state = self._state(url)
        started = self._now()

        if state.open_until > started:
            state.short_circuited += 1
            raise CircuitOpenError(method, url, f"{profile.name} circuit open for another "
                                   f"{state.open_until - started:.0f}s", attempts=0)

        hdrs = {"User-Agent": self.user_agent, **(headers or {})}
        attempt = 0
        while True:
            attempt += 1
            self._pace(profile, state)
            state.requests += 1
            req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
            status: int | None = None
            retry_after: float | None = None
            try:
                with self._open(req, timeout or profile.timeout) as resp:
                    body = resp.read()
                    status = getattr(resp, "status", None) or 200
                    resp_headers = {k.lower(): v for k, v in dict(getattr(resp, "headers", None) or {}).items()}
            except urllib.error.HTTPError as exc:
                status = exc.code
                state.statuses[status] = state.statuses.get(status, 0) + 1
                retry_after = _retry_after_seconds(exc.headers.get("Retry-After") if exc.headers else None,
                                                   self._epoch())
                retryable = status in profile.retry_statuses
                counts = retryable or status in profile.failure_statuses
                reason = f"HTTP {status}"
                error_cls = HttpStatusError
            except (urllib.error.URLError, OSError) as exc:
                # URLError covers DNS / refused / TLS; OSError covers resets
                # and socket timeouts raised mid-read.
                retryable = counts = True
                reason = f"{type(exc).__name__}: {getattr(exc, 'reason', exc)}"
                error_cls = HttpTransportError
            else:
                state.statuses[status] = state.statuses.get(status, 0) + 1
                state.consecutive_failures = 0
                return Response(url=url, status=status, headers=resp_headers, body=body,
                                attempts=attempt, elapsed=self._now() - started)

            if not counts:
                # A definitive answer (404, 400, ...): the host is healthy.
                state.consecutive_failures = 0
                raise error_cls(method, url, reason, status=status, attempts=attempt,
                                elapsed=self._now() - started)

            if retryable and attempt <= profile.retries:
                delay = self._backoff(profile, attempt)
                if retry_after is not None:
                    delay = min(max(delay, retry_after), profile.backoff_cap)
                state.retries += 1
                log(f"[http] {method} {mask_url(url)}: {reason}, retry {attempt}/{profile.retries} "
                    f"in {delay:.1f}s")
                self._wait(delay)
                continue

            self._record_failure(profile, state, url)
            raise error_cls(method, url, reason, status=status, attempts=attempt,
                            elapsed=self._now() - started)

    def get(self, url: str, **kw) -> Response:
        return self.request("GET", url, **kw)

    def get_json(self, url: str, **kw) -> Any:
        """GET and parse JSON. An HTML body (a CDN or SPA fallback page that
        answered 200) or invalid JSON raises ResponseFormatError."""
        kw.setdefault("headers", {"Accept": "application/json"})
        resp = self.get(url, **kw)
        if resp.headers.get("content-type", "").startswith("text/html") or resp.body.lstrip()[:1] == b"<":
            raise ResponseFormatError("GET", url, "expected JSON, got HTML", status=resp.status,
                                      attempts=resp.attempts, elapsed=resp.elapsed)
        try:
            return json.loads(resp.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ResponseFormatError("GET", url, f"invalid JSON: {exc}", status=resp.status,
                                      attempts=resp.attempts, elapsed=resp.elapsed) from exc

    def summary(self) -> list[str]:
        """One line per host touched, for the end of a run."""
        lines = []
        for host, s in sorted(self._hosts.items()):
            codes = ", ".join(f"{c}x{n}" for c, n in sorted(s.statuses.items())) or "none"
            lines.append(
                f"[http] {host}: {s.requests} requests, {s.retries} retries, {s.failures} failures, "
                f"circuit opened {s.circuit_opened}x, {s.short_circuited} short-circuited; statuses {codes}"
            )
        return lines

    def log_summary(self) -> None:
        for line in self.summary():
            log(line)


_default: HttpClient | None = None


def default_client() -> HttpClient:
    """The process-wide client, so every module shares host pacing and breakers."""
    global _default
    if _default is None:
        _default = HttpClient()
    return _default


def reset_default_client(client: HttpClient | None = None) -> None:
    """Replace (or clear) the process-wide client. For tests."""
    global _default
    _default = client
