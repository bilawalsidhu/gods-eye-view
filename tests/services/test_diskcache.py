"""The disk-backed cache: the restart, the expiry, the removal path and the degradations.

Every test here constructs a **second** instance over the same directory wherever a restart is
what is being asserted. That is the whole point of the module: a value written by one process
has to be readable by the next, and an object that merely remembers things in a field would
pass a single-instance test and fail the product.

No network anywhere and no sleeping. The clock is injected so a time to live is a boundary
rather than a wait.
"""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from tracker.cache import FILE_NAME, CacheEntry, DiskCache, key

NOW = datetime(2026, 8, 20, 9, 0, 0, tzinfo=UTC)


class Clock:
    """A hand-driven clock. Expiry boundaries are measured, never slept through."""

    def __init__(self, start: datetime = NOW) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def cache(tmp_path: Path, clock: Clock) -> DiskCache:
    return DiskCache(tmp_path, clock=clock)


# ---------------------------------------------------------------- the key namespace


def test_a_key_joins_its_parts_with_one_separator() -> None:
    """One function owns the separator, so a prefix delete and a write cannot disagree."""
    assert key("celestrak", "elements", "stations") == "celestrak:elements:stations"


def test_a_single_part_key_is_itself() -> None:
    assert key("nominatim") == "nominatim"


# ---------------------------------------------------------------- surviving a restart


def test_a_value_written_by_one_instance_is_read_by_the_next(tmp_path: Path, clock: Clock) -> None:
    """The restart, stated as plainly as it can be: a different object, the same directory.

    This is the assertion the whole module exists for. An in-memory cache passes every test
    that reuses one instance, which is why none of the guards this replaced ever failed one.
    """
    DiskCache(tmp_path, clock=clock).set("k", "v")

    restarted = DiskCache(tmp_path, clock=clock)

    entry = restarted.get("k")
    assert entry == CacheEntry(value="v", fetched_at=NOW)


def test_an_instant_written_by_one_instance_is_read_by_the_next(
    tmp_path: Path, clock: Clock
) -> None:
    """The same proof for a rate floor, which is what most callers actually store."""
    until = NOW + timedelta(seconds=120)
    DiskCache(tmp_path, clock=clock).set_time("floor", until)

    assert DiskCache(tmp_path, clock=clock).get_time("floor") == until


def test_a_second_write_to_one_key_replaces_the_first(cache: DiskCache, clock: Clock) -> None:
    cache.set("k", "first")
    clock.advance(10.0)
    cache.set("k", "second")

    entry = cache.get("k")
    assert entry is not None
    assert entry.value == "second"
    assert entry.fetched_at == NOW + timedelta(seconds=10)


def test_no_file_exists_until_something_is_written(tmp_path: Path, clock: Clock) -> None:
    """A run that caches nothing leaves nothing behind.

    Load-bearing for the test suite rather than for the product: ``build_state`` constructs one
    of these, and almost every test builds state and makes no upstream call. An eager
    connection would put a file in the tree on every run of every test.
    """
    cache = DiskCache(tmp_path, clock=clock)
    assert cache.get("k") is None
    assert cache.keys() == ()
    assert not (tmp_path / FILE_NAME).exists()

    cache.set("k", "v")
    assert (tmp_path / FILE_NAME).exists()


def test_the_directory_is_created_on_first_write(tmp_path: Path, clock: Clock) -> None:
    nested = tmp_path / "does" / "not" / "exist"
    DiskCache(nested, clock=clock).set("k", "v")

    assert (nested / FILE_NAME).is_file()


# ---------------------------------------------------------------- expiry


def test_a_value_inside_its_time_to_live_is_served(cache: DiskCache, clock: Clock) -> None:
    cache.set("k", "v")
    clock.advance(59.0)

    assert cache.get("k", ttl_seconds=60.0) is not None


def test_a_value_at_its_time_to_live_is_absent(cache: DiskCache, clock: Clock) -> None:
    """The boundary is exclusive, matching every other expiry in this project."""
    cache.set("k", "v")
    clock.advance(60.0)

    assert cache.get("k", ttl_seconds=60.0) is None


