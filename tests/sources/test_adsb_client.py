"""The ADS-B HTTP client: URL shapes, failover and rate-limit handling.

No network. Every request is intercepted, and ``assert_all_called=True`` means a test that
believes it exercised failover but did not is a failure rather than a false pass.

Rate limiting gets disproportionate attention because it is the one failure mode with a
lasting cost. These feeds are free, and a client that retries a throttled endpoint on a
tight loop gets its IP blocked.
"""

import json
from collections.abc import AsyncIterator

import httpx
import pytest
import respx

from tests.conftest import fixture_bytes
from tracker.contracts.base import ContractViolationError
from tracker.contracts.geo import BoundingBox
from tracker.sources.adsb import NAUTICAL_MILE_M, AdsbClient
from tracker.sources.base import (
    DEFAULT_RATE_LIMIT_BACKOFF_SECONDS,
    MAX_RATE_LIMIT_BACKOFF_SECONDS,
    RATE_LIMIT_STATUS_CODES,
    RateLimitedError,
    SourceError,
    retry_after_seconds,
)

PRIMARY = "https://api.adsb.lol"
FAILOVER = "https://opendata.adsb.fi/api"

MAX_RADIUS_NM = 250
"""The provider rejects a radius above this outright."""

ONE_AIRCRAFT = json.dumps(
    {
        "now": 1787165611001,
        "msg": "No error",
        "total": 1,
        "ac": [{"hex": "3c6444", "lat": 51.5, "lon": -0.12, "flight": "TEST123 "}],
    }
).encode()


def _expected_radius_nm(box: BoundingBox) -> int:
    """The radius the client will actually ask for, cap and floor included."""
    requested = int(box.enclosing_radius_m() / NAUTICAL_MILE_M) + 1
    return max(1, min(requested, MAX_RADIUS_NM))


def _payload(*records: dict[str, object]) -> bytes:
    return json.dumps({"now": 1787165611001, "msg": "No error", "ac": list(records)}).encode()


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    """A real httpx client. respx intercepts at the transport, so nothing leaves the process."""
    async with httpx.AsyncClient() as client:
        yield client


@pytest.fixture
def client(http: httpx.AsyncClient) -> AdsbClient:
    return AdsbClient(http, base_url=PRIMARY, failover_base_url=FAILOVER)


@pytest.fixture
def solo_client(http: httpx.AsyncClient) -> AdsbClient:
    """A client with no failover, so a primary error has nowhere to go but out."""
    return AdsbClient(http, base_url=PRIMARY, failover_base_url=None)


# ---------------------------------------------------------------- URL shapes


@respx.mock(assert_all_called=True)
async def test_aircraft_near_builds_the_point_url(
    respx_mock: respx.Router, client: AdsbClient
) -> None:
    route = respx_mock.get(f"{PRIMARY}/v2/lat/51.5000/lon/-0.1200/dist/100").mock(
        return_value=httpx.Response(200, content=ONE_AIRCRAFT)
    )

    aircraft = await client.aircraft_near(lat=51.5, lon=-0.12, radius_nm=100)

    assert route.call_count == 1
    assert len(aircraft) == 1
    assert aircraft[0].callsign == "TEST123"
    assert aircraft[0].source == "adsb.lol"


@respx.mock(assert_all_called=True)
async def test_aircraft_near_caps_the_radius_at_250(
    respx_mock: respx.Router, client: AdsbClient
) -> None:
    route = respx_mock.get(f"{PRIMARY}/v2/lat/0.0000/lon/0.0000/dist/250").mock(
        return_value=httpx.Response(200, content=ONE_AIRCRAFT)
    )

    await client.aircraft_near(lat=0.0, lon=0.0, radius_nm=5_000)

    assert route.call_count == 1


@respx.mock(assert_all_called=True)
async def test_aircraft_near_floors_the_radius_at_one(
    respx_mock: respx.Router, client: AdsbClient
) -> None:
    route = respx_mock.get(f"{PRIMARY}/v2/lat/0.0000/lon/0.0000/dist/1").mock(
        return_value=httpx.Response(200, content=ONE_AIRCRAFT)
    )

    await client.aircraft_near(lat=0.0, lon=0.0, radius_nm=0)

    assert route.call_count == 1


@respx.mock(assert_all_called=True)
async def test_aircraft_near_rounds_coordinates_to_four_decimals(
    respx_mock: respx.Router, client: AdsbClient
) -> None:
    """Four decimal places is about eleven metres, far finer than any feed's accuracy."""
    route = respx_mock.get(f"{PRIMARY}/v2/lat/51.5074/lon/-0.1278/dist/50").mock(
        return_value=httpx.Response(200, content=ONE_AIRCRAFT)
    )

    await client.aircraft_near(lat=51.50735, lon=-0.12776, radius_nm=50)

    assert route.call_count == 1


