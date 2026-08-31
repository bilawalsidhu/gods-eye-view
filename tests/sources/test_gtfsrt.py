"""The GTFS-Realtime adapter, against payloads recorded from the real feeds on 2026-08-23.

Every fixture here is one of the traps measured during the sweep that produced the registry,
so the assertions are on real provider behaviour rather than on invented edge cases.
"""

from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import pytest
import respx
from google.transit import gtfs_realtime_pb2

from tests.conftest import fixture_bytes
from tracker.cache import DiskCache
from tracker.contracts.base import ContractViolationError
from tracker.contracts.transit import MAX_PLAUSIBLE_SPEED_MS, TransitVehicle
from tracker.sources import gtfsrt
from tracker.sources.base import ParsedRecords, RateLimitedError

# When every .pb fixture in this module was captured. Freezing the clock here is what lets a
# recorded payload be asserted on at all: the adapter drops a report older than fifteen
# minutes, so a fixture read against today's wall clock would correctly drop every record.
CAPTURED_AT = datetime(2026, 8, 23, 10, 21, 46, tzinfo=UTC)


def feed(url: str = "https://example.invalid/vp", **kwargs: str) -> gtfsrt.TransitFeed:
    """A registry row for a fixture, defaulting to a host with no special floor."""
    fields = {
        "feed_id": "test-feed",
        "country": "GB",
        "provider": "Test Operator",
        "name": "Test feed",
        "url": url,
        "licence": "CC0 1.0",
        "licence_url": "https://creativecommons.org/publicdomain/zero/1.0/",
        "attribution": "",
    }
    fields.update(kwargs)
    return gtfsrt.TransitFeed(**fields)


def parse(name: str, *, at: datetime = CAPTURED_AT, **kwargs: str) -> ParsedRecords[TransitVehicle]:
    """Parse a recorded fixture with the clock frozen to when it was captured."""
    return gtfsrt.parse_records(fixture_bytes(name), feed=feed(**kwargs), now=at)


# ---------------------------------------------------------------- the committed registry


def test_registry_loads_the_expected_number_of_feeds() -> None:
    assert len(gtfsrt.FEEDS) == gtfsrt.EXPECTED_FEED_COUNT


def test_every_registry_row_is_complete() -> None:
    for row in gtfsrt.FEEDS:
        assert row.feed_id
        assert row.provider
        assert row.url.startswith(("http://", "https://"))
        assert row.licence
        assert row.licence_url
        assert len(row.country) == 2
        assert row.country.isupper()


def test_registry_ids_and_urls_are_unique() -> None:
    assert len({row.feed_id for row in gtfsrt.FEEDS}) == len(gtfsrt.FEEDS)
    assert len({row.url for row in gtfsrt.FEEDS}) == len(gtfsrt.FEEDS)


def test_registry_holds_no_feed_from_a_robots_disallowed_host() -> None:
    """bct.tmix.se serves 35 feeds and its robots.txt is Disallow: /. That is binding."""
    assert not [row for row in gtfsrt.FEEDS if row.host == "bct.tmix.se"]


def test_registry_holds_no_feed_behind_an_acceptance_agreement() -> None:
    """MTA and MBTA are reachable and keyless, and out on terms like ADS-B Exchange."""
    assert not [row for row in gtfsrt.FEEDS if "mta.info" in row.host]
    assert not [row for row in gtfsrt.FEEDS if "agree" in row.licence_url.lower()]


def test_every_registry_row_carries_a_determinable_licence() -> None:
    """A record whose licence cannot be determined is dropped, so none reach the registry."""
    for row in gtfsrt.FEEDS:
        assert row.licence_url.startswith("http")


def test_the_cadence_floor_comes_from_the_host_not_the_feed() -> None:
    """passio3.com states X-RateLimit-Limit: 6000, shared across every feed on the host."""
    passio = feed(url="https://passio3.com/x/passioTransit/gtfs/realtime/vehiclePositions")
    assert passio.min_interval_seconds == gtfsrt.HOST_MIN_INTERVAL_SECONDS["passio3.com"]
    assert passio.min_interval_seconds > gtfsrt.DEFAULT_MIN_INTERVAL_SECONDS
    assert feed().min_interval_seconds == gtfsrt.DEFAULT_MIN_INTERVAL_SECONDS


def test_the_busiest_hosts_are_all_slowed_below_the_default() -> None:
    """99 feeds on one host at the default floor would be 3.3 requests a second."""
    hosts = [row.host for row in gtfsrt.FEEDS]
    for host, floor in gtfsrt.HOST_MIN_INTERVAL_SECONDS.items():
        if host in hosts:
            assert floor > gtfsrt.DEFAULT_MIN_INTERVAL_SECONDS


