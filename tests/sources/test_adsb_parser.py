"""The readsb ``/v2`` parser, driven by real captured payloads.

Every fixture here is a genuine response from adsb.lol on 2026-08-19. The counts asserted
are the counts that feed actually returned, which is the point: a parser tested only
against hand-written records passes while quietly dropping half of a live batch.
"""

import json
from datetime import UTC, datetime
from typing import Any

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from tests.conftest import ADSBFI_POINT_AIRCRAFT, ADSBFI_POINT_ON_GROUND, make_aircraft
from tracker.contracts.aircraft import Aircraft, AircraftClass, EmergencyState
from tracker.contracts.base import ContractViolationError
from tracker.contracts.geo import (
    FEET_PER_MINUTE_TO_METRES_PER_SECOND,
    FEET_TO_METRES,
    KNOTS_TO_METRES_PER_SECOND,
    BoundingBox,
)
from tracker.sources.adsb import (
    DB_FLAG_MILITARY,
    DB_FLAG_PRIVACY_ICAO,
    merge_by_identity,
    only_in_box,
    parse_response,
)

POINT_AIRCRAFT_COUNT = 65
"""Records in the captured ``/v2/point`` response, all of which carry a position."""

MIL_RECORD_COUNT = 391
MIL_WITHOUT_POSITION = 81
MIL_AIRCRAFT_COUNT = MIL_RECORD_COUNT - MIL_WITHOUT_POSITION
"""310 usable military aircraft out of 391 records. The other 81 were heard, not located."""

TYPE_AIRCRAFT_COUNT = 18


def _envelope(*records: dict[str, Any], now: float | int | None = 1787165611001) -> bytes:
    """Wrap hand-built records in the readsb envelope, as the feed sends them."""
    payload: dict[str, Any] = {"ac": list(records), "msg": "No error", "total": len(records)}
    if now is not None:
        payload["now"] = now
    return json.dumps(payload).encode()


def _record(**overrides: Any) -> dict[str, Any]:
    """A minimal usable wire record, plus whatever the test is actually about."""
    return {"hex": "3c6444", "lat": 51.5, "lon": -0.12, **overrides}


# ---------------------------------------------------------------- real payloads


def test_parses_the_live_point_response(adsb_point_payload: bytes) -> None:
    aircraft = parse_response(adsb_point_payload, source="adsb.lol")

    assert len(aircraft) == POINT_AIRCRAFT_COUNT
    assert all(a.source == "adsb.lol" for a in aircraft)
    assert all(len(a.icao24) == 6 for a in aircraft)
    assert len({a.icao24 for a in aircraft}) == POINT_AIRCRAFT_COUNT


def test_parses_the_live_military_response(adsb_mil_payload: bytes) -> None:
    """391 records in, 310 aircraft out. The 81 dropped ones carry no lat/lon."""
    raw = json.loads(adsb_mil_payload)
    assert len(raw["ac"]) == MIL_RECORD_COUNT

    positionless = [r for r in raw["ac"] if r.get("lat") is None or r.get("lon") is None]
    assert len(positionless) == MIL_WITHOUT_POSITION

    aircraft = parse_response(adsb_mil_payload, source="adsb.lol")

    assert len(aircraft) == MIL_AIRCRAFT_COUNT
    assert len(aircraft) == MIL_RECORD_COUNT - MIL_WITHOUT_POSITION


def test_every_military_record_is_flagged_military(adsb_mil_payload: bytes) -> None:
    """All 391 records in the live sample carried ``dbFlags`` bit 1."""
    aircraft = parse_response(adsb_mil_payload, source="adsb.lol")

    assert aircraft
    assert all(a.is_military for a in aircraft)
    assert all(a.aircraft_class is AircraftClass.MILITARY for a in aircraft)


def test_parses_the_live_type_response(adsb_type_payload: bytes) -> None:
    aircraft = parse_response(adsb_type_payload, source="adsb.lol")

    assert len(aircraft) == TYPE_AIRCRAFT_COUNT
    assert {a.type_designator for a in aircraft} == {"GLF6"}


def test_live_point_response_yields_stripped_callsigns(adsb_point_payload: bytes) -> None:
    """``flight`` is space-padded to eight characters on the wire, always."""
    raw = json.loads(adsb_point_payload)
    padded = [r["flight"] for r in raw["ac"] if r.get("flight")]
    assert any(f != f.strip() for f in padded), "fixture should contain padded callsigns"

    aircraft = parse_response(adsb_point_payload, source="adsb.lol")

    for a in aircraft:
        assert a.callsign is None or a.callsign == a.callsign.strip()
        assert a.callsign != ""


