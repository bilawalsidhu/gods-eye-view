"""The Estonian Transpordiamet ArcGIS AIS adapter, driven by a real captured body.

``tests/fixtures/transpordiamet_ais_vessels_live.json`` is an 88-record slice of a genuine
``gis.transpordiamet.ee`` FeatureServer query response captured on 2026-08-23, sliced so every
trap is in the committed bytes. No network: respx intercepts at the transport.

Four traps get most of the attention because each produces wrong output rather than an error:
the default spatial reference being Estonian grid metres rather than WGS84, the
``sys_timestamp`` field that is a constant 1900, the ArcGIS error that arrives inside an HTTP
200, and the ``draught`` that is metres here and decimetres on Digitraffic.
"""

import json
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
from tracker.sources.transpordiamet import (
    ATTRIBUTION,
    BASE_URL,
    ESTONIAN_GRID_WKID,
    LICENCE,
    MAX_FIX_TIME_AHEAD_SECONDS,
    MAX_RECORDS_PER_PAGE,
    MIN_INTERVAL_SECONDS,
    QUERY_PATH,
    SOURCE_NAME,
    WGS84_WKID,
    TranspordiametClient,
    parse_features,
)

QUERY_URL = f"{BASE_URL}{QUERY_PATH}"

FIXTURE = "transpordiamet_ais_vessels_live.json"

FEATURE_COUNT = 88
"""Features in the captured slice."""

VESSEL_COUNT = 86
"""Usable vessels. Two are refused: one EPIRB-AIS beacon and one unallocated MID."""

CAPTURE_TIME = datetime(2026, 8, 23, 10, 46, tzinfo=UTC)

SYS_TIMESTAMP_SENTINEL = -2209161600000
"""The constant every record carries in ``sys_timestamp``: 1 January 1900. Trap 2."""


@pytest.fixture
def payload() -> bytes:
    """The captured FeatureServer body, 88 features, 2026-08-23."""
    return fixture_bytes(FIXTURE)


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    """A real httpx client. respx intercepts at the transport, so nothing leaves the process."""
    async with httpx.AsyncClient() as client:
        yield client


@pytest.fixture
def client(http: httpx.AsyncClient) -> TranspordiametClient:
    return TranspordiametClient(http, clock=lambda: CAPTURE_TIME)


class Clock:
    """A hand-driven clock, so a cooldown boundary is measured rather than slept through."""

    def __init__(self, start: datetime = CAPTURE_TIME) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


def _parse(payload: bytes, *, now: datetime = CAPTURE_TIME) -> Any:
    records, _ = parse_features(payload, now=now)
    return records


def _more(payload: bytes, *, now: datetime = CAPTURE_TIME) -> bool:
    _, more = parse_features(payload, now=now)
    return more


def _envelope(
    *features: Any, wkid: int = WGS84_WKID, exceeded: bool = False, **extra: Any
) -> bytes:
    body: dict[str, Any] = {
        "features": list(features),
        "geometryType": "esriGeometryPoint",
        "spatialReference": {"wkid": wkid, "latestWkid": wkid},
        "exceededTransferLimit": exceeded,
    }
    body.update(extra)
    return json.dumps(body).encode()


def _feature(**overrides: Any) -> dict[str, Any]:
    """One feature in the shape this endpoint sends, for a targeted variant."""
    attributes: dict[str, Any] = {
        "objectid": 11295,
        "globalid": "{C393CD1A-2E3C-423B-90F1-EB3219D23D46}",
        "name": "TEST SHIP",
        "timestamp": 1787481437494,
        "mmsi": "230941650",
        "imo": "8912778",
        "flag": "FIN",
        "type_and_cargo": 30,
        "nav_status": 5,
        "destination": "ROHUKYLA",
        "eta": 1779278400000,
        "sog": 4.0,
        "cog": 92.5,
        "length": 41,
        "width": 7,
        "draught": 4.7,
        "fix_type": 1,
        "callsign": "OJPD",
        "class": "A",
        "true_heading": 352,
        "dim_bow": 29,
        "dim_stern": 12,
        "dim_port": 3,
        "dim_starb": 4,
        "sys_timestamp": SYS_TIMESTAMP_SENTINEL,
    }
    geometry: dict[str, Any] = {"x": 23.425483, "y": 58.904183}
    for field, value in overrides.items():
        if field in ("x", "y"):
            geometry[field] = value
        else:
            attributes[field] = value
    return {"attributes": attributes, "geometry": geometry}


