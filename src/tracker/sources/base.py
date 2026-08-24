"""Shared vocabulary for upstream source adapters.

Rate limiting gets its own exception type because it needs different treatment from a
generic failure. A 500 is worth retrying promptly; a 429 retried promptly is how an IP
gets permanently blocked. Several providers here are free and run on donations, and one
of them (CelesTrak) firewalls abusive clients without appeal.

adsb.lol answers with **420** rather than 429 when it is throttling. That is not a
standard code, it was observed live on 2026-08-19 against ``/v2/mil``, and treating it as
a plain client error would mean hammering an endpoint that has explicitly asked us to
stop.

:func:`describe_exception` is here for the same reason: several httpx exceptions carry no
message at all, so every adapter that puts a failure in front of a person needs the same
renderer rather than its own.
"""

import logging
from collections import Counter
from dataclasses import dataclass, field
from typing import Final, Protocol

import httpx

_log = logging.getLogger(__name__)

RATE_LIMIT_STATUS_CODES: Final = frozenset({420, 429})
"""Status codes that mean "slow down", not "you are broken".

429 is the standard. 420 ("enhance your calm") is what adsb.lol actually returns, seen
live against ``/v2/mil``.
"""

DEFAULT_RATE_LIMIT_BACKOFF_SECONDS: Final = 120.0
"""Used when a throttling response carries no ``Retry-After`` header.

Deliberately generous. Guessing short risks a ban; guessing long costs one stale poll.
"""

MAX_RATE_LIMIT_BACKOFF_SECONDS: Final = 3600.0
"""Cap, so a provider sending an absurd ``Retry-After`` cannot silence a layer for a day."""


class SourceError(Exception):
    """Base for every upstream failure this package raises."""

    def __init__(self, source: str, detail: str) -> None:
        self.source = source
        self.detail = detail
        super().__init__(f"{source}: {detail}")


class RateLimitedError(SourceError):
    """An upstream asked us to back off.

    Carries ``retry_after_seconds`` so the poller can honour the provider's own figure
    instead of applying a generic backoff curve that might be far too aggressive.
    """

    def __init__(self, source: str, status_code: int, retry_after_seconds: float) -> None:
        self.status_code = status_code
        self.retry_after_seconds = min(
            max(retry_after_seconds, 1.0), MAX_RATE_LIMIT_BACKOFF_SECONDS
        )
        super().__init__(
            source,
            f"rate limited (HTTP {status_code}); backing off "
            f"{self.retry_after_seconds:.0f}s before retrying",
        )


def retry_after_seconds(response: httpx.Response) -> float:
    """Read ``Retry-After`` from a throttling response, falling back to a safe default.

    The header may be a delay in seconds or an HTTP date. Only the numeric form is
    honoured; a date form falls back to the default rather than risking a parse bug that
    computes a negative delay and turns into a hot retry loop.
    """
    raw = response.headers.get("retry-after", "").strip()
    if not raw:
        return DEFAULT_RATE_LIMIT_BACKOFF_SECONDS
    try:
        return float(raw)
    except ValueError:
        _log.debug("unparseable Retry-After %r; using default backoff", raw)
        return DEFAULT_RATE_LIMIT_BACKOFF_SECONDS


def describe_exception(exc: BaseException) -> str:
    """Render an exception as a reason a person can read, never as an empty string.

    Several httpx exceptions stringify to nothing. ``ConnectTimeout`` and ``ReadTimeout``
    both carry no message, so ``f"{exc}"`` renders an empty string and
    ``f"{type(exc).__name__}: {exc}"`` renders a dangling colon. Both were seen live on
    2026-08-20: adsb.lol logged ``failed for /v2/lat/... ()`` and CelesTrak served
    ``unreachable: ConnectTimeout: `` to ``/api/health``, ``/api/capabilities`` and the
    browser's layer rail. An empty reason reads as a layer that is broken for no stated
    reason, which is worse than a blunt one.

    The type name is always there, because it is the only part guaranteed to exist. The
    message is appended when there is one, and nothing is punctuated onto the end when
    there is not.
    """
    message = str(exc).strip()
    name = type(exc).__name__
    return f"{name}: {message}" if message else name


@dataclass(frozen=True, slots=True)
class ParsedRecords[T]:
    """One upstream response, mapped: the records that survived and why the rest did not.

    This is the contract's "dropped and counted" made returnable instead of logged and
    forgotten. A parse that keeps the count to itself leaves the wiring nothing to serve,
    and ``/api/layers`` then reports zero drops while the log says otherwise, which is
    exactly the state this repo was in on 2026-08-20.

    ``drops`` is keyed by reason, so a poll that loses half its records says which half.
    Reasons are the adapter's own words: an MMSI belonging to a search-and-rescue aircraft
    reads as exactly that.

    Generic over the record type because the shape is the same whatever the layer, and one
    shape is what lets ``app.py`` treat every provider the same way.
    """

    records: tuple[T, ...]
    drops: Counter[str] = field(default_factory=Counter)

    @property
    def dropped(self) -> int:
        """How many records did not map. Zero on a clean poll."""
        return sum(self.drops.values())


class PollingSource(Protocol):
    """A feed we ask for data on a cadence.

    ``min_interval_seconds`` is the provider's documented floor, owned by the adapter
    rather than by configuration, so it cannot be lowered from the environment.
    """

    @property
    def name(self) -> str:
        """Short identifier for this feed, used in health output and logs."""
        ...

    @property
    def min_interval_seconds(self) -> float:
        """The provider's documented polling floor, in seconds."""
        ...