def test_live_point_response_places_every_aircraft_in_range(adsb_point_payload: bytes) -> None:
    """The capture was a 250 nm query around London, so nothing should be on another continent."""
    aircraft = parse_response(adsb_point_payload, source="adsb.lol")

    for a in aircraft:
        assert -10.0 < a.point.lon < 10.0
        assert 44.0 < a.point.lat < 60.0


# ---------------------------------------------------------------- ground handling


def test_alt_baro_ground_maps_to_on_ground() -> None:
    (aircraft,) = parse_response(_envelope(_record(alt_baro="ground")), source="adsb.lol")

    assert aircraft.on_ground is True
    assert aircraft.barometric_altitude_m is None
    assert aircraft.point.altitude_m == 0.0


def test_alt_baro_ground_wins_over_a_geometric_altitude() -> None:
    """A transponder reporting 'ground' plus a stale geometric altitude is on the ground."""
    (aircraft,) = parse_response(
        _envelope(_record(alt_baro="ground", alt_geom=25)), source="adsb.lol"
    )

    assert aircraft.on_ground is True
    assert aircraft.point.altitude_m == 0.0
    assert aircraft.geometric_altitude_m == pytest.approx(25 * FEET_TO_METRES)


def test_a_numeric_alt_baro_is_not_on_ground() -> None:
    (aircraft,) = parse_response(_envelope(_record(alt_baro=0)), source="adsb.lol")

    assert aircraft.on_ground is False
    assert aircraft.barometric_altitude_m == 0.0


def test_a_missing_altitude_leaves_the_point_altitude_unset() -> None:
    (aircraft,) = parse_response(_envelope(_record()), source="adsb.lol")

    assert aircraft.on_ground is False
    assert aircraft.barometric_altitude_m is None
    assert aircraft.geometric_altitude_m is None
    assert aircraft.point.altitude_m is None


def test_geometric_altitude_is_preferred_for_the_point() -> None:
    """Geometric altitude is a GPS height; barometric is pressure and drifts with weather."""
    (aircraft,) = parse_response(
        _envelope(_record(alt_baro=35_000, alt_geom=35_400)), source="adsb.lol"
    )

    assert aircraft.point.altitude_m == pytest.approx(35_400 * FEET_TO_METRES)


# ---------------------------------------------------------------- text fields


def test_callsign_is_whitespace_stripped() -> None:
    (aircraft,) = parse_response(_envelope(_record(flight="RAM801F ")), source="adsb.lol")

    assert aircraft.callsign == "RAM801F"


def test_a_whitespace_only_callsign_becomes_none() -> None:
    (aircraft,) = parse_response(_envelope(_record(flight="        ")), source="adsb.lol")

    assert aircraft.callsign is None


def test_registration_and_type_designator_are_stripped() -> None:
    (aircraft,) = parse_response(_envelope(_record(r=" G-ABCD ", t=" B38M ")), source="adsb.lol")

    assert aircraft.registration == "G-ABCD"
    assert aircraft.type_designator == "B38M"


def test_an_empty_registration_becomes_none() -> None:
    (aircraft,) = parse_response(_envelope(_record(r="   ", t="")), source="adsb.lol")

    assert aircraft.registration is None
    assert aircraft.type_designator is None


def test_message_source_comes_from_the_type_field_not_the_aircraft_type() -> None:
    """``type`` is how the position was derived; the aircraft type designator is ``t``."""
    (aircraft,) = parse_response(_envelope(_record(type="adsb_icao", t="GLF6")), source="adsb.lol")

    assert aircraft.message_source == "adsb_icao"
    assert aircraft.type_designator == "GLF6"


def test_message_source_defaults_to_unknown_and_is_truncated() -> None:
    (missing,) = parse_response(_envelope(_record()), source="adsb.lol")
    assert missing.message_source == "unknown"

    (long,) = parse_response(_envelope(_record(type="x" * 40)), source="adsb.lol")
    assert long.message_source == "x" * 20


# ---------------------------------------------------------------- unit conversions


def test_feet_to_metres_conversion() -> None:
    (aircraft,) = parse_response(
        _envelope(_record(alt_baro=35_000, alt_geom=36_025)), source="adsb.lol"
    )

    assert aircraft.barometric_altitude_m == pytest.approx(10_668.0, abs=0.001)
    assert aircraft.geometric_altitude_m == pytest.approx(
        round(36_025 * FEET_TO_METRES, 3), abs=0.001
    )


