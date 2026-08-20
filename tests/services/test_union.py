"""The provider union: one record per identity, recency wins, nothing averaged.

Every test that matters here runs on the two real captures taken on 2026-08-19,
``adsb_point_live.json`` from adsb.lol and ``adsbfi_point_live.json`` from adsb.fi, put
through the real parser in ``tracker.sources.adsb``. They overlap over central London by
four aircraft out of 122 records, which is the whole point: the merge has to turn 122
reports into 118 assets, and the aircraft only one network saw are the number that pays
for a second provider.

The two captures stand in for two members of a union. Which providers are actually union
members is settled in the wiring, not here: reading R3 in ``docs/pending-decisions.md`` keeps
adsb.fi as a failover on its non-commercial licence, and this module merges whatever it is
handed regardless.

Where a test needs to control which provider is the fresher one it moves the recorded
envelope timestamp and nothing else. Every aircraft record inside stays exactly as
captured.
"""

import json
from datetime import UTC, datetime, timedelta

import pytest
from hypothesis import given
from hypothesis import strategies as st

from tests.conftest import (
    ADSBFI_POINT_AIRCRAFT,
    REFERENCE_TIME,
    FrozenClock,
    fixture_bytes,
    fixture_json,
    make_aircraft,
)
from tracker.contracts.aircraft import Aircraft
from tracker.services.store import EntityStore
from tracker.services.union import ProviderResult, UnionResult, merge_providers
from tracker.sources.adsb import parse_response
from tracker.sources.base import RateLimitedError

LOL = "adsb.lol"
FI = "adsb.fi"
assert FI < LOL, "these tests use the fact that adsb.fi sorts before adsb.lol"

LOL_POINT_FIXTURE = "adsb_point_live.json"
FI_POINT_FIXTURE = "adsbfi_point_live.json"

LOL_POINT_AIRCRAFT = 65
"""Records in the captured adsb.lol response, all of which carry a position."""

UNION_AIRCRAFT = 118
"""Distinct ICAO addresses across both captures: 65 plus 57 minus the 4 seen twice."""

LOL_ONLY_AIRCRAFT = 61
FI_ONLY_AIRCRAFT = 53

SHARED_ADDRESSES = frozenset({"42584b", "42584c", "4cad97", "4d20f4"})
"""The four ICAO 24-bit addresses both networks happened to see in these two captures."""

DISAGREEING_ADDRESS = "4cad97"
"""The shared address where the two networks disagree materially about where it is.

adsb.lol puts it at longitude -0.194636, adsb.fi at -0.436344, roughly 17 km apart. The
merge must return one of those two positions and never the point between them, because no
receiver reported the point between them.
"""

LOL_ENVELOPE_MS = 1787165611001
"""The ``now`` field of the recorded adsb.lol response, in milliseconds: 18:53:31.001 UTC."""

FI_ENVELOPE_TIME = datetime(2026, 8, 19, 20, 17, 38, 1_000, tzinfo=UTC)
"""What the recorded adsb.fi response's ``now`` means: 1787170658.001, in **seconds**.

The unit differs from adsb.lol's and the parser decides which is which. Before that
landed, every adsb.fi batch arrived dated 1970-01-21 and could never win a shared
aircraft, which is provider precedence by accident. See
``tracker.sources.adsb.MILLISECOND_EPOCH_FLOOR``.
"""

MERGE_TIME = datetime(2026, 8, 19, 21, 0, 0, tzinfo=UTC)
"""A moment after both captures, so every report age is positive and exactly computable."""

ENVELOPE_GAP_MS = 60_000
"""How far a doctored envelope is moved when a test wants one provider clearly fresher.

Comfortably larger than the widest position age carried by any of the four shared records
(3.8 s), so the batch timestamp rather than a single record's age decides the winner.
"""

FIX_GAP_MS = 2_000
"""The gap that makes response-time ordering and fix-time ordering disagree.

adsb.fi's report of ``4cad97`` was 3.784 s old when it was sent; adsb.lol's was 0.131 s
old. Move adsb.fi's response 2 s later than adsb.lol's and adsb.fi is the later responder
for every shared aircraft while still holding the older *fix* of that one.
"""