# ---------------------------------------------------------------- the real payload


def test_parses_the_live_body(payload: bytes) -> None:
    parsed = _parse(payload)
    assert len(parsed.records) == VESSEL_COUNT
    assert {v.source for v in parsed.records} == {SOURCE_NAME}
    assert all(v.kind == "vessel" for v in parsed.records)


def test_every_feature_is_kept_or_counted(payload: bytes) -> None:
    parsed = _parse(payload)
    assert len(parsed.records) + parsed.dropped == FEATURE_COUNT


def test_the_provider_is_named_on_every_record_and_the_union_fills_the_rest(
    payload: bytes,
) -> None:
    for vessel in _parse(payload).records:
        assert vessel.source == SOURCE_NAME
        assert vessel.providers == ()


def test_one_record_per_mmsi(payload: bytes) -> None:
    records = _parse(payload).records
    assert len({v.mmsi for v in records}) == len(records)


def test_the_positions_are_in_the_eastern_baltic(payload: bytes) -> None:
    """The coverage this provider exists for: the Gulf of Finland and south to Latvia."""
    for vessel in _parse(payload).records:
        assert 19.0 <= vessel.point.lon <= 30.0
        assert 56.0 <= vessel.point.lat <= 61.0
        assert vessel.point.altitude_m is None


# ---------------------------------------------------------------- trap 1: the projection


def test_a_response_in_the_estonian_grid_is_refused_rather_than_reprojected() -> None:
    """Trap 1, and the sharpest failure here.

    Without ``outSR=4326`` the service answers in EPSG:3301, Estonian grid metres, where a
    berth reads ``x: 466890.13, y: 6529584.57``. Those are not degrees. Refusing is deliberate:
    this project's rule is that Cesium owns all projection, so an adapter that reprojected
    would be the only coordinate maths in the tree and a subtle error there returns a valid
    answer about the wrong place.
    """
    parsed = _parse(_envelope(_feature(x=466890.13, y=6529584.5715), wkid=ESTONIAN_GRID_WKID))
    assert not parsed.records
    reason = (
        f"response is in EPSG:{ESTONIAN_GRID_WKID}, not EPSG:{WGS84_WKID}; refusing to reproject"
    )
    assert parsed.drops[reason] == 1


def test_a_response_with_no_spatial_reference_is_refused() -> None:
    """Absent is not the same as 4326. A server that stops declaring it must fail loudly."""
    body = json.dumps({"features": [_feature()], "geometryType": "esriGeometryPoint"}).encode()
    parsed, _ = parse_features(body, now=CAPTURE_TIME)
    assert not parsed.records
    assert parsed.dropped == 1


def test_the_committed_body_is_in_wgs84() -> None:
    """So the refusal tests above are guarding a real request parameter."""
    assert fixture_json(FIXTURE)["spatialReference"]["latestWkid"] == WGS84_WKID


@respx.mock(assert_all_called=True)
async def test_every_request_asks_for_wgs84(
    respx_mock: respx.Router, client: TranspordiametClient, payload: bytes
) -> None:
    """Trap 1 from the request side, which is the only place the fix is visible."""
    route = respx_mock.get(QUERY_URL).respond(200, content=payload)

    await client.all_vessels()

    params = route.calls[-1].request.url.params
    assert params["outSR"] == str(WGS84_WKID)
    assert params["f"] == "json"
    assert params["where"] == "1=1"
    assert params["returnGeometry"] == "true"


