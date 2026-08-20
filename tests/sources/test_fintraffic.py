"""The Fintraffic Digitraffic vessel adapter, driven by the real captured bodies.

Every fixture here is a genuine response from ``meri.digitraffic.fi`` on 2026-08-19. No
network: respx intercepts at the transport, and ``assert_all_called=True`` means a test that
believes it exercised a path but did not is a failure rather than a false pass.

Five traps get disproportionate attention because each one produces wrong output rather than
an error, so nothing fails and nobody notices: the two identically named timestamp fields
that mean opposite things, the 24-hour default window, the silently ignored ``bbox``, and the
HTTP 406 the host answers without a gzip header.
"""

import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
import respx

from tests.conftest import fixture_bytes, fixture_json
from tracker.contracts.base import ContractViolationError
from tracker.contracts.geo import KNOTS_TO_METRES_PER_SECOND, BoundingBox
from tracker.contracts.vessel import NavigationalStatus
from tracker.sources.base import RateLimitedError, SourceError
from tracker.sources.fintraffic import (
    ATTRIBUTION,
    BASE_URL,
    DEFAULT_WINDOW_SECONDS,
    DIGITRAFFIC_USER_HEADER,
    LOCATIONS_PATH,
    MAX_FIX_TIME_AHEAD_SECONDS,
    MIN_INTERVAL_SECONDS,
    SOURCE_NAME,
    VESSELS_PATH,
    FintrafficClient,
    parse_locations,
    parse_static,
)

LOCATIONS_URL = f"{BASE_URL}{LOCATIONS_PATH}"
VESSELS_URL = f"{BASE_URL}{VESSELS_PATH}"

FEATURE_COUNT = 110
"""Features in the captured ``/api/ais/v1/locations`` body."""

VESSEL_COUNT = 109
"""Usable vessels out of those 110. The one dropped is MMSI 111265584, a real SAR aircraft."""

SAR_AIRCRAFT_MMSI = "111265584"
"""LIFEGUARD 004, callsign SE JRK, in the live vessel body doing helicopter speeds."""

PLACEHOLDER_MMSI = 999999999
""""NATO WARSHIP" on the live feed. 999 is not an allocated ITU MID, so it is not an identity."""

STATIC_COUNT = 93
"""Records in the captured ``/api/ais/v1/vessels`` body, all with distinct MMSI."""

JOINED_COUNT = 15
"""Vessels that had both a position and a static record. The two fixtures were sliced
independently from the live bodies, so the overlap is small by construction: the point being
asserted is that a partial join is normal rather than an error."""

COG_UNAVAILABLE = 14
SOG_UNAVAILABLE = 5
HEADING_UNAVAILABLE = 15
ROT_UNAVAILABLE = 25
"""15 records at -128 plus 7 at +127 and 3 at -127. The last two are "turning faster than 5
degrees per 30 seconds with no rate given", which is not a rate and does not become one."""
NAV_STATUS_UNAVAILABLE = 6

REFERENCE_NOW = datetime(2026, 8, 19, 12, 0, 0, tzinfo=UTC)
"""A fixed instant on a whole minute, so the quantised ``from`` window is exact."""


def _clock() -> datetime:
    return REFERENCE_NOW


def _feature(mmsi: int = 230992610, **properties: Any) -> dict[str, Any]:
    """One position feature in the shape the live feed sends. ``None`` removes a key."""
    props: dict[str, Any] = {
        "mmsi": mmsi,
        "sog": 8.4,
        "cog": 143.2,
        "navStat": 0,
        "rot": 0,
        "posAcc": False,
        "raim": True,
        "heading": 143,
        "timestamp": 27,
        "timestampExternal": 1787179287522,
    }
    props.update(properties)
    return {
        "mmsi": mmsi,
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [22.216732, 60.432413]},
        "properties": {key: value for key, value in props.items() if value is not None},
    }


def _envelope(*features: dict[str, Any], data_updated_time: str = "2026-08-19T22:42:53Z") -> bytes:
    payload = {
        "type": "FeatureCollection",
        "dataUpdatedTime": data_updated_time,
        "features": list(features),
    }
    return json.dumps(payload).encode()


def _static(mmsi: int = 230992610, **overrides: Any) -> dict[str, Any]:
    """One static record in the shape the live feed sends. ``None`` removes a key."""
    record: dict[str, Any] = {
        "mmsi": mmsi,
        "name": "TEST VESSEL",
        "callSign": "OJ1234",
        "destination": "HELSINKI",
        "imo": 9876543,
        "draught": 49,
        "eta": 562112,
        "shipType": 70,
        "posType": 1,
        "referencePointA": 100,
        "referencePointB": 20,
        "referencePointC": 8,
        "referencePointD": 9,
        "timestamp": 1787179211603,
    }
    record.update(overrides)
    return {key: value for key, value in record.items() if value is not None}


def _statics(*records: dict[str, Any]) -> bytes:
    return json.dumps(list(records)).encode()


@pytest.fixture
def locations_payload() -> bytes:
    """Live ``/api/ais/v1/locations`` body, 110 features, captured 2026-08-19."""
    return fixture_bytes("digitraffic_ais_locations_live.json")


@pytest.fixture
def statics_payload() -> bytes:
    """Live ``/api/ais/v1/vessels`` body, 93 static records, captured 2026-08-19."""
    return fixture_bytes("digitraffic_ais_vessels_live.json")


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    """A real httpx client. respx intercepts at the transport, so nothing leaves the process."""
    async with httpx.AsyncClient() as client:
        yield client