@respx.mock(assert_all_called=True)
async def test_military_calls_the_mil_endpoint(
    respx_mock: respx.Router, client: AdsbClient
) -> None:
    route = respx_mock.get(f"{PRIMARY}/v2/mil").mock(
        return_value=httpx.Response(200, content=fixture_bytes("adsb_mil_live.json"))
    )

    aircraft = await client.military()

    assert route.call_count == 1
    assert len(aircraft) == 310
    assert all(a.is_military for a in aircraft)


@respx.mock(assert_all_called=True)
async def test_by_type_uppercases_and_strips_the_designator(
    respx_mock: respx.Router, client: AdsbClient
) -> None:
    route = respx_mock.get(f"{PRIMARY}/v2/type/GLF6").mock(
        return_value=httpx.Response(200, content=fixture_bytes("adsb_type_glf6_live.json"))
    )

    aircraft = await client.by_type("  glf6 ")

    assert route.call_count == 1
    assert len(aircraft) == 18


# ---------------------------------------------------------------- bounding box


@respx.mock(assert_all_called=True)
async def test_aircraft_in_box_queries_the_circumscribed_circle_then_filters(
    respx_mock: respx.Router, client: AdsbClient
) -> None:
    """The feed only understands circles, so a viewport becomes circle plus local filter."""
    box = BoundingBox(west=-1.0, south=51.0, east=1.0, north=52.0)
    centre = box.centre
    radius = _expected_radius_nm(box)

    route = respx_mock.get(
        f"{PRIMARY}/v2/lat/{centre.lat:.4f}/lon/{centre.lon:.4f}/dist/{radius}"
    ).mock(
        return_value=httpx.Response(
            200,
            content=_payload(
                {"hex": "aaaaaa", "lat": 51.5, "lon": 0.0},
                {"hex": "bbbbbb", "lat": 48.8, "lon": 2.35},
                {"hex": "cccccc", "lat": 51.9, "lon": 0.9},
            ),
        )
    )

    aircraft = await client.aircraft_in_box(box)

    assert route.call_count == 1
    assert radius < MAX_RADIUS_NM, "this box should not need the cap"
    assert {a.icao24 for a in aircraft} == {"aaaaaa", "cccccc"}


@respx.mock(assert_all_called=True)
async def test_aircraft_in_box_handles_a_box_across_the_antimeridian(
    respx_mock: respx.Router, client: AdsbClient
) -> None:
    box = BoundingBox(west=179.5, south=-0.5, east=-179.5, north=0.5)
    centre = box.centre
    radius = _expected_radius_nm(box)

    assert abs(centre.lon) == pytest.approx(180.0)

    respx_mock.get(f"{PRIMARY}/v2/lat/{centre.lat:.4f}/lon/{centre.lon:.4f}/dist/{radius}").mock(
        return_value=httpx.Response(
            200,
            content=_payload(
                {"hex": "aaaaaa", "lat": 0.0, "lon": 179.8},
                {"hex": "bbbbbb", "lat": 0.0, "lon": -179.8},
                {"hex": "cccccc", "lat": 0.0, "lon": 170.0},
            ),
        )
    )

    aircraft = await client.aircraft_in_box(box)

    assert {a.icao24 for a in aircraft} == {"aaaaaa", "bbbbbb"}


@respx.mock(assert_all_called=True)
async def test_aircraft_in_box_caps_a_continent_sized_box(
    respx_mock: respx.Router, client: AdsbClient
) -> None:
    """A whole-world viewport still produces one legal request rather than a rejected one."""
    box = BoundingBox(west=-180.0, south=-90.0, east=180.0, north=90.0)
    centre = box.centre

    route = respx_mock.get(
        f"{PRIMARY}/v2/lat/{centre.lat:.4f}/lon/{centre.lon:.4f}/dist/{MAX_RADIUS_NM}"
    ).mock(return_value=httpx.Response(200, content=ONE_AIRCRAFT))

    await client.aircraft_in_box(box)

    assert route.call_count == 1


# ---------------------------------------------------------------- failover


@respx.mock(assert_all_called=True)
async def test_a_500_from_the_primary_fails_over(
    respx_mock: respx.Router, client: AdsbClient
) -> None:
    primary = respx_mock.get(f"{PRIMARY}/v2/mil").mock(return_value=httpx.Response(500))
    secondary = respx_mock.get(f"{FAILOVER}/v2/mil").mock(
        return_value=httpx.Response(200, content=ONE_AIRCRAFT)
    )

    aircraft = await client.military()

    assert primary.call_count == 1
    assert secondary.call_count == 1
    assert len(aircraft) == 1
    assert aircraft[0].source == "adsb.fi"


