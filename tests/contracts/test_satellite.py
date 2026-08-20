"""The satellite domain contract.

The element set is the whole record: there is no position on it, because the browser
computes that from these fields. So the things worth testing hardest are the ones that make
the elements unusable without failing loudly. The catalogue number must not be capped at five
digits, since CelesTrak ran out of those on 2026-07-11. And the epoch must serialise with a
``Z``, because ``json2satrec`` appends one when it is missing and turns ``+00:00`` into
``+00:00Z``, which ``new Date()`` rejects: every satellite then lands at NaN with nothing
thrown and the layer renders empty rather than broken.
"""

import json
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

import pytest
from pydantic import TypeAdapter, ValidationError

from tests.conftest import REFERENCE_TIME, fixture_json, make_satellite
from tracker.contracts.messages import Entity
from tracker.contracts.satellite import STALE_EPOCH_AGE_S, Satellite

_ENTITY_ADAPTER: TypeAdapter[Entity] = TypeAdapter(Entity)

OMM_KEYS = frozenset(
    {
        "OBJECT_NAME",
        "OBJECT_ID",
        "EPOCH",
        "MEAN_MOTION",
        "ECCENTRICITY",
        "INCLINATION",
        "RA_OF_ASC_NODE",
        "ARG_OF_PERICENTER",
        "MEAN_ANOMALY",
        "EPHEMERIS_TYPE",
        "CLASSIFICATION_TYPE",
        "NORAD_CAT_ID",
        "ELEMENT_SET_NO",
        "REV_AT_EPOCH",
        "BSTAR",
        "MEAN_MOTION_DOT",
        "MEAN_MOTION_DDOT",
    }
)
"""The 17 CelesTrak OMM keys, identical across two real captures five months apart."""

RECORDED_OMM = [
    "celestrak_iss_omm.json",
    "celestrak_catnr19548_omm_wayback20260310.json",
]


def _satellite_kwargs(**overrides: object) -> dict[str, object]:
    """A valid satellite as keyword arguments, with one field swapped."""
    kwargs: dict[str, object] = {
        "norad_cat_id": 25544,
        "classification_type": "U",
        "epoch": REFERENCE_TIME,
        "mean_motion": 15.4951252,
        "eccentricity": 0.00076648,
        "inclination_deg": 51.6332,
        "ra_of_asc_node_deg": 346.5707,
        "arg_of_pericenter_deg": 63.0282,
        "mean_anomaly_deg": 297.1489,
        "bstar": 0.00020501314,
        "mean_motion_dot": 0.00011071,
        "mean_motion_ddot": 0.0,
        "ephemeris_type": 0,
        "element_set_no": 999,
        "rev_at_epoch": 58157,
        "group": "stations",
        "fetched_at": REFERENCE_TIME,
        "source": "celestrak",
    }
    kwargs.update(overrides)
    return kwargs


def _satellite_from_omm(record: dict[str, Any], *, group: str = "stations") -> Satellite:
    """Map one recorded OMM record, applying the two rules the adapter will apply.

    The epoch gets UTC attached, because CelesTrak sends it naive and it is UTC by
    specification. Everything else crosses verbatim: no angle conversion, and mean motion is
    revolutions per day on both sides.
    """
    return Satellite(
        norad_cat_id=record["NORAD_CAT_ID"],
        object_name=record.get("OBJECT_NAME"),
        object_id=record.get("OBJECT_ID"),
        classification_type=record["CLASSIFICATION_TYPE"],
        epoch=datetime.fromisoformat(record["EPOCH"]).replace(tzinfo=UTC),
        mean_motion=record["MEAN_MOTION"],
        eccentricity=record["ECCENTRICITY"],
        inclination_deg=record["INCLINATION"],
        ra_of_asc_node_deg=record["RA_OF_ASC_NODE"],
        arg_of_pericenter_deg=record["ARG_OF_PERICENTER"],
        mean_anomaly_deg=record["MEAN_ANOMALY"],
        bstar=float(record["BSTAR"]),
        mean_motion_dot=float(record["MEAN_MOTION_DOT"]),
        mean_motion_ddot=float(record["MEAN_MOTION_DDOT"]),
        ephemeris_type=record["EPHEMERIS_TYPE"],
        element_set_no=record["ELEMENT_SET_NO"],
        rev_at_epoch=record["REV_AT_EPOCH"],
        group=group,
        fetched_at=REFERENCE_TIME,
        source="celestrak",
    )


