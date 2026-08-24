"""One search box resolving everything: the ranking, the de-duplication and the network rule.

The six things phase 4 is judged on that belong to this module are all here. A live callsign,
an MMSI and "ISS" resolve from local stores inside 300 ms (measured, see
``test_local_lookups_are_far_inside_the_budget``). "London" resolves from the local city index
with zero network calls and puts the English one first. Nominatim is reached only when nothing
local matched, and then at most once per unique query.

**The city half runs on the real index over real rows.** No stand-in: the recorded slices of
``cities15000.txt`` go through the real parser in ``tracker.sources.geonames`` and into the real
:class:`~tracker.services.gazetteer.CityIndex`.
``tests/fixtures/geonames_cities15000_london_dead_extract.tsv`` holds both London rows (GB
8,961,989 against CA 422,324, which is why population alone settles it) plus the near misses
that make ranking interesting: Londonderry County Borough, New London and East London.
``tests/fixtures/geonames_cities15000_extract.tsv`` is the first 300 rows of the same file and
is used for one thing, the row whose name and ASCII spelling genuinely differ.

**Nothing here may touch the network.** The Nominatim client is built over a transport that
raises, so a test asserting "no HTTP" fails loudly rather than passing because a route happened
not to be hit. Where a test does want the geocoder it says so and uses the recorded body from
``tests/fixtures/nominatim_search_london_live.json``.
"""

import logging
import time
from collections.abc import AsyncIterator, Iterator

import httpx
import pytest
import respx

from tests.conftest import fixture_bytes, make_aircraft, make_satellite, make_vessel
from tracker.contracts.aircraft import Aircraft
from tracker.contracts.geo import Point
from tracker.contracts.satellite import Satellite
from tracker.contracts.vessel import Vessel
from tracker.services.gazetteer import CityIndex
from tracker.services.search import (
    CITIES_UNLOADED_REASON,
    IDENTIFIER_EXACT_SCORE,
    INDEX_MATCH_SCORE,
    MAX_REASON_CHARS,
    MIN_REMOTE_QUERY_CHARS,
    MIN_SUBSTRING_CHARS,
    NAME_EXACT_SCORE,
    PLACES_UNAVAILABLE_REASON,
    PREFIX_FACTOR,
    SHORT_QUERY_REASON,
    SearchGroup,
    SearchResponse,
    SearchService,
)
from tracker.services.store import EntityStore
from tracker.sources.geonames import parse_cities
from tracker.sources.nominatim import BASE_URL, SEARCH_PATH, NominatimClient

_log = logging.getLogger(__name__)

SEARCH_URL = f"{BASE_URL}{SEARCH_PATH}"
LONDON_FIXTURE = "nominatim_search_london_live.json"

LOCAL_BUDGET_SECONDS = 0.3
"""Phase 4 acceptance 1. The measured figures are two orders of magnitude inside it."""


LONDON_ROWS = "geonames_cities15000_london_dead_extract.tsv"
"""Nine recorded rows: both Londons, three near misses, and four dead places the parser drops."""

FIRST_300_ROWS = "geonames_cities15000_extract.tsv"
"""The head of the same file. Holds Saint John's, whose two spellings differ by an apostrophe."""

LONDON_GB_ID = "2643743"
LONDON_CA_ID = "6058560"
LONDONDERRY_ID = "2643734"


def city_index(fixture: str = LONDON_ROWS) -> CityIndex:
    """The real index over recorded rows, built through the real parser.

    Nothing about this can reach the network: :class:`CityIndex` holds no client and takes no
    URL, which is what makes "a city hit never leaves the process" structural.
    """
    return CityIndex(parse_cities(fixture_bytes(fixture)).records)


def _explode(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"the search touched the network: {request.url}")


@pytest.fixture
async def offline_http() -> AsyncIterator[httpx.AsyncClient]:
    """A client that cannot reach anything. Any request at all fails the test."""
    async with httpx.AsyncClient(transport=httpx.MockTransport(_explode)) as client:
        yield client