def test_x_is_longitude_and_y_is_latitude() -> None:
    """No swap: in 4326 the service puts longitude in ``x``, which matches our rule.

    Confirmed off the live body independently of the field names: longitudes ran 19.68 to
    29.41 and latitudes 56.98 to 60.71, and a latitude of 29 is Egypt.
    """
    parsed = _parse(_envelope(_feature(x=24.7, y=59.4)))
    assert parsed.records[0].point.lon == pytest.approx(24.7)
    assert parsed.records[0].point.lat == pytest.approx(59.4)


@pytest.mark.parametrize(("x", "y"), [(None, 59.4), (24.7, None), (None, None)])
def test_an_incomplete_geometry_is_dropped(x: float | None, y: float | None) -> None:
    parsed = _parse(_envelope(_feature(x=x, y=y)))
    assert parsed.drops["feature carried no usable geometry"] == 1


def test_a_missing_geometry_is_dropped_rather_than_raising() -> None:
    feature = _feature()
    del feature["geometry"]
    parsed = _parse(_envelope(feature))
    assert parsed.drops["feature carried no usable geometry"] == 1


# ---------------------------------------------------------------- trap 2: sys_timestamp


def test_the_constant_sys_timestamp_is_in_the_bytes_and_never_read(payload: bytes) -> None:
    """Trap 2. Every record carries ``-2209161600000``, which is 1 January 1900.

    Read as the observation time it dates the whole feed to 1900 and every vessel then loses
    every recency contest in the union. The field is deliberately absent from the wire model,
    so this asserts the consequence: no record is dated anywhere near 1900.
    """
    raw = {a["attributes"]["sys_timestamp"] for a in fixture_json(FIXTURE)["features"]}
    assert raw == {SYS_TIMESTAMP_SENTINEL}
    for vessel in _parse(payload).records:
        assert vessel.observed_at.year == 2026


def test_the_real_fix_time_comes_from_timestamp(payload: bytes) -> None:
    """A 13-digit millisecond epoch, and ``observed_at - position_age_s`` recovers it."""
    raw = {
        a["attributes"]["mmsi"]: a["attributes"]["timestamp"]
        for a in fixture_json(FIXTURE)["features"]
    }
    for vessel in _parse(payload).records:
        fixed_at = vessel.observed_at - timedelta(seconds=vessel.position_age_s)
        assert fixed_at == datetime.fromtimestamp(raw[vessel.mmsi] / 1000.0, tz=UTC)


@pytest.mark.parametrize("millis", [SYS_TIMESTAMP_SENTINEL, 0, 1787481437, -1])
def test_a_value_that_is_not_a_millisecond_epoch_is_refused(millis: int) -> None:
    """The magnitude floor is what stops trap 2 becoming a silent 1900.

    1787481437 is the same instant in **seconds**, which is a plausible-looking number and a
    1970 date. It is dropped rather than reinterpreted.
    """
    parsed = _parse(_envelope(_feature(timestamp=millis)))
    assert not parsed.records
    assert parsed.drops["timestamp is not a usable millisecond epoch"] == 1


def test_an_unrepresentable_epoch_is_dropped_rather_than_raising() -> None:
    """A nonsense figure must not escape as an OverflowError and kill the whole poll.

    The magnitude floor catches a value that is too small; this is the other end. Nothing on
    the live feed came near it, so this is the guard rather than an observed defect.
    """
    parsed = _parse(_envelope(_feature(timestamp=10**18)))
    assert not parsed.records
    assert parsed.drops["timestamp is not a usable millisecond epoch"] == 1


def test_a_feature_with_no_attributes_is_dropped_rather_than_raising() -> None:
    feature = _feature()
    del feature["attributes"]
    parsed = _parse(_envelope(feature))
    assert not parsed.records
    assert parsed.drops["record does not match the shape this endpoint sends"] == 1


def test_a_record_with_no_timestamp_is_dropped_rather_than_dated_to_now() -> None:
    parsed = _parse(_envelope(_feature(timestamp=None)))
    assert parsed.drops["no timestamp, so the fix has no time"] == 1


