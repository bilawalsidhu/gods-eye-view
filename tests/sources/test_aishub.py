"""AISHub: the traps that would ship a broken vessel layer, one test each.

No network. respx intercepts at the transport and ``assert_all_called=True`` means a test
that thinks it exercised the HTTP path but did not is a failure rather than a false pass.

**Where these payloads come from, because it is not the usual answer.** Only one real AISHub
body has ever been captured, ``tests/fixtures/aishub_ws_invalid_username_live.json``: the
115-byte error envelope a bad username returns. Nobody holds a member username, because
AISHub grants access only to members running a physical AIS receiver, so no successful
response exists to record. The success payloads below are therefore built inline from the
provider's published field list, exactly as ``test_adsb_client.py`` builds its own, and they
are labelled as such rather than dressed up as a recording in ``tests/fixtures/``.

What that means for what these tests prove: they pin **our** behaviour, the unit conversions,
the sentinel mapping, the cadence floor, the empty-200 handling and the drop-and-count, all
of which are ours to get wrong. They cannot prove AISHub spells a key ``DRAUGHT``. When a
username exists, one live call replaces the inline payloads with a fixture and these tests
should pass unchanged.
"""

import inspect
import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import httpx
import pytest
import respx

from tests.conftest import fixture_bytes
from tracker.contracts.base import ContractViolationError
from tracker.contracts.geo import KNOTS_TO_METRES_PER_SECOND, BoundingBox
from tracker.contracts.vessel import (
    AIS_COG_NOT_AVAILABLE,
    AIS_COG_NOT_AVAILABLE_SCALED,
    AIS_ETA_NOT_AVAILABLE,
    AIS_HEADING_NOT_AVAILABLE,
    AIS_IMO_NOT_AVAILABLE,
    AIS_NAV_STATUS_UNDEFINED,
    AIS_ROT_NOT_AVAILABLE,
    AIS_SHIP_TYPE_NOT_AVAILABLE,
    AIS_SOG_NOT_AVAILABLE_SCALED,
    NavigationalStatus,
    Vessel,
)
from tracker.services.poller import Poller
from tracker.services.store import EntityStore
from tracker.sources.aishub import (
    BASE_URL,
    FORMAT_HUMAN,
    FORMAT_SCALED,
    LONLAT_SCALE,
    MIN_INTERVAL_SECONDS,
    NO_USERNAME_REASON,
    SOURCE_NAME,
    AishubClient,
    AishubUnavailableError,
    parse_response,
)
from tracker.sources.base import RateLimitedError

USERNAME = "tracker-test-user"

RECEIVED_AT = datetime(2026, 8, 19, 12, 0, 30, tzinfo=UTC)
"""When the response arrived. Thirty seconds after the fix in :data:`GOOD_RECORD`."""

GOOD_RECORD: dict[str, object] = {
    "MMSI": 230992610,
    "TIME": "2026-08-19 12:00:00 GMT",
    "LONGITUDE": 22.216732,
    "LATITUDE": 60.432413,
    "COG": 143.2,
    "SOG": 12.4,
    "HEADING": 141,
    "ROT": 0,
    "NAVSTAT": 0,
    "IMO": 9315306,
    "NAME": "TEST VESSEL",
    "CALLSIGN": "OJKL",
    "TYPE": 70,
    "A": 100,
    "B": 20,
    "C": 10,
    "D": 12,
    "DRAUGHT": 7.4,
    "DEST": "FIHEL",
    "ETA": 562112,
}
"""A complete human-format record. Real MMSI and position from the 2026-08-19 Baltic capture,
so the ITU category check and the WGS84 bounds are exercised against a real ship's identity."""


def body(*records: dict[str, object], envelope: dict[str, object] | None = None) -> bytes:
    """An AISHub success body: status envelope first, vessel array second."""
    status: dict[str, object] = {
        "ERROR": False,
        "USERNAME": USERNAME,
        "FORMAT": "HUMAN",
        "RECORDS": len(records),
    }
    if envelope is not None:
        status |= envelope
    return json.dumps([status, list(records)]).encode()