@pytest.fixture
async def real_http() -> AsyncIterator[httpx.AsyncClient]:
    """A real client for the tests that do want the geocoder. respx intercepts it."""
    async with httpx.AsyncClient() as client:
        yield client


@pytest.fixture
def london_route() -> Iterator[respx.Route]:
    """The recorded three-result London body, served for any query."""
    with respx.mock(assert_all_called=True) as router:
        yield router.get(SEARCH_URL).respond(200, content=fixture_bytes(LONDON_FIXTURE))


def aircraft_store(*aircraft: Aircraft) -> EntityStore[Aircraft]:
    store: EntityStore[Aircraft] = EntityStore(ttl_seconds=90.0)
    store.upsert_many((one.icao24, one) for one in aircraft)
    return store


def vessel_store(*vessels: Vessel) -> EntityStore[Vessel]:
    store: EntityStore[Vessel] = EntityStore(ttl_seconds=90.0)
    store.upsert_many((one.mmsi, one) for one in vessels)
    return store


def satellite_store(*satellites: Satellite) -> EntityStore[Satellite]:
    store: EntityStore[Satellite] = EntityStore(ttl_seconds=90.0)
    store.upsert_many((str(one.norad_cat_id), one) for one in satellites)
    return store


def group(response: SearchResponse, name: str) -> SearchGroup:
    """The one group with this name, or a failed assertion naming what came back instead."""
    matching = [item for item in response.groups if item.name == name]
    assert matching, f"no {name} group in {[item.name for item in response.groups]}"
    return matching[0]


def hit_count(response: SearchResponse) -> int:
    """Hits across every group. A test helper: nothing in the product asks this question."""
    return sum(len(item.hits) for item in response.groups)


# ---------------------------------------------------------------- live movers


async def test_an_exact_callsign_resolves_the_aircraft() -> None:
    service = SearchService(aircraft=[aircraft_store(make_aircraft("4ca7b3", callsign="RYR8GR"))])

    hits = group(await service.search("ryr8gr"), "aircraft").hits

    assert len(hits) == 1
    assert hits[0].entity_id == "4ca7b3"
    assert hits[0].label == "RYR8GR"
    assert hits[0].score == IDENTIFIER_EXACT_SCORE
    assert hits[0].point is not None


async def test_an_aircraft_resolves_by_hex_and_by_registration() -> None:
    service = SearchService(
        aircraft=[aircraft_store(make_aircraft("a835af", callsign="N628TS", registration="N628TS"))]
    )

    by_hex = group(await service.search("A835AF"), "aircraft").hits
    by_registration = group(await service.search("n628ts"), "aircraft").hits

    assert by_hex[0].entity_id == "a835af"
    assert by_registration[0].entity_id == "a835af"
    assert by_hex[0].detail == "N628TS · A835AF"


async def test_a_callsign_prefix_scores_below_an_exact_match() -> None:
    service = SearchService(
        aircraft=[
            aircraft_store(
                make_aircraft("4ca7b3", callsign="RYR8GR"),
                make_aircraft("4ca7b4", callsign="RYR8GRA"),
            )
        ]
    )

    hits = group(await service.search("ryr8gr"), "aircraft").hits

    assert [hit.entity_id for hit in hits] == ["4ca7b3", "4ca7b4"]
    assert hits[0].score == IDENTIFIER_EXACT_SCORE
    assert hits[1].score == pytest.approx(IDENTIFIER_EXACT_SCORE * PREFIX_FACTOR)


async def test_an_identifier_never_matches_mid_string() -> None:
    """ "992" sits inside a great many MMSIs and inside none that anybody meant."""
    service = SearchService(vessels=[vessel_store(make_vessel("230992610"))])

    response = await service.search("992610")

    assert hit_count(response) == 0


async def test_a_vessel_resolves_by_mmsi_imo_and_name() -> None:
    service = SearchService(
        vessels=[vessel_store(make_vessel("230992610", name="FINNMAID", imo=9319442))]
    )

    by_mmsi = group(await service.search("230992610"), "vessels").hits
    by_imo = group(await service.search("9319442"), "vessels").hits
    by_name = group(await service.search("finnmaid"), "vessels").hits

    assert by_mmsi[0].entity_id == "230992610"
    assert by_imo[0].score == IDENTIFIER_EXACT_SCORE
    assert by_name[0].score == NAME_EXACT_SCORE
    assert by_name[0].detail == "MMSI 230992610 · IMO 9319442"


