"""Attaching registry metadata to a live record, keyed on the record's own identity.

A feed says where an aircraft is. A registry says whose it is. This module joins the two,
and it is the only place that join happens, because phase 5 adds the national registers and
phase 6 adds organisations and people to exactly the same shape.

It knows nothing about aircraft. The identity function, the upstream lookup and the merge
all arrive as callables, the same way :func:`~tracker.services.union.merge_providers` takes
``key`` and ``reported_at``. The provider quirks stay in ``sources/`` where the rest of them
already live: adsbdb answers uppercase for a lowercase hex, serves the same body for a
registration as for a Mode S address, and returns 404 for about one real aircraft in five.
All three belong to the adapter, none of them here.

There is no plugin registry, no factory and no base class. Two known callers, adsbdb now
and the registries in phase 5, justify one shared shape and nothing more.

**Caching is the lookup's job, not this module's.** ``sources/adsbdb.py`` already caches per
identity with a TTL, keeps the answer "this register does not hold that airframe", never
caches a failure, and holds the request budget in the same place. A second cache here would
be dead weight in front of it, and worse than dead weight: a removal under ADR 008 that
cleared this one and left the adapter's would look like it had worked. So the adapter owns
the cache, owns the eviction and owns those tests, and the removal hook is
:meth:`tracker.sources.adsbdb.AdsbdbLookup.forget`.

Three rules survive here, and each one is a bug worth naming.

**A failed lookup degrades the record to feed-only data and never to an error.** An aircraft
whose owner cannot be fetched still has a position, a callsign and a type, and it renders
with all of them. The card losing its owner is a smaller loss than the card losing the
aircraft.

**A failure leaves no trace, so the next attempt is a real attempt.** Nothing here remembers
that a lookup failed. A memoised failure would leave that aircraft unenriched for the life
of the process, and it would read as thin registry coverage rather than as a fault.

**The feed keeps any attribute it supplied, and the disagreement is recorded rather than
dropped.** See :func:`_keep_feed_values` for why.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel
from pydantic.fields import FieldInfo

from tracker.sources.base import RateLimitedError, describe_exception


def _utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True, slots=True)
class AttributeConflict:
    """One attribute where the registry disagrees with the feed. Both values are kept.

    Held on the result so a card can show the disagreement instead of a single value that
    quietly won. ``registry_value`` is what the registry said, and it is not applied.
    """

    attribute: str
    feed_value: object
    registry_value: object


@dataclass(frozen=True, slots=True)
class Enriched[T]:
    """One record after enrichment, whether or not the enrichment worked.

    ``value`` is always renderable. On a clean lookup it carries the registry metadata; on a
    miss or a failure it is the feed's own record, unchanged and the same object that was
    handed in. There is no error state and no absent record, because the alternative is a
    working aircraft disappearing because a second-hand database timed out.

    ``registry`` and ``joined_at`` are the join's own provenance, which ADR 011 wants on
    every claim. ``joined_at`` dates **this join** and is not the date the registry answer
    was fetched: the lookup may have served it from cache, and only the facts themselves
    know when they arrived. Where a registry carries a retrieval date it rides on the facts
    and reaches the record through the merge. The feed half of the provenance is already on
    the record, in its own ``source`` and ``observed_at``.
    """

    key: str
    value: T
    joined_at: datetime
    registry: str | None = None
    conflicts: tuple[AttributeConflict, ...] = ()
    error: str | None = None
    retry_after_seconds: float | None = None
    """How long the registry asked us to wait, when the fault was a throttle rather than a
    failure. ``None`` on every other outcome, including every other kind of failure.

    Here because a caller that walks a layer has to be able to tell "back off for 60 seconds"
    from "this one aircraft timed out": the first must stop the walk and the second must not.
    The card path ignores it and degrades to feed-only data either way, which is why this rides
    on the result rather than being raised.

    The figure is the provider's own, from
    :class:`~tracker.sources.base.RateLimitedError`, never a curve of ours.
    """

    @property
    def enriched(self) -> bool:
        """Whether registry metadata was applied to :attr:`value`."""
        return self.registry is not None


@dataclass(slots=True)
class EnrichmentTally:
    """Cumulative enrichment outcomes for one registry, across the life of the process.

    An :class:`Enriched` describes one record and is thrown away by its caller, so on its
    own a registry that has failed every lookup since start-up is indistinguishable from one
    that failed the last one. Dropped and counted has to mean counted somewhere a person can
    read it, which is here and then on ``/api/layers``.

    ``failures`` is the registry not answering. ``unmappable`` is the registry answering
    something the domain contract will not take, which is the same drop-and-count rule the
    source adapters follow, applied one layer up.
    """

    registry: str
    requests: int = 0
    enriched: int = 0
    not_held: int = 0
    failures: int = 0
    unmappable: int = 0
    conflicts: int = 0
    last_error: str | None = None


@dataclass(slots=True)
class Enricher[T: BaseModel, R]:
    """One registry, joined to one kind of live record, on demand.

    Args:
        registry: The registry's name, shown as provenance on the card. Not a base URL.
        lookup: Ask the registry about one identity. Returns the registry's facts, or
            ``None`` when the registry answered and does not hold that identity. Raises on
            anything that is not an answer: a timeout, a throttle, a spent request budget, a
            shape nobody recognises. It owns its own caching and its own rate limiting,
            because both are provider concerns and both are already built where the provider
            is.
        merge: Apply the registry's facts to the record, returning a new record. Runs through
            the domain contract's own validation, so a value the registry sends that the
            contract will not take fails here and the record survives unenriched rather than
            reaching the globe unvalidated.
        key: The record's existing identity: the ICAO 24-bit address for an aircraft, the
            MMSI for a vessel. Passed to ``lookup`` as-is, so it has to be the domain's own
            casing rather than the upstream's.
        clock: Now, for the join date. Injected so tests need not sleep.

    One record at a time, whoever is asking. The card path asks about the aircraft somebody
    clicked; :class:`tracker.services.ingest.RegistryIngest` asks about the layer, a paced
    batch at a time, so the answer is usually already cached by the time a card wants it.
    Neither of them may sweep the layer in one go: adsbdb's own limiter allows 512 requests a
    minute per IP and a live aircraft layer is thousands of records a cycle, so a full sweep
    would be throttled inside the first pass. The pacing belongs to the caller, because the
    caller is the only thing that knows whether it is serving a click or walking a globe.
    """

    registry: str
    lookup: Callable[[str], Awaitable[R | None]]
    merge: Callable[[T, R], T]
    key: Callable[[T], str]
    clock: Callable[[], datetime] = _utc_now
    held: Callable[[str], bool] | None = None
    """Whether the lookup already holds a live answer for one identity, so no request is due.

    Optional because a lookup is not obliged to cache, and absent means "ask, every time",
    which is what a card path wants anyway. A caller that walks a layer needs it: without a way
    to skip what is already held, every pass spends its whole batch re-reading cached answers
    and never reaches the rest of the layer.

    A predicate rather than the cache itself, because the cache is the lookup's business. This
    module already refuses to hold a second one: a removal under ADR 008 that cleared a cache
    here and left the adapter's would look like it had worked.
    """
    tally: EnrichmentTally = field(init=False)

    def __post_init__(self) -> None:
        self.tally = EnrichmentTally(registry=self.registry)

    def holds(self, record: T) -> bool:
        """Whether a lookup for this record would be answered without a request.

        ``False`` when no :attr:`held` predicate was supplied, because "we cannot tell" and
        "we do not have it" have the same safe consequence here: ask.
        """
        return self.held is not None and self.held(self.key(record))

    async def enrich(self, record: T) -> Enriched[T]:
        """Join one record to the registry, degrading to the record itself on any fault.

        No registry fault reaches the caller. Every one of those paths returns something
        renderable, because the caller is a card being drawn and there is nothing useful for
        it to do with an exception. Cancellation still propagates, since that is a shutdown
        rather than an upstream fault, and a defect in our own conflict resolution raises
        rather than being disguised as a bad answer from the registry.

        One record at a time on purpose. A caller wanting several can gather, and it then
        owns the concurrency limit against its own registry's budget rather than inheriting
        a guess made here.
        """
        key = self.key(record)
        self.tally.requests += 1
        try:
            facts = await self.lookup(key)
        except Exception as exc:  # noqa: BLE001 - a registry fault must not lose the record
            return self._degraded(key, record, exc, unmappable=False)
        if facts is None:
            self.tally.not_held += 1
            return Enriched(key=key, value=record, joined_at=self.clock())
        try:
            merged = self.merge(record, facts)
        except Exception as exc:  # noqa: BLE001 - facts that will not map are dropped, counted
            return self._degraded(key, record, exc, unmappable=True)
        value, conflicts = _keep_feed_values(record, merged)
        self.tally.enriched += 1
        self.tally.conflicts += len(conflicts)
        return Enriched(
            key=key,
            value=value,
            joined_at=self.clock(),
            registry=self.registry,
            conflicts=conflicts,
        )

    def _degraded(self, key: str, record: T, exc: Exception, *, unmappable: bool) -> Enriched[T]:
        """Count a fault and hand the feed's own record back, unchanged.

        A throttle is counted as a failure like any other, because from the tally's point of
        view the registry did not answer. What it also does is put the provider's own wait on
        the result, so a caller walking a layer can stop rather than working through the rest
        of its batch into a refusal. See :attr:`Enriched.retry_after_seconds`.
        """
        reason = describe_exception(exc)
        if unmappable:
            self.tally.unmappable += 1
        else:
            self.tally.failures += 1
        self.tally.last_error = reason
        return Enriched(
            key=key,
            value=record,
            joined_at=self.clock(),
            error=reason,
            retry_after_seconds=(
                exc.retry_after_seconds if isinstance(exc, RateLimitedError) else None
            ),
        )


def _keep_feed_values[T: BaseModel](feed: T, merged: T) -> tuple[T, tuple[AttributeConflict, ...]]:
    """Let the feed keep every attribute it supplied, and record what the registry said.

    **The feed wins, and the registry's value is kept beside it rather than dropped.** Two
    reasons, and both are rules this repo already holds.

    The feed's value is dated and the registry's is not. adsbdb's aircraft body carries no
    as-of date at all, which is why ``AircraftRegistration.retrieved_at`` is our fetch time
    and not a registry extract date, and ADR 008 drops an undated value rather than asserting
    on it. So an undated claim does not displace a value that arrived with a timestamp we
    hold. R2 in ``docs/pending-decisions.md`` scopes ADR 011's both-values-stay rule to
    enriched attributes and leaves live positions to recency, and this is where that scoping
    starts to bite: ``registration`` is the field where it happens, because adsb.lol's ``r``
    and adsbdb's ``registration`` are both mirrors of a national register and they disagree
    on a re-registered airframe.

    The second reason is structural. Feed-wins makes it impossible for enrichment to move an
    aircraft, restamp its observation or change its identity, whatever the injected merge
    does, rather than leaving that to a rule someone has to remember. A merge that rewrites
    ``point`` gets reverted and says so out loud.

    An attribute the feed did not supply is filled silently and is not a conflict. Not
    supplied means ``None`` or the contract's own default, so an aircraft whose class is
    ``UNKNOWN`` or whose ``is_military`` is ``False`` can be told otherwise by a register. A
    required field always counts as supplied, since the feed had to provide it.

    Reverted values come straight off the already-validated feed record, so ``model_copy``
    here cannot put anything past the contract.
    """
    conflicts: list[AttributeConflict] = []
    restore: dict[str, Any] = {}
    for name, info in type(feed).model_fields.items():
        feed_value = getattr(feed, name)
        merged_value = getattr(merged, name)
        if feed_value == merged_value or _unsupplied(feed_value, info):
            continue
        conflicts.append(
            AttributeConflict(attribute=name, feed_value=feed_value, registry_value=merged_value)
        )
        restore[name] = feed_value
    if not restore:
        return merged, ()
    return merged.model_copy(update=restore), tuple(conflicts)


def _unsupplied(value: object, info: FieldInfo) -> bool:
    """Whether a field holds nothing the feed actually told us.

    ``None`` or the contract's declared default. A required field has no default, and
    ``get_default`` then returns pydantic's undefined sentinel, which equals nothing, so a
    required field reads as supplied.
    """
    return value is None or value == info.get_default(call_default_factory=True)