def record(**overrides: object) -> dict[str, object]:
    """:data:`GOOD_RECORD` with fields replaced. ``None`` removes the key entirely."""
    merged = GOOD_RECORD | overrides
    return {key: value for key, value in merged.items() if value is not None}


def parse_one(**overrides: object) -> Vessel:
    """Parse a single-record body and return the one vessel, asserting nothing was dropped."""
    parsed = parse_response(body(record(**overrides)), received_at=RECEIVED_AT)
    assert parsed.drops == {}
    assert len(parsed.records) == 1
    return parsed.records[0]


class FakeMonotonic:
    """A monotonic clock a test moves by hand, so the cadence floor never needs a sleep."""

    def __init__(self) -> None:
        self.value = 1_000.0

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> float:
        self.value += seconds
        return self.value


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient() as client:
        yield client


@pytest.fixture
def clock() -> FakeMonotonic:
    return FakeMonotonic()


@pytest.fixture
def client(http: httpx.AsyncClient, clock: FakeMonotonic) -> AishubClient:
    """A client with a username, which nobody has in reality. See the module docstring."""
    return AishubClient(http, username=USERNAME, monotonic=clock)


# ---------------------------------------------------------------- field mapping


def test_maps_every_documented_field() -> None:
    vessel = parse_one()

    assert vessel.mmsi == "230992610"
    assert vessel.name == "TEST VESSEL"
    assert vessel.call_sign == "OJKL"
    assert vessel.imo == 9315306
    assert vessel.ship_type == 70
    assert vessel.point.lon == pytest.approx(22.216732)
    assert vessel.point.lat == pytest.approx(60.432413)
    assert vessel.point.altitude_m is None
    assert vessel.course_over_ground_deg == pytest.approx(143.2)
    assert vessel.true_heading_deg == pytest.approx(141.0)
    assert vessel.rate_of_turn_deg_per_min == 0.0
    assert vessel.navigational_status is NavigationalStatus.UNDER_WAY_USING_ENGINE
    assert vessel.length_m == pytest.approx(120.0)
    assert vessel.beam_m == pytest.approx(22.0)
    assert vessel.draught_m == pytest.approx(7.4)
    assert vessel.destination == "FIHEL"
    assert vessel.eta is not None
    assert (vessel.eta.month, vessel.eta.day, vessel.eta.hour, vessel.eta.minute) == (8, 18, 15, 0)
    assert vessel.observed_at == RECEIVED_AT
    assert vessel.position_age_s == pytest.approx(30.0)


def test_a_position_only_record_maps_with_everything_else_empty() -> None:
    """Normal, not an error: 108 of 1,058 live positions had no static record to join to.

    Only MMSI, longitude, latitude and TIME are load-bearing. Every other key absent leaves
    the attribute empty rather than defaulted, because an invented name or a zero draught is
    worse than a blank field.
    """
    parsed = parse_response(
        body(
            {
                "MMSI": 230992610,
                "TIME": "2026-08-19 12:00:00 GMT",
                "LONGITUDE": 22.216732,
                "LATITUDE": 60.432413,
            }
        ),
        received_at=RECEIVED_AT,
    )

    assert parsed.drops == {}
    vessel = parsed.records[0]
    assert vessel.label == "230992610"
    assert (vessel.name, vessel.call_sign, vessel.destination, vessel.eta) == (None,) * 4
    assert (vessel.imo, vessel.ship_type, vessel.draught_m) == (None, None, None)
    assert (vessel.course_over_ground_deg, vessel.speed_over_ground_mps) == (None, None)
    assert (vessel.true_heading_deg, vessel.rate_of_turn_deg_per_min) == (None, None)
    assert vessel.navigational_status is None
    assert vessel.position_age_s == pytest.approx(30.0)