@pytest.fixture
def client(http: httpx.AsyncClient) -> FintrafficClient:
    return FintrafficClient(http, digitraffic_user="tracker/0.1 test@example.com", clock=_clock)


def _mock_both(router: respx.Router, locations: bytes, statics: bytes) -> None:
    router.get(VESSELS_URL).respond(200, content=statics)
    router.get(LOCATIONS_URL).respond(200, content=locations)


# ---------------------------------------------------------------- real payloads


def test_parses_the_live_locations_body(locations_payload: bytes) -> None:
    vessels = parse_locations(locations_payload)
    assert len(vessels) == VESSEL_COUNT
    assert {vessel.source for vessel in vessels} == {SOURCE_NAME}
    assert all(vessel.kind == "vessel" for vessel in vessels)
    assert all(vessel.point.altitude_m is None for vessel in vessels)


def test_one_record_per_mmsi_across_the_live_body(locations_payload: bytes) -> None:
    """ADR 010 makes MMSI the merge key, so a duplicate here is a phantom ship."""
    vessels = parse_locations(locations_payload)
    assert len({vessel.mmsi for vessel in vessels}) == len(vessels)


def test_coordinates_are_longitude_then_latitude(locations_payload: bytes) -> None:
    """The feed already agrees with our rule, so the bug would be swapping them anyway.

    The live capture is Finland and the Baltic. A latitude of 32 there is impossible, which
    is what makes this assertion meaningful rather than circular.
    """
    vessels = parse_locations(locations_payload)
    assert all(16.0 < vessel.point.lon < 33.0 for vessel in vessels)
    assert all(57.0 < vessel.point.lat < 66.0 for vessel in vessels)


def test_parses_the_live_static_body(statics_payload: bytes) -> None:
    statics = parse_static(statics_payload)
    assert len(statics) == STATIC_COUNT
    assert all(len(mmsi) == 9 for mmsi in statics)


def test_sentinels_map_to_none_over_the_live_body(locations_payload: bytes) -> None:
    """Every AIS not-available value becomes ``None`` rather than a plausible number."""
    vessels = parse_locations(locations_payload)
    assert sum(v.course_over_ground_deg is None for v in vessels) == COG_UNAVAILABLE
    assert sum(v.speed_over_ground_mps is None for v in vessels) == SOG_UNAVAILABLE
    assert sum(v.true_heading_deg is None for v in vessels) == HEADING_UNAVAILABLE
    assert sum(v.rate_of_turn_deg_per_min is None for v in vessels) == ROT_UNAVAILABLE
    assert sum(v.navigational_status is None for v in vessels) == NAV_STATUS_UNAVAILABLE


def test_a_course_of_zero_is_a_real_course_due_north() -> None:
    """The sentinel is 360.0. Checking the bearing bound first drops 110 real live records."""
    vessels = parse_locations(_envelope(_feature(cog=0.0)))
    assert vessels[0].course_over_ground_deg == 0.0


def test_the_static_body_sentinels_map_to_none(statics_payload: bytes) -> None:
    statics = parse_static(statics_payload)
    assert sum(s.imo is not None for s in statics.values()) == 68
    assert sum(s.draught_m is not None for s in statics.values()) == 78
    assert all(s.imo is None or 1_000_000 <= s.imo <= 9_999_999 for s in statics.values())


# ---------------------------------------------------------------- trap 1


def test_position_time_comes_from_timestamp_external_not_timestamp(
    locations_payload: bytes,
) -> None:
    """Trap 1. ``properties.timestamp`` is the AIS second-of-minute, 0 to 63, not an epoch.

    The record picked here carries ``timestamp`` 62, which ITU-R M.1371 defines as "dead
    reckoning". Read as a time it is 1970-01-01T00:01:02Z. The real fix time is
    ``timestampExternal``, a 13-digit millisecond epoch.
    """
    raw = fixture_json("digitraffic_ais_locations_live.json")
    feature = next(f for f in raw["features"] if f["properties"]["timestamp"] >= 60)
    vessel = next(
        v for v in parse_locations(locations_payload) if v.mmsi == f"{feature['mmsi']:09d}"
    )

    fixed_at = vessel.observed_at - timedelta(seconds=vessel.position_age_s)
    expected = datetime.fromtimestamp(feature["properties"]["timestampExternal"] / 1000.0, tz=UTC)
    assert fixed_at == expected
    assert fixed_at.year == 2026


def test_a_second_of_minute_is_never_read_as_a_time() -> None:
    """Trap 1, the other way round. Nothing falls back to ``timestamp`` for a fix time.

    ``timestamp`` here holds a real 13-digit millisecond epoch, which is what the *other*
    endpoint's identically named field means. A parser that shared one timestamp path would
    date this record happily. This one drops it, because it has no fix time.
    """
    payload = _envelope(_feature(timestamp=1787179287522, timestampExternal=None))
    assert parse_locations(payload) == ()


def test_a_fix_time_outside_the_representable_range_is_dropped() -> None:
    payload = _envelope(_feature(timestampExternal=10**20))
    assert parse_locations(payload) == ()


# ---------------------------------------------------------------- trap 2


