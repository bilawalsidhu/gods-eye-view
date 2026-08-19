"""Supervised background polling.

A poller owns one upstream feed: it calls it on a cadence, records health, and never
dies. "Never dies" is the important part. A naive ``while True: await fetch()`` loop
exits permanently the first time a provider returns malformed JSON, and the layer goes
dark with nothing in the logs to explain why.

Two guards live here that exist to stop us being blocked by a provider:

``min_interval_seconds`` is a hard floor per feed, enforced below whatever the
configuration asks for. CelesTrak permanently firewalls clients that poll too fast, so
that limit must not be a configuration value someone can lower by accident.

``NotBefore`` tracking makes the floor hold across restarts within a process, so a
supervisor restarting a failing poller in a tight loop cannot hammer an upstream.
"""

import asyncio
import logging
import random
from collections.abc import Awaitable, Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from tracker.contracts.messages import FeedHealth, LayerName
from tracker.sources.base import RateLimitedError

_log = logging.getLogger(__name__)

MAX_BACKOFF_SECONDS = 300.0
"""Ceiling on failure backoff. Five minutes keeps a recovered feed from taking an hour
to be noticed, while still backing right off from a sustained outage."""

JITTER_FRACTION = 0.15
"""Random spread applied to every sleep, so several pollers started together do not
synchronise into a thundering herd against different endpoints of the same provider."""


@dataclass(slots=True)
class PollerHealth:
    """Mutable health record for one feed. Snapshotted into a contract for the wire."""

    source: str
    layer: LayerName
    poll_interval_seconds: float
    healthy: bool = False
    entity_count: int = 0
    last_success_at: datetime | None = None
    last_error: str | None = None
    consecutive_failures: int = 0
    total_polls: int = 0
    total_failures: int = 0
    rate_limited_until: datetime | None = None

    def to_contract(self) -> FeedHealth:
        return FeedHealth(
            source=self.source,
            layer=self.layer,
            healthy=self.healthy,
            entity_count=self.entity_count,
            last_success_at=self.last_success_at,
            last_error=self.last_error,
            consecutive_failures=self.consecutive_failures,
            poll_interval_seconds=self.poll_interval_seconds,
            rate_limited_until=self.rate_limited_until,
        )