# ---------------------------------------------------------------- recorded payloads


@pytest.mark.parametrize("name", RECORDED_OMM)
def test_the_recorded_payload_carries_exactly_the_seventeen_omm_keys(name: str) -> None:
    """Two real captures five months apart, identical key sets. Nothing here is invented."""
    record = fixture_json(name)[0]

    assert set(record) == OMM_KEYS


@pytest.mark.parametrize("name", RECORDED_OMM)
def test_a_recorded_element_set_maps_into_the_contract(name: str) -> None:
    record = fixture_json(name)[0]

    satellite = _satellite_from_omm(record)

    assert satellite.norad_cat_id == record["NORAD_CAT_ID"]
    assert satellite.object_name == record["OBJECT_NAME"]
    assert satellite.mean_motion == record["MEAN_MOTION"]
    assert satellite.eccentricity == record["ECCENTRICITY"]
    assert satellite.bstar == record["BSTAR"]
    assert satellite.mean_motion_dot == record["MEAN_MOTION_DOT"]
    assert satellite.epoch.tzinfo is UTC


def test_the_recorded_geostationary_record_has_a_zero_bstar_and_a_negative_dot() -> None:
    """TDRS 3 carries BSTAR 0 and MEAN_MOTION_DOT -3.03e-6, both real values.

    Neither is a missing value, so neither is bounded away and neither maps to None.
    """
    satellite = _satellite_from_omm(fixture_json(RECORDED_OMM[1])[0])

    assert satellite.bstar == 0.0
    assert satellite.mean_motion_dot < 0.0
    assert satellite.mean_motion == pytest.approx(1.00259845)


def test_the_recorded_epoch_is_naive_on_the_wire() -> None:
    """Which is why UTC is attached in the adapter, and why this contract refuses naive."""
    raw = fixture_json(RECORDED_OMM[0])[0]["EPOCH"]

    assert datetime.fromisoformat(raw).tzinfo is None
    with pytest.raises(ValidationError):
        make_satellite(epoch=datetime.fromisoformat(raw))


# ---------------------------------------------------------------- catalogue number


@pytest.mark.parametrize(
    "norad_cat_id",
    [
        pytest.param(1, id="lowest"),
        pytest.param(25544, id="iss-five-digits"),
        pytest.param(100147, id="six-digits-post-2026-07-11"),
        pytest.param(799500000, id="18-spcs-analyst-range"),
        pytest.param(999999999, id="nine-digits"),
    ],
)
def test_the_catalogue_number_is_not_capped_at_five_digits(norad_cat_id: int) -> None:
    """CelesTrak exhausted the 5-digit catalogue on 2026-07-11 with Saramago.

    Everything catalogued since is 100000 or above and cannot be expressed in the TLE
    format at all, which is the structural reason this contract carries OMM elements. A
    contract capped at 99999 would start dropping new objects silently.
    """
    assert make_satellite(norad_cat_id).norad_cat_id == norad_cat_id


@pytest.mark.parametrize("norad_cat_id", [0, -1, 1_000_000_000])
def test_an_impossible_catalogue_number_is_rejected(norad_cat_id: int) -> None:
    with pytest.raises(ValidationError) as caught:
        make_satellite(norad_cat_id)

    assert any(e["loc"] == ("norad_cat_id",) for e in caught.value.errors())


# ---------------------------------------------------------------- the Z trap


