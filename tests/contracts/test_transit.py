"""The transit contract: what it refuses, and why each refusal was measured rather than guessed."""

from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from tracker.contracts.geo import Point
from tracker.contracts.transit import MAX_PLAUSIBLE_SPEED_MS, TransitVehicle

OBSERVED = datetime(2026, 8, 23, 10, 21, 46, tzinfo=UTC)


def vehicle(**kwargs: object) -> TransitVehicle:
    fields: dict[str, object] = {
        "feed_id": "mdb-1646",
        "entity_id": "2026-08-23:EBS:2087:7021",
        "point": Point(lon=4.3447, lat=51.8357),
        "observed_at": OBSERVED,
        "timestamp_basis": "vehicle",
        "position_age_s": 20.0,
        "source": "OVapi",
        "licence": "operator terms",
        "country": "NL",
    }
    fields.update(kwargs)
    return TransitVehicle(**fields)  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]


def test_a_minimal_vehicle_needs_only_identity_place_time_and_licence() -> None:
    v = vehicle()
    assert v.kind == "transit"
    assert v.vehicle_id is None
    assert v.route_id is None
    assert v.bearing is None
    assert v.speed_ms is None
    assert v.occupancy is None


def test_the_contract_is_frozen() -> None:
    v = vehicle()
    with pytest.raises(ValidationError):
        v.feed_id = "other"  # type: ignore[misc]  # ty: ignore[invalid-assignment]


def test_an_unknown_field_is_refused() -> None:
    with pytest.raises(ValidationError):
        vehicle(current_stop_sequence=4)


@pytest.mark.parametrize("missing", ["feed_id", "entity_id", "licence", "country", "source"])
def test_an_empty_required_string_is_refused(missing: str) -> None:
    with pytest.raises(ValidationError):
        vehicle(**{missing: ""})


def test_a_naive_observation_time_is_refused() -> None:
    """Every time in this project is timezone-aware UTC. GTFS-RT sends POSIX seconds."""
    with pytest.raises(ValidationError):
        vehicle(observed_at=datetime(2026, 8, 23, 10, 21, 46))  # noqa: DTZ001


@pytest.mark.parametrize("bad", [-0.1, 360.0, 360.5, -30.0])
def test_a_bearing_outside_the_circle_is_refused(bad: float) -> None:
    """470 vehicles reported negative and 18 reported exactly 360, so the adapter normalises.

    The contract stays strict on purpose: if a normalisation is ever removed, this fails
    rather than a compass needle pointing at nothing on the globe.
    """
    with pytest.raises(ValidationError):
        vehicle(bearing=bad)


@pytest.mark.parametrize("good", [0.0, 71.0, 359.9])
def test_a_bearing_inside_the_circle_is_accepted(good: float) -> None:
    assert vehicle(bearing=good).bearing == good


def test_a_speed_above_the_plausible_bound_is_refused() -> None:
    """Four feeds report km/h into a metres-per-second field and nothing declares the unit."""
    with pytest.raises(ValidationError):
        vehicle(speed_ms=MAX_PLAUSIBLE_SPEED_MS + 0.1)


def test_a_negative_speed_is_refused() -> None:
    with pytest.raises(ValidationError):
        vehicle(speed_ms=-1.0)


def test_a_negative_position_age_is_refused() -> None:
    """Eight feeds ran up to an hour ahead of wall clock. The adapter drops them."""
    with pytest.raises(ValidationError):
        vehicle(position_age_s=-1.0)


@pytest.mark.parametrize("bad", ["nl", "NLD", "N", "", "12"])
def test_a_country_that_is_not_iso_alpha_2_is_refused(bad: str) -> None:
    with pytest.raises(ValidationError):
        vehicle(country=bad)


def test_the_timestamp_basis_says_which_clock_was_used() -> None:
    """A record dated to the feed header is a weaker claim than one dated to its own fix."""
    assert vehicle(timestamp_basis="feed").timestamp_basis == "feed"
    with pytest.raises(ValidationError):
        vehicle(timestamp_basis="header")


def test_altitude_is_left_unset_rather_than_invented() -> None:
    """No GTFS-RT feed reports altitude, and ground level would be a fabricated value."""
    assert vehicle().point.altitude_m is None


def test_there_is_no_providers_field_because_no_two_agencies_report_the_same_bus() -> None:
    """ADR 010's union shape does not apply here. Each feed is the sole publisher of its own."""
    assert "providers" not in TransitVehicle.model_fields


def test_the_identity_is_the_feed_and_the_entity() -> None:
    same_number_elsewhere = vehicle(feed_id="mdb-2391", vehicle_id="557")
    ours = vehicle(vehicle_id="557")
    assert ours.vehicle_id == same_number_elsewhere.vehicle_id
    assert (ours.feed_id, ours.entity_id) != (
        same_number_elsewhere.feed_id,
        same_number_elsewhere.entity_id,
    )


def test_an_older_observation_sorts_older() -> None:
    older = vehicle(observed_at=OBSERVED - timedelta(minutes=5), position_age_s=320.0)
    assert older.observed_at < vehicle().observed_at