def test_knots_to_metres_per_second_conversion() -> None:
    (aircraft,) = parse_response(_envelope(_record(gs=451.4)), source="adsb.lol")

    assert aircraft.ground_speed_mps == pytest.approx(232.220, abs=0.001)
    assert aircraft.ground_speed_mps == pytest.approx(451.4 * KNOTS_TO_METRES_PER_SECOND)


def test_feet_per_minute_to_metres_per_second_conversion() -> None:
    (aircraft,) = parse_response(_envelope(_record(baro_rate=-1_216)), source="adsb.lol")

    expected = -1_216 * FEET_PER_MINUTE_TO_METRES_PER_SECOND
    assert aircraft.vertical_rate_mps == pytest.approx(-6.177, abs=0.001)
    assert aircraft.vertical_rate_mps == pytest.approx(expected)


def test_a_negative_ground_speed_is_clamped_to_zero() -> None:
    """Physically impossible, and a negative speed would break the dead-reckoning maths."""
    (aircraft,) = parse_response(_envelope(_record(gs=-3)), source="adsb.lol")

    assert aircraft.ground_speed_mps == 0.0


def test_geom_rate_is_used_when_baro_rate_is_absent() -> None:
    (aircraft,) = parse_response(_envelope(_record(geom_rate=640)), source="adsb.lol")

    assert aircraft.vertical_rate_mps == pytest.approx(640 * FEET_PER_MINUTE_TO_METRES_PER_SECOND)


def test_baro_rate_wins_over_geom_rate() -> None:
    (aircraft,) = parse_response(
        _envelope(_record(baro_rate=-64, geom_rate=1_000)), source="adsb.lol"
    )

    assert aircraft.vertical_rate_mps == pytest.approx(-64 * FEET_PER_MINUTE_TO_METRES_PER_SECOND)


def test_a_zero_baro_rate_is_not_treated_as_absent() -> None:
    """``0`` is falsy and a truthiness check here would silently prefer ``geom_rate``."""
    (aircraft,) = parse_response(
        _envelope(_record(baro_rate=0, geom_rate=1_000)), source="adsb.lol"
    )

    assert aircraft.vertical_rate_mps == 0.0


def test_position_age_comes_from_seen_pos() -> None:
    (aircraft,) = parse_response(_envelope(_record(seen_pos=4.25)), source="adsb.lol")

    assert aircraft.position_age_s == 4.25


def test_a_negative_seen_pos_is_clamped_and_a_missing_one_is_zero() -> None:
    (negative,) = parse_response(_envelope(_record(seen_pos=-2.0)), source="adsb.lol")
    assert negative.position_age_s == 0.0

    (missing,) = parse_response(_envelope(_record()), source="adsb.lol")
    assert missing.position_age_s == 0.0


def test_messages_received_is_carried_through_and_floored_at_zero() -> None:
    (counted,) = parse_response(_envelope(_record(messages=1_234)), source="adsb.lol")
    assert counted.messages_received == 1_234

    (negative,) = parse_response(_envelope(_record(messages=-5)), source="adsb.lol")
    assert negative.messages_received == 0


# ---------------------------------------------------------------- heading fallback chain


def test_heading_prefers_track() -> None:
    (aircraft,) = parse_response(
        _envelope(_record(track=11.0, true_heading=22.0, mag_heading=33.0, dir=44.0)),
        source="adsb.lol",
    )

    assert aircraft.track_deg == pytest.approx(11.0)


def test_heading_falls_back_to_true_heading() -> None:
    (aircraft,) = parse_response(
        _envelope(_record(true_heading=22.0, mag_heading=33.0, dir=44.0)),
        source="adsb.lol",
    )

    assert aircraft.track_deg == pytest.approx(22.0)


def test_heading_falls_back_to_mag_heading() -> None:
    (aircraft,) = parse_response(
        _envelope(_record(mag_heading=33.0, dir=44.0)),
        source="adsb.lol",
    )

    assert aircraft.track_deg == pytest.approx(33.0)


def test_heading_falls_back_to_dir() -> None:
    """``dir`` is the bearing from the receiver, not the aircraft's heading. Last resort."""
    (aircraft,) = parse_response(_envelope(_record(dir=44.0)), source="adsb.lol")

    assert aircraft.track_deg == pytest.approx(44.0)