def test_the_epoch_serialises_with_a_z_and_not_an_offset() -> None:
    """The satellite.js NaN trap, asserted where it can be caught.

    ``json2satrec`` appends a ``Z`` when the string has none, so ``+00:00`` becomes
    ``+00:00Z`` and ``new Date()`` returns Invalid Date. Every satellite then propagates to
    NaN, nothing throws, and the layer looks empty rather than broken.
    """
    satellite = make_satellite(epoch=datetime(2026, 8, 19, 12, 48, 46, 640160, tzinfo=UTC))

    payload = json.loads(satellite.model_dump_json())

    assert payload["epoch"] == "2026-08-19T12:48:46.640160Z"
    assert "+00:00" not in payload["epoch"]


def test_a_non_utc_epoch_is_normalised_before_it_is_serialised() -> None:
    """An offset timestamp is converted, not carried, so the wire only ever holds Z."""
    tokyo = datetime(2026, 8, 19, 21, 48, 46, tzinfo=timezone(timedelta(hours=9)))

    payload = json.loads(make_satellite(epoch=tokyo).model_dump_json())

    assert payload["epoch"] == "2026-08-19T12:48:46Z"


# ---------------------------------------------------------------- unpropagatable elements


@pytest.mark.parametrize(
    ("field", "value"),
    [
        pytest.param("eccentricity", 1.0, id="parabolic"),
        pytest.param("eccentricity", 1.5, id="hyperbolic"),
        pytest.param("eccentricity", -0.001, id="negative"),
        pytest.param("mean_motion", 0.0, id="mean-motion-zero"),
        pytest.param("mean_motion", -0.5, id="mean-motion-below-zero"),
    ],
)
def test_an_unpropagatable_element_set_is_refused(field: str, value: float) -> None:
    """SatRecError 1 and 2 are decidable from the elements alone, so they never reach a store.

    An eccentricity outside 0 to 1 and a mean motion at or below zero are what SGP4 reports
    as MeanEccentricityOutOfRange and MeanMotionBelowZero. Both are dropped and counted at
    the adapter rather than drawn as a satellite underground.
    """
    kwargs = _satellite_kwargs(**{field: value})

    with pytest.raises(ValidationError) as caught:
        Satellite(**kwargs)  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]

    assert any(e["loc"] == (field,) for e in caught.value.errors())


@pytest.mark.parametrize(
    ("field", "value"),
    [
        pytest.param("mean_motion", float("inf"), id="mean-motion-inf-passes-gt-zero"),
        pytest.param("mean_motion", float("nan"), id="mean-motion-nan"),
        pytest.param("eccentricity", float("nan"), id="eccentricity-nan"),
        pytest.param("bstar", float("nan"), id="bstar-nan"),
        pytest.param("bstar", float("inf"), id="bstar-inf"),
        pytest.param("bstar", float("-inf"), id="bstar-negative-inf"),
        pytest.param("mean_motion_dot", float("nan"), id="mean-motion-dot-nan"),
        pytest.param("mean_motion_ddot", float("inf"), id="mean-motion-ddot-inf"),
        pytest.param("inclination_deg", float("nan"), id="inclination-nan"),
    ],
)
def test_a_non_finite_float_is_refused(field: str, value: float) -> None:
    """``inf`` and ``nan`` are refused on every float, bounded or not.

    Two separate holes closed. ``inf`` satisfies ``gt=0.0``, so an infinite mean motion
    walked past the one bound that exists to refuse an unpropagatable element set. And
    ``bstar``, ``mean_motion_dot`` and ``mean_motion_ddot`` carry no bounds at all, because
    a real B* can be any sign, so nothing else would have caught a ``nan`` on them.
    """
    kwargs = _satellite_kwargs(**{field: value})

    with pytest.raises(ValidationError) as caught:
        Satellite(**kwargs)  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]

    assert any(error["loc"] == (field,) for error in caught.value.errors())


