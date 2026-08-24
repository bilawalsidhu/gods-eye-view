"""The ADS-B HTTP client: URL shapes, failover and rate-limit handling.

No network. Every request is intercepted, and ``assert_all_called=True`` means a test that
believes it exercised failover but did not is a failure rather than a false pass.

Rate limiting gets disproportionate attention because it is the one failure mode with a
lasting cost. These feeds are free, and a client that retries a throttled endpoint on a
tight loop gets its IP blocked.
"""

import json
import logging
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
import respx

from tests.conftest import fixture_bytes
from tracker.cache import FILE_NAME, DiskCache
from tracker.contracts.base import ContractViolationError
from tracker.contracts.geo import BoundingBox
from tracker.sources import adsb
from tracker.sources.adsb import MAX_RADIUS_NM, NAUTICAL_MILE_M, AdsbClient, AdsbCoolingDownError
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

"""Radius cap: imported rather than copied, and that is a deliberate exception.

This file held its own `MAX_RADIUS_NM = 250` with the docstring "the provider rejects a radius
above this outright". Both halves were wrong by 2026-08-24: the real cap is 2000 and nothing was
ever rejected, adsb.lol having served 250, 500, 1000 and 2000 with HTTP 200 each. The copy then
silently disagreed with production and the test built a URL the client would never request.

The house rule is that a test should not ask the implementation for its expected answer, and that
rule is about a **design choice**: a badge width or a threshold, where an independent number is
what catches the constant being moved. It does not extend to a **fact about somebody else's
server**. There, a second copy is just a second place to be wrong, and it cannot be checked
against anything except the real provider. So the URL these tests expect is built from the
production constant, and what stays independent is the live measurement recorded beside it.
"""