def _fix_time(aircraft: Aircraft) -> datetime:
    """When an aircraft's position was actually fixed, which is what recency compares.

    ``observed_at`` is when the provider built the response and ``position_age_s`` is how
    much older the fix inside it is, so this is the real fix time rather than the response
    time. It is the function phase 3 will inject.
    """
    return aircraft.observed_at - timedelta(seconds=aircraft.position_age_s)


def _parsed(name: str, *, source: str, envelope_ms: int | None = None) -> tuple[Aircraft, ...]:
    """One recorded payload through the real parser, optionally with its clock moved.

    Moving ``now`` moves the whole batch and touches no aircraft record, which is the only
    honest way to make a named provider the fresher one without inventing positions.
    """
    if envelope_ms is None:
        return parse_response(fixture_bytes(name), source=source)
    payload = fixture_json(name)
    payload["now"] = envelope_ms
    return parse_response(json.dumps(payload).encode(), source=source)


def _merge(*results: ProviderResult[Aircraft], at: datetime = MERGE_TIME) -> UnionResult[Aircraft]:
    return merge_providers(
        results,
        key=lambda aircraft: aircraft.icao24,
        reported_at=_fix_time,
        clock=FrozenClock(at),
    )


def _both_captures() -> tuple[tuple[Aircraft, ...], tuple[Aircraft, ...]]:
    return (
        _parsed(LOL_POINT_FIXTURE, source=LOL),
        _parsed(FI_POINT_FIXTURE, source=FI),
    )


def _shared(result: UnionResult[Aircraft]) -> dict[str, str]:
    """Which provider supplied each of the four aircraft both networks saw."""
    return {r.key: r.provider for r in result.records if r.key in SHARED_ADDRESSES}


# ---------------------------------------------------------------- one record per identity


def test_two_providers_over_one_city_produce_one_record_per_icao_address() -> None:
    """The phantom-fleet guard. Two networks, one aircraft, one record.

    Counted before and after, because the failure this prevents is not an exception: it is
    an inflated layer where the same jet is drawn three times and every number on screen
    is wrong.
    """
    lol, fi = _both_captures()
    assert (len(lol), len(fi)) == (LOL_POINT_AIRCRAFT, ADSBFI_POINT_AIRCRAFT)
    assert len(lol) + len(fi) == 122

    result = _merge(
        ProviderResult(provider=LOL, records=lol), ProviderResult(provider=FI, records=fi)
    )

    assert len(result.records) == UNION_AIRCRAFT
    keys = [record.key for record in result.records]
    assert len(set(keys)) == len(keys)
    assert {record.key for record in result.records if len(record.sightings) == 2} == (
        SHARED_ADDRESSES
    )


def test_the_union_is_additive_over_what_either_provider_saw_alone() -> None:
    """Coverage is the point of ADR 010: the merged layer is larger than either provider."""
    lol, fi = _both_captures()

    result = _merge(
        ProviderResult(provider=LOL, records=lol), ProviderResult(provider=FI, records=fi)
    )

    assert len(result.records) > len(lol)
    assert len(result.records) > len(fi)
    assert {record.key for record in result.records} == {a.icao24 for a in (*lol, *fi)}


def test_the_same_provider_reporting_an_asset_twice_leaves_one_sighting() -> None:
    """One provider's viewport and military calls overlap, so it can report a hex twice.

    Both arrival orders, because keeping the first report seen rather than the newest is
    the easy way to write this wrong and it only shows up in one of the two orders.
    """
    older = _parsed(LOL_POINT_FIXTURE, source=LOL)
    newer = _parsed(LOL_POINT_FIXTURE, source=LOL, envelope_ms=LOL_ENVELOPE_MS + ENVELOPE_GAP_MS)
    newest_fix = {a.icao24: _fix_time(a) for a in newer}

    for batches in ((*older, *newer), (*newer, *older)):
        result = _merge(ProviderResult(provider=LOL, records=batches))

        assert len(result.records) == LOL_POINT_AIRCRAFT
        for record in result.records:
            assert record.providers == (LOL,)
            assert record.sightings[0].reported_at == newest_fix[record.key]