@respx.mock(assert_all_called=True)
async def test_a_transport_error_fails_over(respx_mock: respx.Router, client: AdsbClient) -> None:
    primary = respx_mock.get(f"{PRIMARY}/v2/mil").mock(
        side_effect=httpx.ConnectError("connection refused")
    )
    secondary = respx_mock.get(f"{FAILOVER}/v2/mil").mock(
        return_value=httpx.Response(200, content=ONE_AIRCRAFT)
    )

    aircraft = await client.military()

    assert primary.call_count == 1
    assert secondary.call_count == 1
    assert aircraft[0].source == "adsb.fi"


@respx.mock(assert_all_called=True)
async def test_a_rate_limit_from_the_primary_fails_over(
    respx_mock: respx.Router, client: AdsbClient
) -> None:
    """adsb.lol answered ``/v2/mil`` with HTTP 420 on the first live run of this app."""
    primary = respx_mock.get(f"{PRIMARY}/v2/mil").mock(
        return_value=httpx.Response(420, headers={"Retry-After": "60"})
    )
    secondary = respx_mock.get(f"{FAILOVER}/v2/mil").mock(
        return_value=httpx.Response(200, content=ONE_AIRCRAFT)
    )

    aircraft = await client.military()

    assert primary.call_count == 1
    assert secondary.call_count == 1
    assert aircraft[0].source == "adsb.fi"


@respx.mock(assert_all_called=True)
async def test_a_contract_violation_from_the_primary_fails_over(
    respx_mock: respx.Router, client: AdsbClient
) -> None:
    """A provider serving a different shape is as unavailable to us as one refusing us."""
    primary = respx_mock.get(f"{PRIMARY}/v2/mil").mock(
        return_value=httpx.Response(200, content=b'{"ac": "changed shape"}')
    )
    secondary = respx_mock.get(f"{FAILOVER}/v2/mil").mock(
        return_value=httpx.Response(200, content=ONE_AIRCRAFT)
    )

    aircraft = await client.military()

    assert primary.call_count == 1
    assert secondary.call_count == 1
    assert aircraft[0].source == "adsb.fi"


@respx.mock(assert_all_called=True)
async def test_a_failure_on_both_providers_raises_the_secondary_error(
    respx_mock: respx.Router, client: AdsbClient
) -> None:
    respx_mock.get(f"{PRIMARY}/v2/mil").mock(return_value=httpx.Response(500))
    respx_mock.get(f"{FAILOVER}/v2/mil").mock(return_value=httpx.Response(503))

    with pytest.raises(httpx.HTTPStatusError) as caught:
        await client.military()

    assert caught.value.response.status_code == 503


@respx.mock(assert_all_called=True)
async def test_the_failover_is_not_touched_when_the_primary_answers(
    respx_mock: respx.Router, client: AdsbClient
) -> None:
    primary = respx_mock.get(f"{PRIMARY}/v2/mil").mock(
        return_value=httpx.Response(200, content=ONE_AIRCRAFT)
    )

    aircraft = await client.military()

    assert primary.call_count == 1
    assert aircraft[0].source == "adsb.lol"
    assert len(respx_mock.routes) == 1, "no request should have reached the failover host"


# ---------------------------------------------------------------- no failover configured


@respx.mock(assert_all_called=True)
async def test_without_failover_a_server_error_propagates(
    respx_mock: respx.Router, solo_client: AdsbClient
) -> None:
    route = respx_mock.get(f"{PRIMARY}/v2/mil").mock(return_value=httpx.Response(500))

    with pytest.raises(httpx.HTTPStatusError):
        await solo_client.military()

    assert route.call_count == 1


@respx.mock(assert_all_called=True)
async def test_without_failover_a_contract_violation_propagates(
    respx_mock: respx.Router, solo_client: AdsbClient
) -> None:
    respx_mock.get(f"{PRIMARY}/v2/mil").mock(return_value=httpx.Response(200, content=b"not json"))

    with pytest.raises(ContractViolationError) as caught:
        await solo_client.military()

    assert caught.value.source == "adsb.lol"


@pytest.mark.parametrize("status", sorted(RATE_LIMIT_STATUS_CODES))
async def test_without_failover_a_rate_limit_propagates(
    solo_client: AdsbClient, status: int
) -> None:
    """429 is the standard code; 420 is what adsb.lol actually sends."""
    async with respx.mock(assert_all_called=True) as router:
        router.get(f"{PRIMARY}/v2/mil").mock(
            return_value=httpx.Response(status, headers={"Retry-After": "45"})
        )

        with pytest.raises(RateLimitedError) as caught:
            await solo_client.military()

    error = caught.value
    assert isinstance(error, SourceError)
    assert error.source == "adsb.lol"
    assert error.status_code == status
    assert error.retry_after_seconds == 45.0