def test_coverage_reason_fits_on_a_card() -> None:
    """The layer rail asserts 120 characters elsewhere; this is the string it will show."""
    assert len(gtfsrt.COVERAGE_REASON) <= 120
    assert "global" not in gtfsrt.COVERAGE_REASON.lower()


def test_coverage_is_seventeen_countries_and_says_so() -> None:
    assert len(gtfsrt.COUNTRIES) == 17
    for absent in ("BR", "IN", "CN", "ZA", "NG", "MX", "AR", "EG"):
        assert absent not in gtfsrt.COUNTRIES


def test_norway_is_present_through_the_unlisted_entur_endpoint() -> None:
    """The catalogue lists zero Norwegian feeds and labels Entur's three slices Czechia."""
    assert "NO" in gtfsrt.COUNTRIES
    entur = [row for row in gtfsrt.FEEDS if row.host == "api.entur.io"]
    assert len(entur) == 1
    assert urlsplit(entur[0].url).query == ""
    assert entur[0].country == "NO"


def test_the_largest_feed_is_labelled_netherlands_not_austria() -> None:
    """The Mobility Database says AT. Its 2,098 vehicles are between 3.35E and 7.13E."""
    ovapi = [row for row in gtfsrt.FEEDS if row.host == "gtfs.ovapi.nl"]
    assert len(ovapi) == 1
    assert ovapi[0].country == "NL"


def test_attributions_cover_every_feed() -> None:
    assert gtfsrt.ATTRIBUTIONS
    for row in gtfsrt.FEEDS:
        assert row.credit in gtfsrt.ATTRIBUTIONS


def test_a_mandated_form_of_words_survives_into_the_credit() -> None:
    """King County Metro and Hamilton both fix the wording. A grouping must leave those alone."""
    mandated = [row for row in gtfsrt.FEEDS if row.attribution]
    assert len(mandated) == 2
    for row in mandated:
        assert row.credit == row.attribution
        assert row.provider not in row.credit or "County" in row.credit


def test_a_feed_without_a_mandated_form_of_words_names_its_licence() -> None:
    """ODbL needs a viewer to know both the source and that it is under that licence."""
    for row in gtfsrt.FEEDS:
        if not row.attribution:
            assert row.licence in row.credit
            assert row.provider in row.credit


def test_no_registry_feed_is_gated_behind_an_agreement_or_registration() -> None:
    """SEPTA, CTtransit and Sound Transit all gate the download and none says so in its URL."""
    gated = {
        "www3.septa.org",
        "www.cttransit.com",
        "www.soundtransit.org",
    }
    for row in gtfsrt.FEEDS:
        assert urlsplit(row.licence_url).netloc not in gated


# ---------------------------------------------------------------- parsing real payloads


def test_a_full_record_maps_every_optional_field() -> None:
    parsed = parse("gtfsrt_alterneo_all_optional_fields_live.pb")
    assert parsed.records
    assert parsed.dropped == 0
    with_all = [
        v
        for v in parsed.records
        if v.bearing is not None and v.vehicle_id and v.route_id and v.occupancy
    ]
    assert with_all
    vehicle = with_all[0]
    assert vehicle.kind == "transit"
    assert vehicle.licence == "CC0 1.0"
    assert vehicle.country == "GB"
    assert vehicle.timestamp_basis == "vehicle"
    assert vehicle.position_age_s >= 0.0
    assert -180.0 <= vehicle.point.lon <= 180.0
    assert -90.0 <= vehicle.point.lat <= 90.0


def test_null_island_records_are_dropped_and_counted() -> None:
    """Minneapolis Metro Transit emits 0,0 for a vehicle it has no fix for.

    Left in, they gave one bus an apparent 10,266km trip in 9.6 minutes between two sweeps.
    """
    parsed = parse("gtfsrt_metrotransit_null_island_live.pb")
    assert parsed.drops[gtfsrt.DROP_NULL_ISLAND] == 93
    assert not [v for v in parsed.records if v.point.lon == 0.0 and v.point.lat == 0.0]


def test_a_bearing_of_exactly_360_is_a_sentinel_not_a_heading() -> None:
    parsed = parse("gtfsrt_szczecin_bearing_360_sentinel_live.pb")
    assert parsed.records
    assert not [v for v in parsed.records if v.bearing == 360.0]
    assert [v for v in parsed.records if v.bearing is None]
    assert [v for v in parsed.records if v.bearing is not None]


