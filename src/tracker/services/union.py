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
        return cls(provider=provider, error=f"{type(exc).__name__}: {exc}")

    @property
    def failed(self) -> bool:
        """Whether this provider dropped out of the union for this cycle."""
        return self.error is not None


@dataclass(frozen=True, slots=True)
class ProviderSighting:
    """One provider's sight of one asset: when the fix was taken and how old it now is.

    ``age_s`` is measured at the merge, not at the response, so a card can show why one
    provider's view of an asset is worth less than another's.
    """

    provider: str
    reported_at: datetime
    age_s: float


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
        """Every provider that saw this asset, freshest first."""
        return tuple(sighting.provider for sighting in self.sightings)


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


def merge_providers[T](
    results: Iterable[ProviderResult[T]],
    *,
    key: Callable[[T], str],
    reported_at: Callable[[T], datetime],
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
            _merge_one(identity, by_provider, now=now) for identity, by_provider in seen.items()
        ),
        provider_results=polled,
    )


def _merge_one[T](
    identity: str,
    by_provider: Mapping[str, tuple[datetime, T]],
    *,
    now: datetime,
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
                )
                for provider, (fixed_at, _) in by_provider.items()
            ),
            key=lambda sighting: (-sighting.reported_at.timestamp(), sighting.provider),
        )
    )
    return MergedRecord(
        key=identity,
        value=by_provider[sightings[0].provider][1],
        sightings=sightings,
    )