def test_a_fix_dated_ahead_of_our_clock_is_dropped() -> None:
    ahead = CAPTURE_TIME + timedelta(seconds=MAX_FIX_TIME_AHEAD_SECONDS + 30)
    parsed = _parse(_envelope(_feature(timestamp=int(ahead.timestamp() * 1000))))
    assert not parsed.records
    assert parsed.drops["timestamp is dated ahead of our own clock"] == 1


def test_a_fix_inside_the_clock_skew_allowance_is_kept() -> None:
    ahead = CAPTURE_TIME + timedelta(seconds=MAX_FIX_TIME_AHEAD_SECONDS - 1)
    parsed = _parse(_envelope(_feature(timestamp=int(ahead.timestamp() * 1000))))
    assert len(parsed.records) == 1
    assert parsed.records[0].position_age_s == 0.0


def test_the_position_age_is_never_negative(payload: bytes) -> None:
    for vessel in _parse(payload).records:
        assert vessel.position_age_s >= 0.0
        assert vessel.observed_at.utcoffset() == timedelta(0)


# ---------------------------------------------------------------- trap 3: error in a 200


def test_an_arcgis_error_inside_a_200_is_a_loud_failure() -> None:
    """Trap 3. ``raise_for_status`` passes and a reader gets a KeyError or "no ships here"."""
    body = json.dumps(
        {
            "error": {
                "code": 500,
                "message": "Field name 'NOT_A_COLUMN' does not exist.",
                "details": [],
            }
        }
    ).encode()
    with pytest.raises(SourceError, match="ArcGIS error 500"):
        parse_features(body)


def test_a_body_with_neither_features_nor_an_error_is_a_loud_failure() -> None:
    with pytest.raises(SourceError, match="neither"):
        parse_features(b"{}")


def test_a_body_that_is_not_json_raises() -> None:
    with pytest.raises(ContractViolationError):
        parse_features(b"not json at all")


def test_one_junk_feature_does_not_reject_the_whole_body() -> None:
    """Per-feature validation, so one bad record cannot empty the layer."""
    features = fixture_json(FIXTURE)["features"]
    parsed, _ = parse_features(
        _envelope("not an object", *features, {"attributes": "wrong"}), now=CAPTURE_TIME
    )
    assert len(parsed.records) == VESSEL_COUNT
    assert parsed.drops["record does not match the shape this endpoint sends"] == 2


def test_an_empty_feature_array_parses_to_nothing_without_raising() -> None:
    parsed, more = parse_features(_envelope())
    assert not parsed.records
    assert parsed.dropped == 0
    assert more is False


# ---------------------------------------------------------------- trap 4: identity and units


def test_the_mmsi_arrives_as_a_string_and_is_not_padded(payload: bytes) -> None:
    """All 627 live records carried a nine-character string, so nothing is invented."""
    raw = {a["attributes"]["mmsi"] for a in fixture_json(FIXTURE)["features"]}
    assert all(isinstance(m, str) and len(m) == 9 for m in raw)
    assert {v.mmsi for v in _parse(payload).records} <= raw


@pytest.mark.parametrize(
    ("mmsi", "reason"),
    [
        ("999999999", "MMSI is a unallocated, not a ship station"),
        ("111257514", "MMSI is a sar_aircraft, not a ship station"),
        ("2320212", "MMSI is not nine digits"),
        ("23094165", "MMSI is not nine digits"),
        ("23094165x", "MMSI is not nine digits"),
        ("", "MMSI is not nine digits"),
        (None, "MMSI is not nine digits"),
    ],
)
def test_only_a_nine_digit_ship_station_mmsi_reaches_the_domain(
    mmsi: str | None, reason: str
) -> None:
    """A short value is refused rather than padded: padding would invent an identity.

    That differs from the other adapters here on purpose, because this feed sends the MMSI as
    a string. There is no numeric value to zero-pad and a nine-character string is what the
    provider promises.
    """
    parsed = _parse(_envelope(_feature(mmsi=mmsi)))
    assert not parsed.records
    assert parsed.drops[reason] == 1