def test_field_descriptions_carry_no_internal_process_notes() -> None:
    """Descriptions reach ``openapi.json`` and then ``frontend/src/types/api.d.ts``.

    A published schema description says what the field is. Why we wrote the code the way we
    did belongs in a comment above the field, which is where the aircraft contract keeps it.
    """
    for name, field in Satellite.model_fields.items():
        text = field.description or ""
        assert "A test asserts" not in text, f"{name} describes our test suite"
        assert "DECISIONS-PENDING" not in text, f"{name} cites an internal working note"
        assert "pending-decisions" not in text, f"{name} cites an internal working note"
        assert len(text) <= 400, f"{name} description is {len(text)} chars of prose"


def test_a_circular_orbit_validates() -> None:
    """Eccentricity 0 is a real value, not a missing one."""
    assert make_satellite(eccentricity=0.0).eccentricity == 0.0


def test_the_contract_carries_no_decay_flag() -> None:
    """Nothing on an OMM record signals decay, so there is no field to fill.

    The guards are absence from the group, epoch staleness, a null from propagate() and
    SATCAT. A ``decayed`` field here would be a placeholder no source fills.
    """
    assert not {"decayed", "decay_date", "ops_status", "on_orbit"} & set(Satellite.model_fields)


def test_the_contract_carries_no_position_and_no_tle_lines() -> None:
    """The position is computed client-side, and json2satrec takes the OMM record directly.

    A server-computed position would be a second source of truth for the same thing. TLE
    line pairs are worse than redundant: they are lossy and they cannot express a 6-digit
    catalogue number at all.
    """
    fields = set(Satellite.model_fields)

    assert not {"point", "lat", "lon", "altitude_m"} & fields
    assert not {"tle_line1", "tle_line2", "tle"} & fields


# ---------------------------------------------------------------- staleness


def test_epoch_age_is_measured_from_the_epoch_and_not_the_fetch() -> None:
    epoch = datetime(2026, 8, 19, 12, 0, tzinfo=UTC)
    satellite = make_satellite(epoch=epoch, fetched_at=epoch + timedelta(hours=6))

    assert satellite.epoch_age_s(epoch + timedelta(hours=1)) == pytest.approx(3600.0)


def test_the_stale_threshold_is_celestraks_own_three_and_a_half_days() -> None:
    assert STALE_EPOCH_AGE_S == 3.5 * 24 * 60 * 60


def test_elements_are_not_stale_at_exactly_the_threshold() -> None:
    epoch = datetime(2026, 8, 19, 12, 0, tzinfo=UTC)
    satellite = make_satellite(epoch=epoch)

    assert satellite.is_stale_at(epoch + timedelta(seconds=STALE_EPOCH_AGE_S)) is False
    assert satellite.is_stale_at(epoch + timedelta(seconds=STALE_EPOCH_AGE_S + 1)) is True


def test_a_clean_error_code_is_not_evidence_of_a_usable_position() -> None:
    """The ISS element set propagates cleanly a year past its epoch. It is still fiction."""
    epoch = datetime(2026, 8, 19, 12, 0, tzinfo=UTC)

    assert make_satellite(epoch=epoch).is_stale_at(epoch + timedelta(days=365)) is True


# ---------------------------------------------------------------- bounds and patterns


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("inclination_deg", -0.001),
        ("inclination_deg", 180.001),
        ("ra_of_asc_node_deg", -0.001),
        ("ra_of_asc_node_deg", 360.001),
        ("arg_of_pericenter_deg", 360.001),
        ("mean_anomaly_deg", 360.001),
        ("ephemeris_type", -1),
        ("ephemeris_type", 10),
        ("element_set_no", -1),
        ("rev_at_epoch", -1),
    ],
)
def test_numeric_bounds_are_enforced(field: str, value: float) -> None:
    kwargs = _satellite_kwargs(**{field: value})

    with pytest.raises(ValidationError) as caught:
        Satellite(**kwargs)  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]

    assert any(error["loc"] == (field,) for error in caught.value.errors())


