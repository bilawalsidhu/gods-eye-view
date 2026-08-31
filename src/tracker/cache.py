"""One disk-backed cache for upstream responses and rate-limit state.

**Why this exists at all.** Every adapter under ``sources/`` used to hold its cache and its
rate-limit state in memory, so a restart threw the lot away. As far as a provider is
concerned a restart loop is indistinguishable from hammering, and CelesTrak firewalls
abusive clients permanently with no appeal. This is not theoretical: on 2026-08-20 adsb.lol
answered **HTTP 420** on the very first ``/v2/mil`` request of a fresh process, which no
request in that process had earned. The previous process had recorded the 120-second backoff
and taken it to the grave.

**SQLite, not a directory of files and never pickle.** Python ships ``sqlite3``, so there is
no dependency to add, and ADR 015 already puts embedding vectors in a local SQLite file, so
the store is the sanctioned one rather than a new idea. Against a file per key it wins on the
two things that matter here: a write is atomic, so a crash halfway through cannot leave a
truncated cooldown that parses as an instant in 1970 and lets every request straight through,
and a prefix delete is one statement rather than a directory walk. Against ``pickle`` it wins
outright, because a cache file is attacker-writable and unpickling one is arbitrary code
execution. Values are text: an ISO timestamp or a JSON document, and nothing else.

**One process, one event loop, which is all this app ever runs.** ``__main__.py`` pins
``workers=1``. There is deliberately no cross-process locking and no in-process locking
either: a second worker would need the first, the same way ``services/store.py`` documents
its own single-loop assumption. Writes are small and land on a local disk, so they run inline
on the loop rather than through a thread.

**A connection is opened and closed per call, and that is the laziest thing that works.**
Holding one open would mean this object needed an owner to close it, and the owner would be
the application lifespan, which every test that builds state by hand skips. Connecting to an
existing SQLite file costs tens of microseconds, and the write volume here is one small row
per poll, so there is nothing to save and one less lifecycle to get wrong. It also keeps
``check_same_thread`` honest: a call from a thread pool gets its own connection rather than
touching one that belongs to the loop.

**A cache we cannot open is a warning, not a fault**, matching
``sources/geonames.py``. Every method degrades to "nothing cached" and the product runs at
the old in-memory behaviour. The one thing that must not happen is a broken cache file
silently lifting a rate guard, so a value that will not parse is treated as absent by the
caller that reads it and the floor then applies from now.

**No personal data belongs in here.** The adsbdb registry cache holds named individuals and
is deliberately not wired onto this: see the reasoning at
:class:`tracker.sources.adsbdb.AdsbdbLookup`. A cache of personal data on disk needs a
removal path under ADR 008, and the honest answer there was not to persist it.

The file lives at ``Settings.cache_dir / upstream.sqlite3`` and is opened lazily, on the
first read or write, so a process that caches nothing leaves no file behind.
"""

import logging
import sqlite3
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final

_log = logging.getLogger(__name__)

FILE_NAME: Final = "upstream.sqlite3"
"""The single file, under the one project cache directory rather than one per source."""

_SCHEMA: Final = (
    "CREATE TABLE IF NOT EXISTS cache ("
    "key TEXT PRIMARY KEY, value TEXT NOT NULL, fetched_at REAL NOT NULL"
    ") WITHOUT ROWID"
)

_KEY_SEPARATOR: Final = ":"
"""Namespace separator, so ``delete_prefix`` can clear one source without touching another."""


def _now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True, slots=True)
class CacheEntry:
    """One cached value and when it was written.

    ``fetched_at`` is carried rather than just used for expiry because this project puts
    recency on the card: a layer serving a value it read off disk should be able to say how
    old that value is.
    """

    value: str
    fetched_at: datetime


def key(*parts: str) -> str:
    """Join namespace parts into a cache key.

    A function rather than an f-string at every call site so the separator is one fact.
    ``key("celestrak", "elements", "stations")`` gives ``celestrak:elements:stations``, and
    ``delete_prefix("celestrak:")`` then clears that whole source.
    """
    return _KEY_SEPARATOR.join(parts)


