"""The vessel domain contract.

Two things get the most attention here, because each is a way the layer ships a lie while
every count on screen looks right. The MMSI is the merge key under ADR 010, so a placeholder
number collapses several ships into one record and the duplicate assertion still passes. And
the AIS sentinels are values rather than nulls, so a course of 360.0 read as a bearing drops
110 real vessels while a course of 0.0 is a real course due north.
"""

import json
from datetime import UTC, datetime
from typing import Any

import pytest
from pydantic import TypeAdapter, ValidationError

from tests.conftest import REFERENCE_TIME, fixture_json, make_aircraft, make_vessel
from tracker.contracts.aircraft import Aircraft
from tracker.contracts.geo import KNOTS_TO_METRES_PER_SECOND, Point
from tracker.contracts.messages import Entity
from tracker.contracts.vessel import (
    AIS_COG_NOT_AVAILABLE,
    AIS_COG_NOT_AVAILABLE_SCALED,
    AIS_DRAUGHT_NOT_AVAILABLE,
    AIS_ETA_NOT_AVAILABLE,
    AIS_HEADING_NOT_AVAILABLE,
    AIS_IMO_NOT_AVAILABLE,
    AIS_NAV_STATUS_CODES,
    AIS_NAV_STATUS_UNDEFINED,
    AIS_ROT_NOT_AVAILABLE,
    AIS_ROT_TURNING_LEFT_NO_RATE,
    AIS_ROT_TURNING_RIGHT_NO_RATE,
    AIS_SHIP_TYPE_NOT_AVAILABLE,
    AIS_SOG_NOT_AVAILABLE,
    AIS_SOG_NOT_AVAILABLE_SCALED,
    MmsiCategory,
    NavigationalStatus,
    Vessel,
    VesselEta,
    ais_bearing,
    mmsi_category,
    rate_of_turn_from_ais,
    speed_over_ground_mps,
)

_ENTITY_ADAPTER: TypeAdapter[Entity] = TypeAdapter(Entity)

RECORDED_POSITIONS = 110
"""Features in the recorded Digitraffic locations body, sliced by the recon from 1,058."""

RECORDED_SHIP_STATIONS = 109
"""How many of them are ships. The other one is a search-and-rescue aircraft."""


def _vessel_kwargs(**overrides: object) -> dict[str, object]:
    """The minimum valid vessel, as keyword arguments, with one field swapped."""
    kwargs: dict[str, object] = {
        "mmsi": "230992610",
        "point": Point(lon=22.216732, lat=60.432413),
        "observed_at": REFERENCE_TIME,
        "position_age_s": 0.0,
        "source": "digitraffic",
    }
    kwargs.update(overrides)
    return kwargs


# ---------------------------------------------------------------- mmsi shape


@pytest.mark.parametrize(
    "bad",
    [
        pytest.param("23099261", id="eight-digits"),
        pytest.param("2309926100", id="ten-digits"),
        pytest.param("", id="empty"),
        pytest.param("23099261a", id="letter"),
        pytest.param(" 230992610", id="leading-space"),
        pytest.param("230992610 ", id="trailing-space"),
        pytest.param("230-99261", id="punctuation"),
    ],
)
def test_mmsi_must_be_nine_digits(bad: str) -> None:
    with pytest.raises(ValidationError) as caught:
        make_vessel(bad)

    assert any(e["loc"] == ("mmsi",) for e in caught.value.errors())


def test_mmsi_is_required() -> None:
    with pytest.raises(ValidationError):
        Vessel(  # type: ignore[call-arg]  # ty: ignore[missing-argument]
            point=Point(lon=0.0, lat=0.0),
            observed_at=REFERENCE_TIME,
            position_age_s=0.0,
            source="digitraffic",
        )


def test_mmsi_stays_a_string() -> None:
    """A string because it is a store key, and because the reserved formats have a leading 0."""
    assert make_vessel("230992610").mmsi == "230992610"


# ---------------------------------------------------------------- mmsi category