def test_heading_is_none_when_the_whole_chain_is_absent() -> None:
    (aircraft,) = parse_response(_envelope(_record()), source="adsb.lol")

    assert aircraft.track_deg is None


def test_heading_zero_is_honoured_rather_than_skipped() -> None:
    """Due north is a real heading. A truthiness check would fall through to ``dir``."""
    (aircraft,) = parse_response(_envelope(_record(track=0, dir=44.0)), source="adsb.lol")

    assert aircraft.track_deg == 0.0


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (360.0, 0.0),
        (361.5, 1.5),
        (-1.0, 359.0),
        (720.0, 0.0),
        (359.9, 359.9),
    ],
)
def test_heading_is_normalised_into_the_bearing_range(raw: float, expected: float) -> None:
    (aircraft,) = parse_response(_envelope(_record(track=raw)), source="adsb.lol")

    assert aircraft.track_deg == pytest.approx(expected)


# ---------------------------------------------------------------- identity


def test_a_tilde_prefixed_address_is_stripped_and_flagged() -> None:
    """readsb marks non-ICAO addresses with '~': TIS-B ground vehicles and ADS-R relays."""
    (aircraft,) = parse_response(_envelope(_record(hex="~ADFB19")), source="adsb.lol")

    assert aircraft.icao24 == "adfb19"
    assert aircraft.non_icao_address is True


def test_an_uppercase_address_is_lowercased() -> None:
    (aircraft,) = parse_response(_envelope(_record(hex="3C6444")), source="adsb.lol")

    assert aircraft.icao24 == "3c6444"
    assert aircraft.non_icao_address is False


def test_a_padded_address_is_stripped() -> None:
    (aircraft,) = parse_response(_envelope(_record(hex="  3c6444 ")), source="adsb.lol")

    assert aircraft.icao24 == "3c6444"


@pytest.mark.parametrize(
    "bad_hex",
    [
        pytest.param("3c644", id="too-short"),
        pytest.param("3c64445", id="too-long"),
        pytest.param("3c644z", id="non-hex"),
        pytest.param("", id="empty"),
        pytest.param("~", id="tilde-only"),
        pytest.param("XXXXXX", id="all-letters"),
    ],
)
def test_a_record_with_an_unusable_address_is_dropped_not_raised_on(bad_hex: str) -> None:
    result = parse_response(
        _envelope(_record(hex=bad_hex), _record(hex="3c6444")), source="adsb.lol"
    )

    assert len(result) == 1
    assert result[0].icao24 == "3c6444"


def test_a_record_without_a_position_is_dropped() -> None:
    """Defaulting to (0, 0) would draw a permanent phantom cluster in the Gulf of Guinea."""
    result = parse_response(
        _envelope(
            {"hex": "aaaaaa"},
            {"hex": "bbbbbb", "lat": 51.5},
            {"hex": "cccccc", "lon": -0.12},
            _record(hex="3c6444"),
        ),
        source="adsb.lol",
    )

    assert len(result) == 1
    assert result[0].icao24 == "3c6444"


# ---------------------------------------------------------------- dbFlags


def test_db_flag_privacy_sets_the_anonymous_class() -> None:
    (aircraft,) = parse_response(
        _envelope(_record(dbFlags=DB_FLAG_PRIVACY_ICAO)), source="adsb.lol"
    )

    assert aircraft.uses_privacy_address is True
    assert aircraft.aircraft_class is AircraftClass.ANONYMOUS
    assert aircraft.is_military is False


def test_db_flag_military_sets_the_military_class() -> None:
    (aircraft,) = parse_response(_envelope(_record(dbFlags=DB_FLAG_MILITARY)), source="adsb.lol")

    assert aircraft.is_military is True
    assert aircraft.aircraft_class is AircraftClass.MILITARY


def test_military_wins_over_privacy_when_both_bits_are_set() -> None:
    (aircraft,) = parse_response(
        _envelope(_record(dbFlags=DB_FLAG_MILITARY | DB_FLAG_PRIVACY_ICAO)),
        source="adsb.lol",
    )

    assert aircraft.is_military is True
    assert aircraft.uses_privacy_address is True
    assert aircraft.aircraft_class is AircraftClass.MILITARY


@pytest.mark.parametrize("flags", [0, 2, 8, 10, None])
def test_other_db_flags_leave_the_class_alone(flags: int | None) -> None:
    (aircraft,) = parse_response(_envelope(_record(dbFlags=flags)), source="adsb.lol")

    assert aircraft.is_military is False
    assert aircraft.uses_privacy_address is False
    assert aircraft.aircraft_class is AircraftClass.UNKNOWN


