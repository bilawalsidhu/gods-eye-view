"""The Kystdatahuset AIS adapter, driven by a real captured body.

``tests/fixtures/kystdatahuset_ais_realtime_live.json`` is a 120-feature slice of a genuine
``kystdatahuset.no/ws/api/ais/realtime/geojson`` response captured on 2026-08-23, sliced so
that every trap in the module docstring is present in the bytes rather than hand-written. No
network: respx intercepts at the transport, and ``assert_all_called=True`` means a test that
believes it exercised a path but did not is a failure rather than a false pass.

Five traps get disproportionate attention because each one produces wrong output rather than
an error, so nothing fails and nobody notices: the LineString whose current position is its
last coordinate, the ``[NN%]`` confidence suffix on a name, the ``draught`` that is an int on
some records and a float on others, the LineString with no coordinates at all, and the ``cog``
field carrying the heading sentinel.
"""

import json
import math
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx

from tests.conftest import fixture_bytes, fixture_json
from tracker.cache import FILE_NAME, DiskCache
from tracker.contracts.base import ContractViolationError
from tracker.contracts.geo import KNOTS_TO_METRES_PER_SECOND
from tracker.contracts.vessel import NavigationalStatus
from tracker.sources.base import RateLimitedError, SourceError
from tracker.sources.kystdatahuset import (
    ATTRIBUTION,
    BASE_URL,
    LICENCE,
    MAX_FIX_TIME_AHEAD_SECONDS,
    MIN_INTERVAL_SECONDS,
    REALTIME_PATH,
    SOURCE_NAME,
    KystdatahusetClient,
    parse_realtime,
)

REALTIME_URL = f"{BASE_URL}{REALTIME_PATH}"

FIXTURE = "kystdatahuset_ais_realtime_live.json"

FEATURE_COUNT = 120
"""Features in the captured body."""

VESSEL_COUNT = 103
"""Usable vessels out of those 120: 15 dropped and 2 superseded duplicate reports."""

DROPPED_COUNT = 15
SUPERSEDED_COUNT = 2

CAPTURE_TIME = datetime(2026, 8, 23, 10, 0, 0, tzinfo=UTC)
"""A clock a few minutes after the capture, so every fix in it is in the past."""

MOVER_MMSI = "257175000"
"""RYGERFONN, doing 29.1 knots on a 40-coordinate track. The direction trap's worked example.

Its track runs from ``[5.33559, 60.13559]`` to ``[5.36778, 60.12712]``, east and slightly
south, which agrees with its own reported course of 108.4 degrees. So the last coordinate is
where she is and the first is where she was, and the two are 1.9 km apart.
"""
MOVER_CURRENT = (5.36778, 60.12712)
MOVER_STALE = (5.33559, 60.13559)
MOVER_COG = 108.4

CONFIDENCE_SUFFIX_MMSI = "585900152"
"""``'THEA MATHILDE  [59%]'`` on the wire. The provider's own match confidence, not a name."""

UNCREWED_MMSI = "253000106"
"""``'DOLPHIN01 [UNCREWED]'``. A trailing bracket that is part of the vessel's real name."""

SAR_AIRCRAFT_MMSI = 111257514
""""SAR AIRCRAFT CHC SAR", callsign LNOQR, a helicopter in the live vessel body."""

COAST_STATION_MMSI = 2320212
""""MAGNUS PLATFOROM", which pads to ``002320212``: a coast station, not a ship."""

COG_SENTINEL_MMSI = "259038580"
"""BRANNBATEN VIB, whose ``cog`` reads 511.0, the *heading* sentinel in the course field."""

SOG_SENTINEL_MMSI = "259473000"
"""A record whose ``speed`` reads exactly 102.3 knots, the AIS not-available value."""

SATURATED_DRAUGHT_MMSI = "232589000"
"""``draught`` 25.5 as a float, which is the AIS "25.5 m or greater" saturation point."""

MICROSECOND_MMSI = "002320212"
"""``date_time_utc`` of ``2026-08-23T09:50:13.637612``. Some records carry microseconds."""

DUPLICATE_MMSI = "259036280"
"""AURORA, reported twice in one body: 09:44:55 with an empty name and 09:52:33 with it."""

DUPLICATE_FRESH_AT = datetime(2026, 8, 23, 9, 52, 33, tzinfo=UTC)


@pytest.fixture
def payload() -> bytes:
    """The captured realtime body, 120 features, 2026-08-23."""
    return fixture_bytes(FIXTURE)


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    """A real httpx client. respx intercepts at the transport, so nothing leaves the process."""
    async with httpx.AsyncClient() as client:
        yield client


@pytest.fixture
def client(http: httpx.AsyncClient) -> KystdatahusetClient:
    return KystdatahusetClient(http, clock=lambda: CAPTURE_TIME)


class Clock:
    """A hand-driven clock, so a cooldown boundary is measured rather than slept through."""

    def __init__(self, start: datetime = CAPTURE_TIME) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


def _parse(payload: bytes, *, now: datetime = CAPTURE_TIME) -> Any:
    return parse_realtime(payload, now=now)


