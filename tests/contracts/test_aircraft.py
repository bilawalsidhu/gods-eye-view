"""The aircraft domain contract.

The identity field gets the most attention. ``icao24`` is the join key for every aircraft
in the system, so a record that reaches the store with an uppercase or short address is a
duplicate aircraft on the globe rather than an obvious error.
"""

import json
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from tests.conftest import REFERENCE_TIME, make_aircraft
from tracker.contracts.aircraft import Aircraft, AircraftClass, EmergencyState
from tracker.contracts.geo import Point

# ---------------------------------------------------------------- icao24


@pytest.mark.parametrize(
    "bad",
    [
        pytest.param("ABC123", id="uppercase"),
        pytest.param("AbC123", id="mixed-case"),
        pytest.param("abc12", id="five-digits"),
        pytest.param("abc1234", id="seven-digits"),
        pytest.param("", id="empty"),
        pytest.param("abcxyz", id="non-hex-letters"),
        pytest.param("abc12g", id="one-non-hex-digit"),
        pytest.param("~bc123", id="tilde-prefix-not-stripped"),
        pytest.param(" abc123", id="leading-space"),
        pytest.param("abc123 ", id="trailing-space"),
    ],
)
def test_icao24_pattern_rejects(bad: str) -> None:
    with pytest.raises(ValidationError) as caught:
        make_aircraft(bad)

    assert any(e["loc"] == ("icao24",) for e in caught.value.errors())


@pytest.mark.parametrize("good", ["000000", "ffffff", "3c6444", "a1b2c3", "abcdef", "0123456"[:6]])
def test_icao24_pattern_accepts_lowercase_six_hex_digits(good: str) -> None:
    assert make_aircraft(good).icao24 == good


def test_icao24_is_required() -> None:
    with pytest.raises(ValidationError):
        Aircraft(  # type: ignore[call-arg]  # ty: ignore[missing-argument]
            point=Point(lon=0.0, lat=0.0),
            observed_at=REFERENCE_TIME,
            position_age_s=0.0,
            source="adsb.lol",
        )


# ---------------------------------------------------------------- in_emergency


@pytest.mark.parametrize("squawk", ["7500", "7600", "7700"])
def test_in_emergency_is_true_for_an_emergency_squawk(squawk: str) -> None:
    assert make_aircraft(squawk=squawk).in_emergency is True


@pytest.mark.parametrize("squawk", ["0000", "1200", "7000", "7477", "7701", None])
def test_in_emergency_is_false_for_an_ordinary_squawk(squawk: str | None) -> None:
    assert make_aircraft(squawk=squawk).in_emergency is False


@pytest.mark.parametrize(
    "state",
    [state for state in EmergencyState if state is not EmergencyState.NONE],
)
def test_in_emergency_is_true_for_any_non_none_emergency_state(state: EmergencyState) -> None:
    assert make_aircraft(emergency=state).in_emergency is True


def test_in_emergency_is_false_when_both_signals_are_clear() -> None:
    aircraft = make_aircraft(squawk="1200", emergency=EmergencyState.NONE)

    assert aircraft.in_emergency is False


def test_in_emergency_is_true_when_both_signals_fire() -> None:
    aircraft = make_aircraft(squawk="7700", emergency=EmergencyState.GENERAL)

    assert aircraft.in_emergency is True


def test_squawk_pattern_rejects_a_non_octal_code() -> None:
    with pytest.raises(ValidationError):
        make_aircraft(squawk="7800")


def test_squawk_pattern_rejects_a_short_code() -> None:
    with pytest.raises(ValidationError):
        make_aircraft(squawk="770")


# ---------------------------------------------------------------- label


def test_label_prefers_the_callsign() -> None:
    aircraft = make_aircraft("3c6444", callsign="BAW123", registration="G-ABCD")

    assert aircraft.label == "BAW123"


def test_label_falls_back_to_the_registration() -> None:
    aircraft = make_aircraft("3c6444", callsign=None, registration="G-ABCD")

    assert aircraft.label == "G-ABCD"


def test_label_falls_back_to_the_uppercased_icao24() -> None:
    aircraft = make_aircraft("3c6444", callsign=None, registration=None)

    assert aircraft.label == "3C6444"


