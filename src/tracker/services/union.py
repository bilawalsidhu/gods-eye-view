"""Merging one live-mover layer out of several providers.

ADR 010: a layer is the union of what its providers return, not whichever one answered
first. Two volunteer ADS-B networks do not see the same aircraft, because each network is
the union of its own volunteers' receivers and because most of them drop or fuzz aircraft
on the FAA blocking programmes. Polling both and merging adds coverage that the failover
inside ``sources/adsb.py`` cannot, and the aircraft most likely to be missing from one
network are exactly the aircraft a wealth profile is about.

This module does the merging and nothing else. It does not poll, it does not store, and
it knows nothing about aircraft or vessels: vessels merge on MMSI in phase 2 and aircraft
merge on the ICAO 24-bit address in phase 3, through the same function.

Four rules here are load-bearing, and each one is a bug ADR 010 names by hand.

**One record per identity.** The same asset reported by three networks is one record.
Counting it three times draws a phantom fleet and inflates every number on screen.

**Recency wins and provider precedence never does.** A stale position from a preferred
network must not beat a fresh one from another, which is the opposite of what this
product is demonstrating. The freshest report supplies the record; nothing else is
consulted.

**Nothing is averaged.** The winning position is the one some receiver actually reported,
returned as the same object the adapter produced. Two providers half a mile apart do not
become a third point between them that nobody saw.

**An empty answer is not a failure.** AISHub signals a bad username, and a call made too
often, with an empty HTTP 200. So "this provider saw nothing" and "this provider fell
over" have to be different states in the result, or a merged store quietly loses every
asset only the broken provider could see. They are different states here: an empty
success still counts as reporting, a failure names the provider as missing and the layer
reads degraded.

**Recency dropping the superseded report is a provisional reading, R2 in
``docs/pending-decisions.md``, and it is reversible here.** ADR 010 says a position conflict
resolves by recency; ADR 011 says conflicting dated values both stay with the
disagreement shown. R2 scopes ADR 011's rule to enriched profile attributes and leaves
positions to recency, because a position is one observation of one physical object at one
instant rather than a competing claim about a fact, and keeping both would draw two pins
for one aircraft. Reverse the reading and this module changes; nothing downstream of it
assumes either way.
"""

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Self

from tracker.sources.base import describe_exception


def _utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True, slots=True)
class ProviderResult[T]:
    """One provider's outcome for one cycle: what it returned, or why it returned nothing.

    Providers are polled concurrently by the caller and each outcome lands in one of
    these. ``error`` set means the provider dropped out of the union for this cycle: it
    timed out, was rate limited, lost its key, or served a shape the adapter does not
    recognise. ``records`` empty with no error means it answered and saw nothing, which
    is a legitimate answer.
    """

    provider: str
    records: tuple[T, ...] = ()
    error: str | None = None

    def __post_init__(self) -> None:
        if self.error is not None and self.records:
            msg = f"{self.provider}: a failed provider cannot also carry records"
            raise ValueError(msg)

    @classmethod
    def from_error(cls, provider: str, exc: BaseException) -> Self:
        """A provider that dropped out, described the way the poller describes a failure."""
        # Rendered rather than interpolated. This string is served as the provider's error
        # on /api/layers and inside degraded_reason, and several httpx exceptions carry no
        # message: interpolating one leaves a dangling colon and no reason.
        return cls(provider=provider, error=describe_exception(exc))

    @property
    def failed(self) -> bool:
        """Whether this provider dropped out of the union for this cycle."""
        return self.error is not None


@dataclass(frozen=True, slots=True)
class ProviderSighting:
    """One provider's sight of one asset: when the fix was taken and how old it now is.

    ``age_s`` is measured at the merge, not at the response, so a card can show why one
    provider's view of an asset is worth less than another's.

    **``provider`` and ``served_by`` are two different questions and conflating them was a
    live bug.** ``provider`` is the union member we polled. ``served_by`` is the host whose
    bytes this record actually is, which differs whenever an adapter fails over internally:
    ``AdsbClient`` polls adsb.lol and falls back to adsb.fi inside one provider row, so a
    cycle can hand back records served by adsb.fi under the member name adsb.lol. Measured
    live on 2026-08-23: two of 1,040 aircraft reached the API reading
    ``source: adsb.fi`` beside ``providers: ["adsb.lol"]``.

    That is a licence misstatement rather than a cosmetic one. adsb.lol publishes under ODbL
    1.0 and adsb.fi under non-commercial terms, so a card crediting the wrong one of the two
    states the wrong licence for the data on screen. Keep both: attribution follows
    ``served_by``, and coverage maths such as :meth:`UnionResult.attributable_counts` follows
    ``provider``, because "aircraft only this feed can see" is a question about what we
    polled, not about which host answered on the day.
    """

    provider: str
    reported_at: datetime
    age_s: float
    served_by: str


