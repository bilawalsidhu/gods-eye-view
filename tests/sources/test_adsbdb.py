"""The adsbdb registry lookup: the cache, the miss, and the traps that make it lie.

No network. respx intercepts at the transport, and every cache assertion counts HTTP calls
rather than reading private state, because the guarantee phase 3 is judged on is "no repeat
call for the same hex in a session" and only a call count proves that.

Both payloads are real recordings from 2026-08-19:
``tests/fixtures/adsbdb_aircraft_live.json`` is the whole 200 body for ``/v0/aircraft/A835AF``
and ``tests/fixtures/adsbdb_unknown_aircraft_live.json`` is the exact 404 body. The flight
route endpoint is not tested because it is not implemented: its data may not be copied,
published or incorporated into another database without the named individual's permission.
"""

import inspect
import json
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
import respx
from annotated_types import MaxLen
from pydantic import BaseModel, ValidationError

import tracker.sources.adsbdb as adsbdb_module
from tests.conftest import fixture_bytes, fixture_json, make_aircraft
from tracker.cache import FILE_NAME, DiskCache
from tracker.contracts.aircraft import Aircraft
from tracker.contracts.base import ContractViolationError
from tracker.sources.adsbdb import (
    BASE_URL,
    DEFAULT_CACHE_TTL_SECONDS,
    MAX_REQUESTS_PER_MINUTE,
    PROVIDER_LOWER_LIMIT_PER_MINUTE,
    PROVIDER_UPPER_LIMIT_PER_MINUTE,
    RATE_WINDOW_SECONDS,
    REGISTRATION_MAX_CHARS,
    SOURCE_NAME,
    TYPE_DESIGNATOR_MAX_CHARS,
    AdsbdbBudgetExhaustedError,
    AdsbdbLookup,
    AircraftRegistration,
    apply_to_aircraft,
    is_unknown_aircraft,
    normalise_lookup_key,
    parse_aircraft,
)
from tracker.sources.base import RateLimitedError

AIRCRAFT_FIXTURE = "adsbdb_aircraft_live.json"
UNKNOWN_FIXTURE = "adsbdb_unknown_aircraft_live.json"

HEX_UPPER = "A835AF"
HEX_LOWER = "a835af"
REGISTRATION = "N628TS"
RECORDED_OWNER = "Falcon Landing LLC"
"""``registered_owner`` off the recorded body. A company here, and a named individual on a
great many N-numbers, which is why this cache counts as personal data under ADR 008."""

FETCHED_AT = datetime(2026, 8, 20, 9, 0, 0, tzinfo=UTC)

UNKNOWN_HEX = "0201A0"
"""CN-RHF. A real airborne aircraft adsbdb does not hold, from the 2026-08-19 comparison."""

ANY_AIRCRAFT_URL = rf"{BASE_URL}/v0/aircraft/.+"


class Clock:
    """A hand-driven clock, so TTL boundaries are exact rather than slept through."""

    def __init__(self, start: datetime = FETCHED_AT) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


def url_for(key: str) -> str:
    return f"{BASE_URL}/v0/aircraft/{key}"


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
def lookup(http: httpx.AsyncClient, clock: Clock) -> AdsbdbLookup:
    return AdsbdbLookup(http, clock=clock)


@pytest.fixture
def aircraft_route() -> Iterator[respx.Route]:
    """One route serving the recorded 200 body for the recorded hex."""
    with respx.mock(assert_all_called=True) as router:
        yield router.get(url_for(HEX_UPPER)).respond(200, content=fixture_bytes(AIRCRAFT_FIXTURE))


@pytest.fixture
def unknown_route() -> Iterator[respx.Route]:
    """One route serving the recorded 404 body for an aircraft adsbdb does not hold."""
    with respx.mock(assert_all_called=True) as router:
        yield router.get(url_for(UNKNOWN_HEX)).respond(404, content=fixture_bytes(UNKNOWN_FIXTURE))


# ---------------------------------------------------------------- parsing