def _by_mmsi(payload: bytes, *, now: datetime = CAPTURE_TIME) -> dict[str, Any]:
    return {vessel.mmsi: vessel for vessel in _parse(payload, now=now).records}


def _envelope(*features: Any) -> bytes:
    return json.dumps({"type": "FeatureCollection", "features": list(features)}).encode()


def _feature(**overrides: Any) -> dict[str, Any]:
    """One feature in the shape this endpoint actually sends, for a targeted variant.

    Built from the real body's key set rather than invented, so a test that overrides one
    field is still exercising the shape the provider sends.
    """
    properties: dict[str, Any] = {
        "id": 12345,
        "cog": 90.0,
        "imo": 9664627,
        "mmsi": 257234800,
        "speed": 10.0,
        "length": 20,
        "status": 0,
        "breadth": 4,
        "draught": 1,
        "callsign": "JWQM",
        "maneuvre": 0,
        "ais_class": "A",
        "ship_name": "TEST SHIP",
        "ship_type": 99,
        "destination": "TRONDHEIM",
        "true_heading": 91,
        "date_time_utc": "2026-08-23T09:55:00",
    }
    geometry: dict[str, Any] = {
        "type": "LineString",
        "coordinates": [[10.0, 63.0], [10.1, 63.0]],
    }
    for field, value in overrides.items():
        if field == "coordinates":
            geometry["coordinates"] = value
        else:
            properties[field] = value
    return {"type": "Feature", "geometry": geometry, "properties": properties}


# ---------------------------------------------------------------- the real payload


def test_parses_the_live_body(payload: bytes) -> None:
    parsed = _parse(payload)
    assert len(parsed.records) == VESSEL_COUNT
    assert parsed.dropped == DROPPED_COUNT
    assert {vessel.source for vessel in parsed.records} == {SOURCE_NAME}
    assert all(vessel.kind == "vessel" for vessel in parsed.records)


def test_every_feature_is_kept_dropped_or_superseded(payload: bytes) -> None:
    """Nothing goes missing between the wire and the records. The arithmetic has to close.

    A parser that silently loses records reads as thin coverage rather than as a bug, which
    is the whole reason ``ParsedRecords`` carries a count at all.
    """
    parsed = _parse(payload)
    assert len(parsed.records) + parsed.dropped + SUPERSEDED_COUNT == FEATURE_COUNT


def test_the_provider_is_named_on_every_record_and_the_union_fills_the_rest(
    payload: bytes,
) -> None:
    """``source`` is per record, per ADR 010. ``providers`` is the union's to fill, not ours.

    The first entry of ``providers`` must equal ``source``, and the merge is what guarantees
    it. An adapter that pre-populated the list would be asserting a merge it never did.
    """
    for vessel in _parse(payload).records:
        assert vessel.source == SOURCE_NAME
        assert vessel.providers == ()


# ---------------------------------------------------------------- trap 1: the LineString


def test_the_position_is_the_last_coordinate_of_the_linestring(payload: bytes) -> None:
    """Trap 1. Taking the first coordinate puts a 29-knot ferry 1.9 km behind herself."""
    mover = _by_mmsi(payload)[MOVER_MMSI]
    assert (mover.point.lon, mover.point.lat) == MOVER_CURRENT
    assert (mover.point.lon, mover.point.lat) != MOVER_STALE


def test_the_track_runs_oldest_first_which_is_why_the_last_coordinate_is_current() -> None:
    """The evidence, asserted rather than left in a docstring.

    The last segment's bearing agrees with the vessel's own reported course over ground and
    the reversed segment disagrees by about 180 degrees. Across the live body that held for
    97.9% of moving vessels one way and 0.2% the other, so the direction is a property of the
    feed and not of this one record.
    """
    feature = next(
        item
        for item in fixture_json(FIXTURE)["features"]
        if item["properties"]["mmsi"] == int(MOVER_MMSI)
    )
    coordinates = feature["geometry"]["coordinates"]
    start, end = coordinates[-2], coordinates[-1]

    def bearing(a: list[float], b: list[float]) -> float:
        north = b[1] - a[1]
        east = (b[0] - a[0]) * math.cos(math.radians(a[1]))
        return math.degrees(math.atan2(east, north)) % 360.0

    def error(value: float) -> float:
        gap = abs(value - MOVER_COG)
        return min(gap, 360.0 - gap)

    assert error(bearing(start, end)) < 20.0
    assert error(bearing(end, start)) > 160.0


# ---------------------------------------------------------------- trap 2: the name suffix


def test_a_match_confidence_suffix_is_stripped_off_the_name(payload: bytes) -> None:
    """Trap 2. ``'THEA MATHILDE  [59%]'`` is a name and an internal score, not a name."""
    assert _by_mmsi(payload)[CONFIDENCE_SUFFIX_MMSI].name == "THEA MATHILDE"


def test_no_surviving_name_carries_a_percentage(payload: bytes) -> None:
    """15 of the 120 features carry the suffix, so this is a real sweep and not a tautology."""
    raw = [
        item["properties"]["ship_name"]
        for item in fixture_json(FIXTURE)["features"]
        if "%]" in item["properties"]["ship_name"]
    ]
    assert len(raw) == 15
    assert all("%]" not in (vessel.name or "") for vessel in _parse(payload).records)