def test_a_record_with_no_timestamp_at_all_is_dropped_and_counted() -> None:
    """No timestamp means no honest report age, and ADR 010 makes the age how a conflict
    between two providers resolves. Dating it to now would make a stale fix look fresh and
    win a merge it should lose."""
    parsed = parse_response(body(record(TIME=None)), received_at=RECEIVED_AT)

    assert parsed.records == ()
    assert parsed.dropped == 1
    assert "no readable timestamp" in next(iter(parsed.drops))


def test_speed_converts_knots_to_metres_per_second() -> None:
    assert parse_one(SOG=12.4).speed_over_ground_mps == pytest.approx(
        12.4 * KNOTS_TO_METRES_PER_SECOND
    )


def test_every_record_names_the_provider_that_supplied_it() -> None:
    """ADR 010: per record, never per layer, or a merged store is unauditable."""
    assert parse_one().source == SOURCE_NAME == "aishub"


def test_the_name_cap_truncates_rather_than_dropping_the_vessel() -> None:
    """Upstream caps NAME at 20, so a longer one is a provider bug, not a reason to lose a ship."""
    assert parse_one(NAME="A" * 30) == parse_one(NAME="A" * 20)


@pytest.mark.parametrize("blank", ["", "   "])
def test_empty_text_becomes_none(blank: str) -> None:
    vessel = parse_one(NAME=blank, CALLSIGN=blank, DEST=blank)

    assert vessel.name is None
    assert vessel.call_sign is None
    assert vessel.destination is None


def test_eta_in_human_text_form_decodes() -> None:
    vessel = parse_one(ETA="08-18 15:00")

    assert vessel.eta is not None
    assert (vessel.eta.month, vessel.eta.day, vessel.eta.hour, vessel.eta.minute) == (8, 18, 15, 0)


@pytest.mark.parametrize("unusable", [AIS_ETA_NOT_AVAILABLE, 0, "not an eta", "13-40 99:99"])
def test_unusable_eta_becomes_none(unusable: object) -> None:
    assert parse_one(ETA=unusable).eta is None


@pytest.mark.parametrize(
    ("first", "second"),
    [(1_000, 1_000), (0, 0), (100, None)],
    ids=["over the field bound", "not available", "half missing"],
)
def test_unusable_dimensions_become_none(first: int, second: int | None) -> None:
    vessel = parse_one(A=first, B=second, C=first, D=second)

    assert vessel.length_m is None
    assert vessel.beam_m is None


# ---------------------------------------------------------------- sentinels, not nulls


def test_human_format_sentinels_all_map_to_none() -> None:
    """Course 360.0, speed 102.4, heading 511, IMO 0, type 0, draught 0, ROT -128, nav 15."""
    vessel = parse_one(
        COG=AIS_COG_NOT_AVAILABLE,
        SOG=102.4,
        HEADING=AIS_HEADING_NOT_AVAILABLE,
        IMO=AIS_IMO_NOT_AVAILABLE,
        TYPE=AIS_SHIP_TYPE_NOT_AVAILABLE,
        DRAUGHT=0,
        ROT=AIS_ROT_NOT_AVAILABLE,
        NAVSTAT=AIS_NAV_STATUS_UNDEFINED,
    )

    assert vessel.course_over_ground_deg is None
    assert vessel.speed_over_ground_mps is None
    assert vessel.true_heading_deg is None
    assert vessel.imo is None
    assert vessel.ship_type is None
    assert vessel.draught_m is None
    assert vessel.rate_of_turn_deg_per_min is None
    assert vessel.navigational_status is None


@pytest.mark.parametrize("sog", [102.3, 102.4], ids=["ITU 1023", "the value AGENTS.md records"])
def test_both_readings_of_the_speed_sentinel_map_to_none(sog: float) -> None:
    assert parse_one(SOG=sog).speed_over_ground_mps is None


def test_a_course_of_zero_survives() -> None:
    """Due north is a real course. Only 360.0 means not available, and 110 of 1,058 live
    records carried it: a naive ``0 <= x < 360`` check would reject every one of them."""
    assert parse_one(COG=0.0).course_over_ground_deg == 0.0


