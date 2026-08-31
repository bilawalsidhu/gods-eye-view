"""The model bases and the wire-to-domain boundary.

Everything here is a guard that has a concrete failure behind it. A naive datetime that
validates is an aircraft with a fix an hour in the future. A strict wire model rejects
every military aircraft. An unsummarised ValidationError buries the one useful line under
three hundred others.
"""

from datetime import UTC, datetime, timedelta, timezone

import pytest
from pydantic import Field, TypeAdapter, ValidationError

from tracker.contracts.base import (
    Bearing,
    ContractViolationError,
    Latitude,
    Longitude,
    StrictModel,
    UtcDatetime,
    WireModel,
    _summarise,
    validate_payload,
)


class _Timestamped(StrictModel):
    at: UtcDatetime


class _Numbers(StrictModel):
    value: float
    count: int = 0


class _Bounded(StrictModel):
    lon: Longitude
    lat: Latitude
    bearing: Bearing


class _Loose(WireModel):
    known: str
    optional: int | None = None


class _Nested(StrictModel):
    a: float
    b: float
    c: float
    d: float


# ---------------------------------------------------------------- UtcDatetime


def test_utc_datetime_rejects_naive() -> None:
    with pytest.raises(ValidationError) as caught:
        _Timestamped(at=datetime(2026, 8, 19, 12, 0, 0))  # noqa: DTZ001

    message = str(caught.value)
    assert "timezone-aware" in message
    assert "ambiguous" in message


def test_utc_datetime_normalises_an_offset_to_utc() -> None:
    plus_five = timezone(timedelta(hours=5))
    model = _Timestamped(at=datetime(2026, 8, 19, 17, 30, 0, tzinfo=plus_five))

    assert model.at.tzinfo is UTC
    assert model.at == datetime(2026, 8, 19, 12, 30, 0, tzinfo=UTC)
    assert model.at.hour == 12


def test_utc_datetime_leaves_an_already_utc_value_alone() -> None:
    original = datetime(2026, 8, 19, 12, 0, 0, tzinfo=UTC)

    assert _Timestamped(at=original).at == original


def test_utc_datetime_accepts_an_iso_string_in_json_mode() -> None:
    model = _Timestamped.model_validate_json('{"at": "2026-08-19T13:00:00+01:00"}')

    assert model.at == datetime(2026, 8, 19, 12, 0, 0, tzinfo=UTC)


# ---------------------------------------------------------------- StrictModel


def test_strict_model_forbids_extra_fields() -> None:
    with pytest.raises(ValidationError) as caught:
        _Numbers(value=1.0, surprise=2)  # type: ignore[call-arg]  # ty: ignore[unknown-argument]

    assert caught.value.errors()[0]["type"] == "extra_forbidden"


def test_strict_model_is_frozen() -> None:
    model = _Numbers(value=1.0)

    with pytest.raises(ValidationError) as caught:
        model.value = 2.0  # type: ignore[misc]  # ty: ignore[invalid-assignment]

    assert caught.value.errors()[0]["type"] == "frozen_instance"


def test_strict_model_rejects_bool_for_float() -> None:
    """A bool is an int in Python, and that coercion silently corrupts numeric fields."""
    with pytest.raises(ValidationError) as caught:
        _Numbers(value=True)

    assert caught.value.errors()[0]["type"] == "float_type"


def test_strict_model_rejects_bool_for_int() -> None:
    with pytest.raises(ValidationError) as caught:
        _Numbers(value=1.0, count=True)

    assert caught.value.errors()[0]["type"] == "int_type"


def test_strict_model_rejects_a_numeric_string() -> None:
    with pytest.raises(ValidationError):
        _Numbers(value="1.0")  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]


def test_strict_model_accepts_an_int_for_a_float() -> None:
    """The one widening pydantic's strict mode allows, and the only one we rely on."""
    assert _Numbers(value=3).value == 3.0


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("lon", -180.5),
        ("lon", 180.5),
        ("lat", -90.5),
        ("lat", 90.5),
        ("bearing", -0.1),
        ("bearing", 360.0),
    ],
)
def test_bounded_aliases_reject_out_of_range(field: str, value: float) -> None:
    kwargs: dict[str, float] = {"lon": 0.0, "lat": 0.0, "bearing": 0.0}
    kwargs[field] = value

    with pytest.raises(ValidationError):
        _Bounded(**kwargs)