def test_the_static_timestamp_is_a_millisecond_epoch(statics_payload: bytes) -> None:
    """Trap 2. ``timestamp`` on ``/api/ais/v1/vessels`` is milliseconds, the opposite field.

    Same name, same API version, opposite semantics from ``/api/ais/v1/locations``. The
    provider confirms it in its own documentation, and this is the single most likely thing
    to ship broken.
    """
    raw = fixture_json("digitraffic_ais_vessels_live.json")
    record = max(raw, key=lambda r: r["timestamp"])
    static = parse_static(statics_payload)[f"{record['mmsi']:09d}"]

    assert static.updated_at == datetime.fromtimestamp(record["timestamp"] / 1000.0, tz=UTC)
    assert static.updated_at is not None
    assert static.updated_at.year == 2026


def test_the_newest_static_record_per_mmsi_wins() -> None:
    """Where the window returns a vessel twice, the fresher record supplies the name.

    This is where trap 2 has teeth: the comparison is only right if the field is read as the
    millisecond epoch it is on this endpoint.
    """
    payload = _statics(
        _static(name="OLD NAME", timestamp=1787094154894),
        _static(name="NEW NAME", timestamp=1787179211603),
    )
    assert parse_static(payload)["230992610"].name == "NEW NAME"

    reversed_order = _statics(
        _static(name="NEW NAME", timestamp=1787179211603),
        _static(name="OLD NAME", timestamp=1787094154894),
    )
    assert parse_static(reversed_order)["230992610"].name == "NEW NAME"


def test_a_static_record_with_no_timestamp_loses_to_one_that_has_it() -> None:
    payload = _statics(
        _static(name="UNDATED", timestamp=None),
        _static(name="DATED", timestamp=1787179211603),
    )
    assert parse_static(payload)["230992610"].name == "DATED"


# ---------------------------------------------------------------- trap 3


@respx.mock(assert_all_called=True)
async def test_the_positions_query_sends_an_explicit_from_window(
    respx_mock: respx.Router,
    client: FintrafficClient,
    locations_payload: bytes,
    statics_payload: bytes,
) -> None:
    """Trap 3. The provider's default is 24 hours of history, not a live snapshot.

    A poller that omits ``from`` renders a day of ghost ships parked where they were
    yesterday, which looks exactly like a working layer.
    """
    _mock_both(respx_mock, locations_payload, statics_payload)
    await client.all_vessels()

    request = respx_mock.calls[-1].request
    assert request.url.path == LOCATIONS_PATH
    sent = int(request.url.params["from"])
    expected_ms = int((REFERENCE_NOW.timestamp() - DEFAULT_WINDOW_SECONDS) * 1000)
    assert sent == expected_ms

    window = REFERENCE_NOW - datetime.fromtimestamp(sent / 1000.0, tz=UTC)
    assert window == timedelta(seconds=DEFAULT_WINDOW_SECONDS)
    assert window < timedelta(hours=24)


def test_the_window_cannot_be_configured_below_the_cadence_floor(
    http: httpx.AsyncClient,
) -> None:
    """A window shorter than the poll interval guarantees vessels blink off the globe."""
    narrow = FintrafficClient(http, window_seconds=1.0, clock=_clock)
    assert narrow.window_seconds == MIN_INTERVAL_SECONDS

    wide = FintrafficClient(http, window_seconds=3600.0, clock=_clock)
    assert wide.window_seconds == 3600.0


def test_the_from_window_is_quantised_so_the_etag_can_match(http: httpx.AsyncClient) -> None:
    """Two polls inside one minute ask the identical question, so the second is a 304."""
    offsets = [0.0, 17.0, 59.9]
    values = {
        FintrafficClient(
            http,
            clock=lambda offset=offset: REFERENCE_NOW + timedelta(seconds=offset),  # type: ignore[misc]
        ).window_start_ms()
        for offset in offsets
    }
    assert len(values) == 1

    next_minute = FintrafficClient(
        http, clock=lambda: REFERENCE_NOW + timedelta(seconds=61)
    ).window_start_ms()
    assert next_minute == values.pop() + int(MIN_INTERVAL_SECONDS * 1000)


# ---------------------------------------------------------------- trap 4


@respx.mock(assert_all_called=True)
async def test_a_viewport_query_uses_radius_and_never_bbox(
    respx_mock: respx.Router,
    client: FintrafficClient,
    locations_payload: bytes,
    statics_payload: bytes,
) -> None:
    """Trap 4. ``bbox`` is accepted and silently ignored: it returned all 1,059 features.

    Unknown query parameters are dropped rather than rejected with a 400, so sending one
    fails silently. The real filter is ``radius`` in kilometres with ``latitude`` and
    ``longitude``.
    """
    _mock_both(respx_mock, locations_payload, statics_payload)
    box = BoundingBox(west=24.0, south=59.9, east=25.5, north=60.4)
    await client.vessels_in_box(box)

    params = respx_mock.calls[-1].request.url.params
    assert "bbox" not in params
    assert float(params["latitude"]) == pytest.approx(box.centre.lat)
    assert float(params["longitude"]) == pytest.approx(box.centre.lon)
    assert int(params["radius"]) >= int(box.enclosing_radius_m() / 1000.0)