def test_a_trailing_bracket_that_is_not_a_percentage_is_part_of_the_name(
    payload: bytes,
) -> None:
    """Trap 2's sharp edge. Strip every trailing bracket and ``DOLPHIN01`` loses what it is."""
    assert _by_mmsi(payload)[UNCREWED_MMSI].name == "DOLPHIN01 [UNCREWED]"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("THEA MATHILDE  [59%]", "THEA MATHILDE"),
        ("BUOY TJ3       [41%]", "BUOY TJ3"),
        ("WIKEROY SENIOR [95%]", "WIKEROY SENIOR"),
        ("DOLPHIN01 [UNCREWED]", "DOLPHIN01 [UNCREWED]"),
        ("NORDLYS [100%]", "NORDLYS"),
        ("SHIP [5%]", "SHIP"),
        ("", None),
        ("   ", None),
        ("[59%]", None),
    ],
)
def test_the_name_strip_takes_a_percentage_and_nothing_else(raw: str, expected: str | None) -> None:
    """The pattern, exercised on its own so the boundary is explicit.

    A name that is only a confidence suffix becomes ``None`` rather than an empty string: the
    vessel still renders, labelled by its call sign or its MMSI.
    """
    parsed = _parse(_envelope(_feature(ship_name=raw)))
    assert parsed.records[0].name == expected


# ---------------------------------------------------------------- trap 3: the mixed draught


def test_int_and_float_draughts_both_survive(payload: bytes) -> None:
    """Trap 3, the ``eo:cloud_cover`` bug again.

    The live body sent 2,192 int draughts against 1,350 floats. A strict float field loses
    the ints and a strict int field loses the floats, so the wire layer must take both. Both
    kinds are present in the fixture and both reach the domain as floats.
    """
    raw = {
        f"{item['properties']['mmsi']:09d}": item["properties"]["draught"]
        for item in fixture_json(FIXTURE)["features"]
    }
    parsed = _by_mmsi(payload)
    from_ints = {
        mmsi: vessel.draught_m
        for mmsi, vessel in parsed.items()
        if vessel.draught_m is not None and isinstance(raw[mmsi], int)
    }
    from_floats = {
        mmsi: vessel.draught_m
        for mmsi, vessel in parsed.items()
        if vessel.draught_m is not None and isinstance(raw[mmsi], float)
    }
    assert from_ints
    assert from_floats
    assert all(isinstance(value, float) for value in (*from_ints.values(), *from_floats.values()))


@pytest.mark.parametrize("draught", [1, 1.0, 6, 6.5, 25, 25.5])
def test_a_draught_reaches_the_domain_as_metres_whichever_type_it_arrived_as(
    draught: float,
) -> None:
    """Metres on this endpoint, unlike Digitraffic's decimetres on ``/api/ais/v1/vessels``.

    Read as decimetres the deepest ship in the live body would draw 2.55 m, which no bulk
    carrier does.
    """
    parsed = _parse(_envelope(_feature(draught=draught)))
    assert parsed.records[0].draught_m == pytest.approx(float(draught))


def test_the_saturated_draught_is_kept_because_it_is_what_the_feed_reported(
    payload: bytes,
) -> None:
    """25.5 m means "25.5 m or greater". Still a reading, so it is not mapped to ``None``."""
    assert _by_mmsi(payload)[SATURATED_DRAUGHT_MMSI].draught_m == pytest.approx(25.5)


@pytest.mark.parametrize(
    ("field", "attribute"),
    [("draught", "draught_m"), ("length", "length_m"), ("breadth", "beam_m")],
)
def test_a_zero_dimension_is_not_available_rather_than_a_zero_metre_ship(
    field: str, attribute: str
) -> None:
    """0 on all three: ``draught`` on 1,435 live records, ``length`` on 126, ``breadth`` on 147."""
    parsed = _parse(_envelope(_feature(**{field: 0})))
    assert getattr(parsed.records[0], attribute) is None


@pytest.mark.parametrize(
    ("field", "attribute", "value"),
    [("draught", "draught_m", 99.0), ("length", "length_m", 5000), ("breadth", "beam_m", 400)],
)
def test_a_dimension_past_its_bound_empties_one_field_and_keeps_the_ship(
    field: str, attribute: str, value: float
) -> None:
    """A junk dimension must not drop a real vessel over a display attribute."""
    parsed = _parse(_envelope(_feature(**{field: value})))
    assert parsed.dropped == 0
    assert getattr(parsed.records[0], attribute) is None


# ---------------------------------------------------------------- trap 4: no coordinates


def test_a_linestring_with_no_coordinates_is_dropped_and_counted(payload: bytes) -> None:
    """Trap 4. 77 of 3,542 live records arrived as ``"coordinates": []`` with full properties.

    A vessel with no position is not on the globe, and it does not get one from anywhere.
    """
    parsed = _parse(payload)
    assert parsed.drops["feature carried no usable coordinates"] == 3