def test_the_recorded_body_maps_to_the_domain() -> None:
    """Every field the recon verified, read off the real payload."""
    record = parse_aircraft(fixture_bytes(AIRCRAFT_FIXTURE), retrieved_at=FETCHED_AT)

    assert record == AircraftRegistration(
        icao24=HEX_LOWER,
        registration=REGISTRATION,
        icao_type="G650",
        model_name="G650 ER",
        manufacturer="Gulfstream Aerospace",
        owner="Falcon Landing LLC",
        owner_country="United States",
        owner_country_iso="US",
        photo_url="https://airport-data.com/images/aircraft/001/598/001598299.jpg",
        photo_thumbnail_url=(
            "https://airport-data.com/images/aircraft/thumbnails/001/598/001598299.jpg"
        ),
        retrieved_at=FETCHED_AT,
        source=SOURCE_NAME,
    )


def test_the_address_is_folded_to_lowercase_to_match_the_feeds() -> None:
    """adsbdb sends A835AF; adsb.lol sends a835af, and Aircraft.icao24 is lowercase.

    Fold the wrong way and the registry key misses every record on the globe.
    """
    record = parse_aircraft(fixture_bytes(AIRCRAFT_FIXTURE), retrieved_at=FETCHED_AT)
    assert record.icao24 == HEX_LOWER
    assert fixture_json(AIRCRAFT_FIXTURE)["response"]["aircraft"]["mode_s"] == HEX_UPPER


def test_the_registration_keeps_its_country_prefix() -> None:
    """The bulk registries all strip it. adsbdb does not, and the join depends on knowing."""
    record = parse_aircraft(fixture_bytes(AIRCRAFT_FIXTURE), retrieved_at=FETCHED_AT)
    assert record.registration is not None
    assert record.registration.startswith("N")


def test_icao_type_is_the_designator_not_the_marketing_name() -> None:
    """FAA ACFTREF.MODEL is '767-322', so this field is the only ICAO designator we get."""
    record = parse_aircraft(fixture_bytes(AIRCRAFT_FIXTURE), retrieved_at=FETCHED_AT)
    assert record.icao_type == "G650"
    assert record.model_name == "G650 ER"


def test_the_flag_image_code_is_not_carried_as_an_operator() -> None:
    """registered_owner_operator_flag_code selects a flag image, not an operator."""
    body = fixture_json(AIRCRAFT_FIXTURE)
    assert "registered_owner_operator_flag_code" in body["response"]["aircraft"]
    assert "operator" not in AircraftRegistration.model_fields


def test_a_non_https_photo_url_is_dropped() -> None:
    """The proxy would make this request. An arbitrary URL reaching it is request forgery."""
    body = fixture_json(AIRCRAFT_FIXTURE)
    body["response"]["aircraft"]["url_photo"] = "file:///etc/passwd"
    body["response"]["aircraft"]["url_photo_thumbnail"] = "http://169.254.169.254/latest/"

    record = parse_aircraft(json_bytes(body), retrieved_at=FETCHED_AT)

    assert record.photo_url is None
    assert record.photo_thumbnail_url is None


def test_a_blank_string_becomes_none_rather_than_an_empty_owner() -> None:
    """An empty owner rendered on a card reads as a fact we hold. It is not one."""
    body = fixture_json(AIRCRAFT_FIXTURE)
    body["response"]["aircraft"]["registered_owner"] = "   "

    record = parse_aircraft(json_bytes(body), retrieved_at=FETCHED_AT)

    assert record.owner is None


def test_an_unusable_mode_s_is_a_contract_violation() -> None:
    """Without a six-digit hex there is no join key, so there is nothing to attach."""
    body = fixture_json(AIRCRAFT_FIXTURE)
    body["response"]["aircraft"]["mode_s"] = "NOTAHEX"

    with pytest.raises(ContractViolationError, match="unusable mode_s"):
        parse_aircraft(json_bytes(body), retrieved_at=FETCHED_AT)


def test_a_naive_retrieved_at_is_rejected() -> None:
    """A naive timestamp on an enrichment record dates it to the wrong hour, silently."""
    with pytest.raises(ValidationError, match="timezone-aware"):
        parse_aircraft(
            fixture_bytes(AIRCRAFT_FIXTURE),
            retrieved_at=FETCHED_AT.replace(tzinfo=None),
        )


def test_a_200_carrying_the_404_shaped_body_is_a_contract_violation() -> None:
    """response is an object on success and a bare string on a miss. A 200 string is neither."""
    with pytest.raises(ContractViolationError):
        parse_aircraft(fixture_bytes(UNKNOWN_FIXTURE), retrieved_at=FETCHED_AT)