def test_three_providers_over_one_asset_are_one_record_and_three_sightings() -> None:
    """Coverage and corroboration are different questions. Reading R1 governs the second.

    The same capture replayed under three provider names is the case R1 in
    ``docs/pending-decisions.md`` describes literally: one volunteer antenna feeding three
    aggregators, so three providers agreeing can be one receiver counted three times.
    That makes it **one** origin for any corroboration score, which is scored elsewhere.
    Here it is three entries on the provider list, because "which networks saw this
    aircraft" is a coverage question and the honest answer is three.
    """
    names = ("adsb.lol", "adsb.fi", "adsbexchange")
    results = [
        ProviderResult(provider=name, records=_parsed(LOL_POINT_FIXTURE, source=name))
        for name in names
    ]

    result = _merge(*results)

    assert len(result.records) == LOL_POINT_AIRCRAFT
    for record in result.records:
        assert len(record.sightings) == 3
        assert set(record.providers) == set(names)
    assert result.attributable_counts() == dict.fromkeys(names, 0)


# ---------------------------------------------------------------- recency, not precedence


@pytest.mark.parametrize(
    ("fi_offset_ms", "expected_winner"),
    [
        pytest.param(ENVELOPE_GAP_MS, FI, id="adsb.fi-fresher"),
        pytest.param(-ENVELOPE_GAP_MS, LOL, id="adsb.lol-fresher"),
    ],
)
def test_an_asset_seen_by_both_resolves_to_the_newer_report(
    fi_offset_ms: int, expected_winner: str
) -> None:
    """The newer report wins in both directions, so no provider has precedence.

    Run twice with the two captures' batch timestamps swapped around. If the answer
    changed only when adsb.lol was fresher, the merge would be preferring a provider and
    calling it recency.
    """
    lol = _parsed(LOL_POINT_FIXTURE, source=LOL)
    fi = _parsed(FI_POINT_FIXTURE, source=FI, envelope_ms=LOL_ENVELOPE_MS + fi_offset_ms)

    result = _merge(
        ProviderResult(provider=LOL, records=lol), ProviderResult(provider=FI, records=fi)
    )

    shared = {record.key: record for record in result.records if record.key in SHARED_ADDRESSES}
    assert set(shared) == SHARED_ADDRESSES
    for record in shared.values():
        assert set(record.providers) == {LOL, FI}, "both providers must stay named on the record"
        assert record.provider == expected_winner
        assert record.value.source == expected_winner
        assert record.providers[0] == expected_winner, "freshest first"
        assert record.sightings[0].reported_at > record.sightings[1].reported_at


def test_the_alphabetically_first_provider_loses_when_its_fix_is_older() -> None:
    """Precedence never wins, including the accidental precedence a sort order creates.

    ``adsb.fi`` sorts before ``adsb.lol`` and is the tie-break winner, so this is the case
    where a merge that fell back on ordering would look correct on every other test. Give
    the alphabetically first provider the older batch and it must lose all four shared
    aircraft, whichever order the two results arrive in.
    """
    lol = _parsed(LOL_POINT_FIXTURE, source=LOL)
    stale_fi = _parsed(FI_POINT_FIXTURE, source=FI, envelope_ms=LOL_ENVELOPE_MS - ENVELOPE_GAP_MS)
    fresh = ProviderResult(provider=LOL, records=lol)
    stale = ProviderResult(provider=FI, records=stale_fi)

    for ordering in ((fresh, stale), (stale, fresh)):
        result = _merge(*ordering)

        assert _shared(result) == dict.fromkeys(SHARED_ADDRESSES, LOL)
        for record in result.records:
            if record.key in SHARED_ADDRESSES:
                assert min(record.providers) == FI, "the loser is the one that sorts first"