def test_no_time_to_live_means_no_expiry(cache: DiskCache, clock: Clock) -> None:
    """What a cache required by a provider's own terms wants. Nominatim is the case."""
    cache.set("k", "v")
    clock.advance(365.0 * 24.0 * 60.0 * 60.0)

    assert cache.get("k") is not None


def test_an_expired_read_does_not_delete_the_row(cache: DiskCache, clock: Clock) -> None:
    """Expiry is a decision the reader makes, so two readers may disagree about one row.

    CelesTrak wants its element sets kept past any window, because a week-old orbit
    determination beats an empty layer, while a caller asking with a time to live wants a
    fresh answer only. A read that pruned would let the second caller empty the first's cache.
    """
    cache.set("k", "v")
    clock.advance(120.0)

    assert cache.get("k", ttl_seconds=60.0) is None
    assert cache.get("k") is not None


# ---------------------------------------------------------------- reading an instant


def test_a_naive_stored_instant_reads_as_utc(cache: DiskCache) -> None:
    """Only a hand-edited file can produce one, and everything we write is UTC.

    Rejecting it would leave the floor absent, which is the unsafe direction: absent means
    "call now". UTC is attached instead, the same call the CelesTrak adapter makes about that
    provider's naive ``EPOCH``.
    """
    cache.set("floor", "2026-08-20T09:02:00")

    assert cache.get_time("floor") == datetime(2026, 8, 20, 9, 2, 0, tzinfo=UTC)


def test_a_stored_value_that_is_not_an_instant_reads_as_absent(cache: DiskCache) -> None:
    """A corrupt floor must not raise into a poll, and it must not read as a valid date."""
    cache.set("floor", "not a timestamp")

    assert cache.get_time("floor") is None


def test_an_absent_instant_is_none(cache: DiskCache) -> None:
    assert cache.get_time("floor") is None


# ---------------------------------------------------------------- the removal path


def test_delete_drops_one_key_and_reports_it(cache: DiskCache) -> None:
    cache.set("a", "1")
    cache.set("b", "2")

    assert cache.delete("a") == 1
    assert cache.get("a") is None
    assert cache.get("b") is not None


def test_deleting_a_key_that_is_not_held_reports_zero(cache: DiskCache) -> None:
    """Zero rather than an error, so a removal aimed at something we never cached is quiet."""
    assert cache.delete("never-stored") == 0


def test_delete_prefix_clears_one_namespace_and_leaves_the_others(cache: DiskCache) -> None:
    cache.set(key("celestrak", "elements", "stations"), "a")
    cache.set(key("celestrak", "attempted", "stations"), "b")
    cache.set(key("nominatim", "q", "london"), "c")

    assert cache.delete_prefix("celestrak:") == 2

    assert cache.keys() == (key("nominatim", "q", "london"),)


def test_delete_prefix_does_not_treat_its_argument_as_a_pattern(cache: DiskCache) -> None:
    """``substr`` rather than ``LIKE``, because a key containing ``_`` is ordinary here.

    Under ``LIKE`` the underscore is a single-character wildcard, so a removal aimed at one
    namespace would silently take its neighbours with it. A removal path that deletes more
    than it was asked to is as wrong as one that deletes less.
    """
    cache.set("a_b:one", "kept-away")
    cache.set("axb:one", "must survive")

    assert cache.delete_prefix("a_b:") == 1

    assert cache.keys() == ("axb:one",)


def test_keys_enumerates_everything_in_order(cache: DiskCache) -> None:
    """Here for the removal path: proving a value is gone needs a way to look."""
    cache.set("b", "2")
    cache.set("a", "1")
    cache.set("c", "3")

    assert cache.keys() == ("a", "b", "c")


def test_keys_narrows_to_a_prefix(cache: DiskCache) -> None:
    cache.set(key("adsb", "not_before", "adsb.lol"), "x")
    cache.set(key("adsb", "not_before", "adsb.fi"), "y")
    cache.set(key("poller", "aircraft/union", "not_before"), "z")

    assert cache.keys("adsb:") == (
        key("adsb", "not_before", "adsb.fi"),
        key("adsb", "not_before", "adsb.lol"),
    )