@respx.mock(assert_all_called=True)
async def test_the_box_filter_is_applied_locally(
    respx_mock: respx.Router, client: FintrafficClient
) -> None:
    """Because the provider ignores the box, this filter is the only thing enforcing it."""
    inside = _feature(mmsi=230992610)
    outside = _feature(mmsi=230078610)
    outside["geometry"]["coordinates"] = [2.35, 48.85]
    _mock_both(respx_mock, _envelope(inside, outside), _statics())

    box = BoundingBox(west=21.0, south=60.0, east=23.0, north=61.0)
    vessels = await client.vessels_in_box(box)
    assert [vessel.mmsi for vessel in vessels] == ["230992610"]


# ---------------------------------------------------------------- trap 5


@respx.mock(assert_all_called=True)
async def test_every_request_asks_for_gzip(
    respx_mock: respx.Router,
    client: FintrafficClient,
    locations_payload: bytes,
    statics_payload: bytes,
) -> None:
    """Trap 5. The host answers HTTP 406 without it, so the header is set per request."""
    _mock_both(respx_mock, locations_payload, statics_payload)
    await client.all_vessels()

    assert len(respx_mock.calls) == 2
    for call in respx_mock.calls:
        assert call.request.headers["accept-encoding"] == "gzip"


@respx.mock(assert_all_called=True)
async def test_a_406_is_a_loud_failure(respx_mock: respx.Router, client: FintrafficClient) -> None:
    """The recorded body says exactly what went wrong, so it travels into the error."""
    body = fixture_bytes("digitraffic_gzip_required_406_live.txt")
    respx_mock.get(VESSELS_URL).respond(200, content=_statics())
    respx_mock.get(LOCATIONS_URL).respond(406, content=body)

    with pytest.raises(SourceError, match="gzip compression is required"):
        await client.all_vessels()


# ---------------------------------------------------------------- the MMSI join


@respx.mock(assert_all_called=True)
async def test_positions_join_static_data_on_mmsi(
    respx_mock: respx.Router,
    client: FintrafficClient,
    locations_payload: bytes,
    statics_payload: bytes,
) -> None:
    _mock_both(respx_mock, locations_payload, statics_payload)
    vessels = await client.all_vessels()

    assert len(vessels) == VESSEL_COUNT
    assert sum(vessel.name is not None for vessel in vessels) == JOINED_COUNT


def test_a_position_with_no_static_record_still_renders(
    locations_payload: bytes, statics_payload: bytes
) -> None:
    """108 of 1,058 live positions had no static record. That is normal, not an error."""
    statics = parse_static(statics_payload)
    vessels = parse_locations(locations_payload, statics)

    unnamed = [vessel for vessel in vessels if vessel.name is None]
    assert len(unnamed) == VESSEL_COUNT - JOINED_COUNT
    sample = unnamed[0]
    assert sample.mmsi not in statics
    assert sample.point.lon != 0.0
    assert (
        sample.call_sign,
        sample.imo,
        sample.destination,
        sample.eta,
        sample.draught_m,
        sample.length_m,
        sample.beam_m,
    ) == (None, None, None, None, None, None, None)


def test_a_static_record_with_no_position_is_not_on_the_globe(
    locations_payload: bytes, statics_payload: bytes
) -> None:
    """A vessel we know the name of but have never seen is not an entity."""
    statics = parse_static(statics_payload)
    vessels = parse_locations(locations_payload, statics)

    rendered = {vessel.mmsi for vessel in vessels}
    unpositioned = set(statics) - rendered
    assert unpositioned
    assert not (unpositioned & rendered)
    assert len(vessels) <= FEATURE_COUNT


def test_static_data_is_optional(locations_payload: bytes) -> None:
    """A failed static call must not empty the layer: positions are the thing on screen."""
    vessels = parse_locations(locations_payload)
    assert len(vessels) == VESSEL_COUNT
    assert all(vessel.name is None for vessel in vessels)


# ---------------------------------------------------------------- identity drops


def test_a_search_and_rescue_aircraft_is_dropped(locations_payload: bytes) -> None:
    """MMSI 111265584 is LIFEGUARD 004, in the live vessel body at helicopter speeds.

    ``111`` is the ITU allocation for SAR aircraft. It has no ICAO 24-bit address so it
    cannot become an aircraft either, and a 36-knot "ship" is exactly what a viewer notices.
    """
    raw = fixture_json("digitraffic_ais_locations_live.json")
    assert any(f["mmsi"] == int(SAR_AIRCRAFT_MMSI) for f in raw["features"])

    vessels = parse_locations(locations_payload)
    assert SAR_AIRCRAFT_MMSI not in {vessel.mmsi for vessel in vessels}
    assert len(vessels) == FEATURE_COUNT - 1


def test_the_placeholder_mmsi_is_dropped_rather_than_merged() -> None:
    """999999999 is a real value on this feed and it is not an identity.

    999 is not an allocated ITU MID, so every ship broadcasting it would merge into one
    record: the count looks right, the one-record-per-MMSI assertion passes, and ships
    disappear.
    """
    junk = fixture_json("digitraffic_ais_vessel_metadata_junk_mmsi_live.json")
    assert junk["mmsi"] == PLACEHOLDER_MMSI

    payload = _envelope(_feature(mmsi=PLACEHOLDER_MMSI), _feature(mmsi=230992610))
    vessels = parse_locations(payload, parse_static(_statics(junk)))
    assert [vessel.mmsi for vessel in vessels] == ["230992610"]
    assert all(vessel.name != "NATO WARSHIP" for vessel in vessels)


def test_a_disagreeing_mmsi_is_dropped() -> None:
    """The MMSI arrives twice. Two copies that disagree are not an identity we can use."""
    feature = _feature(mmsi=230992610)
    feature["properties"]["mmsi"] = 230078610
    assert parse_locations(_envelope(feature)) == ()