def test_a_negative_bearing_is_normalised_rather_than_rejected() -> None:
    """470 vehicles reported one. A strict 0 <= x < 360 field would refuse every one."""
    parsed = parse("gtfsrt_atoumod_negative_bearing_live.pb")
    assert parsed.records
    assert parsed.drops[gtfsrt.DROP_UNMAPPABLE] == 0
    for vehicle in parsed.records:
        if vehicle.bearing is not None:
            assert 0.0 <= vehicle.bearing < 360.0


def test_an_implausible_speed_is_left_empty_rather_than_converted() -> None:
    """Four feeds report above 50 m/s into a metres-per-second field. Nothing declares a unit."""
    parsed = parse("gtfsrt_toulon_speed_out_of_range_live.pb")
    assert parsed.records
    over = [
        v for v in parsed.records if v.speed_ms is not None and v.speed_ms > MAX_PLAUSIBLE_SPEED_MS
    ]
    assert not over
    assert [v for v in parsed.records if v.speed_ms is not None]


def test_a_vehicle_timestamp_of_zero_falls_back_to_the_feed_header() -> None:
    """Zero means "not set", not 1 January 1970. Brest sends it on every vehicle."""
    parsed = parse("gtfsrt_brest_vehicle_timestamp_zero_live.pb")
    assert parsed.records
    assert {v.timestamp_basis for v in parsed.records} == {"feed"}
    assert all(v.observed_at.year == CAPTURED_AT.year for v in parsed.records)


def test_a_json_body_on_http_200_is_a_contract_violation() -> None:
    """CobbLinc answers HTTP 200 application/json with capitalised GTFS-RT-shaped keys.

    Content-Type is no guard: it took twelve values across the sweep and was absent on 32
    responses. Only the decode tells you.
    """
    with pytest.raises(ContractViolationError):
        gtfsrt.parse_records(
            fixture_bytes("gtfsrt_cobblinc_json_not_protobuf_http200_live.json"),
            feed=feed(),
            now=CAPTURED_AT,
        )


def test_a_stale_report_is_dropped_and_counted() -> None:
    """A frozen feed served on HTTP 200 is the hardest failure here to see."""
    parsed = parse(
        "gtfsrt_alterneo_all_optional_fields_live.pb",
        at=CAPTURED_AT + timedelta(days=908),
    )
    assert parsed.records == ()
    assert parsed.drops[gtfsrt.DROP_STALE] > 0


def test_a_report_from_the_future_is_dropped_rather_than_given_a_negative_age() -> None:
    parsed = parse(
        "gtfsrt_alterneo_all_optional_fields_live.pb",
        at=CAPTURED_AT - timedelta(hours=1),
    )
    assert parsed.records == ()
    assert parsed.drops[gtfsrt.DROP_FUTURE] > 0


def test_ordinary_clock_skew_is_tolerated() -> None:
    """89 feeds ran a few seconds fast. That is two machines, not a broken feed."""
    parsed = parse(
        "gtfsrt_alterneo_all_optional_fields_live.pb",
        at=CAPTURED_AT - timedelta(seconds=gtfsrt.MAX_CLOCK_SKEW_SECONDS / 2),
    )
    assert parsed.records
    assert all(v.position_age_s >= 0.0 for v in parsed.records)


def test_a_feed_with_no_vehicle_positions_parses_to_nothing_rather_than_failing() -> None:
    """Trip-update and alert feeds are ordinary. 253 feeds were legitimately empty at 10:21."""
    parsed = parse("gtfsrt_gtfsde_germany_no_vehiclepositions_live.pb")
    assert parsed.records == ()
    assert parsed.dropped == 0


def test_the_norwegian_national_feed_parses() -> None:
    parsed = parse("gtfsrt_entur_norway_vehiclepositions_live.pb", country="NO", licence="NLOD 2.0")
    total = len(parsed.records) + parsed.dropped
    assert total > 0
    assert all(v.licence == "NLOD 2.0" for v in parsed.records)


def test_a_vehicle_without_a_position_is_dropped_and_counted() -> None:
    """Roughly every feed carries vehicles it has heard from but cannot place."""
    parsed = parse("gtfsrt_occitanie_no_position_live.pb")
    assert parsed.drops[gtfsrt.DROP_NO_POSITION] == 4
    assert parsed.records


def test_parsing_defaults_to_the_wall_clock_when_no_time_is_given() -> None:
    """Without a clock every recorded fixture is correctly stale, which is the point."""
    parsed = gtfsrt.parse_records(
        fixture_bytes("gtfsrt_alterneo_all_optional_fields_live.pb"), feed=feed()
    )
    assert parsed.records == ()
    assert parsed.drops[gtfsrt.DROP_STALE] > 0


