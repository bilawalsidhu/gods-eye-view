"""The Nominatim geocoder: the coordinate types, the bbox order, the cache and the floor.

No network. respx intercepts at the transport, and every cache assertion counts HTTP calls
rather than reading private state, because the guarantee phase 4 is judged on is "Nominatim is
called at most once per unique query" and only a call count proves that.

Both payloads are real recordings from 2026-08-19.
``tests/fixtures/nominatim_search_london_live.json`` is the whole body for
``q=London&format=jsonv2&limit=5&addressdetails=1&extratags=1``: three results, the top one
named "Greater London" rather than "London".
``tests/fixtures/nominatim_search_address_live.json`` is the whole body for
``q=10+Downing+Street,+London``: one result, an office rather than a settlement, and the one
that proves ``address`` and ``extratags`` vanish from the payload when they are not requested.
"""

import json
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
import respx

import tracker.sources.nominatim as nominatim_module
from tests.conftest import fixture_bytes, fixture_json
from tracker.cache import FILE_NAME, DiskCache
from tracker.cache import key as cache_key
from tracker.contracts.base import ContractViolationError
from tracker.sources.base import RateLimitedError, SourceError
from tracker.sources.nominatim import (
    ATTRIBUTION,
    BASE_URL,
    BLOCK_COOLDOWN_SECONDS,
    CACHE_NAMESPACE,
    MIN_INTERVAL_SECONDS,
    PROVIDER_COOLDOWN_REASON,
    RESPONSE_FORMAT,
    SEARCH_LIMIT,
    SEARCH_PATH,
    SOURCE_NAME,
    NominatimClient,
    NominatimThrottledError,
    Place,
    normalise_query,
    parse_search,
)

LONDON_FIXTURE = "nominatim_search_london_live.json"
ADDRESS_FIXTURE = "nominatim_search_address_live.json"

SEARCH_URL = f"{BASE_URL}{SEARCH_PATH}"

FETCHED_AT = datetime(2026, 8, 20, 9, 0, 0, tzinfo=UTC)

GREATER_LONDON_BBOX = ("51.2867601", "51.6918741", "-0.5103751", "0.3340155")
"""The recorded boundingbox for the top London result, in the provider's own order:
south, north, west, east, all four as strings."""


class Clock:
    """A hand-driven clock, so the one-per-second floor is exact rather than slept through."""

    def __init__(self, start: datetime = FETCHED_AT) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


def json_bytes(body: object) -> bytes:
    return json.dumps(body).encode()


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    """A real httpx client. respx intercepts at the transport, so nothing leaves the process."""
    async with httpx.AsyncClient() as client:
        yield client


@pytest.fixture
def client(http: httpx.AsyncClient, clock: Clock) -> NominatimClient:
    return NominatimClient(http, clock=clock)


@pytest.fixture
def london_route() -> Iterator[respx.Route]:
    """One route serving the recorded three-result London body for any query."""
    with respx.mock(assert_all_called=True) as router:
        yield router.get(SEARCH_URL).respond(200, content=fixture_bytes(LONDON_FIXTURE))


# ---------------------------------------------------------------- parsing


def test_the_recorded_london_body_maps_to_three_places() -> None:
    """Names, ranks and licence read straight off the real payload."""
    parsed = parse_search(fixture_bytes(LONDON_FIXTURE), retrieved_at=FETCHED_AT)

    assert parsed.dropped == 0
    assert [place.name for place in parsed.records] == [
        "Greater London",
        "City of London",
        "London",
    ]
    top = parsed.records[0]
    assert top.osm_type == "relation"
    assert top.osm_id == 175342
    assert top.osm_key == "relation/175342"
    assert top.display_name == "Greater London, England, United Kingdom"
    assert top.importance == pytest.approx(0.8920997258748663)
    assert top.licence == ATTRIBUTION
    assert top.retrieved_at == FETCHED_AT
    assert top.source == SOURCE_NAME


