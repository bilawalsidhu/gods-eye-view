"""Supervised polling: health accounting, the cadence floor and never dying.

The cadence floor is the guard that stops a careless environment variable getting our IP
banned, so it is asserted directly rather than inferred from timing. The "never dies"
property is asserted by making a poll raise and then making the next one succeed: a naive
loop would have exited permanently on the first failure.
"""

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from tracker.cache import FILE_NAME, DiskCache
from tracker.cache import key as cache_key
from tracker.services.poller import (
    JITTER_FRACTION,
    MAX_BACKOFF_SECONDS,
    NOT_BEFORE_KEY,
    Poller,
    PollerGroup,
    PollerHealth,
)
from tracker.sources.base import RateLimitedError


class _Counter:
    """A poll function that records how often it was called and can be told to fail."""

    __slots__ = ("calls", "error", "result")

    def __init__(self, result: int = 3, error: BaseException | None = None) -> None:
        self.calls = 0
        self.result = result
        self.error = error

    async def __call__(self) -> int:
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.result


def _poller(
    poll: _Counter,
    *,
    interval_seconds: float = 5.0,
    min_interval_seconds: float = 1.0,
    name: str = "adsb.lol/point",
    cache: DiskCache | None = None,
) -> Poller:
    return Poller(
        cache=cache,
        name=name,
        layer="aircraft",
        poll=poll,
        interval_seconds=interval_seconds,
        min_interval_seconds=min_interval_seconds,
    )


# ---------------------------------------------------------------- success path


async def test_run_once_records_a_success() -> None:
    poll = _Counter(result=42)
    poller = _poller(poll)

    assert await poller.run_once() is True

    health = poller.health
    assert poll.calls == 1
    assert health.healthy is True
    assert health.entity_count == 42
    assert health.consecutive_failures == 0
    assert health.last_error is None
    assert health.last_success_at is not None
    assert health.total_polls == 1
    assert health.total_failures == 0
    assert health.rate_limited_until is None


async def test_health_starts_unhealthy_before_the_first_poll() -> None:
    """An unpolled feed is not a working feed, and the UI should not claim it is."""
    poller = _poller(_Counter())

    assert poller.health.healthy is False
    assert poller.health.total_polls == 0
    assert poller.health.entity_count == 0


async def test_the_health_contract_carries_the_effective_interval() -> None:
    poller = _poller(_Counter(), interval_seconds=8.0, min_interval_seconds=30.0)

    contract = poller.health.to_contract()

    assert contract.poll_interval_seconds == 30.0
    assert contract.source == "adsb.lol/point"
    assert contract.layer == "aircraft"
    assert contract.healthy is False


# ---------------------------------------------------------------- failure path


async def test_a_raising_poll_records_the_failure_without_killing_the_poller() -> None:
    poll = _Counter(error=RuntimeError("upstream exploded"))
    poller = _poller(poll, interval_seconds=0.0, min_interval_seconds=0.001)

    assert await poller.run_once() is True

    health = poller.health
    assert health.healthy is False
    assert health.consecutive_failures == 1
    assert health.total_failures == 1
    assert health.last_error == "RuntimeError: upstream exploded"


async def test_a_failure_with_no_message_still_says_what_broke() -> None:
    """``last_error`` is served on ``/api/health`` and drawn on the layer rail.

    An httpx connect timeout carries no message, so interpolating it served
    "ConnectTimeout: " with nothing after the colon: a feed that broke for no stated reason.
    """
    poll = _Counter(error=httpx.ConnectTimeout(""))
    poller = _poller(poll, interval_seconds=0.0, min_interval_seconds=0.001)

    await poller.run_once()

    assert poller.health.last_error == "ConnectTimeout"


async def test_consecutive_failures_accumulate() -> None:
    poll = _Counter(error=ValueError("bad payload"))
    poller = _poller(poll, interval_seconds=0.0, min_interval_seconds=0.001)

    for expected in (1, 2, 3):
        poller._not_before = None
        await poller.run_once()
        assert poller.health.consecutive_failures == expected

    assert poller.health.total_failures == 3
    assert poller.health.total_polls == 3


async def test_a_subsequent_success_recovers_the_poller() -> None:
    """The whole point of the design: one bad payload must not end the loop forever."""
    poll = _Counter(error=RuntimeError("upstream exploded"))
    poller = _poller(poll, interval_seconds=0.0, min_interval_seconds=0.001)
    await poller.run_once()
    assert poller.health.healthy is False

    poll.error = None
    poll.result = 7
    poller._not_before = None
    assert await poller.run_once() is True

    health = poller.health
    assert health.healthy is True
    assert health.consecutive_failures == 0
    assert health.last_error is None
    assert health.entity_count == 7
    assert health.total_failures == 1, "the historical failure count is not reset"