def test_the_non_vessel_stations_in_the_body_are_dropped_by_category(payload: bytes) -> None:
    """An EPIRB-AIS beacon and an unallocated MID, both real records in the capture."""
    drops = _parse(payload).drops
    assert drops["MMSI is a epirb_ais, not a ship station"] == 1
    assert drops["MMSI is a unallocated, not a ship station"] == 1


@pytest.mark.parametrize("draught", [0.5, 4.7, 16.3, 25.5])
def test_draught_is_metres_on_this_endpoint(draught: float) -> None:
    """Trap 4. Metres here, decimetres on Digitraffic's ``/api/ais/v1/vessels``.

    Measured 0 to 16.3 on the live body, which is a laden bulk carrier. Read as decimetres the
    deepest ship in the Gulf of Finland would draw 1.63 m.
    """
    parsed = _parse(_envelope(_feature(draught=draught)))
    assert parsed.records[0].draught_m == pytest.approx(draught)


@pytest.mark.parametrize(
    ("field", "attribute"), [("draught", "draught_m"), ("length", "length_m"), ("width", "beam_m")]
)
def test_a_zero_dimension_is_not_available_rather_than_a_zero_metre_ship(
    field: str, attribute: str
) -> None:
    """``draught`` 0 on 29 of 627, ``length`` on 19, ``width`` on 20."""
    parsed = _parse(_envelope(_feature(**{field: 0})))
    assert getattr(parsed.records[0], attribute) is None


@pytest.mark.parametrize(
    ("field", "attribute", "value"),
    [("draught", "draught_m", 99.0), ("length", "length_m", 5000), ("width", "beam_m", 400)],
)
def test_a_dimension_past_its_bound_empties_one_field_and_keeps_the_ship(
    field: str, attribute: str, value: float
) -> None:
    parsed = _parse(_envelope(_feature(**{field: value})))
    assert parsed.dropped == 0
    assert getattr(parsed.records[0], attribute) is None


def test_the_width_field_becomes_the_beam() -> None:
    """Called ``width`` here and ``breadth`` on Kystdatahuset. Same measurement, two names."""
    parsed = _parse(_envelope(_feature(width=34)))
    assert parsed.records[0].beam_m == pytest.approx(34.0)


# ---------------------------------------------------------------- the ETA


def test_the_eta_is_a_real_epoch_and_is_decoded_without_its_year() -> None:
    """The one place this feed carries more than the domain can hold.

    Every other AIS source sends the 20-bit packed ETA, which has no year at all, so
    ``VesselEta`` has no year field. This feed sends a millisecond epoch. The year is dropped
    deliberately, so the field means the same thing whichever provider filled it.
    """
    when = datetime(2026, 5, 21, 14, 30, tzinfo=UTC)
    parsed = _parse(_envelope(_feature(eta=int(when.timestamp() * 1000))))
    eta = parsed.records[0].eta
    assert eta is not None
    assert (eta.month, eta.day, eta.hour, eta.minute) == (5, 21, 14, 30)


@pytest.mark.parametrize("eta", [None, 0, 1596])
def test_an_absent_or_unusable_eta_becomes_none(eta: int | None) -> None:
    """``null`` is a real value on this feed, and a small integer is not an epoch."""
    parsed = _parse(_envelope(_feature(eta=eta)))
    assert parsed.records[0].eta is None


# ---------------------------------------------------------------- sentinels


@pytest.mark.parametrize(
    ("cog", "expected"), [(0.0, 0.0), (92.5, 92.5), (359.9, 359.9), (360.0, None), (511.0, None)]
)
def test_course_over_ground_maps_its_sentinel_before_its_range(
    cog: float, expected: float | None
) -> None:
    """360 on 97 of 627 records, and 0 is a real course due north."""
    parsed = _parse(_envelope(_feature(cog=cog)))
    assert parsed.records[0].course_over_ground_deg == expected


@pytest.mark.parametrize(
    ("heading", "expected"), [(0, 0.0), (352, 352.0), (359, 359.0), (360, None), (511, None)]
)
def test_true_heading_maps_its_own_sentinel(heading: int, expected: float | None) -> None:
    """511 on 178 of 627 records."""
    parsed = _parse(_envelope(_feature(true_heading=heading)))
    assert parsed.records[0].true_heading_deg == expected