class DiskCache:
    """Keyed text values on disk, with an optional time to live per read.

    Small on purpose. It is a cache, not a data layer: get, set, delete, delete by prefix,
    and list keys. Anything that needs a schema belongs in its own module.

    Not thread-safe and not multi-process safe. One asyncio event loop owns it, like
    everything else here.
    """

    def __init__(self, directory: Path, *, clock: Callable[[], datetime] = _now) -> None:
        self._path = directory / FILE_NAME
        self._clock = clock
        self._prepared = False
        self._disabled = False

    @property
    def path(self) -> Path:
        """Where the file is, whether or not it has been created yet."""
        return self._path

    def get(self, key: str, *, ttl_seconds: float | None = None) -> CacheEntry | None:
        """One value, or ``None`` when it is absent or older than ``ttl_seconds``.

        Args:
            key: Exact key, as built by :func:`key`.
            ttl_seconds: Treat an entry written longer ago than this as absent. ``None``
                means no expiry, which is what a cache required by a provider's own terms
                wants: Nominatim's policy makes caching mandatory rather than advised.
        """
        row = self._one("SELECT value, fetched_at FROM cache WHERE key = ?", (key,))
        if row is None:
            return None
        fetched_at = datetime.fromtimestamp(row[1], tz=UTC)
        if ttl_seconds is not None and (self._clock() - fetched_at).total_seconds() >= ttl_seconds:
            return None
        return CacheEntry(value=row[0], fetched_at=fetched_at)

    def set(self, key: str, value: str) -> None:
        """Write one value, stamping it with now. Replaces whatever was there."""
        self._run(
            "INSERT INTO cache (key, value, fetched_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, "
            "fetched_at = excluded.fetched_at",
            (key, value, self._clock().timestamp()),
            create=True,
        )

    def get_time(self, key: str) -> datetime | None:
        """A stored instant, or ``None`` when absent or unreadable.

        Every writer here goes through :meth:`set_time` and writes timezone-aware UTC, so a
        naive value can only have come from a hand-edited file. UTC is attached rather than
        the value being rejected, which is the same call ``sources/celestrak.py`` makes about
        CelesTrak's naive ``EPOCH``. A value that is not a timestamp at all reads as absent,
        so the floor applies from now rather than not applying.
        """
        entry = self.get(key)
        if entry is None:
            return None
        try:
            parsed = datetime.fromisoformat(entry.value)
        except ValueError:
            _log.warning("cache: %s holds %r, which is not a timestamp; ignoring", key, entry.value)
            return None
        return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)

    def set_time(self, key: str, when: datetime) -> None:
        """Store one instant. Timezone-aware UTC in, ISO 8601 on disk."""
        self.set(key, when.isoformat())

    def delete(self, key: str) -> int:
        """Drop one key. Returns how many rows went, so zero means nothing was held."""
        return self._run("DELETE FROM cache WHERE key = ?", (key,))

    def delete_prefix(self, prefix: str) -> int:
        """Drop every key starting with ``prefix``. Returns how many rows went.

        ``substr`` rather than ``LIKE`` because a ``LIKE`` pattern would need ``%`` and ``_``
        escaped in the prefix, and a key containing an underscore silently matching its
        neighbours is exactly the sort of bug a removal path must not have.
        """
        return self._run("DELETE FROM cache WHERE substr(key, 1, ?) = ?", (len(prefix), prefix))

    def keys(self, prefix: str = "") -> tuple[str, ...]:
        """Every key held, optionally narrowed to one prefix, in key order.

        Here for the removal path: a removal has to be able to find what is held before it
        can prove the value is gone.
        """
        rows = self._all(
            "SELECT key FROM cache WHERE substr(key, 1, ?) = ? ORDER BY key", (len(prefix), prefix)
        )
        return tuple(row[0] for row in rows)

    def _run(self, sql: str, params: tuple[object, ...], *, create: bool = False) -> int:
        """Execute one statement, returning affected rows, or 0 when there is no cache.

        ``create`` is only true for a write. A delete against a file that does not exist has
        nothing to delete, and creating one to find that out would put a file on disk for a
        removal aimed at a cache that was never written.
        """
        with self._connect(create=create) as conn:
            if conn is None:
                return 0
            try:
                return conn.execute(sql, params).rowcount
            except sqlite3.Error as exc:
                verb = sql.split(maxsplit=1)[0]
                _log.warning("cache: %s failed on %s: %s", verb, self._path, exc)
                return 0

    def _one(self, sql: str, params: tuple[object, ...]) -> tuple[Any, ...] | None:
        """Fetch one row, or ``None`` when there is nothing to fetch and nowhere to fetch it."""
        rows = self._all(sql, params)
        return rows[0] if rows else None

    def _all(self, sql: str, params: tuple[object, ...]) -> list[tuple[Any, ...]]:
        with self._connect(create=False) as conn:
            if conn is None:
                return []
            try:
                return conn.execute(sql, params).fetchall()
            except sqlite3.Error as exc:
                _log.warning("cache: read failed on %s: %s", self._path, exc)
                return []

    @contextmanager
    def _connect(self, *, create: bool) -> Iterator[sqlite3.Connection | None]:
        """One connection for one call, or ``None`` when there is nothing to connect to.

        **A read never creates the file.** ``sqlite3.connect`` creates an empty database on any
        open, read included, so without the existence check below every construction of a
        client that reads a stored floor would leave a file behind. ``build_state`` builds one
        such client, and almost every test in the suite builds state, so the file would appear
        on every run of every test whether or not anything was cached. Only a write creates.
        """
        if self._disabled or (not create and not self._path.is_file()):
            yield None
            return
        try:
            conn = self._open()
        except (sqlite3.Error, OSError) as exc:
            self._disabled = True
            # Not fatal. Every guard falls back to its in-memory behaviour, which is what the
            # whole product did before this file existed. The cost is paid on the next
            # restart, by re-asking upstreams we would otherwise have had answers for. Set
            # once rather than retried, so a poll every eight seconds does not flood the log.
            _log.warning("cache: cannot open %s (%s); running without it", self._path, exc)
            yield None
            return
        try:
            yield conn
        finally:
            conn.close()

    def _open(self) -> sqlite3.Connection:
        """Connect, preparing the file on the first call of the process.

        ``isolation_level=None`` puts the connection in autocommit, so a single statement is
        durable the moment it returns and there is no transaction to forget to commit. WAL
        plus ``synchronous=NORMAL`` is the usual cache setting: it survives a process crash,
        which is the case that matters here, and trades only a power cut. Both are properties
        of the file rather than the connection once set, so they are issued once.

        Raises:
            sqlite3.Error: The file is not a database, or is not writable.
            OSError: The directory cannot be created.
        """
        if self._prepared:
            return sqlite3.connect(self._path, isolation_level=None)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self._path, isolation_level=None)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute(_SCHEMA)
        except sqlite3.Error:
            # Closed here rather than left to the garbage collector, which reports it as an
            # unraisable ResourceWarning from wherever the next collection happens to run.
            conn.close()
            raise
        self._prepared = True
        return conn