def test_the_rotorcraft_category_becomes_a_helicopter() -> None:
    (aircraft,) = parse_response(_envelope(_record(category="A7")), source="adsb.lol")

    assert aircraft.aircraft_class is AircraftClass.HELICOPTER
    assert aircraft.category == "A7"


def test_a_military_helicopter_is_classed_military() -> None:
    (aircraft,) = parse_response(
        _envelope(_record(category="A7", dbFlags=DB_FLAG_MILITARY)), source="adsb.lol"
    )

    assert aircraft.aircraft_class is AircraftClass.MILITARY


# ---------------------------------------------------------------- emergency


@pytest.mark.parametrize(
    ("wire", "expected"),
    [
        ("none", EmergencyState.NONE),
        ("general", EmergencyState.GENERAL),
        ("lifeguard", EmergencyState.LIFEGUARD),
        ("minfuel", EmergencyState.MINIMUM_FUEL),
        ("nordo", EmergencyState.NO_COMMUNICATIONS),
        ("unlawful", EmergencyState.UNLAWFUL_INTERFERENCE),
        ("downed", EmergencyState.DOWNED_AIRCRAFT),
        ("reserved", EmergencyState.RESERVED),
    ],
)
def test_the_emergency_field_maps_onto_the_enum(wire: str, expected: EmergencyState) -> None:
    (aircraft,) = parse_response(_envelope(_record(emergency=wire)), source="adsb.lol")

    assert aircraft.emergency is expected


def test_an_unrecognised_emergency_value_falls_back_to_none() -> None:
    """A new value upstream must not blank the aircraft; it degrades to no emergency."""
    (aircraft,) = parse_response(_envelope(_record(emergency="wibble")), source="adsb.lol")

    assert aircraft.emergency is EmergencyState.NONE


@pytest.mark.parametrize("squawk", ["7500", "7600", "7700"])
def test_an_emergency_squawk_promotes_the_emergency_state(squawk: str) -> None:
    (aircraft,) = parse_response(_envelope(_record(squawk=squawk)), source="adsb.lol")

    assert aircraft.emergency is EmergencyState.GENERAL
    assert aircraft.in_emergency is True


def test_an_explicit_emergency_is_not_overwritten_by_a_squawk() -> None:
    (aircraft,) = parse_response(
        _envelope(_record(squawk="7700", emergency="unlawful")), source="adsb.lol"
    )

    assert aircraft.emergency is EmergencyState.UNLAWFUL_INTERFERENCE


def test_a_padded_squawk_is_stripped() -> None:
    (aircraft,) = parse_response(_envelope(_record(squawk=" 7700 ")), source="adsb.lol")

    assert aircraft.squawk == "7700"


def test_an_empty_squawk_becomes_none() -> None:
    (aircraft,) = parse_response(_envelope(_record(squawk="")), source="adsb.lol")

    assert aircraft.squawk is None
    assert aircraft.in_emergency is False


# ---------------------------------------------------------------- batch timestamp


def test_the_batch_timestamp_comes_from_the_envelope_now_in_milliseconds() -> None:
    (aircraft,) = parse_response(_envelope(_record(), now=1787165611001), source="adsb.lol")

    assert aircraft.observed_at == datetime(2026, 8, 19, 18, 53, 31, 1_000, tzinfo=UTC)
    assert aircraft.observed_at.tzinfo is UTC


def test_every_aircraft_in_a_batch_shares_the_envelope_timestamp(
    adsb_point_payload: bytes,
) -> None:
    """Records carry only an age relative to ``now``, so ``now`` is the batch's authority."""
    raw = json.loads(adsb_point_payload)
    expected = datetime.fromtimestamp(raw["now"] / 1000.0, tz=UTC)

    aircraft = parse_response(adsb_point_payload, source="adsb.lol")

    assert {a.observed_at for a in aircraft} == {expected}


def test_a_missing_now_falls_back_to_the_current_time() -> None:
    before = datetime.now(UTC)

    (aircraft,) = parse_response(_envelope(_record(), now=None), source="adsb.lol")

    assert before <= aircraft.observed_at <= datetime.now(UTC)


# ---------------------------------------------------------------- envelope failures