async def test_iss_resolves_from_the_element_set_and_carries_no_position() -> None:
    """The browser propagates a satellite from its elements, so a hit has nothing to fly to."""
    service = SearchService(satellites=[satellite_store(make_satellite())])

    hits = group(await service.search("ISS"), "satellites").hits

    assert hits[0].entity_id == "25544"
    assert hits[0].label == "ISS (ZARYA)"
    assert hits[0].detail == "NORAD 25544 · 1998-067A"
    assert hits[0].point is None
    assert hits[0].score == pytest.approx(NAME_EXACT_SCORE * PREFIX_FACTOR)


async def test_a_satellite_resolves_by_catalogue_number() -> None:
    service = SearchService(satellites=[satellite_store(make_satellite())])

    hits = group(await service.search("25544"), "satellites").hits

    assert hits[0].score == IDENTIFIER_EXACT_SCORE


async def test_an_aircraft_in_two_stores_is_offered_once() -> None:
    """The military sweep is worldwide and the point feed is a radius, so they overlap."""
    military = make_aircraft("ae1234", callsign="RCH512", is_military=True)
    service = SearchService(aircraft=[aircraft_store(military), aircraft_store(military)])

    hits = group(await service.search("rch512"), "aircraft").hits

    assert len(hits) == 1


async def test_equal_scores_break_on_freshness() -> None:
    """Two aircraft, same callsign prefix. The one whose fix is newer comes first."""
    service = SearchService(
        aircraft=[
            aircraft_store(
                make_aircraft("400001", callsign="BAW1A", position_age_s=40.0),
                make_aircraft("400002", callsign="BAW1B", position_age_s=2.0),
            )
        ]
    )

    hits = group(await service.search("baw1"), "aircraft").hits

    assert [hit.entity_id for hit in hits] == ["400002", "400001"]


async def test_a_short_query_does_not_match_mid_name() -> None:
    """Bounded work as much as bounded noise: "ma" must not match the whole vessel store."""
    service = SearchService(vessels=[vessel_store(make_vessel("230992610", name="FINNMAID"))])

    assert hit_count(await service.search("ma")) == 0
    assert hit_count(await service.search("mai")) == 1
    assert len("mai") == MIN_SUBSTRING_CHARS


async def test_the_limit_is_per_group() -> None:
    service = SearchService(
        aircraft=[
            aircraft_store(
                *(make_aircraft(f"40000{index}", callsign=f"BAW{index}") for index in range(5))
            )
        ]
    )

    hits = group(await service.search("baw", limit=2), "aircraft").hits

    assert len(hits) == 2


async def test_an_empty_query_resolves_to_nothing() -> None:
    service = SearchService(aircraft=[aircraft_store(make_aircraft())])

    response = await service.search("   ")

    assert response.groups == ()
    assert response.query == ""


# ---------------------------------------------------------------- cities, offline


async def test_london_resolves_locally_with_the_english_one_first(
    offline_http: httpx.AsyncClient,
) -> None:
    """Phase 4 acceptance 3. The client raises on any request, so a network call fails this."""
    service = SearchService(cities=city_index(), places=NominatimClient(offline_http))

    response = await service.search("London")

    hits = group(response, "cities").hits
    assert [hit.entity_id for hit in hits] == [LONDON_GB_ID, LONDON_CA_ID, LONDONDERRY_ID]
    assert hits[0].label == "London"
    assert hits[0].detail == "GB · population 8,961,989"
    assert hits[0].point == Point(lon=-0.12574, lat=51.50853)
    assert hits[0].score == NAME_EXACT_SCORE
    assert hits[1].detail == "CA · population 422,324"
    assert hits[2].score == pytest.approx(NAME_EXACT_SCORE * PREFIX_FACTOR)
    assert [item.name for item in response.groups] == ["cities"]