@pytest.mark.parametrize(
    ("mmsi", "expected"),
    [
        pytest.param("230992610", MmsiCategory.SHIP_STATION, id="real-finnish-ship"),
        pytest.param("265832550", MmsiCategory.SHIP_STATION, id="real-swedish-ship"),
        pytest.param("748283126", MmsiCategory.SHIP_STATION, id="highest-observed-mid"),
        pytest.param("201000001", MmsiCategory.SHIP_STATION, id="lowest-allocated-mid"),
        pytest.param("775000001", MmsiCategory.SHIP_STATION, id="highest-allocated-mid"),
        pytest.param("200000001", MmsiCategory.UNALLOCATED, id="mid-below-range"),
        pytest.param("776000001", MmsiCategory.UNALLOCATED, id="mid-above-range"),
        pytest.param("100000001", MmsiCategory.UNALLOCATED, id="first-digit-one"),
        pytest.param("111265583", MmsiCategory.SAR_AIRCRAFT, id="lifeguard-003"),
        pytest.param("111265584", MmsiCategory.SAR_AIRCRAFT, id="lifeguard-004"),
        pytest.param("999999999", MmsiCategory.UNALLOCATED, id="nato-warship-placeholder"),
        pytest.param("002442000", MmsiCategory.COAST_STATION, id="coast-station"),
        pytest.param("023212345", MmsiCategory.GROUP_OF_SHIPS, id="group-of-ships"),
        pytest.param("992441234", MmsiCategory.NAVIGATIONAL_AID, id="aid-to-navigation"),
        pytest.param("982441234", MmsiCategory.AUXILIARY_CRAFT, id="auxiliary-craft"),
        pytest.param("823456789", MmsiCategory.HANDHELD_DSC, id="handheld-dsc"),
        pytest.param("970241234", MmsiCategory.AIS_SART, id="ais-sart"),
        pytest.param("972123456", MmsiCategory.MOB_DEVICE, id="mob-no-mid"),
        pytest.param("974123456", MmsiCategory.EPIRB_AIS, id="epirb-no-mid"),
        pytest.param("800000000", MmsiCategory.UNALLOCATED, id="handheld-with-junk-mid"),
    ],
)
def test_mmsi_category_reads_the_itu_prefix(mmsi: str, expected: MmsiCategory) -> None:
    assert mmsi_category(mmsi) == expected


def test_a_placeholder_mmsi_is_dropped_rather_than_merged() -> None:
    """999999999 is a real live record named NATO WARSHIP, and 999 is not an ITU MID.

    Merging on it collapses every ship using the placeholder into one record: the count
    looks right, the one-record-per-MMSI assertion passes, and ships disappear. The contract
    refuses it, so the adapter drops and counts it rather than inventing a key. A generated
    key would be worse: it would churn every poll, drawing a fresh pin each cycle and never
    merging by recency.
    """
    with pytest.raises(ValidationError) as caught:
        make_vessel("999999999")

    error = caught.value.errors()[0]
    assert error["loc"] == ("mmsi",)
    assert "unallocated" in error["msg"]


@pytest.mark.parametrize("mmsi", ["111265583", "111265584"])
def test_a_sar_aircraft_never_reaches_the_vessel_layer(mmsi: str) -> None:
    """LIFEGUARD 003 and 004 are on the live vessel feed, one of them doing 36 knots.

    They are aircraft with no ICAO 24-bit address, so they cannot become an Aircraft either.
    Dropped and counted, with the category naming what was dropped.
    """
    with pytest.raises(ValidationError) as caught:
        make_vessel(mmsi)

    assert "sar_aircraft" in caught.value.errors()[0]["msg"]


@pytest.mark.parametrize(
    "mmsi",
    ["002442000", "023212345", "992441234", "982441234", "823456789", "970241234"],
)
def test_no_non_ship_station_reaches_the_vessel_layer(mmsi: str) -> None:
    with pytest.raises(ValidationError):
        make_vessel(mmsi)


def test_flag_mid_is_the_first_three_digits() -> None:
    """Phase 5 resolves the flag state from this, with no per-vessel registry call."""
    assert make_vessel("230992610").flag_mid == "230"


# ---------------------------------------------------------------- sentinels


def test_the_course_sentinel_is_rejected_but_a_real_zero_course_is_not() -> None:
    """The subtle half of the sentinel trap, and the half that costs 110 real vessels.

    360.0 means not available and is mapped to None before any bearing check. 0.0 is a real
    course due north and 37 live records carried it, so a naive range check applied first
    rejects the sentinel records and reads as thin coverage rather than as a bug.
    """
    with pytest.raises(ValidationError) as caught:
        make_vessel(course_over_ground_deg=AIS_COG_NOT_AVAILABLE)

    assert any(e["loc"] == ("course_over_ground_deg",) for e in caught.value.errors())
    assert make_vessel(course_over_ground_deg=0.0).course_over_ground_deg == 0.0
    assert make_vessel(course_over_ground_deg=None).course_over_ground_deg is None