# ---------------------------------------------------------------- degrading, never failing


def test_a_directory_that_cannot_be_opened_degrades_to_no_cache(tmp_path: Path) -> None:
    """A cache we cannot write is a warning, not a fault, matching ``sources/geonames.py``.

    Every guard that uses this falls back to its in-memory behaviour, which is what the whole
    product did before this module existed. The alternative is a failed ``mkdir`` taking down
    a poll, and a broken cache directory is not a reason to stop showing aircraft.
    """
    blocker = tmp_path / "blocked"
    blocker.write_text("this is a file where a directory needs to be")
    cache = DiskCache(blocker / "sub")

    cache.set("k", "v")

    assert cache.get("k") is None
    assert cache.keys() == ()
    assert cache.delete("k") == 0
    assert cache.delete_prefix("k") == 0


def test_a_cache_that_has_given_up_does_not_keep_retrying(tmp_path: Path) -> None:
    """One warning, not one per call. A poll every eight seconds would flood the log."""
    blocker = tmp_path / "blocked"
    blocker.write_text("in the way")
    cache = DiskCache(blocker / "sub")
    cache.set("k", "v")

    # Clearing the obstruction changes nothing: the object has already reported itself.
    blocker.unlink()
    cache.set("k", "v")

    assert not (blocker / "sub" / FILE_NAME).exists()


def test_a_corrupted_file_degrades_rather_than_raising(tmp_path: Path, clock: Clock) -> None:
    """A read or write that throws mid-session must not reach the caller.

    The file can be replaced underneath us: a temp reaper, a truncated write, a full disk.
    None of those is a reason for a poll to fail, so each is a warning and a cache miss. No
    monkeypatching here on purpose, because a file that is not a database is the real shape of
    the failure and sqlite3 raises on the statement rather than on the connect.
    """
    cache = DiskCache(tmp_path, clock=clock)
    cache.set("k", "v")
    (tmp_path / FILE_NAME).write_bytes(b"this is not a SQLite database")

    assert cache.get("k") is None
    assert cache.keys() == ()
    assert cache.delete("k") == 0
    cache.set("k", "other")


def test_the_path_is_reported_before_the_file_exists(tmp_path: Path) -> None:
    """So a log line and the operator's reset route can name the file either way."""
    assert DiskCache(tmp_path).path == tmp_path / FILE_NAME


# ---------------------------------------------------------------- one loop, no locking


def test_two_instances_on_one_directory_see_each_others_writes(
    tmp_path: Path, clock: Clock
) -> None:
    """Not a concurrency claim. It is what makes the two ADS-B clients share one cooldown.

    A 420 is per egress address rather than per endpoint, so the military sweep being held off
    has to hold the viewport sweep off too, and they are separate client objects.
    """
    first = DiskCache(tmp_path, clock=clock)
    second = DiskCache(tmp_path, clock=clock)

    first.set_time("adsb:not_before:adsb.lol", NOW + timedelta(seconds=120))

    assert second.get_time("adsb:not_before:adsb.lol") == NOW + timedelta(seconds=120)


def test_the_module_documents_that_a_second_worker_would_need_locking() -> None:
    """The same assumption ``services/store.py`` states about itself, asserted rather than hoped.

    ``__main__.py`` pins one worker. If that ever changes, this cache and the entity store both
    need work, and the docstring is where the next person finds that out.
    """
    import tracker.cache as module

    assert module.__doc__ is not None
    assert "workers=1" in module.__doc__


def test_a_file_that_is_not_a_database_degrades_on_the_first_open(tmp_path: Path) -> None:
    """Preparing the file is where a corrupt one is caught, and it must not leak a connection.

    ``sqlite3.connect`` succeeds on anything: the error arrives on the first statement. So the
    connection is open by then and closing it is the difference between a warning and an
    unraisable ``ResourceWarning`` surfacing from wherever the next garbage collection lands.
    """
    (tmp_path / FILE_NAME).write_bytes(b"not a database, but it is in the way")
    cache = DiskCache(tmp_path)

    cache.set("k", "v")

    assert cache.get("k") is None