def test_label_ignores_an_empty_registration() -> None:
    """An empty string is not a usable label, and the field forbids it becoming one."""
    with pytest.raises(ValidationError):
        make_aircraft("3c6444", callsign="")


# ---------------------------------------------------------------- immutability


def test_aircraft_is_frozen() -> None:
    aircraft = make_aircraft()

    with pytest.raises(ValidationError) as caught:
        aircraft.callsign = "OTHER"  # type: ignore[misc]  # ty: ignore[invalid-assignment]

    assert caught.value.errors()[0]["type"] == "frozen_instance"


def test_aircraft_point_is_frozen_too() -> None:
    aircraft = make_aircraft()

    with pytest.raises(ValidationError):
        aircraft.point.lon = 12.0  # type: ignore[misc]  # ty: ignore[invalid-assignment]


def test_aircraft_forbids_an_unknown_field() -> None:
    with pytest.raises(ValidationError) as caught:
        Aircraft(  # type: ignore[call-arg]
            icao24="abc123",
            point=Point(lon=0.0, lat=0.0),
            observed_at=REFERENCE_TIME,
            position_age_s=0.0,
            source="adsb.lol",
            wake_category="M",  # ty: ignore[unknown-argument]
        )

    assert caught.value.errors()[0]["type"] == "extra_forbidden"


def test_two_aircraft_built_from_the_same_data_compare_equal() -> None:
    """Frozen models are shareable without copying, which is what the store relies on."""
    assert make_aircraft("3c6444") == make_aircraft("3c6444")
    assert make_aircraft("3c6444") != make_aircraft("3c6445")


# ---------------------------------------------------------------- serialisation


def test_aircraft_round_trips_through_json() -> None:
    """The declared fields survive a serialise/validate cycle unchanged, with no help.

    No stripping, no preprocessing. Derived values are plain properties rather than
    pydantic computed fields precisely so that our own published wire format can be
    re-validated by anything that replays it.
    """
    original = make_aircraft(
        "3c6444",
        callsign="GAF123",
        registration="10+27",
        squawk="7700",
        emergency=EmergencyState.GENERAL,
        aircraft_class=AircraftClass.MILITARY,
        is_military=True,
        observed_at=datetime(2026, 8, 19, 12, 13, 31, 1000, tzinfo=UTC),
        position_age_s=4.25,
    )

    restored = Aircraft.model_validate_json(original.model_dump_json())

    assert restored == original
    assert restored.observed_at == original.observed_at
    assert restored.point == original.point
    assert restored.emergency is EmergencyState.GENERAL
    assert restored.aircraft_class is AircraftClass.MILITARY


def test_derived_values_stay_off_the_wire() -> None:
    """``label`` and ``in_emergency`` are properties, not serialised fields.

    They are deliberately absent from the payload. Serialising them would make the wire
    format impossible to re-validate under ``extra="forbid"``, and the frontend derives
    both in ``frontend/src/domain/derive.ts`` from the fields that are present.
    """
    aircraft = make_aircraft("3c6444", callsign="GAF123", squawk="7700")
    payload = json.loads(aircraft.model_dump_json())

    assert "in_emergency" not in payload
    assert "label" not in payload
    assert payload["kind"] == "aircraft"
    assert payload["callsign"] == "GAF123"
    assert payload["squawk"] == "7700"


def test_derived_properties_still_work_server_side() -> None:
    """Removing them from the wire must not remove them from the domain model."""
    assert make_aircraft("3c6444", callsign="GAF123", squawk="7700").in_emergency is True
    assert make_aircraft("3c6444", squawk="1200").in_emergency is False
    assert make_aircraft("3c6444", callsign="GAF123").label == "GAF123"
    assert make_aircraft("3c6444", callsign=None, registration="10+27").label == "10+27"
    assert make_aircraft("3c6444", callsign=None, registration=None).label == "3C6444"