def test_string_coordinates_become_floats_longitude_first() -> None:
    """``lat`` and ``lon`` arrive as strings and our contract is longitude first."""
    raw = fixture_json(LONDON_FIXTURE)[0]
    assert isinstance(raw["lat"], str)
    assert isinstance(raw["lon"], str)

    place = parse_search(fixture_bytes(LONDON_FIXTURE), retrieved_at=FETCHED_AT).records[0]

    assert place.point.lon == pytest.approx(-0.1277653)
    assert place.point.lat == pytest.approx(51.5074456)
    assert place.point.altitude_m is None


def test_the_extent_and_the_type_fields_are_not_carried() -> None:
    """The provider sends five fields nothing reads, so none of them reaches the domain.

    ``boundingbox`` is the sharp one: it is four strings latitude-first, a fifth bounding-box
    convention in a project that already has four, and search flies the camera to a point at a
    fixed altitude so no extent has a consumer. ``place_rank`` is the expensive one: carried
    behind the provider's documented ``le=30`` ceiling it would have dropped a whole live
    result the day the provider went past it, for a field with no reader.
    """
    raw = fixture_json(LONDON_FIXTURE)[0]
    assert tuple(raw["boundingbox"]) == GREATER_LONDON_BBOX
    assert raw["place_rank"] == 10

    place = parse_search(fixture_bytes(LONDON_FIXTURE), retrieved_at=FETCHED_AT).records[0]

    assert not {"bbox", "category", "place_type", "address_type", "place_rank"} & set(
        Place.model_fields
    )
    assert place.point.lon == pytest.approx(-0.1277653)


def test_an_address_result_is_not_a_settlement() -> None:
    """A geocoder answer can be an office at rank 30, and nothing here calls it a city."""
    parsed = parse_search(fixture_bytes(ADDRESS_FIXTURE), retrieved_at=FETCHED_AT)

    assert parsed.dropped == 0
    assert len(parsed.records) == 1
    place = parsed.records[0]
    assert place.name == "10 Downing Street"
    assert place.display_name.startswith("10 Downing Street")
    # The provider itself calls this an office at rank 30, and nothing here reads either.
    assert fixture_json(ADDRESS_FIXTURE)[0]["addresstype"] == "office"


def test_a_numeric_coordinate_drops_that_record_and_counts_it() -> None:
    """The wire model declares lat and lon as strings, so a type change is loud, not coerced."""
    body = fixture_json(LONDON_FIXTURE)
    body[0]["lat"] = 51.5074456

    parsed = parse_search(json_bytes(body), retrieved_at=FETCHED_AT)

    assert len(parsed.records) == 2
    assert parsed.dropped == 1


def test_an_unparseable_coordinate_drops_that_record_and_counts_it() -> None:
    body = fixture_json(LONDON_FIXTURE)
    body[1]["lon"] = "not-a-number"

    parsed = parse_search(json_bytes(body), retrieved_at=FETCHED_AT)

    assert [place.name for place in parsed.records] == ["Greater London", "London"]
    assert parsed.drops == {"lon 'not-a-number' is not a number": 1}


def test_a_malformed_bounding_box_costs_the_record_nothing() -> None:
    """Three edges is not a box, and it is no longer a reason to lose a real search result.

    The field is not modelled, so a provider that changes its shape cannot drop a place whose
    coordinates are perfectly good.
    """
    body = fixture_json(LONDON_FIXTURE)
    body[0]["boundingbox"] = ["51.2867601", "51.6918741", "-0.5103751"]

    parsed = parse_search(json_bytes(body), retrieved_at=FETCHED_AT)

    assert len(parsed.records) == 3
    assert parsed.dropped == 0


def test_a_record_with_no_name_falls_back_to_the_display_name() -> None:
    body = fixture_json(LONDON_FIXTURE)
    del body[0]["name"]

    place = parse_search(json_bytes(body), retrieved_at=FETCHED_AT).records[0]

    assert place.name == "Greater London"