@dataclass(slots=True)
class Poller:
    """Repeatedly calls one async function, forever, recording what happened.

    ``poll`` returns the number of entities it produced, which is used only for health
    reporting. It is expected to do its own storing; the poller deliberately knows
    nothing about stores so the same machinery drives feeds that write nowhere.
    """

    name: str
    layer: LayerName
    poll: Callable[[], Awaitable[int]]
    interval_seconds: float
    min_interval_seconds: float = 1.0
    health: PollerHealth = field(init=False)
    _task: asyncio.Task[None] | None = field(default=None, init=False)
    _not_before: datetime | None = field(default=None, init=False)
    _stopping: asyncio.Event = field(default_factory=asyncio.Event, init=False)

    def __post_init__(self) -> None:
        if self.min_interval_seconds <= 0:
            raise ValueError("min_interval_seconds must be positive")
        self.health = PollerHealth(
            source=self.name,
            layer=self.layer,
            poll_interval_seconds=self.effective_interval,
        )

    @property
    def effective_interval(self) -> float:
        """The cadence actually used: never faster than this feed's documented floor.

        Configuration can slow a feed down but never speed it past its floor. This is the
        guard that stops a careless environment variable getting our IP banned.
        """
        return max(self.interval_seconds, self.min_interval_seconds)

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            raise RuntimeError(f"poller {self.name} is already running")
        self._stopping.clear()
        self._task = asyncio.create_task(self._run(), name=f"poller:{self.name}")

    async def stop(self) -> None:
        """Signal the loop to finish and wait for it, tolerating a stuck request."""
        self._stopping.set()
        task = self._task
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        finally:
            self._task = None

    async def run_once(self) -> bool:
        """Poll exactly once, respecting the cadence floor. Returns whether it ran.

        Public because it is how tests drive a poller deterministically, and how a
        manual refresh endpoint can ask for data without spawning a loop.
        """
        now = datetime.now(UTC)
        if self._not_before is not None and now < self._not_before:
            _log.debug(
                "%s: skipping poll, cadence floor holds until %s", self.name, self._not_before
            )
            return False

        self._not_before = now + timedelta(seconds=self.effective_interval)
        self.health.total_polls += 1
        try:
            count = await self.poll()
        except asyncio.CancelledError:
            raise
        except RateLimitedError as exc:
            # Honour the provider's own figure rather than our backoff curve. Retrying a
            # throttled endpoint on a generic schedule is how a free feed bans an IP.
            self._not_before = datetime.now(UTC) + timedelta(seconds=exc.retry_after_seconds)
            self.health.healthy = False
            self.health.consecutive_failures += 1
            self.health.total_failures += 1
            self.health.last_error = str(exc)
            self.health.rate_limited_until = self._not_before
            _log.warning("%s: %s", self.name, exc)
            return True
        except Exception as exc:
            self.health.healthy = False
            self.health.consecutive_failures += 1
            self.health.total_failures += 1
            self.health.last_error = f"{type(exc).__name__}: {exc}"
            _log.warning(
                "%s: poll failed (%d consecutive): %s",
                self.name,
                self.health.consecutive_failures,
                exc,
            )
            return True

        self.health.healthy = True
        self.health.consecutive_failures = 0
        self.health.last_error = None
        self.health.last_success_at = datetime.now(UTC)
        self.health.rate_limited_until = None
        self.health.entity_count = count
        return True

    def _sleep_seconds(self) -> float:
        """How long to wait before the next attempt, with backoff and jitter.

        Never wakes earlier than the cadence floor allows. Without that clamp a poller
        under a two-minute throttle would still wake every few seconds, find the guard
        closed and go back to sleep: harmless but pointless churn that also hides the
        real wait from anyone reading the logs.
        """
        base = self.effective_interval
        if self.health.consecutive_failures:
            base = min(
                self.effective_interval * (2.0**self.health.consecutive_failures),
                MAX_BACKOFF_SECONDS,
            )
        if self._not_before is not None:
            remaining = (self._not_before - datetime.now(UTC)).total_seconds()
            base = max(base, remaining)
        return max(0.0, base) * (1.0 + random.uniform(-JITTER_FRACTION, JITTER_FRACTION))

    async def _run(self) -> None:
        """The supervised loop.

        Catching ``Exception`` inside the loop rather than around it is the whole design.
        Around it, one bad payload ends the loop forever.
        """
        _log.info("%s: polling every %.1fs", self.name, self.effective_interval)
        while not self._stopping.is_set():
            await self.run_once()
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=self._sleep_seconds())
            except TimeoutError:
                continue
        _log.info("%s: stopped", self.name)


class PollerGroup:
    """Starts and stops a set of pollers together, and reports their health.

    Owned by the application lifespan. Stopping is best-effort and concurrent, because a
    shutdown must not hang on one provider that has stopped answering.
    """

    def __init__(self, pollers: list[Poller] | None = None) -> None:
        self._pollers: list[Poller] = pollers or []

    def add(self, poller: Poller) -> Poller:
        self._pollers.append(poller)
        return poller

    def start_all(self) -> None:
        for poller in self._pollers:
            poller.start()

    async def stop_all(self) -> None:
        await asyncio.gather(*(p.stop() for p in self._pollers), return_exceptions=True)

    def health(self) -> tuple[FeedHealth, ...]:
        return tuple(p.health.to_contract() for p in self._pollers)

    def __len__(self) -> int:
        return len(self._pollers)

    def __iter__(self) -> Iterator[Poller]:
        return iter(self._pollers)
