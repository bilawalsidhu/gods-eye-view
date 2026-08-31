"""The city domain contract, tested against the real GeoNames rows.

Three things here are worth more than the rest. The coordinate pair must not silently
mirror, because latitude is column 5 and longitude is column 6 and this repo has documented
that backwards twice. The modification date must stay a ``date``, because there is no time
anywhere in the file and a ``UtcDatetime`` here would be a midnight we invented. And an
absent elevation must stay absent rather than becoming zero, because it is absent on 87% of
the file and zero is a real elevation.
"""

import json
from datetime import UTC, date, datetime

import pytest
from pydantic import TypeAdapter, ValidationError

from tracker.contracts.city import City
from tracker.contracts.geo import Point

_ADAPTER: TypeAdapter[City] = TypeAdapter(City)

# The real London GB row, geonames_id 2643743, line 12173 of cities15000.txt.
LONDON_GB = {
    "geonames_id": 2643743,
    "name": "London",
    "ascii_name": "London",
    "point": {"lon": -0.12574, "lat": 51.50853},
    "feature_code": "PPLC",
    "country_code": "GB",
    "admin1_code": "ENG",
    "population": 8961989,
    "timezone": "Europe/London",
    "elevation_m": None,
    "modification_date": date(2026, 8, 17),
}


def _london(**overrides: object) -> City:
    return City(**{**LONDON_GB, **overrides})  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]


def test_real_london_row_validates() -> None:
    city = _london()
    assert city.kind == "city"
    assert city.geonames_id == 2643743
    assert city.point.lon == pytest.approx(-0.12574)
    assert city.point.lat == pytest.approx(51.50853)
    assert city.modification_date == date(2026, 8, 17)


def test_longitude_and_latitude_are_not_interchangeable() -> None:
    """9,075 rows in the file have |longitude| > 90, so a mirrored pair must fail loudly.

    The one this uses is real: Tokyo sits at longitude 139.69, which is not a latitude.
    """
    with pytest.raises(ValidationError):
        Point(lon=35.6895, lat=139.69171)


def test_altitude_is_left_unset_and_elevation_is_separate() -> None:
    """Elevation is metres above mean sea level; altitude here is above the ellipsoid.

    They differ by up to about 100 metres, so the contract keeps them apart.
    """
    city = _london(elevation_m=25)
    assert city.point.altitude_m is None
    assert city.elevation_m == 25


def test_absent_elevation_stays_none_and_zero_stays_zero() -> None:
    assert _london(elevation_m=None).elevation_m is None
    assert _london(elevation_m=0).elevation_m == 0


def test_modification_date_is_a_date_not_a_datetime() -> None:
    """The file carries no time and no zone, so nothing here may invent one."""
    with pytest.raises(ValidationError):
        _london(modification_date=datetime(2026, 8, 17, tzinfo=UTC))


def test_population_zero_is_accepted() -> None:
    """Three real rows report population 0. They are data, not errors."""
    assert _london(population=0).population == 0


def test_seven_digit_geonames_id_is_accepted() -> None:
    """The real Pechersk row carries 13535745. Nothing may cap the id width."""
    assert _london(geonames_id=13535745).geonames_id == 13535745


def test_admin1_is_optional_because_25_rows_have_none() -> None:
    assert _london(admin1_code=None).admin1_code is None


def test_lowercase_country_code_is_rejected() -> None:
    with pytest.raises(ValidationError):
        _london(country_code="gb")


def test_non_ppl_feature_code_is_accepted() -> None:
    """Two real rows carry STLMT, so the code is not PPL-pattern-constrained."""
    assert _london(feature_code="STLMT").feature_code == "STLMT"


def test_extra_field_is_rejected() -> None:
    """A new GeoNames column must fail a test rather than be silently ignored."""
    with pytest.raises(ValidationError):
        _london(dem=25)


def test_city_is_frozen() -> None:
    city = _london()
    with pytest.raises(ValidationError):
        city.population = 1  # type: ignore[misc]  # ty: ignore[invalid-assignment]


def test_round_trips_through_json() -> None:
    """Serialise, re-validate, and get the same record back.

    This is what the ban on pydantic computed fields protects: one would serialise and then be
    rejected on the way back in by ``extra="forbid"``, so the contract could not survive its
    own round trip. The field set on the wire is exactly the field set the model declares.
    """
    city = _london()
    dumped = city.model_dump_json()
    assert set(json.loads(dumped)) == set(City.model_fields)
    assert _ADAPTER.validate_json(dumped) == city


def test_date_arrives_as_an_iso_string_in_json_mode_only() -> None:
    """The wire form is a string; the Python form is a ``date``, and strict mode says so.

    Which is exactly why sources/geonames.py calls ``date.fromisoformat`` rather than
    handing the raw cell to pydantic and hoping.
    """
    payload = json.dumps({**LONDON_GB, "modification_date": "2026-08-17"})
    assert _ADAPTER.validate_json(payload).modification_date == date(2026, 8, 17)
    with pytest.raises(ValidationError):
        _london(modification_date="2026-08-17")