def test_an_empty_result_list_is_not_an_error() -> None:
    parsed = parse_search(b"[]", retrieved_at=FETCHED_AT)

    assert parsed.records == ()
    assert parsed.dropped == 0


def test_a_body_that_is_not_a_list_is_a_contract_violation() -> None:
    """A shape change has to be loud. An HTML error page must not read as no results."""
    with pytest.raises(ContractViolationError, match="not a JSON list"):
        parse_search(b"<html>Bad Request</html>", retrieved_at=FETCHED_AT)


def test_normalise_query_folds_case_and_whitespace() -> None:
    assert normalise_query("  London  ") == "london"
    assert normalise_query("New\tYork") == "new york"
    assert normalise_query("   ") == ""


# ---------------------------------------------------------------- the client


async def test_the_request_pins_the_format_and_the_limit(
    client: NominatimClient, london_route: respx.Route
) -> None:
    """``format`` is pinned because ``json`` and ``jsonv2`` disagree on the category key."""
    await client.search("London")

    request = london_route.calls[0].request
    assert request.url.params["q"] == "london"
    assert request.url.params["format"] == RESPONSE_FORMAT
    assert request.url.params["limit"] == str(SEARCH_LIMIT)


async def test_the_same_query_is_fetched_once(
    client: NominatimClient, clock: Clock, london_route: respx.Route
) -> None:
    """Acceptance 2: at most one call per unique query. Caching is a condition of use here."""
    first = await client.search("London")
    clock.advance(MIN_INTERVAL_SECONDS * 10)
    second = await client.search("London")

    assert london_route.call_count == 1
    assert first == second


async def test_case_and_whitespace_do_not_buy_a_second_request(
    client: NominatimClient, clock: Clock, london_route: respx.Route
) -> None:
    await client.search("London")
    clock.advance(MIN_INTERVAL_SECONDS * 10)
    await client.search("  lONdOn ")

    assert london_route.call_count == 1


async def test_an_empty_answer_is_cached(client: NominatimClient, clock: Clock) -> None:
    """A query with no match will not grow one, and re-asking it is the faulty-client pattern."""
    with respx.mock(assert_all_called=True) as router:
        route = router.get(SEARCH_URL).respond(200, content=b"[]")

        assert await client.search("nowhere at all") == ()
        clock.advance(MIN_INTERVAL_SECONDS * 10)
        assert await client.search("nowhere at all") == ()

        assert route.call_count == 1


async def test_a_blank_query_never_reaches_the_network(client: NominatimClient) -> None:
    with respx.mock(assert_all_called=False) as router:
        route = router.get(SEARCH_URL).respond(200, content=b"[]")

        assert await client.search("   ") == ()

        assert route.call_count == 0


async def test_a_second_query_inside_the_floor_is_refused_before_the_network(
    client: NominatimClient, london_route: respx.Route
) -> None:
    """The floor is the provider's absolute maximum, so the refusal happens before the call."""
    await client.search("London")

    with pytest.raises(NominatimThrottledError) as caught:
        await client.search("Rotterdam")

    assert london_route.call_count == 1
    assert caught.value.retry_after_seconds == pytest.approx(MIN_INTERVAL_SECONDS)
    assert caught.value.source == SOURCE_NAME


async def test_the_floor_releases_after_a_second(
    client: NominatimClient, clock: Clock, london_route: respx.Route
) -> None:
    await client.search("London")
    clock.advance(MIN_INTERVAL_SECONDS)
    await client.search("Rotterdam")

    assert london_route.call_count == 2


async def test_a_cached_query_is_not_throttled(
    client: NominatimClient, london_route: respx.Route
) -> None:
    """The floor guards the network, not the cache. A repeated query stays instant."""
    await client.search("London")
    again = await client.search("London")

    assert london_route.call_count == 1
    assert len(again) == 3


async def test_the_published_floor_is_one_request_per_second() -> None:
    """Quoted from the OSMF policy: "an absolute maximum of 1 request per second"."""
    assert MIN_INTERVAL_SECONDS == 1.0