@pytest.mark.parametrize("angle", [0.0, 180.0, 359.9999, 360.0])
def test_a_full_turn_is_accepted_on_an_orbital_angle(angle: float) -> None:
    """An orbital angle is not a compass bearing, so 360.0 is not excluded.

    Excluding it would drop an object for a value the provider is entitled to send.
    """
    assert make_satellite(ra_of_asc_node_deg=angle).ra_of_asc_node_deg == angle


@pytest.mark.parametrize("classification", ["U", "C", "S"])
def test_the_classification_pattern_accepts_the_three_codes(classification: str) -> None:
    assert make_satellite(classification_type=classification).classification_type == classification


@pytest.mark.parametrize("classification", ["u", "X", "", "UU"])
def test_the_classification_pattern_rejects_anything_else(classification: str) -> None:
    with pytest.raises(ValidationError):
        make_satellite(classification_type=classification)


def test_an_analyst_object_needs_no_name_or_designator() -> None:
    """CelesTrak documents that 80000-series analyst objects carry neither."""
    satellite = make_satellite(80001, object_name=None, object_id=None)

    assert satellite.object_name is None
    assert satellite.object_id is None
    assert satellite.label == "80001"


def test_label_prefers_the_object_name() -> None:
    assert make_satellite().label == "ISS (ZARYA)"


@pytest.mark.parametrize("field", ["group", "source"])
def test_group_and_source_must_not_be_empty(field: str) -> None:
    kwargs = _satellite_kwargs(**{field: ""})

    with pytest.raises(ValidationError):
        Satellite(**kwargs)  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]


# ---------------------------------------------------------------- strictness


def test_satellite_is_frozen() -> None:
    satellite = make_satellite()

    with pytest.raises(ValidationError) as caught:
        satellite.mean_motion = 1.0  # type: ignore[misc]  # ty: ignore[invalid-assignment]

    assert caught.value.errors()[0]["type"] == "frozen_instance"


def test_satellite_forbids_an_unknown_field() -> None:
    """The OMM keyword set is fixed, so a new key fails a test rather than being ignored."""
    kwargs = _satellite_kwargs(REF_FRAME="TEME")

    with pytest.raises(ValidationError) as caught:
        Satellite(**kwargs)  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]

    assert caught.value.errors()[0]["type"] == "extra_forbidden"


def test_fetched_at_must_be_timezone_aware() -> None:
    with pytest.raises(ValidationError):
        make_satellite(fetched_at=datetime(2026, 8, 19, 12, 0))  # noqa: DTZ001


def test_two_satellites_built_from_the_same_data_compare_equal() -> None:
    assert make_satellite(25544) == make_satellite(25544)
    assert make_satellite(25544) != make_satellite(36086)


# ---------------------------------------------------------------- serialisation


def test_satellite_round_trips_through_json() -> None:
    original = _satellite_from_omm(fixture_json(RECORDED_OMM[0])[0])

    restored = Satellite.model_validate_json(original.model_dump_json())

    assert restored == original
    assert restored.epoch == original.epoch


def test_derived_values_stay_off_the_wire() -> None:
    """``label`` is a plain property, for the reason set out in contracts/aircraft.py."""
    payload = json.loads(make_satellite().model_dump_json())

    assert "label" not in payload
    assert payload["kind"] == "satellite"
    assert payload["norad_cat_id"] == 25544


# ---------------------------------------------------------------- entity union


def test_a_satellite_round_trips_through_the_discriminated_entity_union() -> None:
    original = make_satellite()

    restored = _ENTITY_ADAPTER.validate_json(_ENTITY_ADAPTER.dump_json(original))

    assert isinstance(restored, Satellite)
    assert restored == original


def test_the_union_keeps_the_epoch_z_suffix() -> None:
    """A satellite serialised through the union is still feedable to json2satrec."""
    payload = json.loads(_ENTITY_ADAPTER.dump_json(make_satellite()))

    assert payload["epoch"].endswith("Z")