@pytest.mark.parametrize("mmsi", [1_000_000_000, 12_345_678_901])
def test_an_mmsi_that_is_not_nine_digits_is_dropped(mmsi: int) -> None:
    assert parse_locations(_envelope(_feature(mmsi=mmsi))) == ()
    assert parse_static(_statics(_static(mmsi=mmsi))) == {}


def test_a_feature_with_no_position_is_dropped() -> None:
    feature = _feature()
    feature["geometry"] = None
    assert parse_locations(_envelope(feature)) == ()

    short = _feature()
    short["geometry"]["coordinates"] = [22.2]
    assert parse_locations(_envelope(short)) == ()


def test_a_feature_with_no_properties_is_dropped() -> None:
    feature = _feature()
    feature["properties"] = None
    assert parse_locations(_envelope(feature)) == ()


def test_a_record_that_fails_the_contract_is_dropped_not_partially_accepted() -> None:
    """A speed above the contract bound means the sentinel was missed, so nothing is kept."""
    payload = _envelope(_feature(sog=101.0), _feature(mmsi=230078610))
    vessels = parse_locations(payload)
    assert [vessel.mmsi for vessel in vessels] == ["230078610"]


# ---------------------------------------------------------------- units and decoding


def test_units_are_converted_in_the_adapter() -> None:
    """Knots to metres per second, decimetres to metres, and dimensions summed."""
    vessels = parse_locations(
        _envelope(_feature(sog=10.0)), parse_static(_statics(_static(draught=49)))
    )
    vessel = vessels[0]
    assert vessel.speed_over_ground_mps == pytest.approx(10.0 * KNOTS_TO_METRES_PER_SECOND)
    assert vessel.draught_m == pytest.approx(4.9)
    assert vessel.length_m == pytest.approx(120.0)
    assert vessel.beam_m == pytest.approx(17.0)


def test_a_rate_of_turn_with_no_rate_is_not_turned_into_one() -> None:
    """+/-127 says "faster than 5 degrees per 30 seconds" without saying how fast."""
    assert parse_locations(_envelope(_feature(rot=127)))[0].rate_of_turn_deg_per_min is None
    assert parse_locations(_envelope(_feature(rot=-127)))[0].rate_of_turn_deg_per_min is None
    turning = parse_locations(_envelope(_feature(rot=20)))[0].rate_of_turn_deg_per_min
    assert turning is not None
    assert 0.0 < turning < 20.0


def test_navigational_status_is_decoded_and_the_reserved_codes_are_empty() -> None:
    assert (
        parse_locations(_envelope(_feature(navStat=5)))[0].navigational_status
        is NavigationalStatus.MOORED
    )
    for code in (9, 10, 13, 15):
        assert parse_locations(_envelope(_feature(navStat=code)))[0].navigational_status is None


def test_the_packed_eta_is_decoded_and_never_becomes_a_datetime() -> None:
    """562112 is 18 August 15:00 for SERENADA on the live body. 1596 means not available."""
    decoded = parse_static(_statics(_static(eta=562112)))["230992610"].eta
    assert decoded is not None
    assert (decoded.month, decoded.day, decoded.hour, decoded.minute) == (8, 18, 15, 0)
    assert parse_static(_statics(_static(eta=1596)))["230992610"].eta is None
    assert parse_static(_statics(_static(eta=0)))["230992610"].eta is None


def test_empty_strings_become_none_rather_than_dropping_the_ship() -> None:
    """``callSign`` is empty on 5 of 950 live records and ``destination`` on 91."""
    static = parse_static(_statics(_static(callSign="", destination="", name="  KEPT  ")))
    assert static["230992610"].call_sign is None
    assert static["230992610"].destination is None
    assert static["230992610"].name == "KEPT"


def test_over_long_text_is_truncated_rather_than_dropping_the_ship() -> None:
    static = parse_static(_statics(_static(name="A" * 40, callSign="B" * 12)))["230992610"]
    assert static.name == "A" * 20
    assert static.call_sign == "B" * 7


def test_a_transponder_with_no_dimensions_reports_none_not_zero_metres() -> None:
    static = parse_static(
        _statics(
            _static(referencePointA=0, referencePointB=0, referencePointC=0, referencePointD=0)
        )
    )["230992610"]
    assert static.length_m is None
    assert static.beam_m is None


# ---------------------------------------------------------------- timestamps


def test_the_age_is_measured_against_the_response_time(locations_payload: bytes) -> None:
    """``observed_at`` minus ``position_age_s`` recovers the fix, so the union can rank it."""
    vessels = parse_locations(locations_payload)
    assert all(vessel.position_age_s >= 0.0 for vessel in vessels)
    assert max(vessel.position_age_s for vessel in vessels) > 3600.0


def test_a_fix_newer_than_the_response_gives_an_age_of_zero() -> None:
    """``dataUpdatedTime`` is per query, not a sweep clock, so it can lag its own contents.

    A filtered call returned a value a full day older than the unfiltered one. A negative age
    would fail the contract and drop the record; treating it as zero keeps it and refuses to
    claim the response predates its own data.
    """
    payload = _envelope(
        _feature(timestampExternal=1787179287522), data_updated_time="2026-08-18T23:43:12Z"
    )
    vessel = parse_locations(payload)[0]
    assert vessel.position_age_s == 0.0
    assert vessel.observed_at == datetime.fromtimestamp(1787179287522 / 1000.0, tz=UTC)


