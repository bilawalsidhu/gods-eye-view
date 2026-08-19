"""Application wiring: the poller closures, the lifespan and the entry point.

The two poller closures in ``tracker.app`` are the only place the ADS-B client, the stores
and the viewport meet, so they are driven here with intercepted HTTP rather than left to be
discovered in production. The viewport branch matters: a client that has panned somewhere
must change which circle gets queried.
"""

import json
from collections.abc import AsyncIterator

import httpx
import pytest
import respx

from tests.conftest import fixture_bytes, make_aircraft
from tracker import __main__
from tracker.app import (
    ADSB_MIL_MIN_INTERVAL_SECONDS,
    ADSB_MIN_INTERVAL_SECONDS,
    ATTRIBUTIONS,
    build_state,
    create_app,
)
from tracker.config import Settings, get_settings
from tracker.contracts.geo import BoundingBox

PRIMARY = "https://api.adsb.lol"

TWO_AIRCRAFT = json.dumps(
    {
        "now": 1787165611001,
        "msg": "No error",
        "ac": [
            {"hex": "aaaaaa", "lat": 51.5, "lon": -0.12, "flight": "BAW123  "},
            {"hex": "bbbbbb", "lat": 51.6, "lon": 0.1, "flight": "EZY456  "},
        ],
    }
).encode()


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient() as client:
        yield client


def _settings(**overrides: object) -> Settings:
    return Settings(adsb_base_url=PRIMARY, adsb_failover_base_url="", **overrides)  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]


# ---------------------------------------------------------------- build_state


def test_build_state_registers_two_stores_and_two_pollers(http: httpx.AsyncClient) -> None:
    state = build_state(_settings(), http)

    assert len(state.pollers) == 2
    assert [p.name for p in state.pollers] == ["adsb.lol/point", "adsb.lol/mil"]
    assert state.hub.layers == ("aircraft", "military")
    assert len(state.aircraft) == 0
    assert len(state.military) == 0
    assert state.viewport is None
    assert state.attribution == ATTRIBUTIONS


def test_the_hard_cadence_floors_are_applied_below_configuration(
    http: httpx.AsyncClient,
) -> None:
    """A careless environment variable must not be able to speed either feed up."""
    state = build_state(_settings(adsb_poll_seconds=0.5), http)
    point, military = tuple(state.pollers)

    assert point.min_interval_seconds == ADSB_MIN_INTERVAL_SECONDS
    assert point.effective_interval == ADSB_MIN_INTERVAL_SECONDS
    assert military.min_interval_seconds == ADSB_MIL_MIN_INTERVAL_SECONDS
    assert military.effective_interval == ADSB_MIL_MIN_INTERVAL_SECONDS
    assert military.effective_interval > point.effective_interval


def test_a_slower_configured_cadence_is_honoured(http: httpx.AsyncClient) -> None:
    state = build_state(_settings(adsb_poll_seconds=60.0), http)
    point, military = tuple(state.pollers)

    assert point.effective_interval == 60.0
    assert military.effective_interval == 240.0


def test_the_health_provider_is_wired_to_the_poller_group(http: httpx.AsyncClient) -> None:
    state = build_state(_settings(), http)

    assert len(state.pollers.health()) == 2


# ---------------------------------------------------------------- the viewport poller