async def test_a_failure_is_not_cached(client: NominatimClient, clock: Clock) -> None:
    """A transient 500 must not become an hour of "no such place"."""
    with respx.mock(assert_all_called=True) as router:
        route = router.get(SEARCH_URL)
        route.side_effect = [
            httpx.Response(500, content=b"upstream broke"),
            httpx.Response(200, content=fixture_bytes(LONDON_FIXTURE)),
        ]

        with pytest.raises(httpx.HTTPStatusError):
            await client.search("London")
        clock.advance(MIN_INTERVAL_SECONDS)
        assert len(await client.search("London")) == 3

        assert route.call_count == 2


async def test_a_throttling_response_raises_with_the_providers_own_delay(
    client: NominatimClient,
) -> None:
    with respx.mock(assert_all_called=True) as router:
        router.get(SEARCH_URL).respond(429, headers={"Retry-After": "45"}, content=b"slow down")

        with pytest.raises(RateLimitedError) as caught:
            await client.search("London")

        assert caught.value.retry_after_seconds == pytest.approx(45.0)


async def test_the_providers_own_backoff_is_honoured_rather_than_recorded(
    client: NominatimClient, clock: Clock
) -> None:
    """A 429 asking for 120s used to be answered with another request one second later.

    120 requests inside the window the provider asked us to stay out of, while the reason the
    API handed back said we were backing off. Nominatim's policy names repeated identical
    queries as grounds for classifying a client as faulty and blocking it.
    """
    with respx.mock(assert_all_called=True) as router:
        route = router.get(SEARCH_URL).respond(
            429, headers={"Retry-After": "120"}, content=b"slow down"
        )

        with pytest.raises(RateLimitedError):
            await client.search("Nowhere Street 123")

        clock.advance(MIN_INTERVAL_SECONDS)
        for query in ("Nowhere Street 123", "Paris", "Berlin"):
            with pytest.raises(NominatimThrottledError) as caught:
                await client.search(query)
            clock.advance(MIN_INTERVAL_SECONDS)
            assert "backoff the provider asked for" in caught.value.detail

        assert route.call_count == 1, "requests went out inside the provider's own window"

        clock.advance(120.0)
        route.side_effect = None
        route.return_value = httpx.Response(200, content=fixture_bytes(LONDON_FIXTURE))
        assert len(await client.search("London")) == 3


async def test_a_block_page_holds_the_client_off_and_a_server_fault_does_not(
    client: NominatimClient, clock: Clock
) -> None:
    """403 is "stopped serving you"; 500 is "broke this once". They get different answers.

    The block page carries no ``Retry-After`` to read, so it takes the same generous default a
    ``Retry-After``-less 429 gets. A 500 keeps the one-per-second floor and nothing more,
    because ``sources/base.py`` is right that a 500 is worth retrying promptly.
    """
    with respx.mock(assert_all_called=True) as router:
        route = router.get(SEARCH_URL)
        route.side_effect = [
            httpx.Response(500, content=b"upstream broke"),
            httpx.Response(403, content=b"<html>blocked</html>"),
        ]

        with pytest.raises(httpx.HTTPStatusError):
            await client.search("first")
        clock.advance(MIN_INTERVAL_SECONDS)
        # The 500 left no cooldown, so this one really is sent.
        with pytest.raises(httpx.HTTPStatusError):
            await client.search("second")
        clock.advance(MIN_INTERVAL_SECONDS)

        with pytest.raises(NominatimThrottledError) as caught:
            await client.search("third")

        assert route.call_count == 2
        assert caught.value.retry_after_seconds == pytest.approx(
            BLOCK_COOLDOWN_SECONDS - MIN_INTERVAL_SECONDS
        )