def test_a_naive_response_time_gets_utc_attached_in_the_adapter() -> None:
    vessel = parse_locations(_envelope(_feature(), data_updated_time="2026-08-19T22:42:53"))[0]
    assert vessel.observed_at.tzinfo is not None
    assert vessel.observed_at.utcoffset() == timedelta(0)


# ---------------------------------------------------------------- envelope guards


@pytest.mark.parametrize(
    "payload",
    [
        b"{}",
        b'{"dataUpdatedTime": "2026-08-19T22:42:53Z"}',
        b'{"type": "FeatureCollection", "features": []}',
        b"[]",
        b"not json at all",
    ],
)
def test_an_unrecognisable_locations_envelope_is_a_contract_violation(payload: bytes) -> None:
    """A shape change that parsed to zero vessels would read as a healthy but empty layer."""
    with pytest.raises(ContractViolationError):
        parse_locations(payload)


def test_an_empty_feature_list_is_a_legitimate_answer() -> None:
    """A radius query over open water is allowed to see nothing."""
    assert parse_locations(_envelope()) == ()


@pytest.mark.parametrize("payload", [b"{}", b'{"vessels": []}', b"not json at all"])
def test_an_unrecognisable_static_body_is_a_contract_violation(payload: bytes) -> None:
    with pytest.raises(ContractViolationError):
        parse_static(payload)


# ---------------------------------------------------------------- cadence and caching


def test_the_cadence_floor_is_a_constant_that_configuration_cannot_lower(
    http: httpx.AsyncClient,
) -> None:
    """60 requests a minute per IP, and responses are cached for a minute either way.

    There is no constructor argument, no setting and no keyword that reaches this number, so
    the only way to poll faster is to edit the module.
    """
    import inspect

    assert MIN_INTERVAL_SECONDS == 60.0
    parameters = inspect.signature(FintrafficClient.__init__).parameters
    assert not [name for name in parameters if "interval" in name or "cadence" in name]

    for window in (1.0, 60.0, 86_400.0):
        built = FintrafficClient(http, window_seconds=window, clock=_clock)
        assert built.min_interval_seconds == MIN_INTERVAL_SECONDS
        assert built.name == SOURCE_NAME


@respx.mock(assert_all_called=True)
async def test_an_etag_is_replayed_and_a_304_reuses_the_cached_body(
    respx_mock: respx.Router,
    client: FintrafficClient,
    locations_payload: bytes,
    statics_payload: bytes,
) -> None:
    """A real 304 with an empty body was verified live. It is the cheap way to poll."""
    etag = 'W/"0e03f2cb33cf10fba9567539b09f9d571"'
    respx_mock.get(VESSELS_URL).respond(200, content=statics_payload, headers={"etag": etag})
    respx_mock.get(LOCATIONS_URL).mock(
        side_effect=[
            httpx.Response(200, content=locations_payload, headers={"etag": etag}),
            httpx.Response(304),
        ]
    )

    first = await client.all_vessels()
    second = await client.all_vessels()

    assert first == second
    assert len(first) == VESSEL_COUNT
    assert respx_mock.calls[-1].request.headers["if-none-match"] == etag
    assert respx_mock.calls[-2].request.headers["if-none-match"] == etag


@respx.mock(assert_all_called=True)
async def test_a_304_with_nothing_cached_is_an_error(
    respx_mock: respx.Router, client: FintrafficClient
) -> None:
    """Nothing to serve and no way to know what changed, so it fails rather than empties."""
    respx_mock.get(VESSELS_URL).respond(200, content=_statics())
    respx_mock.get(LOCATIONS_URL).respond(304)
    with pytest.raises(SourceError, match="no cached body"):
        await client.all_vessels()


@respx.mock(assert_all_called=True)
async def test_the_conditional_cache_stays_bounded(
    respx_mock: respx.Router, client: FintrafficClient
) -> None:
    """A viewport that moves every frame must not grow the cache without limit."""
    respx_mock.get(VESSELS_URL).respond(200, content=_statics(), headers={"etag": 'W/"statics"'})
    respx_mock.get(LOCATIONS_URL).respond(
        200, content=_envelope(), headers={"etag": 'W/"locations"'}
    )

    for radius in range(1, 13):
        await client.vessels_near(lat=60.1, lon=24.9, radius_km=radius)
    assert len(client._cache) <= 8


@respx.mock(assert_all_called=True)
async def test_a_429_backs_off_on_the_providers_own_terms(
    respx_mock: respx.Router, client: FintrafficClient
) -> None:
    """The provider states 60 requests a minute per IP and returns 429 above it."""
    respx_mock.get(VESSELS_URL).respond(429, headers={"retry-after": "45"})

    with pytest.raises(RateLimitedError) as caught:
        await client.all_vessels()
    assert caught.value.retry_after_seconds == 45.0
    assert caught.value.source == SOURCE_NAME


@respx.mock(assert_all_called=True)
async def test_a_server_error_is_raised_rather_than_swallowed(
    respx_mock: respx.Router, client: FintrafficClient
) -> None:
    respx_mock.get(VESSELS_URL).respond(200, content=_statics())
    respx_mock.get(LOCATIONS_URL).respond(503)
    with pytest.raises(httpx.HTTPStatusError):
        await client.all_vessels()