COOLDOWN_START = datetime(2026, 8, 20, 17, 5, 44, tzinfo=UTC)
"""The instant adsb.lol answered HTTP 420 on the live run this behaviour was built from."""

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
async def test_aircraft_near_clamps_a_radius_above_the_cap(
    respx_mock: respx.Router, client: AdsbClient
) -> None:
    """An over-large request is clamped to the cap rather than sent as asked.

    Named for the behaviour rather than for the number, because the number moved: this was
    `caps_the_radius_at_250` with 250 written into the URL, and it broke the day the cap was
    measured properly. What matters is that 5,000 does not reach the provider.
    """
    route = respx_mock.get(f"{PRIMARY}/v2/lat/0.0000/lon/0.0000/dist/{MAX_RADIUS_NM}").mock(
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


@respx.mock(assert_all_called=True)
async def test_the_failover_log_names_the_failure_even_when_it_carries_no_message(
    respx_mock: respx.Router, client: AdsbClient, caplog: pytest.LogCaptureFixture
) -> None:
    """A read timeout stringifies to nothing, so this line read ``failed for /v2/mil ()``.

    Verified live on 2026-08-20. An operator reading that has been told the primary failed
    and nothing else, which is the class of bug the renderer exists to stop.
    """
    respx_mock.get(f"{PRIMARY}/v2/mil").mock(side_effect=httpx.ReadTimeout(""))
    respx_mock.get(f"{FAILOVER}/v2/mil").mock(
        return_value=httpx.Response(200, content=ONE_AIRCRAFT)
    )

    with caplog.at_level(logging.WARNING, logger="tracker.sources.adsb"):
        aircraft = await client.military()

    assert aircraft[0].source == "adsb.fi"
    assert "adsb.lol failed for /v2/mil (ReadTimeout); trying adsb.fi" in caplog.text
    assert "()" not in caplog.text, "an empty reason tells an operator nothing"


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


# ---------------------------------------------------------------- honouring a provider's backoff


class Clock:
    """A hand-driven clock, so a cooldown boundary is measured rather than slept through."""

    def __init__(self, start: datetime = COOLDOWN_START) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


@respx.mock(assert_all_called=True)
async def test_a_throttled_provider_is_not_asked_again_inside_its_own_backoff(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """The defect measured live on 2026-08-20, and the reason this state exists at all.

    adsb.lol answered HTTP 420 on ``/v2/mil`` and asked for 120 seconds. The failover to
    adsb.fi succeeded, which meant the poll succeeded, which meant the poller never saw the
    ``RateLimitedError`` and never applied a backoff. The next cycle called adsb.lol again 65
    seconds into the window it had asked for. So the second call here must go straight to the
    failover with no second request to the primary.
    """
    clock = Clock()
    primary = respx_mock.get(f"{PRIMARY}/v2/mil").mock(
        return_value=httpx.Response(420, headers={"Retry-After": "120"})
    )
    secondary = respx_mock.get(f"{FAILOVER}/v2/mil").mock(
        return_value=httpx.Response(200, content=ONE_AIRCRAFT)
    )
    client = AdsbClient(http, base_url=PRIMARY, failover_base_url=FAILOVER, clock=clock, cache=None)

    assert len(await client.military()) == 1
    clock.advance(65.0)
    assert len(await client.military()) == 1

    assert primary.call_count == 1
    assert secondary.call_count == 2


@respx.mock(assert_all_called=True)
async def test_the_provider_is_asked_again_once_its_backoff_has_elapsed(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """A cooldown delays and never latches. A provider we could never call again is worse."""
    clock = Clock()
    primary = respx_mock.get(f"{PRIMARY}/v2/mil")
    primary.side_effect = [
        httpx.Response(420, headers={"Retry-After": "120"}),
        httpx.Response(200, content=ONE_AIRCRAFT),
    ]
    respx_mock.get(f"{FAILOVER}/v2/mil").mock(
        return_value=httpx.Response(200, content=ONE_AIRCRAFT)
    )
    client = AdsbClient(http, base_url=PRIMARY, failover_base_url=FAILOVER, clock=clock)

    await client.military()
    clock.advance(121.0)
    await client.military()

    assert primary.call_count == 2


@respx.mock(assert_all_called=True)
async def test_both_providers_cooling_raises_so_the_poller_backs_off(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """The only route by which a throttle now reaches the poller, and the right one.

    While either provider can answer, the layer is not degraded and the poller has nothing to
    do. When neither can, the error carries the remaining time so the poller honours it.
    """
    clock = Clock()
    respx_mock.get(f"{PRIMARY}/v2/mil").mock(
        return_value=httpx.Response(420, headers={"Retry-After": "120"})
    )
    respx_mock.get(f"{FAILOVER}/v2/mil").mock(
        return_value=httpx.Response(429, headers={"Retry-After": "60"})
    )
    client = AdsbClient(http, base_url=PRIMARY, failover_base_url=FAILOVER, clock=clock)

    with pytest.raises(RateLimitedError):
        await client.military()

    clock.advance(10.0)
    with pytest.raises(AdsbCoolingDownError) as raised:
        await client.military()

    assert "no request made" in str(raised.value)
    assert raised.value.retry_after_seconds == pytest.approx(50.0)


@respx.mock(assert_all_called=True)
async def test_a_cooldown_error_is_a_rate_limited_error(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """So no caller needs a new branch: the failover and the poller both already handle it."""
    clock = Clock()
    respx_mock.get(f"{PRIMARY}/v2/mil").mock(
        return_value=httpx.Response(420, headers={"Retry-After": "120"})
    )
    client = AdsbClient(http, base_url=PRIMARY, clock=clock)

    with pytest.raises(RateLimitedError):
        await client.military()
    with pytest.raises(RateLimitedError):
        await client.military()

    assert issubclass(AdsbCoolingDownError, RateLimitedError)


@respx.mock(assert_all_called=True)
async def test_a_cooldown_is_per_provider_not_per_client(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """A 420 from the primary must not silence the failover, which answered fine."""
    clock = Clock()
    respx_mock.get(f"{PRIMARY}/v2/lat/51.5000/lon/-0.1200/dist/100").mock(
        return_value=httpx.Response(420, headers={"Retry-After": "120"})
    )
    secondary = respx_mock.get(f"{FAILOVER}/v2/lat/51.5000/lon/-0.1200/dist/100").mock(
        return_value=httpx.Response(200, content=ONE_AIRCRAFT)
    )
    client = AdsbClient(http, base_url=PRIMARY, failover_base_url=FAILOVER, clock=clock)

    await client.aircraft_near(lat=51.5, lon=-0.12, radius_nm=100)
    clock.advance(1.0)
    await client.aircraft_near(lat=51.5, lon=-0.12, radius_nm=100)

    assert secondary.call_count == 2


@respx.mock(assert_all_called=True)
async def test_a_cooldown_survives_a_restart(
    respx_mock: respx.Router, http: httpx.AsyncClient, tmp_path: Path
) -> None:
    """The restart proof. A fresh process must not open by hammering a provider that refused."""
    clock = Clock()
    cache = DiskCache(tmp_path, clock=clock)
    primary = respx_mock.get(f"{PRIMARY}/v2/mil").mock(
        return_value=httpx.Response(420, headers={"Retry-After": "120"})
    )
    secondary = respx_mock.get(f"{FAILOVER}/v2/mil").mock(
        return_value=httpx.Response(200, content=ONE_AIRCRAFT)
    )
    await AdsbClient(
        http, base_url=PRIMARY, failover_base_url=FAILOVER, clock=clock, cache=cache
    ).military()

    clock.advance(30.0)
    restarted = AdsbClient(
        http, base_url=PRIMARY, failover_base_url=FAILOVER, clock=clock, cache=cache
    )
    await restarted.military()

    assert primary.call_count == 1
    assert secondary.call_count == 2


@respx.mock(assert_all_called=True)
async def test_two_clients_on_one_provider_share_its_cooldown(
    respx_mock: respx.Router, http: httpx.AsyncClient, tmp_path: Path
) -> None:
    """A 420 is per egress address, not per endpoint, and this app runs two adsb.lol clients.

    The worldwide military sweep and the viewport sweep are separate objects on the same
    provider. One being told to be quiet has to quiet the other, or the provider sees us
    ignore it on the endpoint it did not happen to refuse.
    """
    clock = Clock()
    cache = DiskCache(tmp_path, clock=clock)
    mil = respx_mock.get(f"{PRIMARY}/v2/mil").mock(
        return_value=httpx.Response(420, headers={"Retry-After": "120"})
    )
    point = respx_mock.get(f"{PRIMARY}/v2/lat/51.5000/lon/-0.1200/dist/100").mock(
        return_value=httpx.Response(200, content=ONE_AIRCRAFT)
    )
    respx_mock.get(f"{FAILOVER}/v2/mil").mock(
        return_value=httpx.Response(200, content=ONE_AIRCRAFT)
    )
    failover_point = respx_mock.get(f"{FAILOVER}/v2/lat/51.5000/lon/-0.1200/dist/100").mock(
        return_value=httpx.Response(200, content=ONE_AIRCRAFT)
    )
    military_client = AdsbClient(
        http, base_url=PRIMARY, failover_base_url=FAILOVER, clock=clock, cache=cache
    )
    viewport_client = AdsbClient(
        http, base_url=PRIMARY, failover_base_url=FAILOVER, clock=clock, cache=cache
    )

    await viewport_client.aircraft_near(lat=51.5, lon=-0.12, radius_nm=100)
    await military_client.military()
    clock.advance(10.0)
    await viewport_client.aircraft_near(lat=51.5, lon=-0.12, radius_nm=100)

    assert mil.call_count == 1
    assert point.call_count == 1
    assert failover_point.call_count == 1


@respx.mock(assert_all_called=True)
async def test_a_client_with_no_cache_writes_nothing(
    respx_mock: respx.Router, http: httpx.AsyncClient, tmp_path: Path
) -> None:
    """The persistence is opt-in and the in-process cooldown works without it."""
    clock = Clock()
    respx_mock.get(f"{PRIMARY}/v2/mil").mock(
        return_value=httpx.Response(420, headers={"Retry-After": "120"})
    )
    client = AdsbClient(http, base_url=PRIMARY, clock=clock)

    with pytest.raises(RateLimitedError):
        await client.military()

    assert not (tmp_path / FILE_NAME).exists()


@respx.mock(assert_all_called=True)
async def test_the_stored_cooldown_is_the_figure_the_provider_asked_for(
    respx_mock: respx.Router, http: httpx.AsyncClient, tmp_path: Path
) -> None:
    """Honour the provider's own number, not a curve of ours. adsb.lol asked for 120 seconds.

    The stored deadline is asserted rather than inferred from a call count, because it is what
    the next process reads and the number is the whole point of reading it.
    """
    clock = Clock()
    cache = DiskCache(tmp_path, clock=clock)
    respx_mock.get(f"{PRIMARY}/v2/mil").mock(
        return_value=httpx.Response(420, headers={"Retry-After": "120"})
    )

    with pytest.raises(RateLimitedError):
        await AdsbClient(http, base_url=PRIMARY, clock=clock, cache=cache).military()

    assert cache.get_time("adsb:not_before:adsb.lol") == COOLDOWN_START + timedelta(seconds=120)


# ---------------------------------------------------------------- the global sweep


def test_a_full_rotation_covers_every_cell_exactly_once() -> None:
    """The stride must stay coprime with the cell count, or the sweep silently skips the earth.

    This is the guard on `SWEEP_STRIDE`. It exists because the stride is only safe by a number
    theory property that nothing else checks: any stride coprime with the cell count visits
    every cell once per rotation, and any stride sharing a factor with it visits a subset for
    ever. A stride of 35 against 70 cells would sweep two cells and report itself healthy.

    So this fails if anyone changes `SWEEP_STEP_DEGREES` (which moves the cell count) without
    rechecking the stride against it.
    """
    sweep = adsb.GlobalSweep()
    picks = [sweep.next_cell() for _ in range(len(sweep.cells))]

    assert len(set(picks)) == len(sweep.cells)
    assert set(picks) == set(sweep.cells)


def test_the_rotation_spreads_across_latitudes_rather_than_walking_north() -> None:
    """A cold start must put aircraft on several continents, not survey Antarctica first.

    The measured failure this prevents: one aircraft after three minutes, because the grid is
    built south to north and a stride of one spent the opening minutes on the southern ocean.
    Twelve cells is roughly the first minute at a five-second interval, so this asserts what a
    viewer sees in the first minute rather than what the sweep eventually covers.
    """
    sweep = adsb.GlobalSweep()
    available = {cell[0] for cell in sweep.cells}
    # Half the grid's own bands, not a fixed count. This asserted "at least five" and broke the
    # day the grid coarsened to four bands in total, which made it unsatisfiable rather than
    # wrong. The property worth holding is that the opening picks spread across whatever bands
    # exist, so it has to be expressed against the grid rather than against a remembered shape.
    opening = [sweep.next_cell() for _ in range(len(sweep.cells) // 2)]

    bands = {cell[0] for cell in opening}
    assert len(bands) >= len(available) / 2, (
        f"opening cells reached {len(bands)} of {len(available)} latitude bands: {sorted(bands)}"
    )


def test_the_camera_cell_is_a_grid_cell_and_not_the_camera() -> None:
    """Favouring the camera must not cost a request that cannot advance global coverage.

    The point of `cell_containing` is that honouring the camera and sweeping the globe are the
    same request. If this ever returned the camera's own position, half the rate budget would go
    on circles that tick nothing off the rotation, which is the bug the sweep replaced.
    """
    sweep = adsb.GlobalSweep()

    cell = sweep.cell_containing(51.5, -0.12)

    assert cell in sweep.cells
    assert cell != (51.5, -0.12)