def test_the_heading_sentinel_is_rejected_but_a_real_zero_heading_is_not() -> None:
    with pytest.raises(ValidationError):
        make_vessel(true_heading_deg=float(AIS_HEADING_NOT_AVAILABLE))

    assert make_vessel(true_heading_deg=0.0).true_heading_deg == 0.0


@pytest.mark.parametrize("knots", [AIS_SOG_NOT_AVAILABLE, 102.4])
def test_an_unmapped_speed_sentinel_fails_validation(knots: float) -> None:
    """102.3 knots is the ITU sentinel, and AGENTS.md records AISHub sending 102.4.

    The bound sits at 100 knots, below both, so an adapter that converts the sentinel
    instead of mapping it fails here rather than drawing a ship at 190 km/h.
    """
    with pytest.raises(ValidationError):
        make_vessel(speed_over_ground_mps=knots * KNOTS_TO_METRES_PER_SECOND)


def test_a_genuinely_fast_vessel_still_validates() -> None:
    fast = make_vessel(speed_over_ground_mps=40.0 * KNOTS_TO_METRES_PER_SECOND)

    assert fast.speed_over_ground_mps == pytest.approx(20.58, abs=0.01)


def test_every_sentinel_has_a_named_constant() -> None:
    """AISHub ``format=0`` sends the scaled integer form, so both forms are named."""
    assert AIS_COG_NOT_AVAILABLE == 360.0
    assert AIS_COG_NOT_AVAILABLE_SCALED == 3600
    assert AIS_SOG_NOT_AVAILABLE == 102.3
    assert AIS_SOG_NOT_AVAILABLE_SCALED == 1023
    assert AIS_HEADING_NOT_AVAILABLE == 511
    assert AIS_ROT_NOT_AVAILABLE == -128
    assert AIS_ROT_TURNING_RIGHT_NO_RATE == 127
    assert AIS_ROT_TURNING_LEFT_NO_RATE == -127
    assert AIS_NAV_STATUS_UNDEFINED == 15
    assert AIS_ETA_NOT_AVAILABLE == 1596
    assert AIS_IMO_NOT_AVAILABLE == 0
    assert AIS_SHIP_TYPE_NOT_AVAILABLE == 0
    assert AIS_DRAUGHT_NOT_AVAILABLE == 0


@pytest.mark.parametrize(
    "rot",
    [AIS_ROT_NOT_AVAILABLE, AIS_ROT_TURNING_RIGHT_NO_RATE, AIS_ROT_TURNING_LEFT_NO_RATE],
)
def test_every_rate_of_turn_sentinel_maps_to_none(rot: int) -> None:
    """-128 is not available. +/-127 says turning hard without saying how hard.

    Neither is a rate. Squaring 127 would publish 720 degrees per minute, which no vessel
    does and no receiver reported.
    """
    assert rate_of_turn_from_ais(rot) is None


@pytest.mark.parametrize(
    ("rot", "expected"),
    [
        pytest.param(0, 0.0, id="steady"),
        pytest.param(126, 708.7, id="fastest-reportable-to-starboard"),
        pytest.param(-126, -708.7, id="fastest-reportable-to-port"),
        pytest.param(23, 23.6, id="five-degrees-per-thirty-seconds"),
        pytest.param(-23, -23.6, id="the-same-to-port"),
    ],
)
def test_rate_of_turn_decodes_the_square_law(rot: int, expected: float) -> None:
    decoded = rate_of_turn_from_ais(rot)

    assert decoded is not None
    assert decoded == pytest.approx(expected, abs=0.1)


@pytest.mark.parametrize("rot", [126, -126])
def test_a_decoded_rate_of_turn_fits_the_contract_bounds(rot: int) -> None:
    rate = rate_of_turn_from_ais(rot)

    assert make_vessel(rate_of_turn_deg_per_min=rate).rate_of_turn_deg_per_min == rate