# ---------------------------------------------------------------- identification and licence


@respx.mock(assert_all_called=True)
async def test_the_digitraffic_user_header_is_sent_when_configured(
    respx_mock: respx.Router, client: FintrafficClient
) -> None:
    """The provider asks every API user to identify itself and raises the cap in return."""
    _mock_both(respx_mock, _envelope(_feature()), _statics())
    await client.all_vessels()
    header = respx_mock.calls[-1].request.headers[DIGITRAFFIC_USER_HEADER]
    assert header == "tracker/0.1 test@example.com"


@respx.mock(assert_all_called=True)
async def test_an_unconfigured_digitraffic_user_omits_the_header_rather_than_sending_blank(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    _mock_both(respx_mock, _envelope(_feature()), _statics())
    anonymous = FintrafficClient(http, digitraffic_user="   ", clock=_clock)
    await anonymous.all_vessels()
    assert DIGITRAFFIC_USER_HEADER not in respx_mock.calls[-1].request.headers


def test_the_attribution_string_is_exact() -> None:
    """A licence condition, not a nicety. CC BY 4.0 requires this wording."""
    assert ATTRIBUTION == "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY"


@respx.mock(assert_all_called=True)
async def test_the_base_url_is_the_versioned_ais_path(
    respx_mock: respx.Router, client: FintrafficClient
) -> None:
    """The historic unversioned path is a 404. Both paths carry the ``ais/v1`` segment."""
    _mock_both(respx_mock, _envelope(_feature()), _statics())
    await client.all_vessels()
    assert [call.request.url.path for call in respx_mock.calls] == [
        "/api/ais/v1/vessels",
        "/api/ais/v1/locations",
    ]


async def test_a_trailing_slash_on_the_base_url_does_not_double_up(
    http: httpx.AsyncClient,
) -> None:
    built = FintrafficClient(http, base_url=f"{BASE_URL}/", clock=_clock)
    with respx.mock(assert_all_called=True) as router:
        _mock_both(router, _envelope(_feature()), _statics())
        await built.all_vessels()
        assert router.calls[-1].request.url.path == LOCATIONS_PATH


def test_the_default_clock_is_the_wall_clock(http: httpx.AsyncClient) -> None:
    """Without an injected clock the window still tracks real time, not the epoch."""
    built = FintrafficClient(http)
    window_start = datetime.fromtimestamp(built.window_start_ms() / 1000.0, tz=UTC)
    behind = datetime.now(UTC) - window_start
    assert timedelta(seconds=DEFAULT_WINDOW_SECONDS) <= behind < timedelta(hours=1)


def test_a_missing_text_field_is_absent_rather_than_empty() -> None:
    """Every key was present on every live record, so an absent one is a shape change."""
    static = parse_static(_statics(_static(name=None, callSign=None, destination=None)))
    assert static["230992610"].name is None
    assert static["230992610"].call_sign is None
    assert static["230992610"].destination is None


# ---------------------------------------------------------------- per-record validation


def test_one_junk_field_in_one_feature_loses_that_feature_and_nothing_else(
    locations_payload: bytes,
) -> None:
    """The array is validated per record, so a type change on one ship costs one ship.

    ``rot`` is a bare ``int | None`` on the wire model and the live feed sends whole numbers,
    so a fractional one is the cheapest realistic break. Validating the array in one pass
    turned that into a rejected payload, and with no AISHub username and no aisstream key
    Fintraffic is the only vessel provider, so the layer emptied one TTL later.
    """
    raw = fixture_json("digitraffic_ais_locations_live.json")
    raw["features"][5]["properties"]["rot"] = 0.5
    broken = json.dumps(raw).encode()

    assert len(parse_locations(locations_payload)) == VESSEL_COUNT
    assert len(parse_locations(broken)) == VESSEL_COUNT - 1


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(lambda f: f["properties"].__setitem__("heading", "n/a"), id="junk heading"),
        pytest.param(lambda f: f.pop("mmsi"), id="no mmsi"),
        pytest.param(
            lambda f: f["geometry"].__setitem__("coordinates", [None, 60.1]),
            id="null coordinate",
        ),
    ],
)
def test_an_unreadable_feature_is_dropped_and_the_rest_survive(
    locations_payload: bytes, mutate: Any
) -> None:
    raw = fixture_json("digitraffic_ais_locations_live.json")
    mutate(raw["features"][7])
    assert len(parse_locations(json.dumps(raw).encode())) == VESSEL_COUNT - 1


@pytest.mark.parametrize("draught", ["n/a", 5.5], ids=["text", "fractional"])
def test_one_junk_static_record_keeps_the_other_ninety_two(
    statics_payload: bytes, draught: object
) -> None:
    """``draught`` is decimetres and an int on this endpoint, so a decimal is a type break."""
    raw = fixture_json("digitraffic_ais_vessels_live.json")
    raw[4]["draught"] = draught

    assert len(parse_static(statics_payload)) == STATIC_COUNT
    assert len(parse_static(json.dumps(raw).encode())) == STATIC_COUNT - 1


# ---------------------------------------------------------------- the two legs are independent