def test_the_speed_sentinel_maps_to_none_and_keeps_the_vessel() -> None:
    """102.3 knots is not-available. Two live records carried it."""
    parsed = _parse(_envelope(_feature(sog=102.3)))
    assert parsed.records[0].speed_over_ground_mps is None


def test_a_real_speed_is_converted_from_knots() -> None:
    parsed = _parse(_envelope(_feature(sog=12.5)))
    assert parsed.records[0].speed_over_ground_mps == pytest.approx(
        12.5 * KNOTS_TO_METRES_PER_SECOND
    )


@pytest.mark.parametrize(
    ("imo", "expected"),
    [
        ("8912778", 8912778),
        ("0", None),
        ("", None),
        (None, None),
        ("912974400", None),
        ("not-a-number", None),
    ],
)
def test_the_imo_is_parsed_from_a_string(imo: str | None, expected: int | None) -> None:
    """A string on this feed where every other provider sends an int.

    Absent, empty or ``"0"`` on 219 of 627 live records, which is a third of the feed.
    """
    parsed = _parse(_envelope(_feature(imo=imo)))
    assert parsed.records[0].imo == expected


@pytest.mark.parametrize(("ship_type", "expected"), [(0, None), (30, 30), (99, 99), (200, None)])
def test_the_ship_type_sentinel_maps_to_none(ship_type: int, expected: int | None) -> None:
    """Called ``type_and_cargo`` here and ``shipType`` on Digitraffic. 0 on 14 of 627."""
    parsed = _parse(_envelope(_feature(type_and_cargo=ship_type)))
    assert parsed.records[0].ship_type == expected


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (0, NavigationalStatus.UNDER_WAY_USING_ENGINE),
        (5, NavigationalStatus.MOORED),
        (9, None),
        (15, None),
    ],
)
def test_navigational_status_leaves_undefined_and_reserved_empty(
    status: int, expected: NavigationalStatus | None
) -> None:
    parsed = _parse(_envelope(_feature(nav_status=status)))
    assert parsed.records[0].navigational_status == expected


def test_empty_and_null_text_both_become_none() -> None:
    """``name`` empty on 6 of 627, ``destination`` on 147. Some fields send a real null."""
    for blank in ("", "   ", None):
        parsed = _parse(_envelope(_feature(name=blank, callsign=blank, destination=blank)))
        vessel = parsed.records[0]
        assert vessel.name is None
        assert vessel.call_sign is None
        assert vessel.destination is None


def test_long_text_is_truncated_rather_than_dropping_the_ship() -> None:
    parsed = _parse(_envelope(_feature(destination="A" * 60, callsign="B" * 20)))
    assert parsed.records[0].destination == "A" * 20
    assert parsed.records[0].call_sign == "B" * 7


def test_no_rate_of_turn_is_invented(payload: bytes) -> None:
    """The endpoint sends none, and a rate computed from two fixes is our arithmetic."""
    assert all(v.rate_of_turn_deg_per_min is None for v in _parse(payload).records)


def test_a_coordinate_outside_wgs84_is_dropped_and_counted() -> None:
    parsed = _parse(_envelope(_feature(x=200.0)))
    assert not parsed.records
    assert parsed.drops["failed the vessel contract"] == 1


# ---------------------------------------------------------------- paging


def test_the_transfer_limit_flag_is_reported_back(payload: bytes) -> None:
    """Paging is the client's job, so the parser only reports what the server said."""
    assert _more(payload) is False
    assert _more(_envelope(_feature(), exceeded=True)) is True