def test_the_recorded_404_body_is_recognised_as_an_unknown_aircraft() -> None:
    assert is_unknown_aircraft(fixture_bytes(UNKNOWN_FIXTURE)) is True


@pytest.mark.parametrize(
    "body",
    [
        b'{"response": "unknown callsign"}',
        b"<html>404 Not Found</html>",
        b"",
        b"[]",
    ],
)
def test_any_other_404_body_is_not_an_unknown_aircraft(body: bytes) -> None:
    """'unknown callsign' is the other endpoint. HTML is a proxy. Neither is a real miss."""
    assert is_unknown_aircraft(body) is False


# ---------------------------------------------------------------- lookup keys


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("a835af", "A835AF"),
        (" A835AF ", "A835AF"),
        ("n628ts", "N628TS"),
        ("C-FPFW", "C-FPFW"),
        ("VH-ABC", "VH-ABC"),
    ],
)
def test_keys_are_folded_to_the_form_adsbdb_answers_on(raw: str, expected: str) -> None:
    assert normalise_lookup_key(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   ",
        "A",
        "../../etc/passwd",
        "a835af/../callsign/RAM801F",
        "A835AF?callsign=RAM801F",
        "A835AF A835AF",
        "A" * 13,
    ],
)
def test_an_unusable_key_is_refused_before_any_request(raw: str) -> None:
    """A feed's ``r`` field is untrusted text going into a URL path.

    The query-string case matters on its own: appending ``?callsign=`` to this endpoint
    returns flight-route data, which is the licence-blocked half of adsbdb.
    """
    with pytest.raises(ValueError, match="neither a Mode S address nor a registration"):
        normalise_lookup_key(raw)


# ---------------------------------------------------------------- the cache


async def test_a_second_lookup_of_the_same_hex_makes_no_request(
    lookup: AdsbdbLookup, aircraft_route: respx.Route
) -> None:
    """Acceptance criterion 3, counted at the transport."""
    first = await lookup.aircraft(HEX_UPPER)
    second = await lookup.aircraft(HEX_UPPER)

    assert first is not None
    assert second == first
    assert aircraft_route.call_count == 1


async def test_a_lowercase_hex_hits_the_same_cache_entry_as_an_uppercase_one(
    lookup: AdsbdbLookup, aircraft_route: respx.Route
) -> None:
    """adsb.lol sends lowercase and a registry sends uppercase. One aircraft, one request."""
    await lookup.aircraft(HEX_LOWER)
    await lookup.aircraft(HEX_UPPER)

    assert aircraft_route.call_count == 1


async def test_a_hit_is_also_cached_under_its_own_registration(
    lookup: AdsbdbLookup, aircraft_route: respx.Route
) -> None:
    """One route serves both identifiers, so asking the other way round costs nothing."""
    await lookup.aircraft(HEX_UPPER)
    by_registration = await lookup.aircraft(REGISTRATION)

    assert by_registration is not None
    assert by_registration.registration == REGISTRATION
    assert aircraft_route.call_count == 1


async def test_a_lookup_by_registration_is_also_cached_under_the_address(
    http: httpx.AsyncClient, clock: Clock
) -> None:
    with respx.mock(assert_all_called=True) as router:
        route = router.get(url_for(REGISTRATION)).respond(
            200, content=fixture_bytes(AIRCRAFT_FIXTURE)
        )
        lookup = AdsbdbLookup(http, clock=clock)

        await lookup.aircraft(REGISTRATION)
        by_hex = await lookup.aircraft(HEX_LOWER)

        assert by_hex is not None
        assert route.call_count == 1


async def test_an_unknown_aircraft_is_cached_so_it_is_not_re_fetched(
    lookup: AdsbdbLookup, unknown_route: respx.Route
) -> None:
    """About 19% of live aircraft miss. Re-fetching per card open is how you get blocked."""
    first = await lookup.aircraft(UNKNOWN_HEX)
    second = await lookup.aircraft(UNKNOWN_HEX)

    assert first is None
    assert second is None
    assert unknown_route.call_count == 1