@pytest.mark.parametrize("coordinates", [[], [[10.0]], [[]]])
def test_a_geometry_that_cannot_give_a_position_is_dropped(coordinates: Any) -> None:
    parsed = _parse(_envelope(_feature(coordinates=coordinates)))
    assert not parsed.records
    assert parsed.drops["feature carried no usable coordinates"] == 1


def test_a_missing_geometry_is_dropped_rather_than_raising() -> None:
    feature = _feature()
    del feature["geometry"]
    parsed = _parse(_envelope(feature))
    assert parsed.drops["feature carried no usable coordinates"] == 1


def test_a_missing_properties_object_is_dropped_rather_than_raising() -> None:
    feature = _feature()
    del feature["properties"]
    parsed = _parse(_envelope(feature))
    assert not parsed.records
    assert parsed.dropped == 1


# ---------------------------------------------------------------- trap 5: bearing sentinels


def test_the_course_field_carrying_the_heading_sentinel_maps_to_none(payload: bytes) -> None:
    """Trap 5. 3 live records read ``cog`` 511.0, which is the heading sentinel, not a course.

    A ``0 <= x < 360`` check applied before the sentinel mapping rejects 545 real vessels
    across the live body and reads as thin coverage rather than as a bug.
    """
    vessel = _by_mmsi(payload)[COG_SENTINEL_MMSI]
    assert vessel.course_over_ground_deg is None
    assert vessel.mmsi in {v.mmsi for v in _parse(payload).records}


@pytest.mark.parametrize(
    ("cog", "expected"),
    [(0.0, 0.0), (108.4, 108.4), (359.9, 359.9), (360.0, None), (511.0, None), (-1.0, None)],
)
def test_course_over_ground_maps_its_sentinels_before_its_range(
    cog: float, expected: float | None
) -> None:
    """0.0 is a real course due north and 360.0 is not-available, so order is load-bearing."""
    parsed = _parse(_envelope(_feature(cog=cog)))
    assert parsed.records[0].course_over_ground_deg == expected


@pytest.mark.parametrize(
    ("heading", "expected"),
    [(0, 0.0), (61, 61.0), (359, 359.0), (360, None), (511, None)],
)
def test_true_heading_maps_its_own_sentinel(heading: int, expected: float | None) -> None:
    """511 on 1,179 of 3,542 live records, a third of the feed."""
    parsed = _parse(_envelope(_feature(true_heading=heading)))
    assert parsed.records[0].true_heading_deg == expected


def test_the_speed_sentinel_maps_to_none_and_keeps_the_vessel(payload: bytes) -> None:
    """102.3 knots is not-available, not a ship doing 190 km/h. 14 live records carried it."""
    vessel = _by_mmsi(payload)[SOG_SENTINEL_MMSI]
    assert vessel.speed_over_ground_mps is None


def test_a_real_speed_is_converted_from_knots_to_metres_per_second(payload: bytes) -> None:
    mover = _by_mmsi(payload)[MOVER_MMSI]
    assert mover.speed_over_ground_mps == pytest.approx(29.1 * KNOTS_TO_METRES_PER_SECOND)


def test_no_rate_of_turn_is_invented_from_the_track(payload: bytes) -> None:
    """The endpoint sends no ROT. A rate computed off two coordinates is our arithmetic."""
    assert all(vessel.rate_of_turn_deg_per_min is None for vessel in _parse(payload).records)


def test_no_eta_is_invented(payload: bytes) -> None:
    """No packed ETA field on this endpoint, and a guessed one would carry a guessed year."""
    assert all(vessel.eta is None for vessel in _parse(payload).records)


# ---------------------------------------------------------------- MMSI as the merge key


def test_a_search_and_rescue_aircraft_is_dropped_and_named(payload: bytes) -> None:
    """MMSI 111257514, "SAR AIRCRAFT CHC SAR". The ``111`` prefix is an aircraft, not a ship.

    Dropped rather than rendered, and dropped with its ITU category in the reason so the
    count says what was lost rather than reporting anonymous junk.
    """
    parsed = _parse(payload)
    assert parsed.drops["MMSI is a sar_aircraft, not a ship station"] == 1
    assert f"{SAR_AIRCRAFT_MMSI:09d}" not in {v.mmsi for v in parsed.records}


def test_a_coast_station_is_dropped_under_its_own_category(payload: bytes) -> None:
    """2320212 pads to ``002320212``, whose ``00`` prefix and MID 232 make it a coast station.

    Zero-padding before classification is what makes that reason true. Refusing it on length
    alone would have counted a UK coast station as a malformed MMSI.
    """
    parsed = _parse(payload)
    assert parsed.drops["MMSI is a coast_station, not a ship station"] == 1
    assert f"{COAST_STATION_MMSI:09d}" not in {v.mmsi for v in parsed.records}


def test_every_non_vessel_station_is_dropped_by_its_itu_category(payload: bytes) -> None:
    """The live body carried six ITU categories that are not ships, and each is named.

    Fishing-gear buoys on unallocated MIDs, auxiliary craft on the ``98`` prefix, a coast
    station, a handheld DSC set and a SAR helicopter. None of them is a vessel and none of
    them gets a substitute key, because a generated key would churn every poll and draw a new
    pin each cycle.
    """
    drops = _parse(payload).drops
    assert drops["MMSI is a unallocated, not a ship station"] == 9
    assert drops["MMSI is a auxiliary_craft, not a ship station"] == 1
    assert sum(count for reason, count in drops.items() if "not a ship station" in reason) == 12