def test_junk_above_the_bearing_range_becomes_none_rather_than_dropping_the_vessel() -> None:
    assert parse_one(HEADING=400).true_heading_deg is None


def test_out_of_range_imo_becomes_none() -> None:
    """The live Digitraffic feed carried IMO values up to 912974400, which is not an IMO."""
    assert parse_one(IMO=912974400).imo is None


def test_rate_of_turn_is_decoded_from_the_ais_encoding() -> None:
    """ROT_AIS is 4.733 * sqrt(degrees per minute), signed. 4.733 * sqrt(4) is 9.466."""
    assert parse_one(ROT=-9).rate_of_turn_deg_per_min == pytest.approx(-3.616, abs=0.01)


@pytest.mark.parametrize("no_rate", [127, -127])
def test_turning_without_a_rate_is_not_a_rate(no_rate: int) -> None:
    assert parse_one(ROT=no_rate).rate_of_turn_deg_per_min is None


# ---------------------------------------------------------------- format=0 scaling


def test_scaled_format_descales_position_course_speed_and_draught() -> None:
    scaled = record(
        LONGITUDE=round(22.216732 * LONLAT_SCALE),
        LATITUDE=round(60.432413 * LONLAT_SCALE),
        COG=1432,
        SOG=124,
        DRAUGHT=74,
    )

    parsed = parse_response(
        body(scaled, envelope={"FORMAT": "AIS"}),
        ais_format=FORMAT_SCALED,
        received_at=RECEIVED_AT,
    )

    assert parsed.drops == {}
    vessel = parsed.records[0]
    assert vessel.point.lon == pytest.approx(22.216732, abs=1e-6)
    assert vessel.point.lat == pytest.approx(60.432413, abs=1e-6)
    assert vessel.course_over_ground_deg == pytest.approx(143.2)
    assert vessel.speed_over_ground_mps == pytest.approx(12.4 * KNOTS_TO_METRES_PER_SECOND)
    assert vessel.draught_m == pytest.approx(7.4)


@pytest.mark.parametrize(
    "sog", [AIS_SOG_NOT_AVAILABLE_SCALED, 1024], ids=["ITU 1023", "the reading AGENTS.md records"]
)
def test_scaled_sentinels_map_to_none_too(sog: int) -> None:
    """3600, 1023 and 511: the same not-available values, ten times bigger except heading."""
    parsed = parse_response(
        body(
            record(
                LONGITUDE=round(22.216732 * LONLAT_SCALE),
                LATITUDE=round(60.432413 * LONLAT_SCALE),
                COG=AIS_COG_NOT_AVAILABLE_SCALED,
                SOG=sog,
                HEADING=AIS_HEADING_NOT_AVAILABLE,
                DRAUGHT=0,
            ),
            envelope={"FORMAT": "AIS"},
        ),
        ais_format=FORMAT_SCALED,
        received_at=RECEIVED_AT,
    )

    vessel = parsed.records[0]
    assert vessel.course_over_ground_deg is None
    assert vessel.speed_over_ground_mps is None
    assert vessel.true_heading_deg is None
    assert vessel.draught_m is None


def test_a_mode_we_did_not_ask_for_is_a_contract_violation() -> None:
    """Trusting the echo is the alternative, and it puts every ship 600000 degrees east."""
    with pytest.raises(ContractViolationError, match="scaled wrong"):
        parse_response(body(record(), envelope={"FORMAT": "AIS"}), received_at=RECEIVED_AT)


def test_an_unrecognised_format_echo_is_left_alone() -> None:
    assert (
        parse_response(
            body(record(), envelope={"FORMAT": "SOMETHING NEW"}), received_at=RECEIVED_AT
        )
        .records[0]
        .mmsi
        == "230992610"
    )


# ---------------------------------------------------------------- timestamps


