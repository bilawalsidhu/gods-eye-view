"""Background registry ingest: the owner join runs on a cadence rather than on a click.

Every other upstream in this project is polled. The aircraft-to-owner join was the exception:
:mod:`tracker.services.enrich` was reached from the card path, so an owner arrived only for an
airframe somebody had already clicked, and it arrived through a network round trip inside that
request. This walks the layer instead and warms the same cache ahead of the click, so the card
finds an answer already held and opens no socket.

**It is a cache warmer and nothing else, deliberately.** It writes no store, registers no layer
and produces no delta, because what it fetches is not a position: ownership changes on registry
timescales, not on globe timescales. What it changes is *when* the fetch happens, which is the
whole request. The card path still calls the same enricher against the same cache. A restart
empties that cache, by design, and this is what refills it without anybody clicking.

**A task rather than a Poller, for the reason the city refresh gives.** A poller belongs to a
feed that publishes a new picture on a cadence and registers a layer so deltas reach a browser.
There is no owner layer, no delta channel and no entity count that means anything here, and
wiring one would need a ``LayerName`` for a layer nothing draws.

## The rate, and the sum stated the way AGENTS.md asks

- adsbdb's own limit is **512 requests a minute per IP**, read off its source rather than
  published. At 512 it refuses for 60 seconds; at 1,024 the penalty becomes 300.
- ``sources/adsbdb.py`` holds our budget at **half of that, 256 a minute**, as a constant
  nothing in configuration can raise.
- This ingest takes a **quarter of our budget: 64 a minute**, one every 0.94 seconds, which is
  an eighth of the provider's own floor. The card path keeps the other 192.
- **So the ingest alone can never spend the budget.** That is the point of taking a share
  rather than the lot: a background sweep must not starve the click it exists to serve.

**Time to fill the layer, stated because a rate on its own hides it.** 13,377 aircraft were
held on 2026-08-24 and none of them carried an owner, because nothing had been clicked. A cold
cache fills in 13,377 / 64 = 209 minutes, three and a half hours, against a cache time to live
of a day. Steady state needs 13,377 a day, 9.3 a minute, so the sustained cost is a seventh of
what this is allowed to spend and the rest is headroom for churn. The priority function is what
makes the first minutes worth having: 997 of those aircraft were already classified as business
jets off the feed's own type designator, so the population this demo is about is warm in sixteen
minutes rather than in three and a half hours.

**One pass is one minute of work.** The layer is re-read between batches, so an airframe that
has left the globe is not looked up and one that arrived a minute ago is. A pass that finds
nothing to do sleeps rather than spinning.

## Two things that must survive a restart, and one that must not

**The cache must not.** It holds ``registered_owner``, which is a named individual on a great
many N-numbers, and :class:`tracker.sources.adsbdb.AdsbdbLookup` is the one cache in
``sources/`` deliberately kept off :class:`~tracker.cache.DiskCache` for that reason. Nothing
here changes that: this warms the in-memory cache and holds no answer of its own. A removal
under ADR 008 therefore still reaches everything it reached before, and the test asserting that
no owner name appears in the cache file still passes for the same reason it did.

**A throttle must.** AGENTS.md: in-memory rate state does not survive a restart, and a restart
loop is indistinguishable from hammering. A backoff this ingest is asked for goes to the disk
cache with an expiry, so a process started inside that window makes no request at all. The
expiry comes from the provider's own figure, never from a curve of ours.

**A removal must, and this is the subtle one.** ``forget_all`` empties the owner cache, and
this ingest would otherwise refill it within minutes, automatically, which is precisely the
"next crawl resurrects it" failure AGENTS.md names. So a removal starts a quiet period during
which this fetches nothing: see :meth:`RegistryIngest._removal_quiet_until`. The signal is read
from :class:`~tracker.services.suppression.SuppressionStore`, which is on disk and names
nobody, so it survives a restart for free.

**What the quiet period does not fix, said plainly rather than papered over.** A suppression is
keyed on a ``person_id`` and an adsbdb ``registered_owner`` is a bare name with no person id, so
there is no key that says "never fetch this airframe's owner again". Turning one into the other
means comparing owner names, which means the removal path holding the name it is removing, and
``suppression.py`` exists to make that impossible. So the quiet period delays the re-fetch by
the exact window the removal was protecting, the cache's own day, and after that an airframe's
registered owner is fetched again like any other primary registry record. The card path has
always been able to do the same on a click. A suppression key for a registry owner name is the
real fix and it does not exist yet.
"""