@pytest.mark.parametrize(
    "garbage",
    [
        pytest.param(b"not json at all", id="not-json"),
        pytest.param(b"<html>502 Bad Gateway</html>", id="html-error-page"),
        pytest.param(b'{"ac": "not-a-list"}', id="ac-not-a-list"),
        pytest.param(b'{"ac": 17}', id="ac-a-number"),
        pytest.param(b"[]", id="top-level-list"),
        pytest.param(b"", id="empty-body"),
    ],
)
def test_a_garbage_envelope_raises_a_contract_violation(garbage: bytes) -> None:
    with pytest.raises(ContractViolationError) as caught:
        parse_response(garbage, source="adsb.lol")

    assert caught.value.source == "adsb.lol"


def test_an_envelope_with_no_aircraft_key_is_rejected() -> None:
    """An absent list key means an unrecognised provider shape, not a quiet feed.

    This previously parsed to empty, which is how the adsb.fi envelope difference stayed
    invisible: every response became zero aircraft over a feed reporting itself healthy.
    A quiet feed sends an empty list under a key we know, which is still accepted.
    """
    with pytest.raises(ContractViolationError):
        parse_response(b'{"now": 1787165611001, "msg": "No error"}', source="adsb.lol")


def test_an_empty_aircraft_list_parses_as_empty() -> None:
    assert parse_response(_envelope(), source="adsb.lol") == ()


def test_one_corrupt_record_is_skipped_while_the_rest_still_parse() -> None:
    """One aircraft with a bad field must not blank the entire globe."""
    result = parse_response(
        _envelope(
            _record(hex="aaaaaa"),
            _record(hex="bbbbbb", alt_baro=9_999_999),
            _record(hex="cccccc", gs=999_999),
            _record(hex="dddddd", squawk="9999"),
            _record(hex="eeeeee"),
        ),
        source="adsb.lol",
    )

    assert {a.icao24 for a in result} == {"aaaaaa", "eeeeee"}


def test_a_record_that_is_not_an_object_fails_the_envelope() -> None:
    """A malformed element is an envelope-shape problem, so it is a loud failure."""
    with pytest.raises(ContractViolationError):
        parse_response(b'{"now": 1, "ac": ["just-a-string"]}', source="adsb.lol")


def test_the_source_name_is_stamped_onto_every_record() -> None:
    result = parse_response(_envelope(_record()), source="adsb.fi")

    assert result[0].source == "adsb.fi"


# ---------------------------------------------------------------- merge_by_identity


def test_merge_keeps_the_record_with_the_lower_position_age() -> None:
    stale = make_aircraft("3c6444", position_age_s=30.0, callsign="STALE")
    fresh = make_aircraft("3c6444", position_age_s=1.5, callsign="FRESH")

    merged = merge_by_identity([stale], [fresh])

    assert len(merged) == 1
    assert merged[0].callsign == "FRESH"


def test_merge_is_order_independent() -> None:
    stale = make_aircraft("3c6444", position_age_s=30.0, callsign="STALE")
    fresh = make_aircraft("3c6444", position_age_s=1.5, callsign="FRESH")

    assert merge_by_identity([fresh], [stale])[0].callsign == "FRESH"
    assert merge_by_identity([stale], [fresh])[0].callsign == "FRESH"


def test_merge_keeps_the_first_of_two_equally_aged_records() -> None:
    first = make_aircraft("3c6444", position_age_s=2.0, callsign="FIRST")
    second = make_aircraft("3c6444", position_age_s=2.0, callsign="SECOND")

    assert merge_by_identity([first], [second])[0].callsign == "FIRST"


def test_merge_keeps_distinct_addresses_apart() -> None:
    merged = merge_by_identity(
        [make_aircraft("aaaaaa"), make_aircraft("bbbbbb")],
        [make_aircraft("bbbbbb"), make_aircraft("cccccc")],
    )

    assert {a.icao24 for a in merged} == {"aaaaaa", "bbbbbb", "cccccc"}


def test_merge_of_nothing_is_empty() -> None:
    assert merge_by_identity() == ()
    assert merge_by_identity([], []) == ()


def test_merge_deduplicates_within_a_single_batch() -> None:
    """The viewport and military queries overlap, and so can one provider's own response."""
    merged = merge_by_identity(
        [
            make_aircraft("3c6444", position_age_s=9.0, callsign="OLD"),
            make_aircraft("3c6444", position_age_s=0.5, callsign="NEW"),
        ]
    )

    assert len(merged) == 1
    assert merged[0].callsign == "NEW"


# ---------------------------------------------------------------- only_in_box