async def test_a_failed_lookup_is_not_cached_and_is_retried(
    http: httpx.AsyncClient, clock: Clock
) -> None:
    """The difference the brief asks for: a miss is an answer, a 500 is not.

    A cached 500 would report "this airframe is not in the registry" for a day over what was
    a five-second outage.
    """
    with respx.mock(assert_all_called=True) as router:
        route = router.get(url_for(HEX_UPPER)).respond(500)
        lookup = AdsbdbLookup(http, clock=clock)

        for _ in range(2):
            with pytest.raises(httpx.HTTPStatusError):
                await lookup.aircraft(HEX_UPPER)

        assert route.call_count == 2


async def test_a_transport_failure_is_not_cached_either(
    http: httpx.AsyncClient, clock: Clock
) -> None:
    with respx.mock(assert_all_called=True) as router:
        route = router.get(url_for(HEX_UPPER)).mock(side_effect=httpx.ConnectTimeout("timed out"))
        lookup = AdsbdbLookup(http, clock=clock)

        for _ in range(2):
            with pytest.raises(httpx.ConnectTimeout):
                await lookup.aircraft(HEX_UPPER)

        assert route.call_count == 2


async def test_a_404_that_is_not_an_unknown_aircraft_is_not_cached_as_a_miss(
    http: httpx.AsyncClient, clock: Clock
) -> None:
    """A withdrawn endpoint 404s everything. Cached, that reads as no registry coverage."""
    with respx.mock(assert_all_called=True) as router:
        route = router.get(url_for(HEX_UPPER)).respond(404, html="<h1>Not Found</h1>")
        lookup = AdsbdbLookup(http, clock=clock)

        for _ in range(2):
            with pytest.raises(ContractViolationError, match="probably moved"):
                await lookup.aircraft(HEX_UPPER)

        assert route.call_count == 2


async def test_the_cache_expires_at_the_ttl(http: httpx.AsyncClient, clock: Clock) -> None:
    """Driven by the injected clock against the one TTL there is, which is a constant.

    There used to be a ``cache_ttl_seconds`` argument and a floor clamping it, and nothing in
    the product ever passed one: the floor guarded only against the argument's own existence.
    The clock reaches the same expiry branch, so both went.
    """
    with respx.mock(assert_all_called=True) as router:
        route = router.get(url_for(HEX_UPPER)).respond(200, content=fixture_bytes(AIRCRAFT_FIXTURE))
        lookup = AdsbdbLookup(http, clock=clock)

        await lookup.aircraft(HEX_UPPER)
        clock.advance(DEFAULT_CACHE_TTL_SECONDS - 1.0)
        await lookup.aircraft(HEX_UPPER)
        assert route.call_count == 1

        clock.advance(2.0)
        await lookup.aircraft(HEX_UPPER)
        assert route.call_count == 2


def test_the_cache_ttl_is_a_constant_that_no_caller_can_move(http: httpx.AsyncClient) -> None:
    """A zero TTL would turn the cache off and uncap the call rate against adsbdb's limiter.

    So there is nothing to pass: the constructor takes no TTL and the only value there is
    lives in code, next to the request budget it protects.
    """
    parameters = set(inspect.signature(AdsbdbLookup.__init__).parameters)
    assert not parameters & {"cache_ttl_seconds", "ttl", "ttl_seconds", "cache_seconds"}
    assert AdsbdbLookup(http)._ttl == timedelta(seconds=DEFAULT_CACHE_TTL_SECONDS)


def test_a_trailing_slash_on_the_base_url_is_removed(http: httpx.AsyncClient) -> None:
    """Paths are joined with an f-string, so a trailing slash would double up."""
    assert AdsbdbLookup(http, base_url=f"{BASE_URL}/")._base_url == BASE_URL


# ---------------------------------------------------------------- the request budget


def test_the_budget_is_half_the_provider_stated_floor() -> None:
    """adsbdb's own ratelimit.rs: 512 starts a 60s block, 1024 extends it to 300s."""
    assert PROVIDER_LOWER_LIMIT_PER_MINUTE == 512
    assert PROVIDER_UPPER_LIMIT_PER_MINUTE == 1024
    assert MAX_REQUESTS_PER_MINUTE == PROVIDER_LOWER_LIMIT_PER_MINUTE // 2