@pytest.mark.parametrize(
    ("mmsi", "reason"),
    [
        (999999999, "MMSI is a unallocated, not a ship station"),
        (111265583, "MMSI is a sar_aircraft, not a ship station"),
        (992572500, "MMSI is a navigational_aid, not a ship station"),
        (983110590, "MMSI is a auxiliary_craft, not a ship station"),
        (877227586, "MMSI is a handheld_dsc, not a ship station"),
        (1234567890123, "MMSI is not nine digits"),
        (-1, "MMSI is not nine digits"),
    ],
)
def test_only_a_ship_station_mmsi_reaches_the_domain(mmsi: int, reason: str) -> None:
    """The merge key is the whole identity, so a placeholder is never merged on.

    999999999 is the case ADR 010's own one-record-per-MMSI test cannot catch: two warships
    broadcasting it collide into one record and the duplicate assertion still passes.
    """
    parsed = _parse(_envelope(_feature(mmsi=mmsi)))
    assert not parsed.records
    assert parsed.drops[reason] == 1


def test_a_missing_mmsi_is_dropped_rather_than_generated() -> None:
    feature = _feature()
    del feature["properties"]["mmsi"]
    parsed = _parse(_envelope(feature))
    assert parsed.drops["MMSI is not nine digits"] == 1


def test_one_record_per_mmsi(payload: bytes) -> None:
    """The phantom-fleet assertion ADR 010 asks for, applied inside one provider."""
    records = _parse(payload).records
    assert len({vessel.mmsi for vessel in records}) == len(records)


# ---------------------------------------------------------------- duplicates in one body


def test_the_same_mmsi_twice_in_one_body_keeps_the_freshest_fix(payload: bytes) -> None:
    """19 MMSIs arrived twice in the live body, 38 features, with different internal ids.

    They are one ship reported twice by the provider's own query, so recency decides and the
    superseded report is discarded. The older of the AURORA pair carries an empty name, so
    picking the wrong one loses the ship's name as well as its position.
    """
    vessel = _by_mmsi(payload)[DUPLICATE_MMSI]
    fixed_at = vessel.observed_at - timedelta(seconds=vessel.position_age_s)
    assert fixed_at == DUPLICATE_FRESH_AT
    assert vessel.name == "AURORA"


def test_a_superseded_duplicate_is_not_counted_as_a_drop(payload: bytes) -> None:
    """Nothing was refused, so it is not a drop. Counting it would inflate the drop total."""
    parsed = _parse(payload)
    assert parsed.dropped == DROPPED_COUNT
    assert not any("duplicate" in reason for reason in parsed.drops)


def test_the_fresher_report_wins_whichever_order_it_arrives_in() -> None:
    """Order independence, so the answer is the freshest fix and not the last one read."""
    stale = _feature(date_time_utc="2026-08-23T09:40:00", ship_name="")
    fresh = _feature(date_time_utc="2026-08-23T09:55:00", ship_name="AURORA")
    for order in ((stale, fresh), (fresh, stale)):
        parsed = _parse(_envelope(*order))
        assert len(parsed.records) == 1
        assert parsed.records[0].name == "AURORA"


# ---------------------------------------------------------------- time


def test_a_naive_timestamp_gets_utc_attached_in_the_adapter(payload: bytes) -> None:
    """Every ``date_time_utc`` on the wire is naive and is UTC by its own name.

    The CelesTrak ``EPOCH`` case: a naive datetime reaching a domain contract is a validation
    error, so the zone is attached here.
    """
    for vessel in _parse(payload).records:
        assert vessel.observed_at.tzinfo is not None
        assert vessel.observed_at.utcoffset() == timedelta(0)


def test_a_timestamp_carrying_microseconds_parses() -> None:
    """Some records send ``2026-08-23T09:50:13.637612`` and some send whole seconds."""
    raw = next(
        item["properties"]["date_time_utc"]
        for item in fixture_json(FIXTURE)["features"]
        if f"{item['properties']['mmsi']:09d}" == MICROSECOND_MMSI
    )
    assert "." in raw


def test_the_position_age_is_never_negative_and_recovers_the_fix(payload: bytes) -> None:
    """``observed_at - position_age_s`` is what the union resolves a conflict on.

    There is no envelope timestamp on this endpoint, so ``observed_at`` is our receive clock
    floored at the record's own fix. That floor is what stops a fix a few seconds inside our
    clock skew producing a negative age.
    """
    for vessel in _parse(payload).records:
        assert vessel.position_age_s >= 0.0
        assert vessel.observed_at - timedelta(seconds=vessel.position_age_s) <= vessel.observed_at


def test_the_age_is_measured_from_our_own_clock() -> None:
    parsed = _parse(
        _envelope(_feature(date_time_utc="2026-08-23T09:55:00")),
        now=datetime(2026, 8, 23, 10, 0, 0, tzinfo=UTC),
    )
    assert parsed.records[0].position_age_s == pytest.approx(300.0)