async def test_a_city_that_only_contains_the_query_is_not_a_match(
    offline_http: httpx.AsyncClient,
) -> None:
    """The index prefix-matches rather than substring-matches, and this holds that line.

    East London ZA has 478,676 people, so a substring index would slot it between the two
    Londons and push Ontario down a place for no reason anybody could explain.
    """
    service = SearchService(cities=city_index(), places=NominatimClient(offline_http))

    hits = group(await service.search("london"), "cities").hits

    assert "East London" not in [hit.label for hit in hits]
    assert group(await service.search("east london"), "cities").hits[0].label == "East London"


async def test_a_city_matched_on_its_ascii_spelling_is_kept(
    offline_http: httpx.AsyncClient,
) -> None:
    """Saint John's is indexed under a typographic and a straight apostrophe. Both resolve.

    The two fold differently, so scoring the query against the display name alone would rank a
    real exact match at the floor. This is the case that proves the ASCII column is scored too.
    """
    service = SearchService(cities=city_index(FIRST_300_ROWS), places=NominatimClient(offline_http))

    hits = group(await service.search("saint john's"), "cities").hits

    assert hits[0].label == "Saint John\u2019s"
    assert hits[0].entity_id == "3576022"
    assert hits[0].score == NAME_EXACT_SCORE
    assert INDEX_MATCH_SCORE < NAME_EXACT_SCORE


async def test_a_live_identifier_outranks_a_city_name() -> None:
    service = SearchService(
        aircraft=[aircraft_store(make_aircraft("400abc", callsign="LONDON"))],
        cities=city_index(),
    )

    response = await service.search("london")

    assert [item.name for item in response.groups] == ["aircraft", "cities"]


async def test_an_exact_city_outranks_a_live_prefix() -> None:
    service = SearchService(
        aircraft=[aircraft_store(make_aircraft("400abc", callsign="LONDON1"))],
        cities=city_index(),
    )

    response = await service.search("london")

    assert [item.name for item in response.groups] == ["cities", "aircraft"]


async def test_no_city_index_means_no_city_group(offline_http: httpx.AsyncClient) -> None:
    """A partly wired app answers rather than raising."""
    service = SearchService(aircraft=[aircraft_store(make_aircraft(callsign="TEST123"))])

    response = await service.search("test123")

    assert [item.name for item in response.groups] == ["aircraft"]


# ---------------------------------------------------------------- places, on the network


async def test_the_geocoder_is_reached_only_when_nothing_local_matched(
    real_http: httpx.AsyncClient, london_route: respx.Route
) -> None:
    service = SearchService(cities=city_index(), places=NominatimClient(real_http))

    local = await service.search("London")
    assert london_route.call_count == 0
    assert group(local, "cities").hits

    remote = await service.search("downing street")

    assert london_route.call_count == 1
    assert group(remote, "places").hits[0].label == "Greater London"


async def test_the_geocoder_is_called_once_per_unique_query(
    real_http: httpx.AsyncClient, london_route: respx.Route
) -> None:
    """Phase 4 acceptance 2, in full: caching is a condition of use on this provider."""
    service = SearchService(places=NominatimClient(real_http))

    first = await service.search("Downing Street")
    second = await service.search("  downing street ")

    assert london_route.call_count == 1
    assert first.groups == second.groups


async def test_a_place_hit_carries_the_geocoder_position_and_provenance(
    real_http: httpx.AsyncClient, london_route: respx.Route
) -> None:
    service = SearchService(places=NominatimClient(real_http))

    hits = group(await service.search("greater london"), "places").hits

    assert hits[0].entity_id == "relation/175342"
    assert hits[0].detail == "Greater London, England, United Kingdom"
    assert hits[0].point is not None
    assert hits[0].point.lon == pytest.approx(-0.1277653)
    assert hits[0].score == NAME_EXACT_SCORE


async def test_with_no_contact_email_the_places_group_says_why() -> None:
    """``Settings.osm_services_available`` is false, so the wiring passes no client at all."""
    service = SearchService(cities=city_index())

    response = await service.search("somewhere with no local match")

    places = group(response, "places")
    assert places.hits == ()
    assert places.unavailable_reason == PLACES_UNAVAILABLE_REASON