@respx.mock(assert_all_called=True)
async def test_a_failing_static_endpoint_still_renders_the_positions(
    respx_mock: respx.Router,
    client: FintrafficClient,
    locations_payload: bytes,
) -> None:
    """Positions and static data are two endpoints and only one of them is load-bearing.

    A vessel with a position and no metadata renders with the static fields empty, which was
    the normal case for 108 of 1,058 live positions. Aborting the cycle over a name made the
    only keyless vessel provider contribute nothing at all.
    """
    respx_mock.get(VESSELS_URL).respond(503)
    respx_mock.get(LOCATIONS_URL).respond(200, content=locations_payload)

    vessels = await client.all_vessels()
    assert len(vessels) == VESSEL_COUNT
    assert all(vessel.name is None for vessel in vessels)


@respx.mock(assert_all_called=True)
async def test_a_static_failure_falls_back_to_the_last_static_data_we_hold(
    respx_mock: respx.Router,
    client: FintrafficClient,
    locations_payload: bytes,
    statics_payload: bytes,
) -> None:
    """Blanking every name for one cycle would put the flap on the card."""
    respx_mock.get(VESSELS_URL).mock(
        side_effect=[httpx.Response(200, content=statics_payload), httpx.Response(503)]
    )
    respx_mock.get(LOCATIONS_URL).respond(200, content=locations_payload)

    first = await client.all_vessels()
    second = await client.all_vessels()
    named = {vessel.mmsi: vessel.name for vessel in first if vessel.name is not None}
    assert len(named) == JOINED_COUNT
    assert {vessel.mmsi: vessel.name for vessel in second if vessel.name is not None} == named


@respx.mock(assert_all_called=True)
async def test_a_429_on_the_static_leg_is_still_loud(
    respx_mock: respx.Router, client: FintrafficClient
) -> None:
    """The one static failure that is not survivable: it binds the positions request too."""
    respx_mock.get(VESSELS_URL).respond(429, headers={"retry-after": "45"})
    with pytest.raises(RateLimitedError):
        await client.all_vessels()


# ---------------------------------------------------------------- fix time bounds


def test_a_fix_time_in_our_future_is_dropped_and_counted() -> None:
    """An unbounded ``timestampExternal`` is accidental provider precedence, which ADR 010
    forbids however it arrives. 1893456000000 is 1 January 2030: dated to the future the
    record carries an age of zero and beats every real report until the clock catches up."""
    payload = _envelope(_feature(timestampExternal=1893456000000))
    assert parse_locations(payload, now=REFERENCE_NOW) == ()


def test_a_fix_a_little_ahead_of_our_clock_is_kept() -> None:
    """Clock skew between us and the provider is not a broken record."""
    ahead = int((REFERENCE_NOW + timedelta(seconds=5)).timestamp() * 1000)
    payload = _envelope(_feature(timestampExternal=ahead), data_updated_time="2026-08-19T12:00:00Z")
    vessel = parse_locations(payload, now=REFERENCE_NOW)[0]
    assert vessel.position_age_s == 0.0
    assert vessel.observed_at == datetime.fromtimestamp(ahead / 1000.0, tz=UTC)


def test_the_future_bound_is_a_constant_in_code() -> None:
    assert MAX_FIX_TIME_AHEAD_SECONDS == 60.0


def test_a_seconds_epoch_is_refused_rather_than_dated_to_1970() -> None:
    """``AGENTS.md`` records this API sending the same instant in seconds under a different
    name, so the magnitude is checked rather than trusted. Read as milliseconds, 1787179287
    dates the fix to January 1970 and gives it an age of 1.8 billion seconds, which loses
    every recency contest in the union without anything being counted."""
    payload = _envelope(_feature(timestampExternal=1787179287))
    assert parse_locations(payload, now=REFERENCE_NOW) == ()


def test_a_static_record_dated_in_seconds_is_undated_rather_than_dated_to_1970() -> None:
    """The same magnitude check on the other endpoint, where the field picks which record
    supplies the name. Read as milliseconds the value dates the record to January 1970, which
    is a wrong answer the comparison would act on; refused, the record is simply undated and
    loses to any record that carries a real timestamp."""
    seconds = parse_static(_statics(_static(name="SECONDS EPOCH", timestamp=1787179287)))
    assert seconds["230992610"].updated_at is None

    payload = _statics(
        _static(name="SECONDS EPOCH", timestamp=1787179287),
        _static(name="MILLISECOND EPOCH", timestamp=1787094154894),
    )
    assert parse_static(payload)["230992610"].name == "MILLISECOND EPOCH"


# ---------------------------------------------------------------- the empty world


@respx.mock(assert_all_called=True)
async def test_an_empty_answer_to_the_unfiltered_query_is_a_failed_poll(
    respx_mock: respx.Router, client: FintrafficClient
) -> None:
    """The bare call is the whole Baltic in a ten-minute window, 1,058 features when it was
    measured. Zero means something broke upstream, the same stance CelesTrak takes on an
    empty element array. Reported healthy with a count of zero, the store expires every ship
    180 seconds later and the browser is told to remove them."""
    _mock_both(respx_mock, _envelope(), _statics())
    with pytest.raises(SourceError, match="never as an empty sea"):
        await client.all_vessels()


@respx.mock(assert_all_called=True)
async def test_an_empty_answer_to_a_bounded_query_is_a_legitimate_zero(
    respx_mock: respx.Router, client: FintrafficClient
) -> None:
    """Quiet water is not a broken feed, which is why the guard is scoped to the bare call."""
    _mock_both(respx_mock, _envelope(), _statics())
    assert await client.vessels_near(lat=60.1, lon=24.9, radius_km=5) == ()