def test_the_naive_gmt_timestamp_gets_utc_attached() -> None:
    vessel = parse_one(TIME="2026-08-19 11:59:00 GMT")

    assert vessel.observed_at.tzinfo is not None
    assert vessel.position_age_s == pytest.approx(90.0)


def test_the_xml_and_csv_field_name_is_accepted_for_the_same_value() -> None:
    """``TIME`` in JSON is ``TSTAMP`` everywhere else. Same value, two names."""
    payload = record()
    del payload["TIME"]
    payload["TSTAMP"] = "2026-08-19 12:00:00 GMT"

    parsed = parse_response(body(payload), received_at=RECEIVED_AT)

    assert parsed.records[0].position_age_s == pytest.approx(30.0)


def test_an_epoch_timestamp_is_read_as_seconds() -> None:
    epoch = (RECEIVED_AT - timedelta(seconds=45)).timestamp()

    assert parse_one(TIME=int(epoch)).position_age_s == pytest.approx(45.0)


def test_a_clock_ahead_of_us_never_produces_a_negative_age() -> None:
    assert parse_one(TIME="2026-08-19 12:01:00 GMT").position_age_s == 0.0


@pytest.mark.parametrize("unreadable", ["yesterday", "2026-08-19T12:00:00Z", 10**30])
def test_an_undatable_record_is_dropped_and_counted(unreadable: object) -> None:
    parsed = parse_response(body(record(TIME=unreadable)), received_at=RECEIVED_AT)

    assert parsed.records == ()
    assert parsed.dropped == 1
    assert "no readable timestamp" in next(iter(parsed.drops))


# ---------------------------------------------------------------- dropped and counted


def test_a_search_and_rescue_aircraft_is_dropped_with_its_category_named() -> None:
    """MMSI 111265583 is LIFEGUARD 003 on the live feed, doing 36 knots. Not a vessel."""
    parsed = parse_response(body(record(MMSI=111265583)), received_at=RECEIVED_AT)

    assert parsed.records == ()
    assert parsed.dropped == 1
    assert "sar_aircraft" in next(iter(parsed.drops))


def test_the_placeholder_mmsi_is_dropped_rather_than_merging_ships_together() -> None:
    """999999999 is NATO WARSHIP on the live feed. Every ship using it merges into one."""
    parsed = parse_response(body(record(MMSI=999999999)), received_at=RECEIVED_AT)

    assert parsed.records == ()
    assert "unallocated" in next(iter(parsed.drops))


@pytest.mark.parametrize(
    ("bad", "reason"),
    [
        ({"LONGITUDE": None}, "no position"),
        ({"LATITUDE": None}, "no position"),
        ({"MMSI": None}, "no MMSI"),
        ({"LATITUDE": 91.0}, "less than or equal to 90"),
        ({"MMSI": "not a number"}, "invalid literal"),
    ],
)
def test_an_unmappable_record_is_dropped_and_counted(bad: dict[str, object], reason: str) -> None:
    parsed = parse_response(body(record(**bad)), received_at=RECEIVED_AT)

    assert parsed.records == ()
    assert parsed.dropped == 1
    assert reason in next(iter(parsed.drops))


def test_one_bad_record_does_not_lose_the_good_ones() -> None:
    payload = body(record(), {"not": "a vessel"}, record(MMSI=265513270))

    parsed = parse_response(payload, received_at=RECEIVED_AT)

    assert {vessel.mmsi for vessel in parsed.records} == {"230992610", "265513270"}
    assert parsed.dropped == 1


def test_a_record_that_is_not_even_an_object_is_dropped_and_counted() -> None:
    parsed = parse_response(json.dumps([{"ERROR": False}, ["a string"]]), received_at=RECEIVED_AT)

    assert parsed.records == ()
    assert parsed.dropped == 1


# ---------------------------------------------------------------- the empty 200