async def test_a_very_short_query_never_reaches_the_geocoder(
    offline_http: httpx.AsyncClient,
) -> None:
    service = SearchService(places=NominatimClient(offline_http))

    places = group(await service.search("xy"), "places")

    assert places.unavailable_reason == SHORT_QUERY_REASON
    assert len("xy") < MIN_REMOTE_QUERY_CHARS


async def test_the_one_per_second_floor_degrades_the_group_rather_than_the_search(
    real_http: httpx.AsyncClient, london_route: respx.Route
) -> None:
    """A typeahead firing twice inside a second loses its remote results, not its local ones."""
    service = SearchService(places=NominatimClient(real_http))

    await service.search("downing street")
    throttled = await service.search("westminster bridge")

    assert london_route.call_count == 1
    places = group(throttled, "places")
    assert places.hits == ()
    assert places.unavailable_reason is not None
    assert "NominatimThrottledError" in places.unavailable_reason


async def test_a_geocoder_failure_degrades_the_group_and_names_the_reason(
    real_http: httpx.AsyncClient,
) -> None:
    with respx.mock(assert_all_called=True) as router:
        router.get(SEARCH_URL).respond(503, content=b"unavailable")
        service = SearchService(places=NominatimClient(real_http))

        places = group(await service.search("downing street"), "places")

        assert places.hits == ()
        assert places.unavailable_reason is not None


async def test_a_long_query_against_a_failing_geocoder_still_answers(
    real_http: httpx.AsyncClient,
) -> None:
    """A degraded group must not become an HTTP 500, however long the query is.

    An httpx status error renders the whole request URL, so the percent-encoded query rides
    inside the reason string: 79 ASCII characters, or 14 Cyrillic ones, pushed it past the
    contract's own 300-character ceiling and the validation error escaped the route. The route
    accepts a query of 200 characters, so this is ordinary input.
    """
    with respx.mock(assert_all_called=True) as router:
        router.get(SEARCH_URL).respond(503, content=b"unavailable")
        service = SearchService(places=NominatimClient(real_http))

        places = group(await service.search("a" * 200), "places")

        assert places.hits == ()
        assert places.unavailable_reason is not None
        assert len(places.unavailable_reason) <= MAX_REASON_CHARS


async def test_a_cyrillic_address_against_a_failing_geocoder_still_answers(
    real_http: httpx.AsyncClient,
) -> None:
    """Percent-encoding triples every character, so a real address overflows at 14 of them."""
    with respx.mock(assert_all_called=True) as router:
        router.get(SEARCH_URL).respond(503, content=b"unavailable")
        service = SearchService(places=NominatimClient(real_http))

        places = group(await service.search("Улица Тверская, Москва, Россия"), "places")

        assert places.unavailable_reason is not None
        assert len(places.unavailable_reason) <= MAX_REASON_CHARS


async def test_an_empty_gazetteer_says_so_and_never_reaches_the_geocoder(
    offline_http: httpx.AsyncClient,
) -> None:
    """Phase 4's degraded case, and the one the search box could not tell from "no such place".

    ``AppState`` always wires an index and fills it when the weekly download lands, so an empty
    one means the download has not landed or has failed. Dropping the empty cities group left
    the response silent about it, and the fall-through then pointed a typeahead at Nominatim for
    every city query, which is the systematic querying its own usage policy names as
    unacceptable use. The offline client fails the test if a single request goes out.
    """
    service = SearchService(cities=CityIndex(()), places=NominatimClient(offline_http))

    response = await service.search("London")

    cities = group(response, "cities")
    assert cities.hits == ()
    assert cities.unavailable_reason == CITIES_UNLOADED_REASON
    assert [item.name for item in response.groups] == ["cities"]