@pytest.mark.parametrize("code", [9, 10, 13, AIS_NAV_STATUS_UNDEFINED, 16, -1])
def test_a_reserved_or_undefined_nav_status_maps_to_none(code: int) -> None:
    """Code 15 alone was 47 of 1,058 live records. ``dict.get`` is the whole mapping."""
    assert AIS_NAV_STATUS_CODES.get(code) is None


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        (0, NavigationalStatus.UNDER_WAY_USING_ENGINE),
        (1, NavigationalStatus.AT_ANCHOR),
        (5, NavigationalStatus.MOORED),
        (7, NavigationalStatus.ENGAGED_IN_FISHING),
        (8, NavigationalStatus.UNDER_WAY_SAILING),
        (14, NavigationalStatus.AIS_SART_ACTIVE),
    ],
)
def test_a_defined_nav_status_maps_to_its_member(code: int, expected: NavigationalStatus) -> None:
    assert AIS_NAV_STATUS_CODES[code] is expected


def test_every_nav_status_member_is_reachable_from_a_wire_code() -> None:
    """An unmapped member would be dead weight on the card and in the OpenAPI schema."""
    assert set(AIS_NAV_STATUS_CODES.values()) == set(NavigationalStatus)


# ---------------------------------------------------------------- eta


@pytest.mark.parametrize(
    ("packed", "expected"),
    [
        pytest.param(562112, (8, 18, 15, 0), id="serenada"),
        pytest.param(564096, (8, 19, 14, 0), id="elbstrom"),
        pytest.param(613120, (9, 11, 12, 0), id="thrasyvoulos-v"),
        pytest.param(851451, (12, 31, 23, 59), id="highest-observed-value"),
    ],
)
def test_eta_decodes_the_packed_field(packed: int, expected: tuple[int, int, int, int]) -> None:
    """Checked against the real static body: month, day, hour, minute, and no year at all."""
    eta = VesselEta.from_ais_packed(packed)

    assert eta is not None
    assert (eta.month, eta.day, eta.hour, eta.minute) == expected


@pytest.mark.parametrize(
    "packed",
    [
        pytest.param(AIS_ETA_NOT_AVAILABLE, id="not-available-1596"),
        pytest.param(0, id="zero"),
        pytest.param(851516, id="hour-24-and-minute-60"),
        pytest.param((12 << 16) | (31 << 11) | (24 << 6), id="hour-24"),
        pytest.param(0x0F << 16, id="month-15"),
    ],
)
def test_an_unusable_eta_maps_to_none(packed: int) -> None:
    """238 of 950 live records, a quarter of the field. 1596 alone was 198 of them."""
    assert VesselEta.from_ais_packed(packed) is None


def test_eta_is_not_a_datetime() -> None:
    """The wire field carries no year, so any year on it would be a guess."""
    assert set(VesselEta.model_fields) == {"month", "day", "hour", "minute"}


def test_a_decoded_eta_survives_the_wire() -> None:
    original = make_vessel(eta=VesselEta.from_ais_packed(562112))

    restored = Vessel.model_validate_json(original.model_dump_json())

    assert restored.eta == original.eta


# ---------------------------------------------------------------- numeric bounds


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("imo", AIS_IMO_NOT_AVAILABLE),
        ("imo", 912974400),
        ("imo", 999_999),
        ("ship_type", AIS_SHIP_TYPE_NOT_AVAILABLE),
        ("ship_type", 100),
        ("draught_m", 0.0),
        ("draught_m", 25.6),
        ("length_m", 0.0),
        ("length_m", 1_022.1),
        ("beam_m", 0.0),
        ("beam_m", 126.1),
        ("speed_over_ground_mps", -0.001),
        ("rate_of_turn_deg_per_min", 710.1),
        ("rate_of_turn_deg_per_min", -710.1),
        ("position_age_s", -0.001),
        ("course_over_ground_deg", 360.0),
        ("true_heading_deg", -0.001),
    ],
)
def test_numeric_bounds_are_enforced(field: str, value: float) -> None:
    kwargs = _vessel_kwargs(**{field: value})

    with pytest.raises(ValidationError) as caught:
        Vessel(**kwargs)  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]

    assert any(error["loc"] == (field,) for error in caught.value.errors())


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("imo", 9074729),
        ("ship_type", 51),
        ("draught_m", 4.9),
        ("draught_m", 25.5),
        ("length_m", 189.0),
        ("beam_m", 32.0),
    ],
)
def test_real_static_values_validate(field: str, value: float) -> None:
    kwargs = _vessel_kwargs(**{field: value})

    vessel = Vessel(**kwargs)  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]

    assert getattr(vessel, field) == value