def test_the_fix_time_decides_and_not_the_response_time() -> None:
    """A slow provider's stale fix must not win because its response arrived last.

    Built so the two orderings disagree on the real captures. adsb.fi's response is moved
    2 s later than adsb.lol's, which makes adsb.fi the later responder for all four shared
    aircraft. Its report of ``4cad97`` was already 3.784 s old when it was sent, against
    0.131 s for adsb.lol, so that one aircraft resolves to adsb.lol while the other three
    resolve to adsb.fi. Ranking on response time would hand adsb.fi all four.
    """
    lol = _parsed(LOL_POINT_FIXTURE, source=LOL)
    fi = _parsed(FI_POINT_FIXTURE, source=FI, envelope_ms=LOL_ENVELOPE_MS + FIX_GAP_MS)
    assert fi[0].observed_at > lol[0].observed_at, "adsb.fi must be the later responder"

    result = _merge(
        ProviderResult(provider=LOL, records=lol), ProviderResult(provider=FI, records=fi)
    )

    assert _shared(result) == {
        DISAGREEING_ADDRESS: LOL,
        "42584b": FI,
        "42584c": FI,
        "4d20f4": FI,
    }
    stale = next(r for r in result.records if r.key == DISAGREEING_ADDRESS)
    assert stale.value.position_age_s == pytest.approx(0.131)
    by_provider = {s.provider: s for s in stale.sightings}
    assert by_provider[FI].reported_at < by_provider[LOL].reported_at


def test_the_winning_position_is_one_a_receiver_actually_reported() -> None:
    """Nothing is averaged. The record holds an input object, not a value we computed."""
    lol, fi = _both_captures()
    by_provider = {(a.source, a.icao24): a for a in (*lol, *fi)}

    result = _merge(
        ProviderResult(provider=LOL, records=lol), ProviderResult(provider=FI, records=fi)
    )

    for record in result.records:
        assert record.value is by_provider[record.provider, record.key]

    disagreement = next(r for r in result.records if r.key == DISAGREEING_ADDRESS)
    reported = {(a.point.lon, a.point.lat) for a in (*lol, *fi) if a.icao24 == DISAGREEING_ADDRESS}
    assert len(reported) == 2, "this address is here because the two networks disagree"
    assert (disagreement.value.point.lon, disagreement.value.point.lat) in reported
    midpoint_lon = sum(lon for lon, _ in reported) / 2
    assert disagreement.value.point.lon != pytest.approx(midpoint_lon)


def test_two_fixes_at_the_same_instant_resolve_to_the_same_provider_every_time() -> None:
    """A tie is broken on the provider name, which is the documented rule and a stable one.

    Coin-tossing a tie would make an asset jitter between two positions on every poll, so
    the answer has to be the same on repeated calls and in either arrival order. The two
    real captures are merged with one injected fix instant, so every one of the four shared
    aircraft ties and ``adsb.fi`` wins them on its name alone.
    """
    lol, fi = _both_captures()
    tied = ProviderResult(provider=LOL, records=lol), ProviderResult(provider=FI, records=fi)

    first, again, reversed_order = (
        merge_providers(
            ordering,
            key=lambda aircraft: aircraft.icao24,
            reported_at=lambda _aircraft: REFERENCE_TIME,
            clock=FrozenClock(MERGE_TIME),
        )
        for ordering in (tied, tied, tuple(reversed(tied)))
    )

    for result in (first, again, reversed_order):
        assert _shared(result) == dict.fromkeys(SHARED_ADDRESSES, FI)
        for record in result.records:
            assert record.provider == min(record.providers), "ties go to the first name"
    assert again.keyed() == first.keyed(), "the same input twice gives the same answer twice"
    assert dict(reversed_order.keyed()) == dict(first.keyed()), (
        "arrival order changes which provider is listed first, never who wins a tie"
    )


