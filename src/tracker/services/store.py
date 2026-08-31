"""In-memory live entity store with expiry and change tracking.

One store per layer. It answers three questions: what is live right now (for a REST
snapshot or a newly connected client), what changed since the last flush (for a
WebSocket delta), and what has gone quiet long enough to remove from the globe.

Expiry is the part that matters most for honesty. A feed that stops reporting an aircraft
means it has landed, gone out of receiver range, or switched its transponder off. Leaving
the last known position on screen forever would show a fleet of aircraft that are not
there, so entities are dropped once their fix ages past a time to live.
"""

from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime


def _utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(slots=True)
class _Tracked[T]:
    value: T
    updated_at: datetime


@dataclass(slots=True)
class StoreChanges[T]:
    """What changed in a store between two flushes.

    ``upserted`` carries whole entities because the frontend replaces rather than patches;
    ``removed`` carries only keys because there is nothing left to send.
    """

    upserted: tuple[T, ...] = ()
    removed: tuple[str, ...] = ()

    @property
    def is_empty(self) -> bool:
        """Whether nothing at all changed since the last take."""
        return not self.upserted and not self.removed


@dataclass(slots=True)
class EntityStore[T]:
    """Keyed live entities with a time to live and pending-change accounting.

    Generic over the entity type so aircraft, vessels, satellites and events all share
    one implementation. The key must be a stable identity from the source: an ICAO
    address, an MMSI, a NORAD catalogue number. Never a positional or generated key, or
    an entity will duplicate itself every time it moves.

    Not thread-safe, and deliberately so. Everything touching it runs on one asyncio
    event loop, and a lock here would be pure overhead plus a false sense of safety.
    """

    ttl_seconds: float
    clock: Callable[[], datetime] = _utc_now
    fix_time: Callable[[T], datetime] | None = None
    """When a value's position was actually fixed, for a store that must not go backwards.

    Optional because the rule needs a report time and not every entity has one: a satellite
    carries an element set rather than an observation, so its store leaves this unset and
    keeps last-write-wins.

    Where it is set, an incoming report older than the one already held is not stored, per
    ADR 010: conflicts resolve by recency and never by provider precedence. Without it
    recency only holds inside one poll cycle, because the merge compares the reports of that
    cycle and the store then takes whatever it is handed. A provider re-serving a stale fix
    while the freshest provider skips a cycle would walk a ship backwards across the globe,
    which is provider precedence arriving by accident.
    """

    _entities: dict[str, _Tracked[T]] = field(default_factory=dict, init=False)
    _pending_upserts: set[str] = field(default_factory=set, init=False)
    _pending_removals: set[str] = field(default_factory=set, init=False)

    def upsert(self, key: str, value: T) -> None:
        """Insert or replace an entity and mark it as changed.

        A store with a :attr:`fix_time` keeps the newer fix and does not queue a delta for
        the older one, so nothing on screen moves backwards. The held record's update time
        is still refreshed, because a provider re-reporting a stale fix is still a provider
        reporting: expiring the ship instead would take it off the globe while a feed is
        actively naming it.
        """
        held = self._entities.get(key)
        if held is not None and self._is_older(value, held.value):
            held.updated_at = self.clock()
            return
        self._entities[key] = _Tracked(value=value, updated_at=self.clock())
        self._pending_upserts.add(key)
        self._pending_removals.discard(key)

    def _is_older(self, incoming: T, held: T) -> bool:
        """Whether ``incoming`` reports an earlier fix than the value already held."""
        if self.fix_time is None:
            return False
        return self.fix_time(incoming) < self.fix_time(held)

    def upsert_many(self, items: Iterable[tuple[str, T]]) -> None:
        """Insert or update several entities in one pass."""
        for key, value in items:
            self.upsert(key, value)

    def get(self, key: str) -> T | None:
        """One entity by key, or ``None`` when the store does not hold it."""
        tracked = self._entities.get(key)
        return None if tracked is None else tracked.value

    def snapshot(self) -> tuple[T, ...]:
        """Every live entity. Used for REST reads and to prime a new WebSocket client."""
        return tuple(tracked.value for tracked in self._entities.values())

    def keys(self) -> frozenset[str]:
        """The keys of every entity currently held."""
        return frozenset(self._entities)

    def __len__(self) -> int:
        return len(self._entities)

    def __contains__(self, key: str) -> bool:
        return key in self._entities

    def expire(self) -> tuple[str, ...]:
        """Drop entities whose last update is older than the time to live.

        Returns the removed keys and queues them for the next flush, so clients are told
        to remove them rather than being left with stale icons.
        """
        cutoff = self.clock().timestamp() - self.ttl_seconds
        stale = [key for key, t in self._entities.items() if t.updated_at.timestamp() < cutoff]
        for key in stale:
            del self._entities[key]
            self._pending_upserts.discard(key)
            self._pending_removals.add(key)
        return tuple(stale)

    def take_changes(self) -> StoreChanges[T]:
        """Drain and return everything that changed since the last call.

        Draining is the point: the hub calls this on a fixed interval, so an entity that
        updated five times between flushes is sent once, at its latest value. That is
        what keeps bandwidth flat as feed frequency rises.
        """
        upserted = tuple(
            self._entities[key].value for key in self._pending_upserts if key in self._entities
        )
        removed = tuple(self._pending_removals)
        self._pending_upserts.clear()
        self._pending_removals.clear()
        return StoreChanges(upserted=upserted, removed=removed)

    def replace_all(self, items: Iterable[tuple[str, T]]) -> None:
        """Set the store's contents to exactly ``items``, removing anything absent.

        For feeds that publish a complete world view each poll, such as the military
        endpoint. Using :meth:`upsert_many` there would let an aircraft that dropped off
        the feed linger until its time to live expired.
        """
        incoming = dict(items)
        for key in self._entities.keys() - incoming.keys():
            del self._entities[key]
            self._pending_upserts.discard(key)
            self._pending_removals.add(key)
        self.upsert_many(incoming.items())