def test_no_constructor_or_setter_can_raise_the_budget(http: httpx.AsyncClient) -> None:
    """The cadence floor is a constant in code, not configuration."""
    parameters = set(inspect.signature(AdsbdbLookup.__init__).parameters)
    assert not parameters & {
        "max_requests_per_minute",
        "requests_per_minute",
        "rate_limit",
        "budget",
        "min_interval_seconds",
        "settings",
    }

    # Asserted on the module constant, which is where the rule lives. The class used to carry
    # a read-only property mirroring it that nothing in the product read.
    assert not hasattr(AdsbdbLookup(http), "max_requests_per_minute")
    assert MAX_REQUESTS_PER_MINUTE == 256


async def test_the_budget_refuses_before_touching_the_network(
    http: httpx.AsyncClient, clock: Clock
) -> None:
    """One enrichment pass over a full globe must not earn a five-minute block."""
    with respx.mock(assert_all_called=True) as router:
        route = router.get(url__regex=ANY_AIRCRAFT_URL).respond(
            404, content=fixture_bytes(UNKNOWN_FIXTURE)
        )
        lookup = AdsbdbLookup(http, clock=clock)

        for index in range(MAX_REQUESTS_PER_MINUTE):
            await lookup.aircraft(f"{index:06X}")

        assert route.call_count == MAX_REQUESTS_PER_MINUTE

        with pytest.raises(AdsbdbBudgetExhaustedError) as raised:
            await lookup.aircraft("FFFFFF")

        assert route.call_count == MAX_REQUESTS_PER_MINUTE, "no request may be made"
        assert raised.value.retry_after_seconds == RATE_WINDOW_SECONDS
        assert isinstance(raised.value, RateLimitedError)
        assert "no request made" in str(raised.value)


async def test_the_budget_window_rolls_forward(http: httpx.AsyncClient, clock: Clock) -> None:
    with respx.mock(assert_all_called=True) as router:
        route = router.get(url__regex=ANY_AIRCRAFT_URL).respond(
            404, content=fixture_bytes(UNKNOWN_FIXTURE)
        )
        lookup = AdsbdbLookup(http, clock=clock)

        for index in range(MAX_REQUESTS_PER_MINUTE):
            await lookup.aircraft(f"{index:06X}")

        clock.advance(RATE_WINDOW_SECONDS + 1.0)
        assert await lookup.aircraft("FFFFFF") is None
        assert route.call_count == MAX_REQUESTS_PER_MINUTE + 1


async def test_a_throttling_response_is_raised_with_the_providers_own_delay(
    http: httpx.AsyncClient, clock: Clock
) -> None:
    """No adsbdb response carries a rate-limit header, so this covers the case it starts to."""
    with respx.mock(assert_all_called=True) as router:
        router.get(url_for(HEX_UPPER)).respond(429, headers={"Retry-After": "300"})
        lookup = AdsbdbLookup(http, clock=clock)

        with pytest.raises(RateLimitedError) as raised:
            await lookup.aircraft(HEX_UPPER)

        assert raised.value.retry_after_seconds == 300.0
        assert raised.value.source == SOURCE_NAME


async def test_a_throttled_lookup_is_not_cached(http: httpx.AsyncClient, clock: Clock) -> None:
    with respx.mock(assert_all_called=True) as router:
        route = router.get(url_for(HEX_UPPER)).respond(429)
        lookup = AdsbdbLookup(http, clock=clock)

        for _ in range(2):
            with pytest.raises(RateLimitedError):
                await lookup.aircraft(HEX_UPPER)

        assert route.call_count == 2


# ---------------------------------------------------------------- wiring facts


def test_the_source_name_is_on_every_record() -> None:
    """ADR 010: every record names the provider that supplied it."""
    record = parse_aircraft(fixture_bytes(AIRCRAFT_FIXTURE), retrieved_at=FETCHED_AT)
    assert record.source == SOURCE_NAME


def test_the_record_is_frozen() -> None:
    record = parse_aircraft(fixture_bytes(AIRCRAFT_FIXTURE), retrieved_at=FETCHED_AT)
    with pytest.raises(ValidationError, match="frozen"):
        record.owner = "someone else"  # type: ignore[misc]  # ty: ignore[invalid-assignment]