@dataclass(frozen=True, slots=True)
class MergedRecord[T]:
    """One asset, once, plus every provider that saw it.

    ``value`` is the freshest report, exactly as the adapter produced it. ``sightings``
    runs freshest first and holds one entry per provider, so the record itself can say
    which networks saw this asset and how stale each of them is. That evidence rides on
    the record rather than on the layer, because a merged store that cannot say which
    network saw a given asset is unauditable.
    """

    key: str
    value: T
    sightings: tuple[ProviderSighting, ...]

    @property
    def provider(self) -> str:
        """The provider whose report supplied :attr:`value`."""
        return self.sightings[0].provider

    @property
    def providers(self) -> tuple[str, ...]:
        """Every host that served this asset, freshest first, for attribution.

        The serving hosts rather than the polled members, so this list agrees with the
        record's own ``source`` field: both contracts promise that the first entry is the
        one named in ``source``, and before ``served_by`` existed an internal failover broke
        that promise silently. Duplicates are collapsed, keeping the freshest position, since
        two members failing over to one host is one host's data twice and not corroboration.
        """
        ordered = dict.fromkeys(sighting.served_by for sighting in self.sightings)
        return tuple(ordered)


@dataclass(frozen=True, slots=True)
class UnionResult[T]:
    """The merged layer for one cycle, carrying the provider evidence that produced it.

    ``provider_results`` is kept verbatim so the degradation reporting is derived from
    what actually came back rather than from a summary somebody has to remember to keep
    in step.
    """

    records: tuple[MergedRecord[T], ...]
    provider_results: tuple[ProviderResult[T], ...]

    @property
    def reporting(self) -> tuple[str, ...]:
        """Providers that answered, including any that answered with nothing."""
        return tuple(r.provider for r in self.provider_results if not r.failed)

    @property
    def empty(self) -> tuple[str, ...]:
        """Providers that answered and saw no assets. Thin coverage, not a fault."""
        return tuple(r.provider for r in self.provider_results if not r.failed and not r.records)

    @property
    def missing(self) -> tuple[str, ...]:
        """Providers that dropped out, so the union is short of whatever only they see."""
        return tuple(r.provider for r in self.provider_results if r.failed)

    @property
    def degraded(self) -> bool:
        """Whether any provider dropped out. The layer still serves; it covers less."""
        return any(r.failed for r in self.provider_results)

    @property
    def degraded_reason(self) -> str | None:
        """Why the layer is degraded, naming each missing provider, or ``None`` if it is not.

        Named rather than counted because "one provider down" tells a viewer nothing
        about what is missing from the globe, and the providers are not interchangeable:
        losing the unfiltered one loses exactly the aircraft this product cares about.
        """
        failures = [f"{r.provider}: {r.error}" for r in self.provider_results if r.failed]
        return "; ".join(failures) if failures else None

    def keyed(self) -> tuple[tuple[str, T], ...]:
        """The merged entities as ``(key, value)`` pairs, ready for a store.

        Feeds :meth:`~tracker.services.store.EntityStore.upsert_many` directly.
        ``replace_all`` is the caller's decision and a dangerous one on a degraded cycle,
        since it would remove every asset the missing provider was the only one to see:
        branch on :attr:`degraded` before reaching for it.
        """
        return tuple((record.key, record.value) for record in self.records)

    def attributable_counts(self) -> Mapping[str, int]:
        """How many assets each provider was the only one to see.

        This is the commercial argument for a paid feed, measured rather than asserted:
        "aircraft only ADS-B Exchange can see" is this number. Every reporting provider
        gets an entry, zero included, so a provider that added nothing this cycle says so
        rather than dropping out of the table.
        """
        counts = dict.fromkeys(self.reporting, 0)
        for record in self.records:
            if len(record.sightings) == 1:
                counts[record.provider] += 1
        return counts


@dataclass(slots=True)
class ProviderTally:
    """Cumulative outcomes for one provider of one merged layer, across every cycle.

    :class:`UnionResult` describes one cycle and is replaced by the next one, so on its own
    a provider that has failed every cycle for a week is indistinguishable from one that
    failed once. ADR 010 says an empty AISHub 200 is "an error, counted", and the plan's
    phase 2 acceptance 8 says "counted as a failed poll": this is where that count lives,
    because the single union poller stays healthy when one provider drops out and so its own
    failure counters never move.

    ``empty_polls`` is the same argument for the answer that is not a failure. A provider
    reporting nothing every cycle is thin coverage once and a broken feed a thousand times,
    and the layer cannot tell them apart from the current cycle alone.

    ``drops`` is the records the adapter refused, added per cycle where the adapter hands the
    count back. Dropped and counted has to mean counted somewhere a human can read it, not
    logged and discarded by the wiring.
    """

    provider: str
    polls: int = 0
    failures: int = 0
    empty_polls: int = 0
    drops: int = 0
    last_success_at: datetime | None = None


