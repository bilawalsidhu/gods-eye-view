"""Geographic primitives.

The antimeridian is where naive geospatial code fails, so it gets the most attention here.
A box spanning the date line has ``west > east``, and a caller comparing longitudes with
``<=`` on both sides silently returns nothing at all rather than erroring.
"""

import math

import pytest
from hypothesis import assume, given
from hypothesis import strategies as st
from pydantic import ValidationError

from tracker.contracts.geo import (
    EARTH_RADIUS_M,
    FEET_PER_MINUTE_TO_METRES_PER_SECOND,
    FEET_TO_METRES,
    KNOTS_TO_METRES_PER_SECOND,
    BoundingBox,
    Point,
)

LONDON = Point(lon=-0.1276, lat=51.5072)
PARIS = Point(lon=2.3522, lat=48.8566)
LONDON_TO_PARIS_M = 343_500.0
"""Great-circle distance London to Paris, about 344 km. Asserted to within 1%."""

lons = st.floats(min_value=-180.0, max_value=180.0, allow_nan=False, allow_infinity=False)
lats = st.floats(min_value=-90.0, max_value=90.0, allow_nan=False, allow_infinity=False)
bearings = st.floats(min_value=0.0, max_value=359.999, allow_nan=False, allow_infinity=False)


# ---------------------------------------------------------------- Point validation


@pytest.mark.parametrize("lon", [-180.001, 180.001, 360.0, -1e6])
def test_point_rejects_out_of_range_longitude(lon: float) -> None:
    with pytest.raises(ValidationError):
        Point(lon=lon, lat=0.0)


@pytest.mark.parametrize("lat", [-90.001, 90.001, 91.0, 1e6])
def test_point_rejects_out_of_range_latitude(lat: float) -> None:
    with pytest.raises(ValidationError):
        Point(lon=0.0, lat=lat)


def test_point_accepts_the_extremes() -> None:
    assert Point(lon=-180.0, lat=-90.0).lon == -180.0
    assert Point(lon=180.0, lat=90.0).lat == 90.0


def test_point_altitude_defaults_to_none_and_is_bounded() -> None:
    assert Point(lon=0.0, lat=0.0).altitude_m is None
    assert Point(lon=0.0, lat=0.0, altitude_m=0.0).altitude_m == 0.0

    with pytest.raises(ValidationError):
        Point(lon=0.0, lat=0.0, altitude_m=-500.001)
    with pytest.raises(ValidationError):
        Point(lon=0.0, lat=0.0, altitude_m=40_000_001.0)


def test_point_is_frozen() -> None:
    point = Point(lon=1.0, lat=2.0)

    with pytest.raises(ValidationError):
        point.lon = 3.0  # type: ignore[misc]


# ---------------------------------------------------------------- distance


def test_distance_london_to_paris_is_about_344_km() -> None:
    metres = LONDON.distance_to_m(PARIS)

    assert metres == pytest.approx(LONDON_TO_PARIS_M, rel=0.01)


def test_distance_is_symmetric() -> None:
    assert LONDON.distance_to_m(PARIS) == pytest.approx(PARIS.distance_to_m(LONDON))


def test_distance_between_identical_points_is_zero() -> None:
    assert LONDON.distance_to_m(LONDON) == 0.0
    assert Point(lon=170.0, lat=-40.0).distance_to_m(Point(lon=170.0, lat=-40.0)) == 0.0


def test_distance_ignores_altitude() -> None:
    high = Point(lon=LONDON.lon, lat=LONDON.lat, altitude_m=11_000.0)

    assert high.distance_to_m(PARIS) == pytest.approx(LONDON.distance_to_m(PARIS))


def test_distance_across_the_antimeridian_is_the_short_way_round() -> None:
    west = Point(lon=179.0, lat=0.0)
    east = Point(lon=-179.0, lat=0.0)

    two_degrees_at_equator = 2.0 * math.pi * EARTH_RADIUS_M * 2.0 / 360.0
    assert west.distance_to_m(east) == pytest.approx(two_degrees_at_equator, rel=1e-6)


def test_distance_pole_to_pole_is_half_the_circumference() -> None:
    metres = Point(lon=0.0, lat=90.0).distance_to_m(Point(lon=0.0, lat=-90.0))

    assert metres == pytest.approx(math.pi * EARTH_RADIUS_M, rel=1e-9)


# ---------------------------------------------------------------- projection


def test_project_then_measure_returns_the_input_distance() -> None:
    for distance in (1.0, 1_000.0, 100_000.0, 1_000_000.0):
        moved = LONDON.project(bearing_deg=57.0, distance_m=distance)

        assert LONDON.distance_to_m(moved) == pytest.approx(distance, rel=1e-6)