def test_a_fix_dated_ahead_of_our_clock_is_dropped() -> None:
    """A future fix does not merely enter the recency merge, it wins every one of them.

    That is the accidental provider precedence ADR 010 forbids, arriving through a bad
    timestamp rather than through a preference order.
    """
    now = datetime(2026, 8, 23, 10, 0, 0, tzinfo=UTC)
    ahead = now + timedelta(seconds=MAX_FIX_TIME_AHEAD_SECONDS + 30)
    parsed = _parse(
        _envelope(_feature(date_time_utc=ahead.replace(tzinfo=None).isoformat())), now=now
    )
    assert not parsed.records
    assert parsed.drops["date_time_utc is dated ahead of our own clock"] == 1


def test_a_fix_inside_the_clock_skew_allowance_is_kept() -> None:
    """A minute of skew between us and the provider is not a bad record."""
    now = datetime(2026, 8, 23, 10, 0, 0, tzinfo=UTC)
    ahead = now + timedelta(seconds=MAX_FIX_TIME_AHEAD_SECONDS - 1)
    parsed = _parse(
        _envelope(_feature(date_time_utc=ahead.replace(tzinfo=None).isoformat())), now=now
    )
    assert len(parsed.records) == 1
    assert parsed.records[0].position_age_s == 0.0


def test_a_record_with_no_fix_time_is_dropped_rather_than_dated_to_now() -> None:
    """A record that cannot say when it was taken would win every merge it entered."""
    feature = _feature()
    del feature["properties"]["date_time_utc"]
    parsed = _parse(_envelope(feature))
    assert parsed.drops["no date_time_utc, so the fix has no time"] == 1


# ---------------------------------------------------------------- text and optional fields


def test_empty_text_becomes_none_rather_than_an_empty_string() -> None:
    """The feed sends ``""``: ``destination`` on 809 of 3,542 records, nearly a quarter."""
    parsed = _parse(_envelope(_feature(callsign="", destination="", ship_name="")))
    vessel = parsed.records[0]
    assert vessel.call_sign is None
    assert vessel.destination is None
    assert vessel.name is None


def test_a_null_text_field_is_accepted_because_the_provider_declares_them_nullable() -> None:
    """``ship_name``, ``callsign`` and ``destination`` are ``nullable: true`` in the provider's
    own schema, even though the captured body sent an empty string every time instead.

    Both forms have to mean the same thing here, or the day the provider starts sending
    ``null`` becomes the day a quarter of the feed fails the contract.
    """
    parsed = _parse(_envelope(_feature(ship_name=None, callsign=None, destination=None)))
    vessel = parsed.records[0]
    assert vessel.name is None
    assert vessel.call_sign is None
    assert vessel.destination is None


def test_a_coordinate_outside_wgs84_is_dropped_and_counted() -> None:
    """The last line of defence. A junk position fails the contract rather than being drawn.

    Every position in the capture landed in Norwegian waters, so this is the guard rather
    than an observed defect: the drop is counted under the contract reason, so a body that
    started sending nonsense would show up on ``/api/layers`` instead of silently thinning.
    """
    parsed = _parse(_envelope(_feature(coordinates=[[10.0, 63.0], [200.0, 63.0]])))
    assert not parsed.records
    assert parsed.drops["failed the vessel contract"] == 1


def test_long_text_is_truncated_rather_than_dropping_the_ship() -> None:
    """Losing the tail of a destination beats losing a real vessel over a display field."""
    parsed = _parse(_envelope(_feature(destination="A" * 60, callsign="B" * 20)))
    vessel = parsed.records[0]
    assert vessel.destination == "A" * 20
    assert vessel.call_sign == "B" * 7


@pytest.mark.parametrize(("imo", "expected"), [(0, None), (9664627, 9664627), (912974400, None)])
def test_the_imo_sentinel_and_out_of_range_values_map_to_none(
    imo: int, expected: int | None
) -> None:
    """0 on 1,845 of 3,542 live records, over half the feed."""
    parsed = _parse(_envelope(_feature(imo=imo)))
    assert parsed.records[0].imo == expected


@pytest.mark.parametrize(("ship_type", "expected"), [(0, None), (70, 70), (99, 99), (200, None)])
def test_the_ship_type_sentinel_maps_to_none(ship_type: int, expected: int | None) -> None:
    parsed = _parse(_envelope(_feature(ship_type=ship_type)))
    assert parsed.records[0].ship_type == expected


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (0, NavigationalStatus.UNDER_WAY_USING_ENGINE),
        (5, NavigationalStatus.MOORED),
        (7, NavigationalStatus.ENGAGED_IN_FISHING),
        (9, None),
        (13, None),
        (15, None),
    ],
)
def test_navigational_status_leaves_the_undefined_and_reserved_codes_empty(
    status: int, expected: NavigationalStatus | None
) -> None:
    """15 undefined on 81 live records, plus 9, 10 and 13 reserved on 16 more."""
    parsed = _parse(_envelope(_feature(status=status)))
    assert parsed.records[0].navigational_status == expected