@pytest.mark.parametrize("field", ["name", "call_sign", "destination"])
def test_an_empty_string_does_not_drop_a_real_ship(field: str) -> None:
    """The adapter maps empty text to None, and 91 of 950 destinations were empty.

    No text field here carries ``min_length=1``: if the adapter ever slips, the vessel is
    still drawn without that attribute rather than vanishing off the layer.
    """
    kwargs = _vessel_kwargs(**{field: ""})

    vessel = Vessel(**kwargs)  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]

    assert getattr(vessel, field) == ""


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("name", "A" * 21),
        ("call_sign", "ABCDEFGH"),
        ("destination", "A" * 21),
    ],
)
def test_text_longer_than_the_ais_field_is_rejected(field: str, value: str) -> None:
    kwargs = _vessel_kwargs(**{field: value})

    with pytest.raises(ValidationError):
        Vessel(**kwargs)  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]


def test_a_vessel_carries_no_altitude() -> None:
    """AIS reports no altitude, and 0.0 would claim the source said 'at the surface'."""
    assert make_vessel().point.altitude_m is None


# ---------------------------------------------------------------- label and defaults


def test_label_prefers_the_name() -> None:
    assert make_vessel(name="VIKING CINDERELLA", call_sign="OIZS").label == "VIKING CINDERELLA"


def test_label_falls_back_to_the_call_sign() -> None:
    assert make_vessel(name=None, call_sign="OIZS").label == "OIZS"


def test_label_falls_back_to_the_mmsi() -> None:
    """108 of 1,058 live positions had no static record at all, so this is a normal case."""
    assert make_vessel("230992610", name=None, call_sign=None).label == "230992610"


def test_label_ignores_empty_text() -> None:
    assert make_vessel("230992610", name="", call_sign="").label == "230992610"


def test_vessel_defaults_are_the_conservative_ones() -> None:
    vessel = Vessel(
        mmsi="230992610",
        point=Point(lon=22.216732, lat=60.432413),
        observed_at=REFERENCE_TIME,
        position_age_s=0.0,
        source="digitraffic",
    )

    assert vessel.kind == "vessel"
    assert vessel.name is None
    assert vessel.call_sign is None
    assert vessel.imo is None
    assert vessel.ship_type is None
    assert vessel.course_over_ground_deg is None
    assert vessel.speed_over_ground_mps is None
    assert vessel.true_heading_deg is None
    assert vessel.rate_of_turn_deg_per_min is None
    assert vessel.navigational_status is None
    assert vessel.draught_m is None
    assert vessel.length_m is None
    assert vessel.beam_m is None
    assert vessel.destination is None
    assert vessel.eta is None
    assert vessel.label == "230992610"


# ---------------------------------------------------------------- strictness


def test_vessel_is_frozen() -> None:
    vessel = make_vessel()

    with pytest.raises(ValidationError) as caught:
        vessel.name = "OTHER"  # type: ignore[misc]  # ty: ignore[invalid-assignment]

    assert caught.value.errors()[0]["type"] == "frozen_instance"


def test_a_decoded_eta_is_frozen_too() -> None:
    vessel = make_vessel(eta=VesselEta.from_ais_packed(562112))
    assert vessel.eta is not None

    with pytest.raises(ValidationError):
        vessel.eta.month = 1  # type: ignore[misc]  # ty: ignore[invalid-assignment]


def test_vessel_forbids_an_unknown_field() -> None:
    """posType and raim are on the wire and deliberately not in the domain."""
    with pytest.raises(ValidationError) as caught:
        Vessel(  # type: ignore[call-arg]
            mmsi="230992610",
            point=Point(lon=0.0, lat=0.0),
            observed_at=REFERENCE_TIME,
            position_age_s=0.0,
            source="digitraffic",
            posType=1,  # ty: ignore[unknown-argument]
        )

    assert caught.value.errors()[0]["type"] == "extra_forbidden"