def test_project_on_bearing_zero_increases_latitude_only() -> None:
    moved = LONDON.project(bearing_deg=0.0, distance_m=50_000.0)

    assert moved.lat > LONDON.lat
    assert moved.lon == pytest.approx(LONDON.lon, abs=1e-9)


def test_project_on_bearing_180_decreases_latitude() -> None:
    moved = LONDON.project(bearing_deg=180.0, distance_m=50_000.0)

    assert moved.lat < LONDON.lat


def test_project_on_bearing_90_increases_longitude() -> None:
    moved = Point(lon=0.0, lat=0.0).project(bearing_deg=90.0, distance_m=50_000.0)

    assert moved.lon > 0.0
    assert moved.lat == pytest.approx(0.0, abs=1e-9)


def test_project_across_the_antimeridian_wraps_into_range() -> None:
    near_date_line = Point(lon=179.5, lat=0.0)
    moved = near_date_line.project(bearing_deg=90.0, distance_m=200_000.0)

    assert -180.0 <= moved.lon <= 180.0
    assert moved.lon < 0.0, "crossing eastward past 180 must come out as a negative longitude"


def test_project_westward_across_the_antimeridian_wraps_into_range() -> None:
    moved = Point(lon=-179.5, lat=0.0).project(bearing_deg=270.0, distance_m=200_000.0)

    assert -180.0 <= moved.lon <= 180.0
    assert moved.lon > 0.0


def test_project_zero_distance_is_a_no_op() -> None:
    moved = LONDON.project(bearing_deg=123.0, distance_m=0.0)

    assert moved.lon == pytest.approx(LONDON.lon)
    assert moved.lat == pytest.approx(LONDON.lat)


def test_project_carries_altitude_through_unchanged() -> None:
    """Dead reckoning moves an aircraft horizontally; its altitude is not this method's job."""
    origin = Point(lon=0.0, lat=0.0, altitude_m=9_500.0)

    assert origin.project(bearing_deg=45.0, distance_m=10_000.0).altitude_m == 9_500.0


@given(lon=lons, lat=lats, bearing=bearings, distance=st.floats(min_value=1.0, max_value=500_000.0))
def test_project_round_trip_holds_for_any_start(
    *, lon: float, lat: float, bearing: float, distance: float
) -> None:
    """Projecting and then measuring must return the distance asked for, anywhere on Earth."""
    assume(abs(lat) < 89.5)
    start = Point(lon=lon, lat=lat)

    moved = start.project(bearing_deg=bearing, distance_m=distance)

    assert -180.0 <= moved.lon <= 180.0
    assert -90.0 <= moved.lat <= 90.0
    assert start.distance_to_m(moved) == pytest.approx(distance, rel=1e-4, abs=1e-3)


# ---------------------------------------------------------------- BoundingBox validation


def test_bounding_box_rejects_south_above_north() -> None:
    with pytest.raises(ValidationError) as caught:
        BoundingBox(west=0.0, south=10.0, east=1.0, north=5.0)

    assert "must not exceed north" in str(caught.value)


def test_bounding_box_allows_a_degenerate_line() -> None:
    box = BoundingBox(west=1.0, south=5.0, east=1.0, north=5.0)

    assert box.contains(Point(lon=1.0, lat=5.0))
    assert box.enclosing_radius_m() == 0.0


def test_bounding_box_rejects_out_of_range_edges() -> None:
    with pytest.raises(ValidationError):
        BoundingBox(west=-181.0, south=0.0, east=0.0, north=1.0)
    with pytest.raises(ValidationError):
        BoundingBox(west=0.0, south=-91.0, east=1.0, north=1.0)


# ---------------------------------------------------------------- ordinary boxes


def test_bounding_box_contains_and_excludes() -> None:
    box = BoundingBox(west=-1.0, south=51.0, east=1.0, north=52.0)

    assert box.contains(LONDON)
    assert not box.contains(PARIS)
    assert not box.crosses_antimeridian


def test_bounding_box_edges_are_inclusive() -> None:
    box = BoundingBox(west=-1.0, south=51.0, east=1.0, north=52.0)

    for corner in (
        Point(lon=-1.0, lat=51.0),
        Point(lon=-1.0, lat=52.0),
        Point(lon=1.0, lat=51.0),
        Point(lon=1.0, lat=52.0),
    ):
        assert box.contains(corner)


def test_bounding_box_rejects_a_point_outside_the_latitude_band() -> None:
    box = BoundingBox(west=-1.0, south=51.0, east=1.0, north=52.0)

    assert not box.contains(Point(lon=0.0, lat=50.9))
    assert not box.contains(Point(lon=0.0, lat=52.1))


def test_bounding_box_centre_is_the_midpoint() -> None:
    centre = BoundingBox(west=-2.0, south=50.0, east=4.0, north=54.0).centre

    assert centre.lon == pytest.approx(1.0)
    assert centre.lat == pytest.approx(52.0)