def test_the_callsign_endpoint_is_not_implemented() -> None:
    """Its data may not be copied, published or incorporated into another database.

    A guard rather than a comment, because the combined ``?callsign=`` form on the aircraft
    route makes it a one-word change to start collecting licence-blocked data by accident.
    """
    named = [name for name in dir(adsbdb_module) if "callsign" in name.lower()]
    assert named == []
    assert "callsign" not in adsbdb_module.AIRCRAFT_PATH_TEMPLATE


def test_a_sparse_record_maps_with_nothing_invented() -> None:
    """adsbdb omits fields it has no value for. An absent field is None, never a default."""
    body = {"response": {"aircraft": {"mode_s": HEX_UPPER}}}

    record = parse_aircraft(json_bytes(body), retrieved_at=FETCHED_AT)

    assert record.icao24 == HEX_LOWER
    assert record.registration is None
    assert record.owner is None
    assert record.icao_type is None
    assert record.photo_url is None
    assert record.photo_thumbnail_url is None


async def test_a_record_with_no_registration_is_still_cached_under_its_address(
    http: httpx.AsyncClient,
) -> None:
    """The alias caching must not key an entry on a missing identifier.

    Also the only test that runs on the module's own wall-clock default, so the injected
    clock in every other test is not hiding a broken one.
    """
    body = {"response": {"aircraft": {"mode_s": HEX_UPPER}}}
    with respx.mock(assert_all_called=True) as router:
        route = router.get(url_for(HEX_UPPER)).respond(200, content=json_bytes(body))
        lookup = AdsbdbLookup(http)

        first = await lookup.aircraft(HEX_LOWER)
        second = await lookup.aircraft(HEX_UPPER)

        assert first is not None
        assert first.registration is None
        assert second == first
        assert route.call_count == 1


# ---------------------------------------------------------------- identifier widths


def max_length_of(model: type[BaseModel], field: str) -> int | None:
    """The declared width of one field, read off the contract rather than off a docstring."""
    return next(
        (
            item.max_length
            for item in model.model_fields[field].metadata
            if isinstance(item, MaxLen)
        ),
        None,
    )


@pytest.mark.parametrize(
    ("registry_field", "aircraft_field", "expected"),
    [
        ("registration", "registration", REGISTRATION_MAX_CHARS),
        ("icao_type", "type_designator", TYPE_DESIGNATOR_MAX_CHARS),
    ],
)
def test_the_registry_identifier_widths_match_the_aircraft_contract(
    registry_field: str, aircraft_field: str, expected: int
) -> None:
    """The two contracts have to agree, or a legal registry value costs a whole enrichment.

    This field took 20 and 8 against the aircraft contract's 12 and 4. Neither value could
    ever reach an aircraft record, because the merge revalidates, so the extra width bought
    nothing except the failure surfacing one layer too late: the enrichment service counted
    the whole record unmappable and the airframe lost its owner, its country and its class
    over one field. ``owner`` and ``owner_country`` were already aligned this way, which is
    the pattern rather than a new idea.
    """
    assert max_length_of(AircraftRegistration, registry_field) == expected
    assert max_length_of(Aircraft, aircraft_field) == expected


def test_an_over_long_type_designator_is_dropped_and_the_rest_of_the_record_survives() -> None:
    """One bad field costs one field. Doc 8643 gives a designator four characters."""
    body = fixture_json(AIRCRAFT_FIXTURE)
    body["response"]["aircraft"]["icao_type"] = "GLF6X"

    record = parse_aircraft(json_bytes(body), retrieved_at=FETCHED_AT)

    assert record.icao_type is None
    assert record.registration == REGISTRATION
    assert record.owner == RECORDED_OWNER
    assert record.owner_country == "United States"


def test_an_over_long_registration_is_dropped_rather_than_clipped() -> None:
    """Clipping would fabricate a tail number, which is a different aircraft.

    ``owner`` is clipped by :func:`~tracker.sources.adsbdb._text` because a clipped company
    name is still recognisably the same company. An identifier is not.
    """
    body = fixture_json(AIRCRAFT_FIXTURE)
    body["response"]["aircraft"]["registration"] = "N" + "1" * REGISTRATION_MAX_CHARS

    record = parse_aircraft(json_bytes(body), retrieved_at=FETCHED_AT)

    assert record.registration is None
    assert record.owner == RECORDED_OWNER