async def test_a_gazetteer_with_rows_in_it_still_falls_through_to_the_geocoder(
    real_http: httpx.AsyncClient, london_route: respx.Route
) -> None:
    """The guard is on the index being empty, not on the query missing it.

    An address is never in the gazetteer, so a loaded index must still let one through.
    """
    service = SearchService(cities=city_index(), places=NominatimClient(real_http))

    places = group(await service.search("downing street"), "places")

    assert london_route.call_count == 1
    assert places.hits != ()


async def test_a_malformed_geocoder_body_degrades_the_group(
    real_http: httpx.AsyncClient,
) -> None:
    """Nominatim errors are not always JSON, so a shape change must not raise out of search."""
    with respx.mock(assert_all_called=True) as router:
        router.get(SEARCH_URL).respond(200, content=b"<html>Bad Request</html>")
        service = SearchService(places=NominatimClient(real_http))

        places = group(await service.search("downing street"), "places")

        assert places.hits == ()
        assert places.unavailable_reason is not None
        assert "not a JSON list" in places.unavailable_reason


# ---------------------------------------------------------------- the budget


@pytest.fixture(scope="module")
def busy_stores() -> tuple[
    EntityStore[Aircraft], EntityStore[Aircraft], EntityStore[Vessel], EntityStore[Satellite]
]:
    """Stores at roughly the size a live globe reaches: 8,400 aircraft, 3,000 ships, 60 objects.

    Real identifiers in shape: six-digit hex addresses, MMSIs on the Finnish MID 230 the live
    Digitraffic capture uses, and catalogue numbers in the low thousands.
    """
    civil = aircraft_store(
        *(
            make_aircraft(f"{index:06x}", callsign=f"BAW{index:04d}", position_age_s=index % 60)
            for index in range(8_000)
        )
    )
    military = aircraft_store(
        *(
            make_aircraft(f"ae{index:04x}", callsign=f"RCH{index:04d}", is_military=True)
            for index in range(400)
        )
    )
    ships = vessel_store(
        *(
            make_vessel(f"230{index:06d}", name=f"NORDIC STAR {index}")
            for index in range(100_000, 103_000)
        )
    )
    objects = satellite_store(
        make_satellite(),
        *(
            make_satellite(norad_cat_id=index, object_name=f"STARLINK-{index}")
            for index in range(1_000, 1_059)
        ),
    )
    return civil, military, ships, objects


async def test_local_lookups_are_far_inside_the_budget(
    busy_stores: tuple[
        EntityStore[Aircraft], EntityStore[Aircraft], EntityStore[Vessel], EntityStore[Satellite]
    ],
) -> None:
    """Phase 4 acceptance 1, measured rather than asserted from a guess.

    Measured 2026-08-20 against 8,400 aircraft, 3,000 vessels and 60 element sets: 2.1 to
    3.0 ms per query over nine runs with coverage off, and 19.6 to 23.4 ms with it on, which is
    the figure the merge gate produces. The bound asserted is the acceptance criterion's own
    300 ms, thirteen times the slower figure, so a loaded box does not make this flaky.
    """
    civil, military, ships, objects = busy_stores
    assert (len(civil), len(military), len(ships), len(objects)) == (8_000, 400, 3_000, 60)
    service = SearchService(
        aircraft=[civil, military], vessels=[ships], satellites=[objects], cities=city_index()
    )

    for query in ("BAW7999", "230102999", "ISS"):
        started = time.perf_counter()
        response = await service.search(query)
        elapsed = time.perf_counter() - started

        _log.info(
            "search %r resolved %d hits in %.1f ms", query, hit_count(response), elapsed * 1e3
        )
        assert hit_count(response) >= 1
        assert elapsed < LOCAL_BUDGET_SECONDS, f"{query!r} took {elapsed * 1e3:.0f} ms"


async def test_a_vessel_with_no_name_still_resolves_by_mmsi() -> None:
    """108 of the 1,058 vessels in the live Digitraffic capture had a position and no name."""
    service = SearchService(vessels=[vessel_store(make_vessel("230992610", name=None))])

    hits = group(await service.search("230992610"), "vessels").hits

    assert hits[0].label == "230992610"
    assert hits[0].score == IDENTIFIER_EXACT_SCORE