async def test_a_response_where_nothing_maps_is_a_failure_and_is_not_cached(
    client: NominatimClient, clock: Clock
) -> None:
    """The provider answered and not one record mapped, which is not "no such place".

    Caching the empty tuple would answer that query for the life of the process, long after the
    provider was fixed, and the only trace would be an INFO log line: ``drops`` is read by no
    API surface. The wire model declares ``lat`` and ``lon`` as strings on purpose, so a switch
    to JSON numbers is exactly this case.
    """
    body = fixture_json(ADDRESS_FIXTURE)
    body[0]["lat"] = 51.5034878

    with respx.mock(assert_all_called=True) as router:
        route = router.get(SEARCH_URL)
        route.side_effect = [
            httpx.Response(200, content=json_bytes(body)),
            httpx.Response(200, content=fixture_bytes(ADDRESS_FIXTURE)),
        ]

        with pytest.raises(SourceError, match="none of them mapped"):
            await client.search("10 downing street")
        clock.advance(MIN_INTERVAL_SECONDS)
        assert len(await client.search("10 downing street")) == 1

        assert route.call_count == 2, "the failure was answered from cache"


async def test_an_empty_answer_is_still_cached(client: NominatimClient, clock: Clock) -> None:
    """No match is a real answer. Re-asking it is the pattern the provider calls faulty."""
    with respx.mock(assert_all_called=True) as router:
        route = router.get(SEARCH_URL).respond(200, content=b"[]")

        assert await client.search("nowhere at all") == ()
        clock.advance(MIN_INTERVAL_SECONDS * 10)
        assert await client.search("nowhere at all") == ()

        assert route.call_count == 1


async def test_records_the_provider_sends_that_will_not_map_are_counted(
    client: NominatimClient,
) -> None:
    body = fixture_json(LONDON_FIXTURE)
    body[0]["lon"] = "not-a-number"

    with respx.mock(assert_all_called=True) as router:
        router.get(SEARCH_URL).respond(200, content=json_bytes(body))

        places = await client.search("London")

        assert len(places) == 2
        assert sum(client.drops.values()) == 1