@respx.mock(assert_all_called=True)
async def test_the_client_pages_until_the_server_says_there_is_no_more(
    respx_mock: respx.Router, client: TranspordiametClient
) -> None:
    """``maxRecordCount`` is 1,000 and the count was 627, so one page covers it today.

    A feed that grew past a thousand on a busy day would silently truncate without this, so
    the loop is asserted rather than left as a latent branch.
    """
    first = _envelope(_feature(mmsi="230941650"), exceeded=True)
    second = _envelope(_feature(mmsi="276659000"), exceeded=False)
    route = respx_mock.get(QUERY_URL).mock(
        side_effect=[httpx.Response(200, content=first), httpx.Response(200, content=second)]
    )

    vessels = await client.all_vessels()

    assert {v.mmsi for v in vessels.records} == {"230941650", "276659000"}
    assert route.call_count == 2
    offsets = [call.request.url.params["resultOffset"] for call in route.calls]
    assert offsets == ["0", str(MAX_RECORDS_PER_PAGE)]


@respx.mock(assert_all_called=True)
async def test_a_server_that_always_says_there_is_more_does_not_spin(
    respx_mock: respx.Router, client: TranspordiametClient
) -> None:
    """The backstop. Twenty pages is far above any real answer and far below a runaway."""
    route = respx_mock.get(QUERY_URL).respond(200, content=_envelope(_feature(), exceeded=True))

    vessels = await client.all_vessels()

    assert route.call_count == 20
    assert len(vessels.records) == 1, "the same MMSI twenty times is still one ship"


@respx.mock(assert_all_called=True)
async def test_drops_are_summed_across_pages(
    respx_mock: respx.Router, client: TranspordiametClient
) -> None:
    """A count that reset per page would under-report on any feed that needed two."""
    bad = _envelope(_feature(mmsi="999999999"), _feature(mmsi="230941650"), exceeded=True)
    good = _envelope(_feature(mmsi="276659000"), exceeded=False)
    respx_mock.get(QUERY_URL).mock(
        side_effect=[httpx.Response(200, content=bad), httpx.Response(200, content=good)]
    )

    vessels = await client.all_vessels()

    assert len(vessels.records) == 2
    assert vessels.dropped == 1


# ---------------------------------------------------------------- the client


def test_the_cadence_floor_is_in_code_and_not_configurable(
    client: TranspordiametClient,
) -> None:
    assert client.min_interval_seconds == MIN_INTERVAL_SECONDS
    assert MIN_INTERVAL_SECONDS == 60.0
    assert client.name == SOURCE_NAME


def test_the_licence_is_recorded_as_unstated_rather_than_assumed() -> None:
    """``copyrightText`` is empty and there is no terms page. Verified absent, not inferred."""
    assert "Not stated" in LICENCE
    assert "Transpordiamet" in ATTRIBUTION


@respx.mock(assert_all_called=True)
async def test_it_fetches_keyless_with_no_credential_of_any_kind(
    respx_mock: respx.Router, client: TranspordiametClient, payload: bytes
) -> None:
    """The portal declares token-based security for its admin. This query needs none."""
    route = respx_mock.get(QUERY_URL).respond(200, content=payload)

    vessels = await client.all_vessels()

    assert len(vessels.records) == VESSEL_COUNT
    request = route.calls[-1].request
    assert "authorization" not in request.headers
    assert "token" not in request.url.params
    assert "x-api-key" not in request.headers


@respx.mock(assert_all_called=True)
async def test_an_empty_answer_is_a_failed_poll_and_never_an_empty_sea(
    respx_mock: respx.Router, client: TranspordiametClient
) -> None:
    respx_mock.get(QUERY_URL).respond(200, content=_envelope())

    with pytest.raises(SourceError, match="never as an empty sea"):
        await client.all_vessels()


@respx.mock(assert_all_called=True)
async def test_an_arcgis_error_reaches_the_caller_as_a_source_error(
    respx_mock: respx.Router, client: TranspordiametClient
) -> None:
    respx_mock.get(QUERY_URL).respond(
        200, content=json.dumps({"error": {"code": 400, "message": "bad"}}).encode()
    )

    with pytest.raises(SourceError, match="ArcGIS error"):
        await client.all_vessels()