# ---------------------------------------------------------------- Retry-After


@respx.mock(assert_all_called=True)
async def test_retry_after_is_honoured(respx_mock: respx.Router, solo_client: AdsbClient) -> None:
    respx_mock.get(f"{PRIMARY}/v2/mil").mock(
        return_value=httpx.Response(429, headers={"Retry-After": "90"})
    )

    with pytest.raises(RateLimitedError) as caught:
        await solo_client.military()

    assert caught.value.retry_after_seconds == 90.0


@respx.mock(assert_all_called=True)
async def test_a_non_numeric_retry_after_falls_back_to_the_default(
    respx_mock: respx.Router, solo_client: AdsbClient
) -> None:
    """An HTTP-date ``Retry-After`` is not parsed: a parse bug there becomes a hot retry loop."""
    respx_mock.get(f"{PRIMARY}/v2/mil").mock(
        return_value=httpx.Response(429, headers={"Retry-After": "Wed, 19 Aug 2026 12:20:00 GMT"})
    )

    with pytest.raises(RateLimitedError) as caught:
        await solo_client.military()

    assert caught.value.retry_after_seconds == DEFAULT_RATE_LIMIT_BACKOFF_SECONDS


@respx.mock(assert_all_called=True)
async def test_a_missing_retry_after_falls_back_to_the_default(
    respx_mock: respx.Router, solo_client: AdsbClient
) -> None:
    respx_mock.get(f"{PRIMARY}/v2/mil").mock(return_value=httpx.Response(429))

    with pytest.raises(RateLimitedError) as caught:
        await solo_client.military()

    assert caught.value.retry_after_seconds == DEFAULT_RATE_LIMIT_BACKOFF_SECONDS


@respx.mock(assert_all_called=True)
async def test_a_huge_retry_after_is_clamped(
    respx_mock: respx.Router, solo_client: AdsbClient
) -> None:
    """A provider asking for a day off must not silence a layer for a day."""
    respx_mock.get(f"{PRIMARY}/v2/mil").mock(
        return_value=httpx.Response(429, headers={"Retry-After": "86400"})
    )

    with pytest.raises(RateLimitedError) as caught:
        await solo_client.military()

    assert caught.value.retry_after_seconds == MAX_RATE_LIMIT_BACKOFF_SECONDS


@respx.mock(assert_all_called=True)
async def test_a_zero_retry_after_is_raised_to_one_second(
    respx_mock: respx.Router, solo_client: AdsbClient
) -> None:
    respx_mock.get(f"{PRIMARY}/v2/mil").mock(
        return_value=httpx.Response(429, headers={"Retry-After": "0"})
    )

    with pytest.raises(RateLimitedError) as caught:
        await solo_client.military()

    assert caught.value.retry_after_seconds == 1.0


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ({"Retry-After": "30"}, 30.0),
        ({"Retry-After": " 30 "}, 30.0),
        ({"Retry-After": "30.5"}, 30.5),
        ({"Retry-After": ""}, DEFAULT_RATE_LIMIT_BACKOFF_SECONDS),
        ({"Retry-After": "   "}, DEFAULT_RATE_LIMIT_BACKOFF_SECONDS),
        ({"Retry-After": "soon"}, DEFAULT_RATE_LIMIT_BACKOFF_SECONDS),
        ({}, DEFAULT_RATE_LIMIT_BACKOFF_SECONDS),
    ],
)
def test_retry_after_seconds_reads_the_header(header: dict[str, str], expected: float) -> None:
    assert retry_after_seconds(httpx.Response(429, headers=header)) == expected


def test_rate_limited_error_message_names_the_status_and_the_wait() -> None:
    error = RateLimitedError("adsb.lol", 420, 120.0)

    assert "adsb.lol" in str(error)
    assert "420" in str(error)
    assert "120s" in str(error)


def test_source_error_carries_its_source_and_detail() -> None:
    error = SourceError("celestrak", "firewalled")

    assert error.source == "celestrak"
    assert error.detail == "firewalled"
    assert str(error) == "celestrak: firewalled"


def test_the_base_url_trailing_slash_is_removed(http: httpx.AsyncClient) -> None:
    """Paths are joined with an f-string, so a trailing slash would double up."""
    client = AdsbClient(
        http,
        base_url="https://api.adsb.lol/",
        failover_base_url="https://opendata.adsb.fi/api/",
    )

    assert client._base_url == "https://api.adsb.lol"
    assert client._failover_base_url == "https://opendata.adsb.fi/api"


def test_no_failover_base_url_stays_none(http: httpx.AsyncClient) -> None:
    assert AdsbClient(http, base_url=PRIMARY)._failover_base_url is None