@given(
    offsets=st.lists(
        st.integers(min_value=-600, max_value=600), min_size=2, max_size=5, unique=True
    )
)
def test_recency_decides_whatever_order_the_providers_answer_in(offsets: list[int]) -> None:
    """Concurrent polling means arrival order is arbitrary, so it must not be an input."""
    results = [
        ProviderResult(
            provider=f"provider-{index}",
            records=(
                make_aircraft(
                    "3c6444",
                    observed_at=REFERENCE_TIME + timedelta(seconds=offset),
                    position_age_s=0.0,
                ),
            ),
        )
        for index, offset in enumerate(offsets)
    ]
    expected = f"provider-{offsets.index(max(offsets))}"

    for ordering in (results, list(reversed(results))):
        merged = _merge(*ordering, at=REFERENCE_TIME + timedelta(seconds=3600))

        assert len(merged.records) == 1
        assert merged.records[0].provider == expected
        assert len(merged.records[0].sightings) == len(offsets)


# ---------------------------------------------------------------- provider evidence


def test_every_record_carries_the_providers_that_saw_it_and_the_age_of_each_report() -> None:
    """Per record, not per layer. A merged store that cannot say who saw what is unauditable."""
    lol, fi = _both_captures()
    expected_age = {
        (a.source, a.icao24): (MERGE_TIME - _fix_time(a)).total_seconds() for a in (*lol, *fi)
    }

    result = _merge(
        ProviderResult(provider=LOL, records=lol), ProviderResult(provider=FI, records=fi)
    )

    for record in result.records:
        assert record.sightings
        for sighting in record.sightings:
            assert sighting.age_s == pytest.approx(expected_age[sighting.provider, record.key])
            assert sighting.age_s > 0.0
        ages = [sighting.age_s for sighting in record.sightings]
        assert ages == sorted(ages), "freshest first, so the card reads top down"


def test_the_recorded_adsb_fi_batch_timestamp_survives_into_the_merge() -> None:
    """The unit trap that made this layer wrong: adsb.fi sends ``now`` in seconds.

    Read as milliseconds it dated the whole batch to 1970-01-21, which meant adsb.fi could
    never win a shared aircraft on recency however fresh its fix really was. Asserted here
    as well as in the parser tests because the union is where the damage showed up.
    """
    lol, fi = _both_captures()
    assert {a.observed_at for a in fi} == {FI_ENVELOPE_TIME}

    result = _merge(
        ProviderResult(provider=LOL, records=lol), ProviderResult(provider=FI, records=fi)
    )

    assert _shared(result) == dict.fromkeys(SHARED_ADDRESSES, FI), (
        "adsb.fi responded 84 minutes later, so it holds the fresher fix"
    )
    for record in result.records:
        for sighting in record.sightings:
            assert sighting.reported_at.year == 2026


def test_a_fix_ahead_of_our_clock_reads_as_zero_age_not_a_negative_one() -> None:
    """Receiver clocks drift. A negative age on a card reads as a bug in us, so it is clamped."""
    lol = _parsed(LOL_POINT_FIXTURE, source=LOL)

    result = _merge(
        ProviderResult(provider=LOL, records=lol),
        at=datetime(2026, 8, 19, 18, 0, 0, tzinfo=UTC),
    )

    assert all(s.age_s == 0.0 for record in result.records for s in record.sightings)


def test_the_provider_attributable_count_is_measured_from_the_real_captures() -> None:
    """Aircraft only one provider can see is the argument for paying for a feed.

    Measured off the two captures rather than asserted, so it moves when coverage moves.
    """
    lol, fi = _both_captures()

    result = _merge(
        ProviderResult(provider=LOL, records=lol), ProviderResult(provider=FI, records=fi)
    )

    counts = result.attributable_counts()
    assert counts == {LOL: LOL_ONLY_AIRCRAFT, FI: FI_ONLY_AIRCRAFT}
    assert set(counts) == set(result.reporting), "every reporting provider gets an entry"
    assert sum(counts.values()) + len(SHARED_ADDRESSES) == UNION_AIRCRAFT
    single = [r for r in result.records if len(r.sightings) == 1]
    assert len(single) == sum(counts.values())
    assert counts[LOL] == len({a.icao24 for a in lol} - {a.icao24 for a in fi})