def test_coordinates_are_longitude_first(payload: bytes) -> None:
    """No swap here: the feed already agrees with this project's rule.

    Confirmed off the live body rather than the documentation. Latitudes ran 55.8 to 79.7,
    which is Denmark to Svalbard, and every position lands in Norwegian waters or their
    approaches.
    """
    for vessel in _parse(payload).records:
        assert -1.0 <= vessel.point.lon <= 40.0
        assert 55.0 <= vessel.point.lat <= 81.0
        assert vessel.point.altitude_m is None


# ---------------------------------------------------------------- the envelope


def test_a_changed_envelope_is_a_loud_failure_not_an_empty_layer() -> None:
    """A shape change that parsed to zero vessels would read as a healthy but empty layer."""
    with pytest.raises(ContractViolationError):
        parse_realtime(b'{"features": []}')
    with pytest.raises(ContractViolationError):
        parse_realtime(b'{"type": "FeatureCollection"}')
    with pytest.raises(ContractViolationError):
        parse_realtime(b"not json at all")


def test_one_junk_feature_does_not_reject_the_whole_body(payload: bytes) -> None:
    """Per-feature validation, not one pass over the array.

    Typing ``features`` as a tuple of feature models would let one junk record in 3,542
    reject the entire body, which is the bug that emptied the vessel layer once already.
    """
    features = fixture_json(FIXTURE)["features"]
    parsed = parse_realtime(
        _envelope("not an object at all", *features, {"nested": {"still": "wrong"}}),
        now=CAPTURE_TIME,
    )
    assert len(parsed.records) == VESSEL_COUNT
    assert parsed.drops["record does not match the shape this endpoint sends"] == 2


def test_an_empty_feature_array_parses_to_nothing_without_raising() -> None:
    """The envelope is intact, so this is the parser's answer and the client's decision."""
    parsed = parse_realtime(_envelope())
    assert not parsed.records
    assert parsed.dropped == 0


# ---------------------------------------------------------------- the client


def test_the_cadence_floor_is_in_code_and_not_configurable(
    client: KystdatahusetClient,
) -> None:
    """No constructor argument and no setter, so no configuration can lower it."""
    assert client.min_interval_seconds == MIN_INTERVAL_SECONDS
    assert MIN_INTERVAL_SECONDS == 60.0
    assert client.name == SOURCE_NAME


def test_the_licence_permits_what_this_product_does() -> None:
    """NLOD 1.0, named by the provider in its own OpenAPI document.

    Unlike AISHub and aisstream.io it grants redistribution, so serving these positions to a
    browser is not a licence blocker. The attribution is a condition of it.
    """
    assert LICENCE == "NLOD 1.0"
    assert "Kystverket" in ATTRIBUTION


@respx.mock(assert_all_called=True)
async def test_it_fetches_keyless_with_no_credential_of_any_kind(
    respx_mock: respx.Router, client: KystdatahusetClient, payload: bytes
) -> None:
    """Keyless is the point of this provider. Nothing in the request may look like a key."""
    route = respx_mock.get(REALTIME_URL).respond(200, content=payload)

    vessels = await client.all_vessels()

    assert len(vessels.records) == VESSEL_COUNT
    request = route.calls[-1].request
    assert not request.url.params
    assert "authorization" not in request.headers
    assert "x-api-key" not in request.headers


@respx.mock(assert_all_called=True)
async def test_the_drop_count_comes_back_with_the_vessels(
    respx_mock: respx.Router, client: KystdatahusetClient, payload: bytes
) -> None:
    """``/api/layers`` serves this, so a count that stopped at a log line is not counted."""
    respx_mock.get(REALTIME_URL).respond(200, content=payload)

    assert (await client.all_vessels()).dropped == DROPPED_COUNT


@respx.mock(assert_all_called=True)
async def test_an_empty_answer_is_a_failed_poll_and_never_an_empty_sea(
    respx_mock: respx.Router, client: KystdatahusetClient
) -> None:
    """3,542 features when measured, so zero means something broke upstream.

    Raised so the layer degrades and names this provider, rather than sitting healthy with a
    count of zero and expiring every Norwegian ship one time-to-live later.
    """
    respx_mock.get(REALTIME_URL).respond(200, content=_envelope())

    with pytest.raises(SourceError, match="never as an empty sea"):
        await client.all_vessels()


@respx.mock(assert_all_called=True)
async def test_a_body_of_nothing_but_unmappable_records_is_also_a_failed_poll(
    respx_mock: respx.Router, client: KystdatahusetClient
) -> None:
    """Parsed cleanly to zero renderable vessels is the same lie as an empty array."""
    respx_mock.get(REALTIME_URL).respond(
        200, content=_envelope(_feature(mmsi=999999999), _feature(coordinates=[]))
    )

    with pytest.raises(SourceError):
        await client.all_vessels()


@respx.mock(assert_all_called=True)
async def test_a_server_error_is_raised_for_the_union_to_record(
    respx_mock: respx.Router, client: KystdatahusetClient
) -> None:
    """A failing provider drops out of the cycle. It never empties the vessel store."""
    respx_mock.get(REALTIME_URL).respond(503)

    with pytest.raises(httpx.HTTPStatusError):
        await client.all_vessels()