async def test_a_cancellation_is_not_swallowed() -> None:
    """Cancelling a poller must actually cancel it, not be logged as a feed failure."""
    poll = _Counter(error=asyncio.CancelledError())
    poller = _poller(poll)

    with pytest.raises(asyncio.CancelledError):
        await poller.run_once()

    assert poller.health.consecutive_failures == 0


# ---------------------------------------------------------------- the cadence guard


async def test_run_once_twice_in_a_row_polls_exactly_once() -> None:
    """The cadence guard. Two immediate calls must produce one upstream request."""
    poll = _Counter()
    poller = _poller(poll, interval_seconds=5.0, min_interval_seconds=1.0)

    assert await poller.run_once() is True
    assert await poller.run_once() is False

    assert poll.calls == 1
    assert poller.health.total_polls == 1


async def test_the_effective_interval_is_the_configured_one_when_it_clears_the_floor() -> None:
    poller = _poller(_Counter(), interval_seconds=8.0, min_interval_seconds=5.0)

    assert poller.effective_interval == max(8.0, 5.0)
    assert poller.effective_interval == 8.0


async def test_a_configured_interval_below_the_floor_is_raised_to_the_floor() -> None:
    """Configuration can slow a feed down but never speed it past its documented floor."""
    poller = _poller(_Counter(), interval_seconds=1.0, min_interval_seconds=30.0)

    assert poller.effective_interval == max(1.0, 30.0)
    assert poller.effective_interval == 30.0
    assert poller.health.poll_interval_seconds == 30.0


async def test_the_cadence_floor_uses_the_effective_interval_not_the_configured_one() -> None:
    poll = _Counter()
    poller = _poller(poll, interval_seconds=0.001, min_interval_seconds=60.0)

    await poller.run_once()

    assert await poller.run_once() is False
    assert poll.calls == 1
    assert poller._not_before is not None
    assert (poller._not_before - datetime.now(UTC)).total_seconds() > 55.0


async def test_the_guard_opens_once_the_interval_has_passed() -> None:
    poll = _Counter()
    poller = _poller(poll, interval_seconds=0.0, min_interval_seconds=0.001)

    await poller.run_once()
    await asyncio.sleep(0.01)

    assert await poller.run_once() is True
    assert poll.calls == 2


def test_a_non_positive_minimum_interval_is_rejected() -> None:
    """A zero or negative floor is not a fast feed, it is an unbounded request rate."""
    for bad in (0.0, -1.0):
        with pytest.raises(ValueError, match="min_interval_seconds must be positive"):
            _poller(_Counter(), min_interval_seconds=bad)


# ---------------------------------------------------------------- rate limiting


async def test_a_rate_limit_sets_rate_limited_until_and_holds_the_guard() -> None:
    poll = _Counter(error=RateLimitedError("adsb.lol", 420, 120.0))
    poller = _poller(poll, interval_seconds=1.0, min_interval_seconds=1.0)

    assert await poller.run_once() is True

    health = poller.health
    assert health.rate_limited_until is not None
    assert health.healthy is False
    assert health.consecutive_failures == 1
    assert "rate limited (HTTP 420)" in str(health.last_error)

    wait = (health.rate_limited_until - datetime.now(UTC)).total_seconds()
    assert 115.0 < wait <= 120.0

    assert await poller.run_once() is False
    assert poll.calls == 1


async def test_a_rate_limit_honours_the_provider_figure_over_the_configured_interval() -> None:
    """A throttled endpoint retried on our own schedule is how a free feed bans an IP."""
    poll = _Counter(error=RateLimitedError("adsb.lol", 429, 300.0))
    poller = _poller(poll, interval_seconds=1.0, min_interval_seconds=1.0)

    await poller.run_once()

    assert poller._not_before is not None
    assert (poller._not_before - datetime.now(UTC)).total_seconds() > 290.0


async def test_recovery_after_a_rate_limit_clears_the_marker() -> None:
    poll = _Counter(error=RateLimitedError("adsb.lol", 420, 1.0))
    poller = _poller(poll, interval_seconds=0.0, min_interval_seconds=0.001)
    await poller.run_once()
    assert poller.health.rate_limited_until is not None

    poll.error = None
    poller._not_before = None
    await poller.run_once()

    assert poller.health.healthy is True
    assert poller.health.rate_limited_until is None