@pytest.mark.parametrize("field", ["registration", "icao_type"])
def test_a_blank_identifier_becomes_none_rather_than_an_empty_string(field: str) -> None:
    """Both contracts take a string of any length down to nothing, so "" would validate.

    An empty registration on a card reads as an aircraft with no tail number, which is a
    fact, when what happened is that adsbdb sent whitespace.
    """
    body = fixture_json(AIRCRAFT_FIXTURE)
    body["response"]["aircraft"][field] = "   "

    record = parse_aircraft(json_bytes(body), retrieved_at=FETCHED_AT)

    assert getattr(record, field) is None


def test_an_over_long_designator_costs_one_field_and_not_the_whole_enrichment() -> None:
    """The consequence the width alignment exists for, asserted through the real merge.

    Before it, this record raised on the way onto the aircraft and the enrichment service
    counted it unmappable, so the airframe kept its position and lost the owner as well as
    the designator.
    """
    body = fixture_json(AIRCRAFT_FIXTURE)
    body["response"]["aircraft"]["icao_type"] = "GLF6X"
    record = parse_aircraft(json_bytes(body), retrieved_at=FETCHED_AT)

    merged = apply_to_aircraft(make_aircraft(icao24=HEX_LOWER), record)

    assert merged.owner == RECORDED_OWNER
    assert merged.registered_country == "United States"
    assert merged.registration == REGISTRATION
    assert merged.type_designator is None


# ---------------------------------------------------------------- the removal hook


def cached_owners(lookup: AdsbdbLookup) -> set[str]:
    """Every owner name currently held in the cache, by any key.

    The one place this file reads private state, and it is the point of the test rather than
    a shortcut. A call count proves a key was re-fetched; only the cache itself proves the
    name is no longer in memory, which is what ADR 008 asks for.
    """
    return {
        entry.registration.owner
        for entry in lookup._cache.values()
        if entry.registration is not None and entry.registration.owner is not None
    }


async def test_forget_makes_the_owner_unreachable_by_every_key_it_was_stored_under(
    http: httpx.AsyncClient, clock: Clock
) -> None:
    """ADR 008's removal, applied to the cache that would otherwise keep serving the name.

    A registered owner is a named individual on a great many N-numbers, so this cache holds
    personal data with a one-day TTL. One answer is remembered under three keys, so clearing
    one and reporting success is the subtler version of the same bug.
    """
    with respx.mock(assert_all_called=True) as router:
        by_hex = router.get(url_for(HEX_UPPER)).respond(
            200, content=fixture_bytes(AIRCRAFT_FIXTURE)
        )
        by_registration = router.get(url_for(REGISTRATION)).respond(
            200, content=fixture_bytes(AIRCRAFT_FIXTURE)
        )
        lookup = AdsbdbLookup(http, clock=clock)
        await lookup.aircraft(HEX_LOWER)
        assert cached_owners(lookup) == {RECORDED_OWNER}

        assert lookup.forget(HEX_LOWER) == 2

        # The name is gone from every key, which no call count can show.
        assert cached_owners(lookup) == set()
        # And the alias key really does go back to the network rather than answering from
        # memory, which is the half a cache-dictionary assertion cannot show.
        await lookup.aircraft(REGISTRATION)
        assert by_registration.call_count == 1
        assert by_hex.call_count == 1


async def test_forget_drops_an_entry_left_under_a_superseded_registration(
    http: httpx.AsyncClient, clock: Clock
) -> None:
    """The sweep is on identity, not on the two keys the current record happens to name.

    A re-registered airframe leaves the old registration pointing at the old answer, and the
    old answer carries the old owner. Deleting only the keys the *current* record names would
    leave that name reachable, which is exactly the alias bug one step along.
    """
    old_body = fixture_json(AIRCRAFT_FIXTURE)
    old_body["response"]["aircraft"]["registration"] = "N100AA"
    old_body["response"]["aircraft"]["registered_owner"] = "Gulfstream Aerospace"
    with respx.mock(assert_all_called=True) as router:
        route = router.get(url_for(HEX_UPPER))
        route.side_effect = [
            httpx.Response(200, content=json_bytes(old_body)),
            httpx.Response(200, content=fixture_bytes(AIRCRAFT_FIXTURE)),
        ]
        lookup = AdsbdbLookup(http, clock=clock)
        await lookup.aircraft(HEX_UPPER)
        clock.advance(DEFAULT_CACHE_TTL_SECONDS + 1.0)
        await lookup.aircraft(HEX_UPPER)
        assert cached_owners(lookup) == {"Gulfstream Aerospace", RECORDED_OWNER}

        assert lookup.forget(REGISTRATION) == 3

        assert cached_owners(lookup) == set()