# The cases below are constructed rather than recorded, because no feed in the 553-URL sweep
# produced them. They are guards against a shape the specification permits and nobody sent.


def one_vehicle(
    *,
    entity_id: str = "e1",
    lat: float = 51.5,
    lon: float = -0.12,
    vehicle_ts: int = 0,
    header_ts: int = 0,
    with_position: bool = True,
) -> bytes:
    """A minimal FeedMessage, for a shape no real feed in the sample sent."""
    message = gtfs_realtime_pb2.FeedMessage()
    message.header.gtfs_realtime_version = "2.0"
    message.header.timestamp = header_ts
    entity = message.entity.add()
    entity.id = entity_id
    if with_position:
        entity.vehicle.position.latitude = lat
        entity.vehicle.position.longitude = lon
    else:
        entity.vehicle.vehicle.id = "no-position"
    entity.vehicle.timestamp = vehicle_ts
    return bytes(message.SerializeToString())


def test_a_record_with_no_clock_anywhere_is_dropped() -> None:
    """Neither the vehicle nor the header carried a time, so nothing dates the fix."""
    parsed = gtfsrt.parse_records(one_vehicle(), feed=feed(), now=CAPTURED_AT)
    assert parsed.records == ()
    assert parsed.drops[gtfsrt.DROP_NO_TIMESTAMP] == 1


def test_an_epoch_outside_the_representable_range_is_dropped_not_raised() -> None:
    parsed = gtfsrt.parse_records(one_vehicle(vehicle_ts=2**62), feed=feed(), now=CAPTURED_AT)
    assert parsed.records == ()
    assert parsed.drops[gtfsrt.DROP_NO_TIMESTAMP] == 1


def test_an_entity_with_no_id_is_dropped_because_it_cannot_be_keyed() -> None:
    """Every one of 16,535 real vehicles carried one, so this is a guard, not a workaround."""
    payload = one_vehicle(entity_id="", vehicle_ts=int(CAPTURED_AT.timestamp()))
    parsed = gtfsrt.parse_records(payload, feed=feed(), now=CAPTURED_AT)
    assert parsed.records == ()
    assert parsed.drops[gtfsrt.DROP_NO_IDENTITY] == 1


def test_a_position_the_contract_refuses_is_counted_not_raised() -> None:
    """One corrupt record must never blank the layer, which is why the parse catches."""
    payload = one_vehicle(lat=200.0, vehicle_ts=int(CAPTURED_AT.timestamp()))
    parsed = gtfsrt.parse_records(payload, feed=feed(), now=CAPTURED_AT)
    assert parsed.records == ()
    assert parsed.drops[gtfsrt.DROP_UNMAPPABLE] == 1