async def test_the_rate_limit_contract_reaches_the_wire() -> None:
    poll = _Counter(error=RateLimitedError("adsb.lol", 420, 60.0))
    poller = _poller(poll)
    await poller.run_once()

    contract = poller.health.to_contract()

    assert contract.rate_limited_until is not None
    assert contract.is_stale is True


# ---------------------------------------------------------------- backoff


async def test_the_sleep_is_the_interval_plus_jitter_when_healthy() -> None:
    poller = _poller(_Counter(), interval_seconds=10.0, min_interval_seconds=1.0)
    poller.health.healthy = True

    sleep = poller._sleep_seconds()

    assert 10.0 * (1.0 - JITTER_FRACTION) <= sleep <= 10.0 * (1.0 + JITTER_FRACTION)


async def test_the_sleep_backs_off_exponentially_on_repeated_failure() -> None:
    poller = _poller(_Counter(), interval_seconds=10.0, min_interval_seconds=1.0)
    poller.health.consecutive_failures = 3

    sleep = poller._sleep_seconds()

    assert sleep >= 80.0 * (1.0 - JITTER_FRACTION)


async def test_the_backoff_is_capped() -> None:
    poller = _poller(_Counter(), interval_seconds=60.0, min_interval_seconds=1.0)
    poller.health.consecutive_failures = 20

    assert poller._sleep_seconds() <= MAX_BACKOFF_SECONDS * (1.0 + JITTER_FRACTION)


async def test_the_sleep_never_wakes_before_the_cadence_floor_allows() -> None:
    """Waking early only to find the guard closed hides the real wait from the logs."""
    poll = _Counter(error=RateLimitedError("adsb.lol", 420, 600.0))
    poller = _poller(poll, interval_seconds=1.0, min_interval_seconds=1.0)
    await poller.run_once()

    assert poller._sleep_seconds() > 500.0


# ---------------------------------------------------------------- start and stop


async def test_start_then_stop_runs_the_loop_at_least_once() -> None:
    poll = _Counter()
    poller = _poller(poll, interval_seconds=0.0, min_interval_seconds=0.001)

    poller.start()
    await asyncio.sleep(0.02)
    await poller.stop()

    assert poll.calls >= 1


async def test_starting_twice_raises() -> None:
    poller = _poller(_Counter(), interval_seconds=10.0, min_interval_seconds=1.0)
    poller.start()
    try:
        with pytest.raises(RuntimeError, match="already running"):
            poller.start()
    finally:
        await poller.stop()


async def test_stop_is_safe_when_never_started() -> None:
    poller = _poller(_Counter())

    await poller.stop()
    await poller.stop()


async def test_a_stopped_poller_can_be_started_again() -> None:
    poll = _Counter()
    poller = _poller(poll, interval_seconds=0.0, min_interval_seconds=0.001)

    poller.start()
    await asyncio.sleep(0.02)
    await poller.stop()
    poller.start()
    await asyncio.sleep(0.02)
    await poller.stop()

    assert poll.calls >= 2


async def test_the_loop_survives_a_poll_that_keeps_raising() -> None:
    poll = _Counter(error=RuntimeError("still broken"))
    poller = _poller(poll, interval_seconds=0.0, min_interval_seconds=0.001)

    poller.start()
    await asyncio.sleep(0.05)
    running = poller._task is not None and not poller._task.done()
    await poller.stop()

    assert running, "the supervised loop must not exit on a failing poll"
    assert poller.health.consecutive_failures >= 1


# ---------------------------------------------------------------- PollerGroup


async def test_the_group_reports_one_feed_health_per_poller() -> None:
    first = _poller(_Counter(result=5), name="adsb.lol/point")
    second = Poller(
        name="adsb.lol/mil",
        layer="military",
        poll=_Counter(result=310),
        interval_seconds=30.0,
        min_interval_seconds=30.0,
    )
    group = PollerGroup([first])
    group.add(second)

    await first.run_once()
    await second.run_once()
    health = group.health()

    assert len(group) == 2
    assert len(health) == 2
    assert {h.source for h in health} == {"adsb.lol/point", "adsb.lol/mil"}
    assert {h.layer for h in health} == {"aircraft", "military"}
    assert {h.entity_count for h in health} == {5, 310}


def test_an_empty_group_reports_nothing() -> None:
    group = PollerGroup()

    assert len(group) == 0
    assert group.health() == ()
    assert list(group) == []