# ---------------------------------------------------------------- honouring a backoff


@respx.mock(assert_all_called=True)
async def test_a_throttling_response_becomes_a_rate_limited_error(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    respx_mock.get(REALTIME_URL).respond(429, headers={"Retry-After": "300"})
    client = KystdatahusetClient(http, clock=Clock())

    with pytest.raises(RateLimitedError) as caught:
        await client.all_vessels()

    assert caught.value.retry_after_seconds == 300.0


@respx.mock(assert_all_called=True)
async def test_a_throttled_provider_is_not_asked_again_inside_its_own_backoff(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """The union swallows the error into a degraded provider row, so the poller never sees it.

    That is the ``AdsbClient`` bug from a different direction: a provider asks for 300 seconds
    of quiet, the union records a degraded layer, and the next ordinary cycle calls it 60
    seconds later. The figure is honoured here, where the response arrived, and checked before
    the request rather than after it.
    """
    clock = Clock()
    route = respx_mock.get(REALTIME_URL).respond(429, headers={"Retry-After": "300"})
    client = KystdatahusetClient(http, clock=clock)

    with pytest.raises(RateLimitedError):
        await client.all_vessels()
    clock.advance(60.0)
    with pytest.raises(RateLimitedError):
        await client.all_vessels()

    assert route.call_count == 1


@respx.mock(assert_all_called=True)
async def test_a_cooldown_delays_and_never_latches(
    respx_mock: respx.Router, http: httpx.AsyncClient, payload: bytes
) -> None:
    """A provider we could never call again would be worse than one that throttled us."""
    clock = Clock()
    respx_mock.get(REALTIME_URL).mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "300"}),
            httpx.Response(200, content=payload),
        ]
    )
    client = KystdatahusetClient(http, clock=clock)

    with pytest.raises(RateLimitedError):
        await client.all_vessels()
    clock.advance(301.0)

    assert len((await client.all_vessels()).records) == VESSEL_COUNT


@respx.mock(assert_all_called=True)
async def test_a_cooldown_survives_a_restart(
    respx_mock: respx.Router, http: httpx.AsyncClient, tmp_path: Path
) -> None:
    """The restart proof. A fresh process must not open by hammering a provider that refused.

    In-memory rate state does not survive a restart, and a restart loop is indistinguishable
    from hammering as far as a provider is concerned.
    """
    clock = Clock()
    cache = DiskCache(tmp_path, clock=clock)
    route = respx_mock.get(REALTIME_URL).respond(429, headers={"Retry-After": "300"})

    with pytest.raises(RateLimitedError):
        await KystdatahusetClient(http, cache=cache, clock=clock).all_vessels()
    clock.advance(60.0)
    with pytest.raises(RateLimitedError):
        await KystdatahusetClient(http, cache=cache, clock=clock).all_vessels()

    assert route.call_count == 1
    assert cache.get_time(f"{SOURCE_NAME}:not_before") == CAPTURE_TIME + timedelta(seconds=300)


@respx.mock(assert_all_called=True)
async def test_a_longer_cooldown_is_never_shortened_by_a_later_one(
    respx_mock: respx.Router, http: httpx.AsyncClient, tmp_path: Path
) -> None:
    """Guessing short is how an address gets blocked, so the longer figure always wins."""
    clock = Clock()
    cache = DiskCache(tmp_path, clock=clock)
    respx_mock.get(REALTIME_URL).mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "600"}),
            httpx.Response(429, headers={"Retry-After": "10"}),
        ]
    )
    client = KystdatahusetClient(http, cache=cache, clock=clock)

    with pytest.raises(RateLimitedError):
        await client.all_vessels()
    clock.advance(601.0)
    with pytest.raises(RateLimitedError):
        await client.all_vessels()

    held = cache.get_time(f"{SOURCE_NAME}:not_before")
    assert held == clock.now + timedelta(seconds=10)


@respx.mock(assert_all_called=True)
async def test_a_throttling_response_with_no_retry_after_gets_the_safe_default(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Guessing short risks a ban; guessing long costs one stale poll."""
    respx_mock.get(REALTIME_URL).respond(429)

    with pytest.raises(RateLimitedError) as caught:
        await KystdatahusetClient(http, clock=Clock()).all_vessels()

    assert caught.value.retry_after_seconds == 120.0


@respx.mock(assert_all_called=True)
async def test_the_persistence_is_opt_in_and_nothing_is_written_without_a_cache(
    respx_mock: respx.Router, http: httpx.AsyncClient, tmp_path: Path
) -> None:
    """A client with no cache still holds its cooldown in memory, as it did before cache.py."""
    clock = Clock()
    route = respx_mock.get(REALTIME_URL).respond(429, headers={"Retry-After": "300"})
    client = KystdatahusetClient(http, clock=clock)

    with pytest.raises(RateLimitedError):
        await client.all_vessels()
    with pytest.raises(RateLimitedError):
        await client.all_vessels()

    assert route.call_count == 1
    assert not (tmp_path / FILE_NAME).exists()