def test_a_provider_that_added_nothing_this_cycle_still_appears_in_the_count() -> None:
    """A zero is information. A provider vanishing from the table looks like a bug."""
    lol, fi = _both_captures()
    mirror = _parsed(FI_POINT_FIXTURE, source="mirror")

    result = _merge(
        ProviderResult(provider=LOL, records=lol),
        ProviderResult(provider=FI, records=fi),
        ProviderResult(provider="mirror", records=mirror),
    )

    counts = result.attributable_counts()
    assert counts == {LOL: LOL_ONLY_AIRCRAFT, FI: 0, "mirror": 0}
    assert len(result.records) == UNION_AIRCRAFT


# ---------------------------------------------------------------- degradation


def test_a_provider_that_raises_drops_out_and_the_layer_keeps_serving() -> None:
    """Coverage degrades, the layer does not fail, and the result names what is missing."""
    lol = _parsed(LOL_POINT_FIXTURE, source=LOL)
    outage = RateLimitedError(FI, 420, 120.0)
    dropped: ProviderResult[Aircraft] = ProviderResult.from_error(FI, outage)

    result = _merge(ProviderResult(provider=LOL, records=lol), dropped)

    assert len(result.records) == LOL_POINT_AIRCRAFT
    assert result.reporting == (LOL,)
    assert result.missing == (FI,)
    assert result.degraded
    reason = result.degraded_reason
    assert reason is not None
    assert FI in reason
    assert "RateLimitedError" in reason
    assert "rate limited (HTTP 420)" in reason
    assert all(record.providers == (LOL,) for record in result.records)


def test_an_empty_answer_is_not_a_failure() -> None:
    """AISHub answers a bad username with an empty HTTP 200.

    An empty success must never read as an error, and an error must never read as an
    empty success. Both states are here side by side because that is the only way to see
    that the result tells them apart.
    """
    lol = _parsed(LOL_POINT_FIXTURE, source=LOL)
    saw_nothing = _merge(ProviderResult(provider=LOL, records=lol), ProviderResult(provider=FI))
    fell_over: ProviderResult[Aircraft] = ProviderResult.from_error(FI, RuntimeError("empty 200"))
    broke = _merge(ProviderResult(provider=LOL, records=lol), fell_over)

    assert saw_nothing.reporting == (LOL, FI)
    assert saw_nothing.empty == (FI,)
    assert saw_nothing.missing == ()
    assert not saw_nothing.degraded
    assert saw_nothing.degraded_reason is None
    assert saw_nothing.attributable_counts() == {LOL: LOL_POINT_AIRCRAFT, FI: 0}

    assert broke.reporting == (LOL,)
    assert broke.empty == ()
    assert broke.missing == (FI,)
    assert broke.degraded
    assert broke.attributable_counts() == {LOL: LOL_POINT_AIRCRAFT}

    assert len(saw_nothing.records) == len(broke.records)


def test_every_provider_failing_at_once_yields_nothing_and_does_not_raise() -> None:
    """A total outage is an empty layer that says why, not an exception out of the merge."""
    result = _merge(
        ProviderResult.from_error(LOL, RateLimitedError(LOL, 420, 120.0)),
        ProviderResult.from_error(FI, TimeoutError("no answer")),
    )

    assert result.records == ()
    assert result.keyed() == ()
    assert result.reporting == ()
    assert result.empty == ()
    assert result.missing == (LOL, FI)
    assert result.degraded
    assert result.attributable_counts() == {}
    reason = result.degraded_reason
    assert reason is not None
    assert LOL in reason
    assert FI in reason
    assert "TimeoutError: no answer" in reason