@respx.mock(assert_all_called=True)
async def test_a_server_error_is_raised_for_the_union_to_record(
    respx_mock: respx.Router, client: TranspordiametClient
) -> None:
    respx_mock.get(QUERY_URL).respond(503)

    with pytest.raises(httpx.HTTPStatusError):
        await client.all_vessels()


# ---------------------------------------------------------------- honouring a backoff


@respx.mock(assert_all_called=True)
async def test_a_throttling_response_becomes_a_rate_limited_error(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    respx_mock.get(QUERY_URL).respond(429, headers={"Retry-After": "300"})

    with pytest.raises(RateLimitedError) as caught:
        await TranspordiametClient(http, clock=Clock()).all_vessels()

    assert caught.value.retry_after_seconds == 300.0


@respx.mock(assert_all_called=True)
async def test_a_throttled_provider_is_not_asked_again_inside_its_own_backoff(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    clock = Clock()
    route = respx_mock.get(QUERY_URL).respond(429, headers={"Retry-After": "300"})
    client = TranspordiametClient(http, clock=clock)

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
    clock = Clock()
    respx_mock.get(QUERY_URL).mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "300"}),
            httpx.Response(200, content=payload),
        ]
    )
    client = TranspordiametClient(http, clock=clock)

    with pytest.raises(RateLimitedError):
        await client.all_vessels()
    clock.advance(301.0)

    assert len((await client.all_vessels()).records) == VESSEL_COUNT


@respx.mock(assert_all_called=True)
async def test_a_cooldown_survives_a_restart(
    respx_mock: respx.Router, http: httpx.AsyncClient, tmp_path: Path
) -> None:
    """A fresh process must not open by hammering a provider that refused."""
    clock = Clock()
    cache = DiskCache(tmp_path, clock=clock)
    route = respx_mock.get(QUERY_URL).respond(429, headers={"Retry-After": "300"})

    with pytest.raises(RateLimitedError):
        await TranspordiametClient(http, cache=cache, clock=clock).all_vessels()
    clock.advance(60.0)
    with pytest.raises(RateLimitedError):
        await TranspordiametClient(http, cache=cache, clock=clock).all_vessels()

    assert route.call_count == 1
    assert cache.get_time(f"{SOURCE_NAME}:not_before") == CAPTURE_TIME + timedelta(seconds=300)


@respx.mock(assert_all_called=True)
async def test_a_longer_cooldown_is_never_shortened_by_a_later_one(
    respx_mock: respx.Router, http: httpx.AsyncClient, tmp_path: Path
) -> None:
    clock = Clock()
    cache = DiskCache(tmp_path, clock=clock)
    respx_mock.get(QUERY_URL).mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "600"}),
            httpx.Response(429, headers={"Retry-After": "10"}),
        ]
    )
    client = TranspordiametClient(http, cache=cache, clock=clock)

    with pytest.raises(RateLimitedError):
        await client.all_vessels()
    clock.advance(601.0)
    with pytest.raises(RateLimitedError):
        await client.all_vessels()

    assert cache.get_time(f"{SOURCE_NAME}:not_before") == clock.now + timedelta(seconds=10)


@respx.mock(assert_all_called=True)
async def test_a_throttling_response_with_no_retry_after_gets_the_safe_default(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    respx_mock.get(QUERY_URL).respond(429)

    with pytest.raises(RateLimitedError) as caught:
        await TranspordiametClient(http, clock=Clock()).all_vessels()

    assert caught.value.retry_after_seconds == 120.0


@respx.mock(assert_all_called=True)
async def test_the_persistence_is_opt_in_and_nothing_is_written_without_a_cache(
    respx_mock: respx.Router, http: httpx.AsyncClient, tmp_path: Path
) -> None:
    clock = Clock()
    route = respx_mock.get(QUERY_URL).respond(429, headers={"Retry-After": "300"})
    client = TranspordiametClient(http, clock=clock)

    with pytest.raises(RateLimitedError):
        await client.all_vessels()
    with pytest.raises(RateLimitedError):
        await client.all_vessels()

    assert route.call_count == 1
    assert not (tmp_path / FILE_NAME).exists()