@pytest.mark.parametrize("nothing", [b"", b"   ", b"[]"])
def test_an_empty_success_is_an_error_not_an_empty_sea(nothing: bytes) -> None:
    """Plan phase 2 acceptance 8. An empty body read as "no ships anywhere" drops real
    vessels out of a merged store, which is the union making a quirk dangerous."""
    with pytest.raises(AishubUnavailableError, match="empty body"):
        parse_response(nothing)


def test_the_recorded_invalid_username_body_raises_with_the_provider_message() -> None:
    """The one real payload anybody has: HTTP 200, 115 bytes, a structured error envelope.

    This repo previously claimed a bad username returned nothing at all. An adapter written
    to that claim reads this body as a successful empty vessel list.
    """
    with pytest.raises(AishubUnavailableError, match="Invalid username or password"):
        parse_response(fixture_bytes("aishub_ws_invalid_username_live.json"))


def test_an_error_envelope_without_a_message_still_raises() -> None:
    with pytest.raises(AishubUnavailableError, match="no message"):
        parse_response(json.dumps([{"ERROR": True}]))


@respx.mock(assert_all_called=True)
async def test_an_empty_200_never_empties_the_vessel_store(
    respx_mock: respx.Router, client: AishubClient, clock: FakeMonotonic
) -> None:
    """The assertion phase 2 acceptance 8 actually asks for, over the real store.

    ``replace_all`` is used deliberately: it is the call that would wipe the layer, and the
    only thing standing between an empty body and an empty globe is the poll raising before
    it is reached.
    """
    store: EntityStore[Vessel] = EntityStore(ttl_seconds=90.0)
    respx_mock.get(BASE_URL).mock(
        side_effect=[
            httpx.Response(200, content=body(record())),
            httpx.Response(200, content=b""),
        ]
    )

    async def poll() -> int:
        parsed = await client.vessels()
        store.replace_all((vessel.mmsi, vessel) for vessel in parsed.records)
        return len(parsed.records)

    assert await poll() == 1
    clock.advance(MIN_INTERVAL_SECONDS)
    with pytest.raises(AishubUnavailableError, match="empty body"):
        await poll()

    assert len(store) == 1
    assert store.get("230992610") is not None


# ---------------------------------------------------------------- response shape


@pytest.mark.parametrize(
    ("malformed", "reason"),
    [
        (b"<html>nope</html>", "not JSON"),
        (b'{"ERROR": false}', "expected a JSON array"),
        (json.dumps([{"ERROR": False}]).encode(), "no vessel array"),
        (json.dumps([{"ERROR": False}, {"MMSI": 1}]).encode(), "no vessel array"),
    ],
)
def test_an_unrecognisable_shape_fails_loudly(malformed: bytes, reason: str) -> None:
    """A shape we do not know must not parse to zero ships: that is a healthy feed with an
    empty layer, and nothing anywhere says why."""
    with pytest.raises(ContractViolationError, match=reason):
        parse_response(malformed)


def test_the_status_envelope_is_not_read_as_a_ship() -> None:
    """Element 0 is metadata. Anything iterating the response as ships counts it as one."""
    parsed = parse_response(body(record()), received_at=RECEIVED_AT)

    assert len(parsed.records) == 1


# ---------------------------------------------------------------- the cadence floor


def test_the_floor_is_a_constant_in_code_at_once_per_minute() -> None:
    assert MIN_INTERVAL_SECONDS == 60.0


def test_nothing_configurable_can_lower_the_floor(client: AishubClient) -> None:
    """No constructor argument, no setter, no attribute to assign: only the constant.

    Checked by introspection rather than by passing a bad argument, because a bad argument is
    a type error the two checkers reject before a test ever runs, which proves the point at
    review time and not at all once somebody adds the parameter.
    """
    assert "min_interval_seconds" not in inspect.signature(AishubClient).parameters
    assert isinstance(inspect.getattr_static(AishubClient, "min_interval_seconds"), property)
    assert client.min_interval_seconds == MIN_INTERVAL_SECONDS

    with pytest.raises(AttributeError):
        setattr(client, "min_interval_seconds", 1.0)  # noqa: B010