def test_observed_at_must_be_timezone_aware() -> None:
    """AISHub sends a naive timestamp with a GMT suffix, so UTC is attached in the adapter."""
    with pytest.raises(ValidationError):
        make_vessel(observed_at=datetime(2026, 8, 19, 22, 42, 53))  # noqa: DTZ001


def test_source_must_not_be_empty() -> None:
    """ADR 010: a merged store that cannot say which provider saw a ship is unauditable."""
    with pytest.raises(ValidationError):
        make_vessel(source="")


def test_two_vessels_built_from_the_same_data_compare_equal() -> None:
    assert make_vessel("230992610") == make_vessel("230992610")
    assert make_vessel("230992610") != make_vessel("230002660")


# ---------------------------------------------------------------- serialisation


def test_vessel_round_trips_through_json() -> None:
    original = make_vessel(
        "230078610",
        name="VIKING CINDERELLA",
        call_sign="OIZS",
        imo=8719188,
        ship_type=60,
        course_over_ground_deg=347.2,
        speed_over_ground_mps=5.6,
        true_heading_deg=347.0,
        rate_of_turn_deg_per_min=rate_of_turn_from_ais(23),
        navigational_status=NavigationalStatus.UNDER_WAY_USING_ENGINE,
        draught_m=6.7,
        length_m=189.0,
        beam_m=34.0,
        destination="FIHEL<>FIMHQ<>SESTO",
        eta=VesselEta.from_ais_packed(565706),
        observed_at=datetime(2026, 8, 19, 22, 42, 53, tzinfo=UTC),
        position_age_s=12.25,
    )

    restored = Vessel.model_validate_json(original.model_dump_json())

    assert restored == original
    assert restored.observed_at == original.observed_at
    assert restored.point == original.point
    assert restored.navigational_status is NavigationalStatus.UNDER_WAY_USING_ENGINE


def test_derived_values_stay_off_the_wire() -> None:
    """``label`` and ``flag_mid`` are plain properties, not pydantic computed fields.

    Same reason as the aircraft contract: a computed field serialises but is rejected on the
    way back in by ``extra="forbid"``, so our own published wire format could not be
    re-validated by anything replaying it.
    """
    payload = json.loads(make_vessel("230992610", name="TEST VESSEL").model_dump_json())

    assert "label" not in payload
    assert "flag_mid" not in payload
    assert payload["kind"] == "vessel"
    assert payload["mmsi"] == "230992610"


# ---------------------------------------------------------------- entity union


def test_a_vessel_round_trips_through_the_discriminated_entity_union() -> None:
    original = make_vessel("230992610", name="TEST VESSEL")

    restored = _ENTITY_ADAPTER.validate_json(_ENTITY_ADAPTER.dump_json(original))

    assert isinstance(restored, Vessel)
    assert restored == original


def test_the_widened_union_still_takes_an_aircraft() -> None:
    """Widening the union was meant to touch no consumer. This is that claim, asserted."""
    restored = _ENTITY_ADAPTER.validate_json(make_aircraft().model_dump_json())

    assert isinstance(restored, Aircraft)


def test_a_payload_with_an_unknown_kind_is_rejected() -> None:
    payload = json.loads(make_vessel().model_dump_json())
    payload["kind"] = "submarine"

    with pytest.raises(ValidationError) as caught:
        _ENTITY_ADAPTER.validate_python(payload)

    assert caught.value.errors()[0]["type"] == "union_tag_invalid"


# ---------------------------------------------------------------- real recorded payloads