def record_cycle[T](
    tallies: dict[str, ProviderTally],
    union: UnionResult[T],
    *,
    clock: Callable[[], datetime] = _utc_now,
) -> None:
    """Add one merge cycle to the running per-provider tallies, creating them as needed.

    Called by the poller after every merge. Keyed on the provider name rather than held on
    the result, so the history survives the result being replaced.
    """
    now = clock()
    for result in union.provider_results:
        tally = tallies.setdefault(result.provider, ProviderTally(provider=result.provider))
        tally.polls += 1
        if result.failed:
            tally.failures += 1
            continue
        if not result.records:
            tally.empty_polls += 1
        tally.last_success_at = now


def count_drops(tallies: dict[str, ProviderTally], provider: str, dropped: int) -> None:
    """Add the records one provider's adapter refused this cycle to its running total."""
    tally = tallies.setdefault(provider, ProviderTally(provider=provider))
    tally.drops += dropped


def merge_providers[T](
    results: Iterable[ProviderResult[T]],
    *,
    key: Callable[[T], str],
    reported_at: Callable[[T], datetime],
    served_by: Callable[[T], str] | None = None,
    clock: Callable[[], datetime] = _utc_now,
) -> UnionResult[T]:
    """Merge concurrent provider results into one record per identity.

    Args:
        results: One outcome per provider, in whatever order they were polled. A failed
            outcome contributes no records and is named in the result.
        key: The asset's existing stable identity: ICAO 24-bit address for aircraft, MMSI
            for vessels. Never a generated or positional key, or an asset duplicates
            itself every time it moves.
        reported_at: When this record's position was actually fixed. Injected rather than
            read off a field because "when was this report taken" differs per feed and is
            usually not the response time. An ``Aircraft`` fix is
            ``observed_at - position_age_s``: ``observed_at`` is when the provider built
            the response, and the position inside it can be seconds older. Resolving a
            conflict on response time would let a slow provider's stale fix win, which is
            provider precedence wearing a recency costume.
        served_by: The host whose bytes a record actually is, where that can differ from
            the member we polled. Omit it and the polled member is assumed to be the
            serving host, which is right for any adapter that talks to exactly one host.
            Pass it wherever an adapter fails over internally: ``AdsbClient`` polls
            adsb.lol and falls back to adsb.fi under one member name, so without this the
            record's ``providers`` list credits adsb.lol for adsb.fi's data and states
            adsb.lol's licence over it. See :class:`ProviderSighting`.
        clock: Now, for the report ages. Injected so tests need not sleep.

    Returns:
        The union: one :class:`MergedRecord` per identity, plus the provider evidence.
    """
    polled = tuple(results)
    now = clock()
    seen: dict[str, dict[str, tuple[datetime, T]]] = {}
    for result in polled:
        if result.failed:
            continue
        for record in result.records:
            by_provider = seen.setdefault(key(record), {})
            fixed_at = reported_at(record)
            previous = by_provider.get(result.provider)
            if previous is None or fixed_at > previous[0]:
                by_provider[result.provider] = (fixed_at, record)
    return UnionResult(
        records=tuple(
            _merge_one(identity, by_provider, now=now, served_by=served_by)
            for identity, by_provider in seen.items()
        ),
        provider_results=polled,
    )


def _merge_one[T](
    identity: str,
    by_provider: Mapping[str, tuple[datetime, T]],
    *,
    now: datetime,
    served_by: Callable[[T], str] | None = None,
) -> MergedRecord[T]:
    """Take the freshest of one asset's reports and keep the rest as evidence.

    Freshest wins outright. Nothing is combined and nothing is interpolated, so the
    record holds a position a receiver reported rather than an average of two. Ties go to
    the provider that sorts first: with two fixes at the same instant there is nothing to
    choose between them, and a stable answer beats a coin toss that makes an asset jitter
    between two positions on every poll.
    """
    sightings = tuple(
        sorted(
            (
                ProviderSighting(
                    provider=provider,
                    reported_at=fixed_at,
                    age_s=max(0.0, (now - fixed_at).total_seconds()),
                    served_by=provider if served_by is None else served_by(record),
                )
                for provider, (fixed_at, record) in by_provider.items()
            ),
            key=lambda sighting: (-sighting.reported_at.timestamp(), sighting.provider),
        )
    )
    return MergedRecord(
        key=identity,
        value=by_provider[sightings[0].provider][1],
        sightings=sightings,
    )