def test_only_in_box_filters_to_the_box() -> None:
    inside = make_aircraft("aaaaaa", lon=-0.12, lat=51.5)
    outside = make_aircraft("bbbbbb", lon=2.35, lat=48.86)
    box = BoundingBox(west=-1.0, south=51.0, east=1.0, north=52.0)

    assert only_in_box([inside, outside], box) == (inside,)


def test_only_in_box_handles_the_antimeridian() -> None:
    box = BoundingBox(west=170.0, south=-10.0, east=-170.0, north=10.0)
    east_side = make_aircraft("aaaaaa", lon=175.0, lat=0.0)
    west_side = make_aircraft("bbbbbb", lon=-175.0, lat=0.0)
    elsewhere = make_aircraft("cccccc", lon=0.0, lat=0.0)
    wrong_latitude = make_aircraft("dddddd", lon=175.0, lat=40.0)

    result = only_in_box([east_side, west_side, elsewhere, wrong_latitude], box)

    assert {a.icao24 for a in result} == {"aaaaaa", "bbbbbb"}


def test_only_in_box_preserves_order() -> None:
    box = BoundingBox(west=-10.0, south=40.0, east=10.0, north=60.0)
    first = make_aircraft("aaaaaa", lon=0.0, lat=50.0)
    second = make_aircraft("bbbbbb", lon=1.0, lat=51.0)

    assert only_in_box([first, second], box) == (first, second)


def test_only_in_box_of_nothing_is_empty() -> None:
    assert only_in_box([], BoundingBox(west=0.0, south=0.0, east=1.0, north=1.0)) == ()


# ---------------------------------------------------------------- property-based


_ODD_NUMBERS = st.one_of(
    st.none(),
    st.integers(min_value=-1_000_000, max_value=1_000_000),
    st.floats(min_value=-1e9, max_value=1e9, allow_nan=False, allow_infinity=False),
)
_ODD_TEXT = st.one_of(st.none(), st.text(max_size=30))

_ODD_RECORD = st.fixed_dictionaries(
    {
        "hex": st.one_of(
            st.text(alphabet="0123456789abcdefABCDEF~ ", min_size=0, max_size=10),
            st.just("3c6444"),
        ),
        "lat": st.one_of(st.none(), st.floats(-1e4, 1e4, allow_nan=False, allow_infinity=False)),
        "lon": st.one_of(st.none(), st.floats(-1e4, 1e4, allow_nan=False, allow_infinity=False)),
        "alt_baro": st.one_of(_ODD_NUMBERS, st.just("ground")),
        "alt_geom": _ODD_NUMBERS,
        "gs": _ODD_NUMBERS,
        "track": _ODD_NUMBERS,
        "true_heading": _ODD_NUMBERS,
        "mag_heading": _ODD_NUMBERS,
        "dir": _ODD_NUMBERS,
        "baro_rate": _ODD_NUMBERS,
        "geom_rate": _ODD_NUMBERS,
        "squawk": _ODD_TEXT,
        "emergency": _ODD_TEXT,
        "category": _ODD_TEXT,
        "flight": _ODD_TEXT,
        "r": _ODD_TEXT,
        "t": _ODD_TEXT,
        "type": _ODD_TEXT,
        "dbFlags": st.one_of(st.none(), st.integers(min_value=0, max_value=15)),
        "seen_pos": _ODD_NUMBERS,
        "messages": st.one_of(st.none(), st.integers(min_value=-10, max_value=10**6)),
    }
)


@settings(max_examples=250, suppress_health_check=[HealthCheck.too_slow], deadline=None)
@given(records=st.lists(_ODD_RECORD, max_size=6))
def test_the_parser_never_raises_on_structurally_valid_records(
    records: list[dict[str, Any]],
) -> None:
    """A record the wire model accepts must never take the parser down.

    Anything unmappable is dropped and counted. The alternative, an exception escaping
    here, blanks the whole globe because one transponder sent nonsense.
    """
    result = parse_response(_envelope(*records), source="adsb.lol")

    assert len(result) <= len(records)
    for aircraft in result:
        assert len(aircraft.icao24) == 6
        assert -180.0 <= aircraft.point.lon <= 180.0
        assert -90.0 <= aircraft.point.lat <= 90.0
        assert aircraft.position_age_s >= 0.0
        assert aircraft.track_deg is None or 0.0 <= aircraft.track_deg < 360.0