def _vessel_from_recorded(feature: dict[str, Any], static: dict[str, Any] | None) -> Vessel:
    """Apply the documented mapping rules to one recorded pair, and nothing else.

    This is not the adapter. It is the contract's own evidence that the recorded real
    payload maps, sentinels and all, so that the field set and the bounds are answerable to
    the live feed rather than to a guess. The adapter arrives separately.
    """
    props = feature["properties"]
    static = static or {}
    lon, lat = feature["geometry"]["coordinates"]
    fixed_at = datetime.fromtimestamp(props["timestampExternal"] / 1000.0, tz=UTC)
    observed_at = datetime(2026, 8, 19, 22, 42, 53, tzinfo=UTC)
    imo = static.get("imo", AIS_IMO_NOT_AVAILABLE)
    length = static.get("referencePointA", 0) + static.get("referencePointB", 0)
    beam = static.get("referencePointC", 0) + static.get("referencePointD", 0)
    return Vessel(
        mmsi=f"{feature['mmsi']:09d}",
        name=static.get("name") or None,
        call_sign=static.get("callSign") or None,
        imo=imo if 1_000_000 <= imo <= 9_999_999 else None,
        ship_type=static.get("shipType", AIS_SHIP_TYPE_NOT_AVAILABLE) or None,
        point=Point(lon=lon, lat=lat),
        course_over_ground_deg=None if props["cog"] >= AIS_COG_NOT_AVAILABLE else props["cog"],
        speed_over_ground_mps=(
            None
            if props["sog"] >= AIS_SOG_NOT_AVAILABLE
            else props["sog"] * KNOTS_TO_METRES_PER_SECOND
        ),
        true_heading_deg=(
            None if props["heading"] >= AIS_HEADING_NOT_AVAILABLE else float(props["heading"])
        ),
        rate_of_turn_deg_per_min=rate_of_turn_from_ais(props["rot"]),
        navigational_status=AIS_NAV_STATUS_CODES.get(props["navStat"]),
        draught_m=static.get("draught", AIS_DRAUGHT_NOT_AVAILABLE) / 10.0 or None,
        length_m=float(length) or None,
        beam_m=float(beam) or None,
        destination=static.get("destination") or None,
        eta=VesselEta.from_ais_packed(static["eta"]) if "eta" in static else None,
        observed_at=observed_at,
        position_age_s=max((observed_at - fixed_at).total_seconds(), 0.0),
        source="digitraffic",
    )


def _recorded_ship_features() -> list[dict[str, Any]]:
    body = fixture_json("digitraffic_ais_locations_live.json")
    features: list[dict[str, Any]] = body["features"]
    assert len(features) == RECORDED_POSITIONS
    return [f for f in features if mmsi_category(f"{f['mmsi']:09d}") is MmsiCategory.SHIP_STATION]


def test_every_recorded_ship_position_maps_into_the_contract() -> None:
    """109 of the 110 recorded features are ships and every one of them maps.

    The 110th is MMSI 111265584, LIFEGUARD 004, a search-and-rescue aircraft on the vessel
    feed. It is not a vessel and it is not rendered as one.
    """
    statics = {v["mmsi"]: v for v in fixture_json("digitraffic_ais_vessels_live.json")}
    ships = _recorded_ship_features()

    mapped = [_vessel_from_recorded(f, statics.get(f["mmsi"])) for f in ships]

    assert len(mapped) == RECORDED_SHIP_STATIONS
    assert len({v.mmsi for v in mapped}) == RECORDED_SHIP_STATIONS


def test_the_recorded_sentinels_all_land_as_none() -> None:
    statics = {v["mmsi"]: v for v in fixture_json("digitraffic_ais_vessels_live.json")}
    seen = {"cog": 0, "sog": 0, "heading": 0, "rot": 0, "navStat": 0}

    for feature in _recorded_ship_features():
        props = feature["properties"]
        vessel = _vessel_from_recorded(feature, statics.get(feature["mmsi"]))
        if props["cog"] == AIS_COG_NOT_AVAILABLE:
            assert vessel.course_over_ground_deg is None
            seen["cog"] += 1
        if props["sog"] == AIS_SOG_NOT_AVAILABLE:
            assert vessel.speed_over_ground_mps is None
            seen["sog"] += 1
        if props["heading"] == AIS_HEADING_NOT_AVAILABLE:
            assert vessel.true_heading_deg is None
            seen["heading"] += 1
        if props["rot"] == AIS_ROT_NOT_AVAILABLE:
            assert vessel.rate_of_turn_deg_per_min is None
            seen["rot"] += 1
        if props["navStat"] == AIS_NAV_STATUS_UNDEFINED:
            assert vessel.navigational_status is None
            seen["navStat"] += 1

    assert all(count > 0 for count in seen.values()), seen


def test_a_real_zero_course_is_kept_in_the_recorded_body() -> None:
    """The other half of the trap: mapping 0.0 to None would lose real courses."""
    statics = {v["mmsi"]: v for v in fixture_json("digitraffic_ais_vessels_live.json")}
    zeros = [f for f in _recorded_ship_features() if f["properties"]["cog"] == 0.0]

    assert zeros
    for feature in zeros:
        vessel = _vessel_from_recorded(feature, statics.get(feature["mmsi"]))
        assert vessel.course_over_ground_deg == 0.0