def test_no_providers_at_all_is_an_empty_union_rather_than_a_degraded_one() -> None:
    """Nothing configured is not the same as everything broken, and uses the real clock."""
    result: UnionResult[Aircraft] = merge_providers(
        (), key=lambda aircraft: aircraft.icao24, reported_at=_fix_time
    )

    assert result.records == ()
    assert result.keyed() == ()
    assert result.reporting == ()
    assert result.missing == ()
    assert not result.degraded
    assert result.attributable_counts() == {}


# ---------------------------------------------------------------- feeding a store


def test_keyed_pairs_go_straight_into_a_store() -> None:
    """``keyed()`` exists to feed ``upsert_many``, so assert it against the real store."""
    store: EntityStore[Aircraft] = EntityStore(ttl_seconds=90.0)
    lol, fi = _both_captures()
    result = _merge(
        ProviderResult(provider=LOL, records=lol), ProviderResult(provider=FI, records=fi)
    )

    store.upsert_many(result.keyed())

    assert len(store) == UNION_AIRCRAFT
    assert store.keys() == {record.key for record in result.records}
    for record in result.records:
        assert store.get(record.key) is record.value


def test_a_degraded_cycle_never_empties_the_store() -> None:
    """The dangerous version of the empty-200 trap: a merged store quietly going blank."""
    store: EntityStore[Aircraft] = EntityStore(ttl_seconds=90.0)
    lol, fi = _both_captures()
    store.upsert_many(
        _merge(
            ProviderResult(provider=LOL, records=lol), ProviderResult(provider=FI, records=fi)
        ).keyed()
    )
    assert len(store) == UNION_AIRCRAFT

    outage: ProviderResult[Aircraft] = ProviderResult.from_error(FI, RuntimeError("no answer"))
    degraded = _merge(ProviderResult(provider=LOL), outage)
    store.upsert_many(degraded.keyed())

    assert degraded.degraded
    assert degraded.keyed() == ()
    assert len(store) == UNION_AIRCRAFT


def test_replace_all_on_a_degraded_cycle_loses_what_only_the_dead_provider_saw() -> None:
    """Why ``keyed()``'s docstring tells a caller to branch on ``degraded`` first.

    ``replace_all`` is correct for a feed that publishes a complete world each poll, and a
    degraded union is not that: it is a partial world that looks like a complete one. Run
    it here so the size of the loss is on the record, 53 aircraft off the globe because one
    provider timed out, none of which had gone anywhere.
    """
    store: EntityStore[Aircraft] = EntityStore(ttl_seconds=90.0)
    lol, fi = _both_captures()
    store.replace_all(
        _merge(
            ProviderResult(provider=LOL, records=lol), ProviderResult(provider=FI, records=fi)
        ).keyed()
    )
    assert len(store) == UNION_AIRCRAFT
    fi_only = {a.icao24 for a in fi} - {a.icao24 for a in lol}
    assert len(fi_only) == FI_ONLY_AIRCRAFT

    degraded = _merge(
        ProviderResult(provider=LOL, records=lol),
        ProviderResult.from_error(FI, TimeoutError("no answer")),
    )
    store.replace_all(degraded.keyed())

    assert degraded.degraded
    assert len(store) == LOL_POINT_AIRCRAFT
    assert fi_only.isdisjoint(store.keys())
    assert set(store.take_changes().removed) == fi_only, (
        "every one of them is pushed to the browser as gone"
    )


# ---------------------------------------------------------------- input validation


def test_a_failed_provider_cannot_also_carry_records() -> None:
    """Records under an error would be counted into the union and blamed on a dead feed."""
    with pytest.raises(ValueError, match="cannot also carry records"):
        ProviderResult(provider=FI, records=(make_aircraft(),), error="RuntimeError: boom")


def test_a_dropped_provider_reports_itself_the_way_the_poller_does() -> None:
    """Same ``Type: message`` shape as ``PollerHealth.last_error``, so logs read alike."""
    dropped: ProviderResult[Aircraft] = ProviderResult.from_error(FI, ValueError("bad envelope"))

    assert dropped.failed
    assert dropped.records == ()
    assert dropped.error == "ValueError: bad envelope"