def test_a_registry_file_of_the_wrong_length_is_refused(tmp_path: Path) -> None:
    """A truncated data file must fail loudly rather than quietly shrinking the layer."""
    short = tmp_path / "gtfsrt_feeds.csv"
    short.write_text(
        "feed_id,country,provider,name,url,licence,licence_url,attribution\n"
        "a,GB,Op,,https://x.invalid/vp,CC0 1.0,https://x.invalid/l,\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="expected"):
        gtfsrt._load_registry(short)


# ---------------------------------------------------------------- the merge key


def test_the_merge_key_is_the_feed_and_the_entity_never_the_vehicle_id() -> None:
    """1,901 vehicle ids were in use by more than one agency. '557' by nine of them."""
    parsed = parse("gtfsrt_metrotransit_null_island_live.pb", feed_id="agency-one")
    other = parse("gtfsrt_metrotransit_null_island_live.pb", feed_id="agency-two")
    assert parsed.records
    assert other.records
    keys = {gtfsrt.merge_key(v) for v in parsed.records}
    other_keys = {gtfsrt.merge_key(v) for v in other.records}
    assert not keys & other_keys
    shared_vehicle_ids = {v.vehicle_id for v in parsed.records if v.vehicle_id} & {
        v.vehicle_id for v in other.records if v.vehicle_id
    }
    assert shared_vehicle_ids, "the two passes must share vehicle ids for this to prove anything"


def test_the_merge_key_is_unique_within_one_feed() -> None:
    parsed = parse("gtfsrt_metrotransit_null_island_live.pb")
    keys = [gtfsrt.merge_key(v) for v in parsed.records]
    assert len(set(keys)) == len(keys)


def test_fix_time_is_the_observation_not_the_fetch() -> None:
    parsed = parse("gtfsrt_alterneo_all_optional_fields_live.pb")
    for vehicle in parsed.records:
        assert gtfsrt.fix_time(vehicle) == vehicle.observed_at
        assert gtfsrt.fix_time(vehicle) <= CAPTURED_AT


# ---------------------------------------------------------------- the client


FEED_URL = "https://feeds.invalid/vp"
LAST_MODIFIED = "Sat, 23 Aug 2026 10:00:00 GMT"
BODY = fixture_bytes("gtfsrt_alterneo_all_optional_fields_live.pb")


class Clock:
    """A hand-driven clock, so a cadence floor is asserted rather than slept through."""

    def __init__(self, start: datetime) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


@pytest.fixture
def clock() -> Clock:
    return Clock(CAPTURED_AT)


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(timeout=5.0) as client:
        yield client


@respx.mock(assert_all_called=True)
async def test_fetch_parses_a_live_body(
    respx_mock: respx.Router, http: httpx.AsyncClient, clock: Clock
) -> None:
    route = respx_mock.get(FEED_URL).mock(return_value=httpx.Response(200, content=BODY))
    client = gtfsrt.GtfsRtClient(http, clock=clock, feeds=(feed(FEED_URL),))

    parsed = await client.fetch(feed(FEED_URL))

    assert route.call_count == 1
    assert parsed is not None
    assert parsed.records


@respx.mock(assert_all_called=True)
async def test_the_host_floor_is_checked_before_the_request_not_after(
    respx_mock: respx.Router, http: httpx.AsyncClient, clock: Clock
) -> None:
    """A throttled host gets silence, not one more call it has to refuse."""
    route = respx_mock.get(FEED_URL).mock(return_value=httpx.Response(200, content=BODY))
    client = gtfsrt.GtfsRtClient(http, clock=clock, feeds=(feed(FEED_URL),))

    await client.fetch(feed(FEED_URL))
    with pytest.raises(gtfsrt.GtfsRtCoolingDownError):
        await client.fetch(feed(FEED_URL))

    assert route.call_count == 1

    clock.advance(gtfsrt.DEFAULT_MIN_INTERVAL_SECONDS + 1)
    await client.fetch(feed(FEED_URL))
    assert route.call_count == 2


@respx.mock(assert_all_called=True)
async def test_the_floor_survives_a_restart(
    respx_mock: respx.Router,
    http: httpx.AsyncClient,
    clock: Clock,
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    """In-memory rate state does not survive a restart, and a restart loop is hammering."""
    route = respx_mock.get(FEED_URL).mock(return_value=httpx.Response(200, content=BODY))
    cache = DiskCache(tmp_path_factory.mktemp("cache"))
    first = gtfsrt.GtfsRtClient(http, cache=cache, clock=clock, feeds=(feed(FEED_URL),))
    await first.fetch(feed(FEED_URL))

    restarted = gtfsrt.GtfsRtClient(http, cache=cache, clock=clock, feeds=(feed(FEED_URL),))
    with pytest.raises(gtfsrt.GtfsRtCoolingDownError):
        await restarted.fetch(feed(FEED_URL))

    assert route.call_count == 1


@respx.mock(assert_all_called=True)
async def test_a_304_means_the_held_records_stand_rather_than_an_empty_feed(
    respx_mock: respx.Router, http: httpx.AsyncClient, clock: Clock
) -> None:
    """33 of 39 feeds offering a validator honour it. Treating 304 as empty blanks the store."""
    respx_mock.get(FEED_URL).mock(
        side_effect=[
            httpx.Response(200, content=BODY, headers={"ETag": 'W/"abc"'}),
            httpx.Response(304),
        ]
    )
    client = gtfsrt.GtfsRtClient(http, clock=clock, feeds=(feed(FEED_URL),))

    first = await client.fetch(feed(FEED_URL))
    clock.advance(gtfsrt.DEFAULT_MIN_INTERVAL_SECONDS + 1)
    second = await client.fetch(feed(FEED_URL))

    assert first is not None
    assert second is None


@respx.mock(assert_all_called=True)
async def test_a_stored_validator_is_sent_back_on_the_next_call(
    respx_mock: respx.Router, http: httpx.AsyncClient, clock: Clock
) -> None:
    sent: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(
            200,
            content=BODY,
            headers={"ETag": 'W/"abc"', "Last-Modified": LAST_MODIFIED},
        )

    respx_mock.get(FEED_URL).mock(side_effect=record)
    client = gtfsrt.GtfsRtClient(http, clock=clock, feeds=(feed(FEED_URL),))

    await client.fetch(feed(FEED_URL))
    clock.advance(gtfsrt.DEFAULT_MIN_INTERVAL_SECONDS + 1)
    await client.fetch(feed(FEED_URL))

    assert "if-none-match" not in sent[0].headers
    assert sent[1].headers["if-none-match"] == 'W/"abc"'
    assert sent[1].headers["if-modified-since"] == LAST_MODIFIED


@respx.mock(assert_all_called=True)
async def test_a_throttling_response_holds_the_whole_host(
    respx_mock: respx.Router, http: httpx.AsyncClient, clock: Clock
) -> None:
    """A 420 or 429 binds the egress address, so it quiets every feed on that host."""
    respx_mock.get(FEED_URL).mock(return_value=httpx.Response(429, headers={"Retry-After": "600"}))
    sibling = feed("https://feeds.invalid/other", feed_id="sibling")
    client = gtfsrt.GtfsRtClient(http, clock=clock, feeds=(feed(FEED_URL), sibling))

    with pytest.raises(RateLimitedError):
        await client.fetch(feed(FEED_URL))

    held = client.not_before("feeds.invalid")
    assert held is not None
    assert held >= clock.now + timedelta(seconds=599)
    with pytest.raises(gtfsrt.GtfsRtCoolingDownError):
        await client.fetch(sibling)


@respx.mock(assert_all_called=True)
async def test_one_dead_agency_does_not_fail_the_sweep(
    respx_mock: respx.Router, http: httpx.AsyncClient, clock: Clock
) -> None:
    good = feed("https://good.invalid/vp", feed_id="good")
    dead = feed("https://dead.invalid/vp", feed_id="dead")
    unchanged = feed("https://quiet.invalid/vp", feed_id="quiet")
    respx_mock.get(good.url).mock(return_value=httpx.Response(200, content=BODY))
    respx_mock.get(dead.url).mock(return_value=httpx.Response(500))
    respx_mock.get(unchanged.url).mock(return_value=httpx.Response(304))
    client = gtfsrt.GtfsRtClient(http, clock=clock, feeds=(good, dead, unchanged))

    result = await client.sweep()

    assert result.records
    assert result.polled == 1
    assert result.unchanged == 1
    assert result.failed == 1
    assert "dead" in result.failures
    assert result.failures["dead"]


@respx.mock(assert_all_called=True)
async def test_a_body_that_is_not_a_feed_is_a_failure_not_a_crash(
    respx_mock: respx.Router, http: httpx.AsyncClient, clock: Clock
) -> None:
    body = fixture_bytes("gtfsrt_cobblinc_json_not_protobuf_http200_live.json")
    respx_mock.get(FEED_URL).mock(return_value=httpx.Response(200, content=body))
    client = gtfsrt.GtfsRtClient(http, clock=clock, feeds=(feed(FEED_URL),))

    result = await client.sweep()

    assert result.records == ()
    assert result.failed == 1


@respx.mock(assert_all_called=False)
async def test_a_sweep_skips_a_host_still_inside_its_floor(
    respx_mock: respx.Router, http: httpx.AsyncClient, clock: Clock
) -> None:
    respx_mock.get(FEED_URL).mock(return_value=httpx.Response(200, content=BODY))
    client = gtfsrt.GtfsRtClient(http, clock=clock, feeds=(feed(FEED_URL),))

    first = await client.sweep()
    second = await client.sweep()

    assert first.polled == 1
    assert second.polled == 0
    assert second.skipped == 1


@respx.mock(assert_all_called=True)
async def test_every_feed_on_a_host_is_read_in_one_pass(
    respx_mock: respx.Router, http: httpx.AsyncClient, clock: Clock
) -> None:
    """The floor gates the pass, not each request in it.

    Applied per request, a host with 99 feeds would refresh one of them per floor window and
    each feed would update every three hours. That was a real defect in the first version of
    this client and this test is why it did not ship.
    """
    one = feed("https://shared.invalid/a", feed_id="a")
    two = feed("https://shared.invalid/b", feed_id="b")
    respx_mock.get(one.url).mock(return_value=httpx.Response(200, content=BODY))
    respx_mock.get(two.url).mock(return_value=httpx.Response(200, content=BODY))
    client = gtfsrt.GtfsRtClient(http, clock=clock, feeds=(one, two))

    first = await client.sweep()
    second = await client.sweep()

    assert first.polled == 2
    assert first.skipped == 0
    assert second.polled == 0
    assert second.skipped == 2

    clock.advance(gtfsrt.DEFAULT_MIN_INTERVAL_SECONDS + 1)
    assert client.not_before("shared.invalid") is not None


@respx.mock(assert_all_called=False)
async def test_a_throttled_host_ends_its_pass_immediately(
    respx_mock: respx.Router, http: httpx.AsyncClient, clock: Clock
) -> None:
    """It has just asked us to stop. Its other 98 feeds must not hear it 98 more times."""
    one = feed("https://busy.invalid/a", feed_id="a")
    two = feed("https://busy.invalid/b", feed_id="b")
    three = feed("https://busy.invalid/c", feed_id="c")
    respx_mock.get(one.url).mock(return_value=httpx.Response(429, headers={"Retry-After": "600"}))
    later = respx_mock.get(two.url).mock(return_value=httpx.Response(200, content=BODY))
    client = gtfsrt.GtfsRtClient(http, clock=clock, feeds=(one, two, three))

    result = await client.sweep()

    assert later.call_count == 0
    assert result.failed == 1
    assert result.skipped == 2
    held = client.not_before("busy.invalid")
    assert held is not None
    assert held >= clock.now + timedelta(seconds=599)


def test_the_registry_spread_over_hosts_is_what_makes_a_per_host_floor_necessary() -> None:
    """55 hosts serve 262 feeds and 99 of them are on one. That is the whole argument."""
    counts: dict[str, int] = {}
    for row in gtfsrt.FEEDS:
        counts[row.host] = counts.get(row.host, 0) + 1
    busiest = max(counts.values())
    assert busiest > len(gtfsrt.FEEDS) / 4
    for host, feeds_on_host in counts.items():
        if feeds_on_host > 20:
            assert host in gtfsrt.HOST_MIN_INTERVAL_SECONDS


def test_the_client_exposes_the_registry_it_polls() -> None:
    """Injectable so a test can hold one feed, and readable so wiring can size the layer."""
    client = gtfsrt.GtfsRtClient(httpx.AsyncClient(), feeds=(feed(),))
    assert client.feeds == (feed(),)
    assert gtfsrt.GtfsRtClient(httpx.AsyncClient()).feeds == gtfsrt.FEEDS


@respx.mock(assert_all_called=True)
async def test_a_validator_survives_a_restart(
    respx_mock: respx.Router,
    http: httpx.AsyncClient,
    clock: Clock,
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    """The saving is only real if the ETag outlives the process that learned it."""
    sent: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(
            200, content=BODY, headers={"ETag": 'W/"abc"', "Last-Modified": LAST_MODIFIED}
        )

    respx_mock.get(FEED_URL).mock(side_effect=record)
    cache = DiskCache(tmp_path_factory.mktemp("cache"))
    first = gtfsrt.GtfsRtClient(http, cache=cache, clock=clock, feeds=(feed(FEED_URL),))
    await first.fetch(feed(FEED_URL))

    clock.advance(gtfsrt.DEFAULT_MIN_INTERVAL_SECONDS + 1)
    restarted = gtfsrt.GtfsRtClient(http, cache=cache, clock=clock, feeds=(feed(FEED_URL),))
    await restarted.fetch(feed(FEED_URL))

    assert "if-none-match" not in sent[0].headers
    assert sent[1].headers["if-none-match"] == 'W/"abc"'
    assert sent[1].headers["if-modified-since"] == LAST_MODIFIED


@respx.mock(assert_all_called=True)
async def test_an_ordinary_floor_never_shortens_a_backoff(
    respx_mock: respx.Router,
    http: httpx.AsyncClient,
    clock: Clock,
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    """The 429 sets ten minutes and the pass that provoked it then sets thirty seconds.

    Both fire, in that order, so without a hold that only ever extends the provider's own
    figure would be silently replaced by ours and we would be back inside its window.
    """
    respx_mock.get(FEED_URL).mock(return_value=httpx.Response(429, headers={"Retry-After": "600"}))
    cache = DiskCache(tmp_path_factory.mktemp("cache"))
    client = gtfsrt.GtfsRtClient(http, cache=cache, clock=clock, feeds=(feed(FEED_URL),))

    with pytest.raises(RateLimitedError):
        await client.fetch(feed(FEED_URL))

    held = client.not_before("feeds.invalid")
    assert held is not None
    assert held >= clock.now + timedelta(seconds=599)

    restarted = gtfsrt.GtfsRtClient(http, cache=cache, clock=clock, feeds=(feed(FEED_URL),))
    restarted._hold_host("feeds.invalid", clock.now + timedelta(seconds=5))
    still_held = restarted.not_before("feeds.invalid")
    assert still_held is not None
    assert still_held >= clock.now + timedelta(seconds=599)


def test_an_entity_id_repeated_inside_one_message_is_counted_not_collapsed_silently() -> None:
    """FeedEntity.id is unique within a feed by specification, and a few feeds break that.

    Left to the store, the second record would overwrite the first and a bus would vanish
    with nothing anywhere saying so.
    """
    epoch = int(CAPTURED_AT.timestamp())
    message = gtfs_realtime_pb2.FeedMessage()
    message.header.gtfs_realtime_version = "2.0"
    message.header.timestamp = epoch
    for lat, ts in ((51.5, epoch - 300), (52.5, epoch)):
        entity = message.entity.add()
        entity.id = "repeated"
        entity.vehicle.position.latitude = lat
        entity.vehicle.position.longitude = -0.12
        entity.vehicle.timestamp = ts

    parsed = gtfsrt.parse_records(message.SerializeToString(), feed=feed(), now=CAPTURED_AT)

    assert len(parsed.records) == 1
    assert parsed.drops[gtfsrt.DROP_DUPLICATE_ENTITY] == 1
    assert parsed.records[0].point.lat == pytest.approx(52.5)


def test_a_repeated_entity_id_keeps_the_newer_fix_whatever_order_it_arrived_in() -> None:
    epoch = int(CAPTURED_AT.timestamp())
    message = gtfs_realtime_pb2.FeedMessage()
    message.header.gtfs_realtime_version = "2.0"
    message.header.timestamp = epoch
    for lat, ts in ((52.5, epoch), (51.5, epoch - 300)):
        entity = message.entity.add()
        entity.id = "repeated"
        entity.vehicle.position.latitude = lat
        entity.vehicle.position.longitude = -0.12
        entity.vehicle.timestamp = ts

    parsed = gtfsrt.parse_records(message.SerializeToString(), feed=feed(), now=CAPTURED_AT)

    assert len(parsed.records) == 1
    assert parsed.records[0].point.lat == pytest.approx(52.5)


def test_the_coverage_reason_names_a_country_count_not_continents() -> None:
    """It used to read "Europe and North America only" while Japan and Australia reported.

    Naming continents put the product in the position of telling a viewer in Tokyo there is no
    coverage in Tokyo while their screen showed buses. The country count cannot contradict the
    screen that way, because the licensed set is fixed and the reporting set is a subset of it.
    """
    reason = gtfsrt.COVERAGE_REASON
    assert str(len(gtfsrt.COUNTRIES)) in reason
    for continent in ("Europe", "North America", "Asia", "Oceania"):
        assert continent not in reason, f"{continent} is a reporting region, not an absent one"
    for absent in ("Latin America", "Africa", "the Middle East", "India", "China"):
        assert absent in reason


def test_the_reporting_countries_are_always_a_subset_of_the_licensed_ones() -> None:
    """The reason states 17 and a live read shows fewer. That is feeds asleep, not a lie."""
    assert len(gtfsrt.COUNTRIES) == 17
    assert {feed.country for feed in gtfsrt.FEEDS} == set(gtfsrt.COUNTRIES)


def test_the_staleness_bound_stays_above_every_host_floor_in_the_registry() -> None:
    """Otherwise our own rate discipline manufactures stale drops.

    A feed we choose to poll every 350 seconds cannot produce a report under 300 seconds old,
    so the bound and the floor would fight and the feed would be dropped for our cadence rather
    than for its own staleness.
    """
    hosts = {feed.host for feed in gtfsrt.FEEDS}
    governing = [floor for host, floor in gtfsrt.HOST_MIN_INTERVAL_SECONDS.items() if host in hosts]
    assert governing, "the floor map must govern at least one registry host"
    assert max(governing) < gtfsrt.MAX_REPORT_AGE_SECONDS
    assert gtfsrt.DEFAULT_MIN_INTERVAL_SECONDS < gtfsrt.MAX_REPORT_AGE_SECONDS


def test_the_staleness_bound_is_above_the_slowest_feed_publish_cadence() -> None:
    """Below about 120 seconds the kept share falls off a cliff, 64.3% at 60 seconds.

    Feed publish cadences are themselves 30 to 60 seconds, so a freshly fetched report is
    already that old and a tighter bound would drop live vehicles for being ordinary.
    """
    assert gtfsrt.MAX_REPORT_AGE_SECONDS >= 120.0


def test_a_report_between_five_and_fifteen_minutes_old_is_now_dropped() -> None:
    """The retune. It used to be kept, and a bus covers 2km in that time."""
    parsed = parse(
        "gtfsrt_alterneo_all_optional_fields_live.pb",
        at=CAPTURED_AT + timedelta(seconds=600),
    )
    assert parsed.records == ()
    assert parsed.drops[gtfsrt.DROP_STALE] > 0


def test_a_report_inside_the_bound_is_still_kept() -> None:
    parsed = parse(
        "gtfsrt_alterneo_all_optional_fields_live.pb",
        at=CAPTURED_AT + timedelta(seconds=120),
    )
    assert parsed.records