def test_the_recorded_placeholder_record_never_becomes_a_vessel() -> None:
    """``digitraffic_ais_vessel_metadata_junk_mmsi_live.json`` is the NATO WARSHIP record."""
    static = fixture_json("digitraffic_ais_vessel_metadata_junk_mmsi_live.json")

    assert static["mmsi"] == 999999999
    assert mmsi_category(str(static["mmsi"])) is MmsiCategory.UNALLOCATED
    with pytest.raises(ValidationError):
        make_vessel(str(static["mmsi"]), name=static["name"])


def test_a_complete_recorded_static_record_maps() -> None:
    """One record with a real IMO, draught and dimensions, to prove the bounds fit."""
    statics = fixture_json("digitraffic_ais_vessels_live.json")
    record = next(
        v
        for v in statics
        if v["imo"] != AIS_IMO_NOT_AVAILABLE
        and v["draught"] > AIS_DRAUGHT_NOT_AVAILABLE
        and v["referencePointA"] + v["referencePointB"] > 0
    )
    feature = {
        "mmsi": record["mmsi"],
        "geometry": {"coordinates": [24.9, 60.1]},
        "properties": {
            "cog": 12.3,
            "sog": 10.9,
            "heading": 12,
            "rot": 0,
            "navStat": 0,
            "timestampExternal": 1787179373376,
        },
    }

    vessel = _vessel_from_recorded(feature, record)

    assert vessel.mmsi == f"{record['mmsi']:09d}"
    assert vessel.imo == record["imo"]
    assert vessel.draught_m == pytest.approx(record["draught"] / 10.0)
    assert vessel.length_m == record["referencePointA"] + record["referencePointB"]
    assert vessel.name == record["name"]
    assert vessel.position_age_s >= 0.0


# ---------------------------------------------------------------- shared AIS mapping


@pytest.mark.parametrize(
    ("value", "sentinel", "expected"),
    [
        pytest.param(0.0, AIS_COG_NOT_AVAILABLE, 0.0, id="due north is a real course"),
        pytest.param(143.2, AIS_COG_NOT_AVAILABLE, 143.2, id="an ordinary course"),
        pytest.param(AIS_COG_NOT_AVAILABLE, AIS_COG_NOT_AVAILABLE, None, id="the cog sentinel"),
        pytest.param(AIS_HEADING_NOT_AVAILABLE, AIS_HEADING_NOT_AVAILABLE, None, id="511"),
        pytest.param(400.0, AIS_HEADING_NOT_AVAILABLE, None, id="above the range"),
        pytest.param(-1.0, AIS_HEADING_NOT_AVAILABLE, None, id="below the range"),
        pytest.param(None, AIS_COG_NOT_AVAILABLE, None, id="absent"),
    ],
)
def test_ais_bearing_maps_the_sentinel_first_and_the_range_second(
    value: float | None, sentinel: float, expected: float | None
) -> None:
    """Order is the whole point. A ``0 <= x < 360`` check applied before the sentinel rejects
    the 110 live records that carried ``cog`` 360.0 and reads as thin coverage; the range
    check that follows is what keeps a junk 400 or a negative from reaching the strict
    ``Bearing`` field and costing the whole vessel."""
    assert ais_bearing(value, sentinel) == expected


def test_speed_over_ground_converts_knots_to_metres_per_second() -> None:
    assert speed_over_ground_mps(12.4) == pytest.approx(12.4 * KNOTS_TO_METRES_PER_SECOND)


@pytest.mark.parametrize(
    "knots",
    [
        pytest.param(AIS_SOG_NOT_AVAILABLE, id="ITU 1023"),
        pytest.param(102.4, id="the reading AGENTS.md records"),
        pytest.param(-3.0, id="negative is not a speed"),
        pytest.param(None, id="absent"),
    ],
)
def test_speed_over_ground_maps_a_non_speed_to_none(knots: float | None) -> None:
    """A negative becomes None rather than zero: zero would claim the receiver said the
    vessel was stopped, and it said nothing of the kind."""
    assert speed_over_ground_mps(knots) is None