def test_configuration_cannot_poll_faster_than_the_floor(client: AishubClient) -> None:
    """The poller takes the floor from the adapter, so a one-second setting still waits 60."""
    poller = Poller(
        name=client.name,
        layer="vessels",
        poll=_never_polled,
        interval_seconds=1.0,
        min_interval_seconds=client.min_interval_seconds,
    )

    assert poller.effective_interval == MIN_INTERVAL_SECONDS


async def _never_polled() -> int:
    """A poll function for a poller a test only reads the cadence off."""
    raise AssertionError("this poller must never run")


@respx.mock(assert_all_called=True)
async def test_a_second_call_inside_the_minute_is_refused_without_a_request(
    respx_mock: respx.Router, client: AishubClient, clock: FakeMonotonic
) -> None:
    """Plan phase 2 acceptance 7. Over-calling is answered with no data, so it is prevented
    here rather than merely discouraged in a setting."""
    route = respx_mock.get(BASE_URL).mock(return_value=httpx.Response(200, content=body(record())))

    await client.vessels()
    clock.advance(MIN_INTERVAL_SECONDS - 0.1)
    with pytest.raises(AishubUnavailableError, match="refusing to call"):
        await client.vessels()

    assert route.call_count == 1


@respx.mock(assert_all_called=True)
async def test_the_next_call_is_allowed_once_the_minute_has_passed(
    respx_mock: respx.Router, client: AishubClient, clock: FakeMonotonic
) -> None:
    route = respx_mock.get(BASE_URL).mock(return_value=httpx.Response(200, content=body(record())))

    await client.vessels()
    clock.advance(MIN_INTERVAL_SECONDS)
    await client.vessels()

    assert route.call_count == 2


@respx.mock(assert_all_called=True)
async def test_a_failed_call_still_consumes_the_slot(
    respx_mock: respx.Router, client: AishubClient, clock: FakeMonotonic
) -> None:
    """Otherwise a failure unlocks an immediate retry, which is what produces the empty body."""
    route = respx_mock.get(BASE_URL).mock(return_value=httpx.Response(500))

    with pytest.raises(httpx.HTTPStatusError):
        await client.vessels()
    clock.advance(1.0)
    with pytest.raises(AishubUnavailableError, match="refusing to call"):
        await client.vessels()

    assert route.call_count == 1


# ---------------------------------------------------------------- the query


@respx.mock(assert_all_called=True)
async def test_output_and_format_are_always_explicit(
    respx_mock: respx.Router, client: AishubClient
) -> None:
    """``output`` defaults to XML upstream and ``format=0`` scales every number."""
    route = respx_mock.get(BASE_URL).mock(return_value=httpx.Response(200, content=body(record())))

    await client.vessels()

    query = route.calls.last.request.url.params
    assert query["output"] == "json"
    assert query["format"] == str(FORMAT_HUMAN) == "1"
    assert query["compress"] == "0"
    assert query["username"] == USERNAME


@respx.mock(assert_all_called=True)
async def test_the_bounding_box_becomes_four_parameters(
    respx_mock: respx.Router, client: AishubClient
) -> None:
    route = respx_mock.get(BASE_URL).mock(return_value=httpx.Response(200, content=body(record())))

    await client.vessels(
        box=BoundingBox(west=20.0, south=59.0, east=25.0, north=61.0),
        mmsi=["230992610", "265513270"],
        interval_minutes=5,
    )

    query = route.calls.last.request.url.params
    assert (query["lonmin"], query["latmin"], query["lonmax"], query["latmax"]) == (
        "20.0",
        "59.0",
        "25.0",
        "61.0",
    )
    assert query["mmsi"] == "230992610,265513270"
    assert query["interval"] == "5"