def test_a_serialised_aircraft_can_be_revalidated_as_is() -> None:
    """Regression guard: our own output must be valid input.

    This failed while ``label`` and ``in_emergency`` were pydantic computed fields, which
    serialise but are rejected on load by ``extra="forbid"``. The tempting fix, a
    ``model_validator(mode="before")`` that strips them, is worse: on a strict model it
    forces every field into Python-mode validation, so ``validate_json`` then rejects a
    JSON array for a tuple field and an ISO string for a datetime, silently breaking JSON
    validation across every contract in the app.
    """
    original = make_aircraft("3c6444", callsign="GAF123", squawk="7700")

    assert Aircraft.model_validate_json(original.model_dump_json()) == original


def test_aircraft_defaults_are_the_conservative_ones() -> None:
    """Nothing is assumed about an aircraft the feed said little about."""
    aircraft = Aircraft(
        icao24="abc123",
        point=Point(lon=0.0, lat=0.0),
        observed_at=REFERENCE_TIME,
        position_age_s=0.0,
        source="adsb.lol",
    )

    assert aircraft.kind == "aircraft"
    assert aircraft.non_icao_address is False
    assert aircraft.message_source == "unknown"
    assert aircraft.callsign is None
    assert aircraft.on_ground is False
    assert aircraft.emergency is EmergencyState.NONE
    assert aircraft.aircraft_class is AircraftClass.UNKNOWN
    assert aircraft.is_military is False
    assert aircraft.uses_privacy_address is False
    assert aircraft.messages_received == 0
    assert aircraft.in_emergency is False
    assert aircraft.label == "ABC123"


# ---------------------------------------------------------------- numeric bounds


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("barometric_altitude_m", -500.001),
        ("barometric_altitude_m", 30_000.001),
        ("geometric_altitude_m", 30_000.001),
        ("ground_speed_mps", -0.001),
        ("ground_speed_mps", 1_500.001),
        ("vertical_rate_mps", -200.001),
        ("vertical_rate_mps", 200.001),
        ("position_age_s", -0.001),
        ("messages_received", -1),
        ("track_deg", 360.0),
        ("track_deg", -0.001),
    ],
)
def test_numeric_bounds_are_enforced(field: str, value: float) -> None:
    kwargs: dict[str, object] = {
        "icao24": "abc123",
        "point": Point(lon=0.0, lat=0.0),
        "observed_at": REFERENCE_TIME,
        "position_age_s": 0.0,
        "source": "adsb.lol",
    }
    kwargs[field] = value

    with pytest.raises(ValidationError) as caught:
        Aircraft(**kwargs)  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]

    assert any(error["loc"] == (field,) for error in caught.value.errors())


def test_a_glitch_vertical_rate_still_validates() -> None:
    """A -32,640 ft/min record appeared in the live 2026-08-19 military sample.

    Those must be visible rather than silently dropping the aircraft, so the bounds are
    deliberately wider than any real aeroplane.
    """
    aircraft = Aircraft(
        icao24="abc123",
        point=Point(lon=0.0, lat=0.0),
        observed_at=REFERENCE_TIME,
        position_age_s=0.0,
        source="adsb.lol",
        vertical_rate_mps=-165.8,
    )

    assert aircraft.vertical_rate_mps == pytest.approx(-165.8)


@pytest.mark.parametrize("category", ["A0", "A7", "B2", "D7"])
def test_category_pattern_accepts_an_emitter_category(category: str) -> None:
    aircraft = Aircraft(
        icao24="abc123",
        point=Point(lon=0.0, lat=0.0),
        observed_at=REFERENCE_TIME,
        position_age_s=0.0,
        source="adsb.lol",
        category=category,
    )

    assert aircraft.category == category


@pytest.mark.parametrize("category", ["E9", "A8", "a7", "A", "A77"])
def test_category_pattern_rejects_junk(category: str) -> None:
    with pytest.raises(ValidationError):
        Aircraft(
            icao24="abc123",
            point=Point(lon=0.0, lat=0.0),
            observed_at=REFERENCE_TIME,
            position_age_s=0.0,
            source="adsb.lol",
            category=category,
        )


def test_observed_at_must_be_timezone_aware() -> None:
    with pytest.raises(ValidationError):
        make_aircraft(observed_at=datetime(2026, 8, 19, 12, 0))  # noqa: DTZ001


def test_source_must_not_be_empty() -> None:
    with pytest.raises(ValidationError):
        make_aircraft(source="")