def test_enclosing_radius_covers_all_four_corners() -> None:
    box = BoundingBox(west=-5.0, south=48.0, east=5.0, north=55.0)
    radius = box.enclosing_radius_m()
    centre = box.centre

    corners = [
        Point(lon=box.west, lat=box.south),
        Point(lon=box.west, lat=box.north),
        Point(lon=box.east, lat=box.south),
        Point(lon=box.east, lat=box.north),
    ]
    for corner in corners:
        assert centre.distance_to_m(corner) <= radius + 1e-6

    assert radius == pytest.approx(max(centre.distance_to_m(c) for c in corners))
    assert radius > 0.0


def test_enclosing_radius_covers_an_interior_point_too() -> None:
    box = BoundingBox(west=-5.0, south=48.0, east=5.0, north=55.0)

    assert box.centre.distance_to_m(Point(lon=2.0, lat=53.0)) < box.enclosing_radius_m()


# ---------------------------------------------------------------- antimeridian boxes


@pytest.fixture
def date_line_box() -> BoundingBox:
    """A box spanning the date line: 170E eastwards to 170W."""
    return BoundingBox(west=170.0, south=-10.0, east=-170.0, north=10.0)


def test_antimeridian_box_reports_that_it_crosses(date_line_box: BoundingBox) -> None:
    assert date_line_box.crosses_antimeridian


def test_antimeridian_box_contains_points_on_both_sides(date_line_box: BoundingBox) -> None:
    assert date_line_box.contains(Point(lon=175.0, lat=0.0))
    assert date_line_box.contains(Point(lon=-175.0, lat=0.0))
    assert date_line_box.contains(Point(lon=180.0, lat=0.0))
    assert date_line_box.contains(Point(lon=-180.0, lat=0.0))


def test_antimeridian_box_excludes_the_rest_of_the_world(date_line_box: BoundingBox) -> None:
    assert not date_line_box.contains(Point(lon=0.0, lat=0.0))
    assert not date_line_box.contains(Point(lon=169.9, lat=0.0))
    assert not date_line_box.contains(Point(lon=-169.9, lat=0.0))


def test_antimeridian_box_still_applies_its_latitude_band(date_line_box: BoundingBox) -> None:
    assert not date_line_box.contains(Point(lon=175.0, lat=11.0))


def test_antimeridian_box_centre_sits_on_the_date_line(date_line_box: BoundingBox) -> None:
    centre = date_line_box.centre

    assert abs(centre.lon) == pytest.approx(180.0)
    assert centre.lat == pytest.approx(0.0)


def test_antimeridian_box_enclosing_radius_covers_its_corners(
    date_line_box: BoundingBox,
) -> None:
    radius = date_line_box.enclosing_radius_m()
    centre = date_line_box.centre

    for corner in (
        Point(lon=date_line_box.west, lat=date_line_box.south),
        Point(lon=date_line_box.west, lat=date_line_box.north),
        Point(lon=date_line_box.east, lat=date_line_box.south),
        Point(lon=date_line_box.east, lat=date_line_box.north),
    ):
        assert centre.distance_to_m(corner) <= radius + 1e-6


@given(
    west=lons,
    east=lons,
    south=lats,
    north=lats,
    lon=lons,
    lat=lats,
)
def test_contains_agrees_with_a_manual_check_for_a_non_crossing_box(
    *, west: float, east: float, south: float, north: float, lon: float, lat: float
) -> None:
    """For a box that does not cross the date line, ``contains`` is a plain range test."""
    assume(west <= east)
    assume(south <= north)
    box = BoundingBox(west=west, south=south, east=east, north=north)
    point = Point(lon=lon, lat=lat)

    expected = west <= lon <= east and south <= lat <= north

    assert box.contains(point) is expected


@given(west=lons, east=lons, south=lats, north=lats, lon=lons, lat=lats)
def test_contains_agrees_with_a_manual_check_for_a_crossing_box(
    *, west: float, east: float, south: float, north: float, lon: float, lat: float
) -> None:
    assume(west > east)
    assume(south <= north)
    box = BoundingBox(west=west, south=south, east=east, north=north)

    expected = (lon >= west or lon <= east) and south <= lat <= north

    assert box.contains(Point(lon=lon, lat=lat)) is expected


# ---------------------------------------------------------------- unit conversions


def test_conversion_constants_are_the_exact_defined_values() -> None:
    """These are definitions, not measurements, so they are asserted exactly."""
    assert FEET_TO_METRES == 0.3048
    assert KNOTS_TO_METRES_PER_SECOND == 0.514444
    assert FEET_PER_MINUTE_TO_METRES_PER_SECOND == 0.00508
    assert pytest.approx(FEET_TO_METRES / 60.0) == FEET_PER_MINUTE_TO_METRES_PER_SECOND