@respx.mock(assert_all_called=False)
async def test_an_antimeridian_box_is_refused_before_a_request_is_made(
    respx_mock: respx.Router, client: AishubClient
) -> None:
    """Four parameters cannot express a wrap, and sending it returns everything except the
    ships asked for. Refusing costs nothing: the slot is not consumed either."""
    route = respx_mock.get(BASE_URL).mock(return_value=httpx.Response(200, content=body(record())))

    with pytest.raises(ValueError, match="antimeridian"):
        await client.vessels(box=BoundingBox(west=170.0, south=-10.0, east=-170.0, north=10.0))

    assert route.call_count == 0


# ---------------------------------------------------------------- availability and throttling


@respx.mock(assert_all_called=False)
async def test_without_a_username_nothing_is_called_and_the_reason_is_the_receiver(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Plan phase 2 acceptance 9: configured but unavailable, exactly like a missing key."""
    route = respx_mock.get(BASE_URL).mock(return_value=httpx.Response(200, content=b"[]"))
    client = AishubClient(http, username="")

    assert client.available is False
    with pytest.raises(AishubUnavailableError, match="physical AIS receiver"):
        await client.vessels()

    assert route.call_count == 0
    assert "receiver" in NO_USERNAME_REASON


def test_whitespace_is_not_a_username(http: httpx.AsyncClient) -> None:
    assert AishubClient(http, username="   ").available is False


def test_a_configured_username_makes_the_provider_available(client: AishubClient) -> None:
    assert client.available is True
    assert client.name == SOURCE_NAME


@respx.mock(assert_all_called=True)
async def test_a_throttling_response_raises_with_the_providers_own_backoff(
    respx_mock: respx.Router, client: AishubClient
) -> None:
    respx_mock.get(BASE_URL).mock(
        return_value=httpx.Response(429, headers={"retry-after": "90"}, content=b"slow down")
    )

    with pytest.raises(RateLimitedError) as raised:
        await client.vessels()

    assert raised.value.retry_after_seconds == 90.0
    assert raised.value.source == SOURCE_NAME


# ---------------------------------------------------------------- the bottom of the range


@pytest.mark.parametrize(
    ("override", "attribute"),
    [
        ({"HEADING": -1}, "true_heading_deg"),
        ({"COG": -5.0}, "course_over_ground_deg"),
        ({"SOG": -3.0}, "speed_over_ground_mps"),
    ],
    ids=["heading", "course", "speed"],
)
def test_a_negative_optional_field_becomes_none_rather_than_dropping_the_vessel(
    override: dict[str, object], attribute: str
) -> None:
    """The other half of the range, which this adapter used to miss.

    It checked only "at or above the sentinel", so 511 and a junk 400 both mapped to None
    and kept the ship while -1 went through to the domain ``Bearing`` bound and lost it.
    Digitraffic and aisstream.io both got this right, which is why the rule now lives in
    ``contracts/vessel.py`` and all three call the same function.
    """
    vessel = parse_one(**override)
    assert getattr(vessel, attribute) is None


# ---------------------------------------------------------------- the envelope cross-check


def test_an_envelope_claiming_more_records_than_it_carries_is_a_failed_poll() -> None:
    """``RECORDS`` is the only cross-check this provider offers, and it is worth having on a
    feed that answers both a bad username and an over-frequent call with HTTP 200. Read as an
    empty sea, a truncated body drops real vessels out of a merged store."""
    truncated = json.dumps([{"ERROR": False, "FORMAT": "HUMAN", "RECORDS": 500}, []]).encode()
    with pytest.raises(AishubUnavailableError, match="never as an empty sea"):
        parse_response(truncated)


def test_an_envelope_reporting_no_records_above_an_empty_array_is_a_legitimate_zero() -> None:
    """Deliberately not an error. The client takes a box, an MMSI list and an interval, so a
    box over quiet water or a ship that is not currently reporting is a correct zero, and
    calling that a provider failure would be a false alarm on the exact path it touches."""
    quiet = json.dumps([{"ERROR": False, "FORMAT": "HUMAN", "RECORDS": 0}, []]).encode()
    assert parse_response(quiet).records == ()