async def test_the_cache_evicts_its_oldest_entry_when_full(
    client: NominatimClient, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Caching is unbounded in time and bounded in size, so eviction has to work."""
    monkeypatch.setattr(nominatim_module, "MAX_CACHED_QUERIES", 2)

    with respx.mock(assert_all_called=True) as router:
        route = router.get(SEARCH_URL).respond(200, content=b"[]")

        for query in ("one", "two", "three"):
            await client.search(query)
            clock.advance(MIN_INTERVAL_SECONDS)

        await client.search("one")

        assert route.call_count == 4


def test_a_result_with_no_bounding_box_still_maps() -> None:
    """The box is absent on plenty of results and was never load-bearing."""
    body = fixture_json(LONDON_FIXTURE)
    del body[0]["boundingbox"]

    place = parse_search(json_bytes(body), retrieved_at=FETCHED_AT).records[0]

    assert place.point.lat == pytest.approx(51.5074456)


def test_a_result_with_nothing_to_label_it_is_dropped_and_counted() -> None:
    """No name and a display name that is punctuation leaves nothing to render."""
    body = fixture_json(LONDON_FIXTURE)
    body[0]["name"] = ""
    body[0]["display_name"] = ","

    parsed = parse_search(json_bytes(body), retrieved_at=FETCHED_AT)

    assert len(parsed.records) == 2
    assert parsed.drops == {"relation/175342 carries no usable name": 1}


# ---------------------------------------------------------------- surviving a restart


async def test_a_cached_answer_survives_a_restart(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """ "Results must be cached on your side" is a condition of use, not advice.

    A cache that empties on every restart does not meet it: the same query went back out after
    every stop and start, which is the pattern the OSMF names as faulty and blockable. The
    second client here is a different object over the same file and it sends nothing.
    """
    cache = DiskCache(tmp_path, clock=clock)
    with respx.mock(assert_all_called=True) as router:
        route = router.get(SEARCH_URL).respond(200, content=fixture_bytes(LONDON_FIXTURE))
        first = await NominatimClient(http, clock=clock, cache=cache).search("London")
        assert route.call_count == 1

    clock.advance(MIN_INTERVAL_SECONDS * 10)
    with respx.mock(assert_all_called=False) as router:
        blocked = router.get(SEARCH_URL).respond(200, content=fixture_bytes(LONDON_FIXTURE))
        restarted = await NominatimClient(http, clock=clock, cache=cache).search("London")

    assert blocked.call_count == 0
    assert [p.osm_key for p in restarted] == [p.osm_key for p in first]


async def test_a_cached_answer_is_keyed_on_the_folded_query(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """Case and stray whitespace never cost a second request, restart included."""
    cache = DiskCache(tmp_path, clock=clock)
    with respx.mock(assert_all_called=True) as router:
        router.get(SEARCH_URL).respond(200, content=fixture_bytes(LONDON_FIXTURE))
        await NominatimClient(http, clock=clock, cache=cache).search("London")

    clock.advance(MIN_INTERVAL_SECONDS * 10)
    with respx.mock(assert_all_called=False) as router:
        blocked = router.get(SEARCH_URL).respond(200, content=fixture_bytes(LONDON_FIXTURE))
        found = await NominatimClient(http, clock=clock, cache=cache).search("  LONDON ")

    assert blocked.call_count == 0
    assert found


async def test_the_provider_cooldown_survives_a_restart(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """A 403 block page carries no ``Retry-After``, so its cooldown is entirely ours to keep.

    Restarting inside it used to send the next keystroke straight at a provider that had just
    stopped serving us.
    """
    cache = DiskCache(tmp_path, clock=clock)
    with respx.mock(assert_all_called=True) as router:
        router.get(SEARCH_URL).respond(403)
        with pytest.raises(httpx.HTTPStatusError):
            await NominatimClient(http, clock=clock, cache=cache).search("London")

    clock.advance(MIN_INTERVAL_SECONDS * 10)
    with respx.mock(assert_all_called=False) as router:
        blocked = router.get(SEARCH_URL).respond(200, content=fixture_bytes(LONDON_FIXTURE))
        with pytest.raises(NominatimThrottledError, match=PROVIDER_COOLDOWN_REASON):
            await NominatimClient(http, clock=clock, cache=cache).search("Paris")

    assert blocked.call_count == 0


async def test_the_persisted_cooldown_lifts_when_it_expires(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """A cooldown delays and never latches, so a persisted one cannot silence search for good."""
    cache = DiskCache(tmp_path, clock=clock)
    with respx.mock(assert_all_called=True) as router:
        router.get(SEARCH_URL).respond(403)
        with pytest.raises(httpx.HTTPStatusError):
            await NominatimClient(http, clock=clock, cache=cache).search("London")

    clock.advance(BLOCK_COOLDOWN_SECONDS + 1.0)
    with respx.mock(assert_all_called=True) as router:
        route = router.get(SEARCH_URL).respond(200, content=fixture_bytes(LONDON_FIXTURE))
        assert await NominatimClient(http, clock=clock, cache=cache).search("Paris")

    assert route.call_count == 1


async def test_a_failed_query_is_never_cached_to_disk(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """The in-memory rule, extended: a transient error must not become a permanent answer.

    On disk it would be worse than before. An empty answer written for a query the provider
    was merely broken on would answer "no such place" for every future run, not just this one.
    """
    cache = DiskCache(tmp_path, clock=clock)
    with respx.mock(assert_all_called=True) as router:
        router.get(SEARCH_URL).respond(500)
        with pytest.raises(httpx.HTTPStatusError):
            await NominatimClient(http, clock=clock, cache=cache).search("London")

    assert cache.keys(f"{CACHE_NAMESPACE}:q:") == ()


async def test_a_client_with_no_cache_writes_nothing(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """The persistence is opt-in, and a deployment with no contact email holds no client."""
    with respx.mock(assert_all_called=True) as router:
        router.get(SEARCH_URL).respond(200, content=fixture_bytes(LONDON_FIXTURE))
        await NominatimClient(http, clock=clock).search("London")

    assert not (tmp_path / FILE_NAME).exists()


async def test_an_unreadable_cached_answer_is_dropped_and_refetched(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """Our own bug or a hand-edited file, never the provider's. It costs one request."""
    cache = DiskCache(tmp_path, clock=clock)
    cache.set(cache_key(CACHE_NAMESPACE, "q", "london"), '[{"nonsense": true}]')

    with respx.mock(assert_all_called=True) as router:
        route = router.get(SEARCH_URL).respond(200, content=fixture_bytes(LONDON_FIXTURE))
        found = await NominatimClient(http, clock=clock, cache=cache).search("London")

    assert route.call_count == 1
    assert found


async def test_the_one_per_second_slot_is_deliberately_not_persisted(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """A restart takes longer than a second, so persisting it buys nothing and costs a write.

    Asserted because the absence is a decision. A fresh client may take its first query
    immediately; the cooldown above is what holds a genuinely refused caller back.
    """
    cache = DiskCache(tmp_path, clock=clock)
    with respx.mock(assert_all_called=True) as router:
        router.get(SEARCH_URL).respond(200, content=fixture_bytes(LONDON_FIXTURE))
        await NominatimClient(http, clock=clock, cache=cache).search("London")

    with respx.mock(assert_all_called=True) as router:
        route = router.get(SEARCH_URL).respond(200, content=fixture_bytes(ADDRESS_FIXTURE))
        assert await NominatimClient(http, clock=clock, cache=cache).search("Downing Street")

    assert route.call_count == 1


async def test_a_second_block_after_the_first_has_lifted_starts_a_new_cooldown(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """A provider that blocks us twice gets backed off twice, from the second refusal.

    The arithmetic takes the longer of the new figure and whatever is left, so a cooldown is
    never shortened. With the first one fully elapsed there is nothing left, and the new one
    runs from now rather than from the old deadline.
    """
    cache = DiskCache(tmp_path, clock=clock)
    with respx.mock(assert_all_called=True) as router:
        router.get(SEARCH_URL).respond(403)
        client = NominatimClient(http, clock=clock, cache=cache)
        with pytest.raises(httpx.HTTPStatusError):
            await client.search("London")

        clock.advance(BLOCK_COOLDOWN_SECONDS + 1.0)
        with pytest.raises(httpx.HTTPStatusError):
            await client.search("Paris")

    expected = clock.now + timedelta(seconds=BLOCK_COOLDOWN_SECONDS)
    assert cache.get_time(cache_key(CACHE_NAMESPACE, "not_before")) == expected


async def test_a_response_where_nothing_maps_is_not_cached_to_disk_either(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """The phase 4 finding, one step worse once the cache is on disk.

    In memory, caching that empty answer reports the query as unknown for the life of the
    process. On disk it would report it as unknown for every process after this one, and a
    restart is what a person tries first. So the raise has to happen before the write, and the
    write is the thing this asserts: the key must not be there at all.
    """
    cache = DiskCache(tmp_path, clock=clock)
    body = fixture_json(ADDRESS_FIXTURE)
    body[0]["lat"] = 51.5034878

    with respx.mock(assert_all_called=True) as router:
        router.get(SEARCH_URL).respond(200, content=json_bytes(body))
        with pytest.raises(SourceError, match="none of them mapped"):
            await NominatimClient(http, clock=clock, cache=cache).search("10 downing street")

    assert cache.keys(f"{CACHE_NAMESPACE}:q:") == ()

    # And the restart really does go back to the provider rather than answering "no such place".
    clock.advance(MIN_INTERVAL_SECONDS)
    with respx.mock(assert_all_called=True) as router:
        route = router.get(SEARCH_URL).respond(200, content=fixture_bytes(ADDRESS_FIXTURE))
        restarted = NominatimClient(http, clock=clock, cache=cache)
        assert len(await restarted.search("10 downing street")) == 1

    assert route.call_count == 1