import asyncio
import logging
import math
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import BaseModel

from tracker.cache import DiskCache
from tracker.services.enrich import Enricher
from tracker.services.suppression import SuppressionStore

_log = logging.getLogger(__name__)


def _utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True, slots=True)
class IngestPace:
    """How fast one background ingest may walk one registry, and what it does when idle.

    Args:
        requests_per_minute: The share of our own budget this ingest may spend. A share and
            not the lot, so the demand path it exists to serve cannot be starved by it.
        idle_seconds: How long to wait after a pass that found nothing to look up. Not zero,
            or a fully warm layer becomes a hot loop over the whole store.
    """

    requests_per_minute: float
    idle_seconds: float

    @property
    def seconds_per_request(self) -> float:
        """The gap between two lookups, so the rate is honoured between calls, not after."""
        return 60.0 / self.requests_per_minute

    @property
    def batch(self) -> int:
        """How many records one pass takes: one minute of work, then re-read the layer.

        A minute rather than the whole layer, so a record that has left the globe is not
        looked up and one that arrived a minute ago is. Floored at one, so a pace slower than
        a request a minute still makes progress instead of doing nothing for ever.
        """
        return max(1, math.floor(self.requests_per_minute))


class RegistryIngest[T: BaseModel]:
    """Warm one registry's cache from one layer, ahead of anything asking for it.

    Args:
        enricher: The join itself. Its ``held`` predicate is required rather than optional
            here: see the ``ValueError`` below.
        records: The layer, read fresh on every pass. A snapshot supplier rather than a
            snapshot, because the whole point is that the batch reflects what is on the globe
            now.
        pace: The share of the budget and the idle wait.
        cache: The one disk cache, for the throttle that has to survive a restart. Nothing
            personal is written to it here.
        cooldown_key: Where in that cache this ingest's backoff lives. Passed in rather than
            built here, so nothing under ``services/`` has to name a provider.
        suppression: The removal register, read to hold off after a removal. Optional so a
            test can build an ingest with no removal path, never so the product can.
        removal_quiet_seconds: How long a removal stops this fetching. Derive it from the
            cache time to live the removal was defeating rather than picking a number.
        priority: Which records to reach first, lowest first. The layer is thousands of
            records and a batch is 64, so without this the interesting ones arrive by luck.
        clock: Now. Injected so a test need not sleep.
        sleep: The wait. Injected for the same reason.

    Raises:
        ValueError: ``enricher.held`` is unset. Without it every pass would re-enrich the same
            highest-priority records, answer each one from the lookup's cache, spend the batch
            on cache hits and never advance: a stall that reports itself as working. Loud at
            construction rather than silent for the life of the process.
    """

    def __init__(
        self,
        *,
        enricher: Enricher[T, Any],
        records: Callable[[], Iterable[T]],
        pace: IngestPace,
        cache: DiskCache,
        cooldown_key: str,
        suppression: SuppressionStore | None = None,
        removal_quiet_seconds: float = 0.0,
        priority: Callable[[T], int] | None = None,
        clock: Callable[[], datetime] = _utc_now,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        if enricher.held is None:
            msg = (
                f"{enricher.registry} ingest needs the enricher's held predicate: without it "
                f"every pass spends its batch re-reading cached answers and never advances"
            )
            raise ValueError(msg)
        self._enricher = enricher
        self._records = records
        self._pace = pace
        self._cache = cache
        self._cooldown_key = cooldown_key
        self._suppression = suppression
        self._removal_quiet_seconds = removal_quiet_seconds
        self._priority = priority
        self._clock = clock
        self._sleep = sleep

    async def run_forever(self) -> None:
        """Warm the cache for as long as the process lives.

        Every wait comes back from :meth:`pass_once` rather than being decided here, so the
        throttle, the removal quiet period, the idle wait and the ordinary gap between two
        lookups are all one number arriving from one place.
        """
        while True:
            await self._sleep(await self.pass_once())

    async def pass_once(self) -> float:
        """One batch of lookups. Returns how long to wait before the next pass.

        A registry fault never raises out of here, because
        :meth:`tracker.services.enrich.Enricher.enrich` does not raise: a failure is counted
        on the tally that ``/api/layers`` already serves and the next pass tries again. Only a
        throttle changes the cadence, and it changes it by the provider's own figure.
        """
        waiting = self._holding_off()
        if waiting is not None:
            return waiting
        batch = self._next_batch()
        if not batch:
            return self._pace.idle_seconds
        for index, record in enumerate(batch):
            if index:
                await self._sleep(self._pace.seconds_per_request)
            joined = await self._enricher.enrich(record)
            if joined.retry_after_seconds is not None:
                return self._start_cooldown(joined.retry_after_seconds)
        return self._pace.seconds_per_request

    def _next_batch(self) -> tuple[T, ...]:
        """One minute of work: the highest-priority records the cache does not already hold.

        Deduplicated on the enricher's own key, because an airframe can sit in two stores at
        once (the military endpoint is a separate store from the viewport sweep) and looking
        one up twice in a batch spends two requests on one answer.
        """
        pending: dict[str, T] = {}
        for record in self._records():
            if self._enricher.holds(record):
                continue
            pending.setdefault(self._enricher.key(record), record)
        ordered = list(pending.values())
        if self._priority is not None:
            ordered.sort(key=self._priority)
        return tuple(ordered[: self._pace.batch])

    def _holding_off(self) -> float | None:
        """Seconds this ingest must not fetch for, or ``None`` when it may proceed.

        The throttle is checked before the removal quiet period only because it is the cheaper
        read. Either one holding is enough.
        """
        now = self._clock()
        until = self._cache.get_time(self._cooldown_key)
        if until is not None and until > now:
            return (until - now).total_seconds()
        quiet = self._removal_quiet_until()
        if quiet is not None and quiet > now:
            return (quiet - now).total_seconds()
        return None

    def _removal_quiet_until(self) -> datetime | None:
        """When this ingest may fetch again after the most recent removal.

        ADR 008 makes a removal immediate and ``forget_all`` empties the owner cache, so
        without this the next pass would refill it within a minute and the removal would be
        undone by a crawl. AGENTS.md names exactly that: suppression is keyed independently of
        ingest so the next crawl does not resurrect it.

        The register is read rather than a flag being set by the removal path, because the
        register is already on disk and already names nobody. That buys two things for free: a
        restart does not clear the quiet period, and this module never touches an identity.
        :meth:`~tracker.services.suppression.SuppressionStore.suppressions` returns them sorted
        by time, so the last entry is the newest.
        """
        if self._suppression is None or self._removal_quiet_seconds <= 0:
            return None
        recorded = self._suppression.suppressions()
        if not recorded:
            return None
        return recorded[-1].suppressed_at + timedelta(seconds=self._removal_quiet_seconds)

    def _start_cooldown(self, seconds: float) -> float:
        """Persist a backoff the provider asked for, and return how long it is.

        On disk, with an expiry, because a restart loop is indistinguishable from hammering as
        far as the provider is concerned. Floored at the ordinary gap between two lookups so a
        nonsensically small figure cannot turn this into a hot loop.
        """
        wait = max(seconds, self._pace.seconds_per_request)
        self._cache.set_time(self._cooldown_key, self._clock() + timedelta(seconds=wait))
        _log.info("%s ingest backing off %.0fs", self._enricher.registry, wait)
        return wait