async def test_forget_drops_a_cached_miss_as_well_as_a_hit(
    lookup: AdsbdbLookup, unknown_route: respx.Route
) -> None:
    """A miss holds no name and is still this key's entry. Left behind, it lies about coverage."""
    await lookup.aircraft(UNKNOWN_HEX)

    assert lookup.forget(UNKNOWN_HEX) == 1

    await lookup.aircraft(UNKNOWN_HEX)
    assert unknown_route.call_count == 2


def test_forget_on_something_never_looked_up_is_a_no_op(lookup: AdsbdbLookup) -> None:
    """A removal for an airframe nobody opened a card on reports zero, not an error."""
    assert lookup.forget(REGISTRATION) == 0


def test_forget_refuses_a_key_that_is_neither_identifier(lookup: AdsbdbLookup) -> None:
    """A removal aimed at junk is loud rather than a silent success."""
    with pytest.raises(ValueError, match="neither a Mode S address nor a registration"):
        lookup.forget("!!")


# ---------------------------------------------------------------- ADR 008 and the disk


async def test_no_owner_name_reaches_the_disk_cache(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """The structural half of the ADR 008 decision, asserted as a consequence not an intent.

    Every other rate guard in ``sources/`` was moved onto the disk cache on 2026-08-20 so a
    restart could not look like hammering. This one was deliberately left in memory, because
    ``registered_owner`` is a named individual on a great many N-numbers and a restart clearing
    it is the right behaviour for a cache of named people. Nothing polls adsbdb, so a restart
    produces no burst to protect against in the first place.

    If someone later wires this onto the disk cache, this test fails, and the removal path has
    to arrive in the same change. That is the point of it: the trap is that a removal reporting
    success while the name sits in a file looks like it worked.
    """
    cache = DiskCache(tmp_path)
    # Written and read so the file exists and is a real database, or "nothing on disk" would
    # pass for the wrong reason.
    cache.set("unrelated", "sentinel")

    with respx.mock(assert_all_called=True) as router:
        router.get(url_for(HEX_UPPER)).respond(200, content=fixture_bytes(AIRCRAFT_FIXTURE))
        lookup = AdsbdbLookup(http, clock=clock)
        record = await lookup.aircraft(HEX_UPPER)

    assert record is not None
    assert record.owner == RECORDED_OWNER
    assert cache.keys() == ("unrelated",)
    assert RECORDED_OWNER.encode() not in (tmp_path / FILE_NAME).read_bytes()


def test_the_lookup_takes_no_cache_argument(http: httpx.AsyncClient) -> None:
    """No constructor path can put this cache on disk, so the decision cannot be made by accident.

    The same discipline as the absent TTL argument: a guard that only holds because nobody
    happened to pass an argument is not a guard.
    """
    assert "cache" not in inspect.signature(AdsbdbLookup.__init__).parameters


async def test_a_restart_leaves_no_owner_reachable_at_all(
    http: httpx.AsyncClient, clock: Clock
) -> None:
    """The other side of the decision: a restart is itself a removal for this cache.

    ``forget`` covers a removal inside one run. A restart covers everything, which is why not
    persisting is a stronger guarantee here than persisting plus an eviction path.
    """
    with respx.mock(assert_all_called=True) as router:
        route = router.get(url_for(HEX_UPPER)).respond(200, content=fixture_bytes(AIRCRAFT_FIXTURE))
        await AdsbdbLookup(http, clock=clock).aircraft(HEX_UPPER)

        restarted = AdsbdbLookup(http, clock=clock)
        assert cached_owners(restarted) == set()

        await restarted.aircraft(HEX_UPPER)
        assert route.call_count == 2