async def test_the_group_starts_and_stops_every_poller() -> None:
    counters = [_Counter(), _Counter()]
    group = PollerGroup(
        [
            _poller(counters[0], interval_seconds=0.0, min_interval_seconds=0.001, name="one"),
            _poller(counters[1], interval_seconds=0.0, min_interval_seconds=0.001, name="two"),
        ]
    )

    group.start_all()
    await asyncio.sleep(0.02)
    await group.stop_all()

    assert all(c.calls >= 1 for c in counters)
    assert all(p._task is None for p in group)


def test_the_group_is_iterable_in_insertion_order() -> None:
    first = _poller(_Counter(), name="one")
    second = _poller(_Counter(), name="two")
    group = PollerGroup()

    assert group.add(first) is first
    group.add(second)

    assert [p.name for p in group] == ["one", "two"]


# ---------------------------------------------------------------- health contract


def test_a_feed_is_stale_when_unhealthy_or_repeatedly_failing() -> None:
    """One failed poll is noise; two is the start of an outage, and the UI says so."""
    healthy = PollerHealth(source="s", layer="aircraft", poll_interval_seconds=5.0, healthy=True)

    assert healthy.to_contract().is_stale is False

    healthy.consecutive_failures = 1
    assert healthy.to_contract().is_stale is False

    healthy.consecutive_failures = 2
    assert healthy.to_contract().is_stale is True

    healthy.consecutive_failures = 0
    healthy.healthy = False
    assert healthy.to_contract().is_stale is True


# ---------------------------------------------------------------- surviving a restart


async def test_a_fresh_poller_honours_the_floor_the_previous_one_wrote(tmp_path: Path) -> None:
    """The claim this module's docstring used to make and did not keep.

    A supervisor bouncing a failing poller, or a person stopping and starting the app, used to
    get a brand new floor every time. The provider cannot tell that apart from hammering. So
    the second poller here is a different object over the same cache file, and it must refuse.
    """
    cache = DiskCache(tmp_path)
    first = _Counter()
    assert await _poller(first, interval_seconds=60.0, cache=cache).run_once() is True
    assert first.calls == 1

    restarted = _Counter()
    assert await _poller(restarted, interval_seconds=60.0, cache=cache).run_once() is False
    assert restarted.calls == 0


async def test_a_fresh_poller_polls_once_the_persisted_floor_has_passed(tmp_path: Path) -> None:
    """The floor delays, it never latches. A poller that could never poll again is worse."""
    cache = DiskCache(tmp_path)
    assert await _poller(_Counter(), interval_seconds=60.0, cache=cache).run_once() is True

    # Rewind the stored floor rather than sleeping a minute: the value on disk is the whole
    # mechanism, so writing an elapsed one is exactly what waiting would produce.
    cache.set_time(
        cache_key("poller", "adsb.lol/point", NOT_BEFORE_KEY),
        datetime.now(UTC) - timedelta(seconds=1),
    )
    restarted = _Counter()

    assert await _poller(restarted, interval_seconds=60.0, cache=cache).run_once() is True
    assert restarted.calls == 1


async def test_a_persisted_rate_limit_backoff_outlives_the_process(tmp_path: Path) -> None:
    """The provider's own figure, not ours, and it is the one that matters.

    adsb.lol answers HTTP 420 and asks for 120 seconds. Losing that on a restart is how a
    fresh process opens by hammering an endpoint that had just asked it to stop.
    """
    cache = DiskCache(tmp_path)
    limited = _Counter(error=RateLimitedError("adsb.lol", 420, 120.0))
    poller = _poller(limited, interval_seconds=5.0, cache=cache)
    await poller.run_once()

    stored = cache.get_time(cache_key("poller", "adsb.lol/point", NOT_BEFORE_KEY))
    assert stored is not None
    assert stored > datetime.now(UTC) + timedelta(seconds=100)

    fresh = _Counter()
    assert await _poller(fresh, interval_seconds=5.0, cache=cache).run_once() is False
    assert fresh.calls == 0


async def test_two_pollers_do_not_share_one_floor(tmp_path: Path) -> None:
    """The key is namespaced by poller name, so the vessel floor is not the aircraft floor."""
    cache = DiskCache(tmp_path)
    assert await _poller(_Counter(), interval_seconds=60.0, cache=cache).run_once() is True

    other = _Counter()
    poller = _poller(other, interval_seconds=60.0, cache=cache, name="vessels/union")

    assert await poller.run_once() is True
    assert other.calls == 1


async def test_a_poller_with_no_cache_writes_nothing_and_behaves_as_before(tmp_path: Path) -> None:
    """The persistence is opt-in, so a poller built without a cache is unchanged."""
    poller = _poller(_Counter(), interval_seconds=60.0)
    await poller.run_once()

    assert poller.not_before is not None
    assert not (tmp_path / FILE_NAME).exists()