@settings(max_examples=100, deadline=None)
@given(
    lat=st.floats(-90.0, 90.0, allow_nan=False, allow_infinity=False),
    lon=st.floats(-180.0, 180.0, allow_nan=False, allow_infinity=False),
)
def test_any_in_range_position_parses(lat: float, lon: float) -> None:
    result = parse_response(_envelope(_record(lat=lat, lon=lon)), source="adsb.lol")

    assert len(result) == 1
    assert result[0].point.lat == pytest.approx(lat)


# ---------------------------------------------------------------- provider envelopes


def test_the_adsb_fi_envelope_parses(adsbfi_point_payload: bytes) -> None:
    """adsb.fi puts the aircraft list under ``aircraft``, not ``ac``.

    Regression guard for a silent-zero bug. The wire model originally read only ``ac``, so
    every adsb.fi response parsed cleanly to no aircraft: failover "succeeded", the poller
    recorded a healthy feed with a count of zero, and the layer emptied with nothing
    anywhere explaining why.
    """
    aircraft = parse_response(adsbfi_point_payload, source="adsb.fi")

    assert len(aircraft) == ADSBFI_POINT_AIRCRAFT
    assert all(a.source == "adsb.fi" for a in aircraft)
    assert sum(a.on_ground for a in aircraft) == ADSBFI_POINT_ON_GROUND


def test_the_adsb_fi_envelope_sends_now_in_seconds_not_milliseconds(
    adsbfi_point_payload: bytes,
) -> None:
    """Two providers, one field name, two units. Reading it wrong dates a batch to 1970.

    Both captures were taken on 2026-08-19. adsb.lol sent ``now: 1787165611001`` and
    mirrored it in ``ctime``; adsb.fi sent ``now: 1787170658.001`` next to a fractional
    ``ptime`` of 0.067, so its value is seconds. Dividing it by a thousand put the whole
    adsb.fi batch at 1970-01-21, which meant every adsb.fi aircraft reached the domain 56
    years stale and could never win a recency contest in
    :mod:`tracker.services.union`. That is provider precedence by accident, which is the
    one thing ADR 010 says the merge must never do.
    """
    aircraft = parse_response(adsbfi_point_payload, source="adsb.fi")

    assert {a.observed_at for a in aircraft} == {
        datetime(2026, 8, 19, 20, 17, 38, 1_000, tzinfo=UTC)
    }


def test_a_nonsense_envelope_timestamp_is_a_contract_violation_not_an_overflow() -> None:
    """Callers catch contract violations to fail over. An ``OverflowError`` kills the poll."""
    with pytest.raises(ContractViolationError, match="unusable envelope timestamp"):
        parse_response(_envelope(_record(), now=1e300), source="adsb.lol")


def test_both_provider_envelopes_produce_the_same_shape(
    adsb_point_payload: bytes, adsbfi_point_payload: bytes
) -> None:
    """One parser, two providers. The domain objects must be indistinguishable in type."""
    lol = parse_response(adsb_point_payload, source="adsb.lol")
    fi = parse_response(adsbfi_point_payload, source="adsb.fi")

    assert lol
    assert fi
    for record in (*lol, *fi):
        assert isinstance(record, Aircraft)
        assert -180.0 <= record.point.lon <= 180.0
        assert -90.0 <= record.point.lat <= 90.0


@pytest.mark.parametrize(
    "envelope",
    [
        pytest.param(b'{"now": 1787165611001, "planes": []}', id="unknown-list-key"),
        pytest.param(b'{"now": 1787165611001}', id="no-list-at-all"),
        pytest.param(b'{"results": [{"hex": "abc123"}]}', id="renamed-by-a-new-provider"),
    ],
)
def test_an_unrecognised_envelope_is_a_contract_violation_not_an_empty_result(
    envelope: bytes,
) -> None:
    """A shape we do not know must fail loudly so the client fails over.

    Parsing it to zero aircraft would report a healthy feed over an empty layer, which is
    the failure mode that hid the adsb.fi bug.
    """
    with pytest.raises(ContractViolationError) as caught:
        parse_response(envelope, source="mystery")

    assert "aircraft list" in str(caught.value)


def test_an_empty_list_under_a_known_key_is_accepted() -> None:
    """A viewport with no aircraft in it is a legitimate answer, not a provider fault."""
    assert parse_response(b'{"now": 1787165611001, "ac": []}', source="adsb.lol") == ()
    assert parse_response(b'{"now": 1787165611001, "aircraft": []}', source="adsb.fi") == ()