@respx.mock(assert_all_called=True)
async def test_the_viewport_poller_uses_the_configured_default_when_nothing_is_set(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    state = build_state(
        _settings(adsb_default_lat=51.5, adsb_default_lon=-0.12, adsb_radius_nm=120), http
    )
    route = respx_mock.get(f"{PRIMARY}/v2/lat/51.5000/lon/-0.1200/dist/120").mock(
        return_value=httpx.Response(200, content=TWO_AIRCRAFT)
    )
    poller = next(iter(state.pollers))

    assert await poller.run_once() is True

    assert route.call_count == 1
    assert poller.health.entity_count == 2
    assert state.aircraft.keys() == frozenset({"aaaaaa", "bbbbbb"})


@respx.mock(assert_all_called=True)
async def test_the_viewport_poller_follows_the_client_viewport(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    state = build_state(_settings(), http)
    state.viewport = BoundingBox(west=-1.0, south=51.0, east=1.0, north=52.0)
    centre = state.viewport.centre
    route = respx_mock.get(url__regex=rf"{PRIMARY}/v2/lat/{centre.lat:.4f}/lon/.*").mock(
        return_value=httpx.Response(200, content=TWO_AIRCRAFT)
    )
    poller = next(iter(state.pollers))

    await poller.run_once()

    assert route.call_count == 1
    assert state.aircraft.keys() == frozenset({"aaaaaa", "bbbbbb"})


@respx.mock(assert_all_called=True)
async def test_the_viewport_poller_upserts_rather_than_replacing(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """A viewport query knows nothing about aircraft outside it, so it must not evict them."""
    state = build_state(_settings(), http)
    respx_mock.get(url__startswith=f"{PRIMARY}/v2/lat/").mock(
        return_value=httpx.Response(200, content=TWO_AIRCRAFT)
    )
    state.aircraft.upsert("cccccc", make_aircraft("cccccc"))

    await next(iter(state.pollers)).run_once()

    assert state.aircraft.keys() == frozenset({"aaaaaa", "bbbbbb", "cccccc"})


@respx.mock(assert_all_called=True)
async def test_a_failing_viewport_poll_marks_the_feed_unhealthy(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    state = build_state(_settings(), http)
    respx_mock.get(url__startswith=f"{PRIMARY}/v2/lat/").mock(return_value=httpx.Response(503))
    poller = next(iter(state.pollers))

    assert await poller.run_once() is True

    assert poller.health.healthy is False
    assert poller.health.consecutive_failures == 1
    assert len(state.aircraft) == 0


# ---------------------------------------------------------------- the military poller


@respx.mock(assert_all_called=True)
async def test_the_military_poller_replaces_the_whole_store(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """``/v2/mil`` is a complete worldwide picture, so anything absent has left the feed."""
    state = build_state(_settings(), http)
    respx_mock.get(f"{PRIMARY}/v2/mil").mock(
        return_value=httpx.Response(200, content=fixture_bytes("adsb_mil_live.json"))
    )
    military_poller = list(state.pollers)[1]

    await military_poller.run_once()

    assert len(state.military) == 310
    assert military_poller.health.entity_count == 310
    assert all(a.is_military for a in state.military.snapshot())


@respx.mock(assert_all_called=True)
async def test_the_military_poller_drops_aircraft_that_left_the_feed(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    state = build_state(_settings(), http)
    respx_mock.get(f"{PRIMARY}/v2/mil").mock(return_value=httpx.Response(200, content=TWO_AIRCRAFT))
    state.military.upsert("999999", make_aircraft("999999", is_military=True))

    await list(state.pollers)[1].run_once()

    assert state.military.keys() == frozenset({"aaaaaa", "bbbbbb"})
    assert "999999" in state.military.take_changes().removed


# ---------------------------------------------------------------- lifespan


async def test_the_lifespan_builds_state_and_leaves_the_injected_client_open(
    http: httpx.AsyncClient,
) -> None:
    app = create_app(_settings(), start_background_tasks=False, http_client=http)

    async with app.router.lifespan_context(app):
        assert app.state.tracker.http is http

    assert http.is_closed is False, "an injected client belongs to the caller"


async def test_the_lifespan_closes_a_client_it_created_itself() -> None:
    app = create_app(_settings(), start_background_tasks=False)

    async with app.router.lifespan_context(app):
        created = app.state.tracker.http
        assert created.is_closed is False

    assert created.is_closed is True


async def test_the_lifespan_starts_and_stops_the_background_tasks(
    http: httpx.AsyncClient,
) -> None:
    """Every poller and the broadcast loop must be torn down, or a test run leaks tasks."""
    app = create_app(
        _settings(adsb_poll_seconds=3_600.0), start_background_tasks=True, http_client=http
    )

    async with respx.mock(assert_all_called=False) as router:
        router.get(url__startswith=PRIMARY).mock(
            return_value=httpx.Response(200, content=TWO_AIRCRAFT)
        )
        async with app.router.lifespan_context(app):
            state = app.state.tracker
            assert all(p._task is not None for p in state.pollers)

    assert all(p._task is None for p in state.pollers)
    assert state.hub.connection_count == 0


async def test_the_user_agent_carries_contact_details_when_configured() -> None:
    """Nominatim, Overpass and the Wikimedia APIs require this in their usage policies."""
    keyless = Settings(contact_email="")
    keyed = Settings(contact_email="ops@example.com")

    assert "(" in keyed.user_agent
    assert "ops@example.com" in keyed.user_agent
    assert "ops@example.com" not in keyless.user_agent
    assert keyless.user_agent.startswith("tracker/0.1")


def test_a_trailing_slash_is_stripped_from_a_configured_base_url() -> None:
    settings = Settings(
        adsb_base_url="https://api.adsb.lol/", adsb_failover_base_url="https://x.example/api//"
    )

    assert settings.adsb_base_url == "https://api.adsb.lol"
    assert settings.adsb_failover_base_url == "https://x.example/api"


def test_settings_are_cached_process_wide() -> None:
    get_settings.cache_clear()

    assert get_settings() is get_settings()

    get_settings.cache_clear()


def test_every_attribution_is_complete() -> None:
    """A new source cannot ship without its credit; several licences require one."""
    assert len(ATTRIBUTIONS) == 3
    for entry in ATTRIBUTIONS:
        assert entry.source
        assert entry.text
        assert entry.url.startswith("https://")
        assert entry.licence


def test_the_console_entry_point_serves_a_single_worker(monkeypatch: pytest.MonkeyPatch) -> None:
    """A second uvicorn worker would run the lifespan again and double every feed request."""
    captured: dict[str, object] = {}

    def _fake_run(target: str, **kwargs: object) -> None:
        captured["target"] = target
        captured.update(kwargs)

    monkeypatch.setattr("tracker.__main__.uvicorn.run", _fake_run)

    __main__.main()

    assert captured["target"] == "tracker.app:create_app"
    assert captured["factory"] is True
    assert captured["workers"] == 1