def test_bounded_aliases_accept_their_edges() -> None:
    model = _Bounded(lon=180.0, lat=-90.0, bearing=359.999)

    assert (model.lon, model.lat) == (180.0, -90.0)


# ---------------------------------------------------------------- WireModel


def test_wire_model_ignores_unknown_fields() -> None:
    """This is the ``/v2/mil`` case. It returns eight fields ``/v2/point`` does not."""
    model = _Loose.model_validate(
        {
            "known": "yes",
            "dbFlags": 1,
            "calc_track": 180,
            "lastPosition": {"lat": 1.0},
            "gpsOkBefore": 1787165611.0,
            "rr_lat": 51.0,
        }
    )

    assert model.known == "yes"
    assert model.optional is None
    assert not hasattr(model, "dbFlags")


def test_wire_model_coerces_a_string_number() -> None:
    """Feeds send numbers as strings whenever it suits them; the wire layer tolerates it."""
    assert _Loose.model_validate({"known": "x", "optional": "42"}).optional == 42


def test_wire_model_is_frozen() -> None:
    model = _Loose(known="x")

    with pytest.raises(ValidationError):
        model.known = "y"  # type: ignore[misc]  # ty: ignore[invalid-assignment]


def test_wire_model_still_requires_its_declared_fields() -> None:
    with pytest.raises(ValidationError) as caught:
        _Loose.model_validate({"optional": 1})

    assert caught.value.errors()[0]["type"] == "missing"


# ---------------------------------------------------------------- validate_payload


def test_validate_payload_parses_bytes() -> None:
    adapter = TypeAdapter(_Loose)
    model = validate_payload(adapter, b'{"known": "from-bytes"}', source="test.feed")

    assert model.known == "from-bytes"


def test_validate_payload_parses_a_string() -> None:
    adapter = TypeAdapter(_Loose)

    assert validate_payload(adapter, '{"known": "str"}', source="test.feed").known == "str"


def test_validate_payload_parses_python_objects() -> None:
    adapter = TypeAdapter(_Loose)
    model = validate_payload(adapter, {"known": "from-dict"}, source="test.feed")

    assert model.known == "from-dict"


def test_validate_payload_raises_contract_violation_naming_the_source() -> None:
    adapter = TypeAdapter(_Loose)

    with pytest.raises(ContractViolationError) as caught:
        validate_payload(adapter, b'{"nope": 1}', source="adsb.lol")

    error = caught.value
    assert error.source == "adsb.lol"
    assert str(error).startswith("adsb.lol: ")
    assert "known" in error.detail
    assert isinstance(error.__cause__, ValidationError)


def test_validate_payload_raises_contract_violation_on_unparseable_json() -> None:
    adapter = TypeAdapter(_Loose)

    with pytest.raises(ContractViolationError) as caught:
        validate_payload(adapter, b"<html>503 Service Unavailable</html>", source="adsb.fi")

    assert caught.value.source == "adsb.fi"


# ---------------------------------------------------------------- _summarise


def test_summarise_reports_every_error_when_there_are_few() -> None:
    with pytest.raises(ValidationError) as caught:
        _Nested.model_validate({"a": 1.0, "b": 2.0})

    summary = _summarise(caught.value)
    assert "c: Field required" in summary
    assert "d: Field required" in summary
    assert "more)" not in summary


def test_summarise_compresses_many_errors_with_a_count_suffix() -> None:
    with pytest.raises(ValidationError) as caught:
        _Nested.model_validate({})

    summary = _summarise(caught.value)
    assert summary.count(";") == 2
    assert summary.endswith("(+1 more)")


def test_summarise_honours_a_custom_limit() -> None:
    with pytest.raises(ValidationError) as caught:
        _Nested.model_validate({})

    assert _summarise(caught.value, limit=1).endswith("(+3 more)")
    assert "(+" not in _summarise(caught.value, limit=4)


def test_summarise_joins_nested_locations_with_dots() -> None:
    class _Outer(StrictModel):
        inner: _Nested = Field()

    with pytest.raises(ValidationError) as caught:
        _Outer.model_validate({"inner": {"a": 1.0, "b": 2.0, "c": 3.0}})

    assert "inner.d" in _summarise(caught.value)


def test_contract_violation_error_is_an_exception_carrying_both_parts() -> None:
    error = ContractViolationError("celestrak", "EPOCH: Field required")

    assert isinstance(error, Exception)
    assert error.source == "celestrak"
    assert error.detail == "EPOCH: Field required"
    assert str(error) == "celestrak: EPOCH: Field required"
