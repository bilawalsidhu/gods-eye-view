"""Application wiring: the poller closures, the lifespan and the entry point.

The poller closures in ``tracker.app`` are the only place the source clients, the stores and
the viewport meet, so they are driven here with intercepted HTTP rather than left to be
discovered in production. The viewport branch matters: a client that has panned somewhere
must change which circle gets queried. The vessel union matters more: it is where three
providers become one record per ship, or fail to.
"""

import asyncio
import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import httpx
import pytest
import respx

from tests.conftest import fixture_bytes, make_aircraft, make_vessel
from tracker import __main__
from tracker.api.state import AppState
from tracker.app import (
    ADSB_MIL_MIN_INTERVAL_SECONDS,
    ADSB_MIN_INTERVAL_SECONDS,
    ATTRIBUTIONS,
    TTL_MISSED_POLLS,
    VESSEL_UNION_MIN_INTERVAL_SECONDS,
    build_state,
    create_app,
)
from tracker.config import Settings, get_settings
from tracker.contracts.geo import BoundingBox
from tracker.services.poller import Poller
from tracker.sources import aishub, aisstream, celestrak, fintraffic

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


def test_build_state_registers_every_store_and_poller(http: httpx.AsyncClient) -> None:
    state = build_state(_settings(), http)

    assert len(state.pollers) == 4
    assert [p.name for p in state.pollers] == [
        "adsb.lol/point",
        "adsb.lol/mil",
        "vessels/union",
        "celestrak/gp",
    ]
    assert state.hub.layers == ("aircraft", "military", "vessels", "satellites")
    assert len(state.aircraft) == 0
    assert len(state.military) == 0
    assert len(state.vessels) == 0
    assert len(state.satellites) == 0
    assert state.viewport is None
    assert state.vessel_union is None
    assert state.attribution == ATTRIBUTIONS


def test_the_hard_cadence_floors_are_applied_below_configuration(
    http: httpx.AsyncClient,
) -> None:
    """A careless environment variable must not be able to speed either feed up."""
    state = build_state(_settings(adsb_poll_seconds=0.5), http)
    point, military = tuple(state.pollers)[:2]

    assert point.min_interval_seconds == ADSB_MIN_INTERVAL_SECONDS
    assert point.effective_interval == ADSB_MIN_INTERVAL_SECONDS
    assert military.min_interval_seconds == ADSB_MIL_MIN_INTERVAL_SECONDS
    assert military.effective_interval == ADSB_MIL_MIN_INTERVAL_SECONDS
    assert military.effective_interval > point.effective_interval


def test_a_slower_configured_cadence_is_honoured(http: httpx.AsyncClient) -> None:
    state = build_state(_settings(adsb_poll_seconds=60.0), http)
    point, military = tuple(state.pollers)[:2]

    assert point.effective_interval == 60.0
    assert military.effective_interval == 240.0


def test_the_health_provider_is_wired_to_the_poller_group(http: httpx.AsyncClient) -> None:
    state = build_state(_settings(), http)

    assert len(state.pollers.health()) == 4


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


async def test_the_lifespan_starts_and_stops_the_vessel_subscription(
    monkeypatch: pytest.MonkeyPatch, http: httpx.AsyncClient
) -> None:
    """The socket is not a poller, so the lifespan owns it directly, both ends.

    ``run`` is replaced because there is no way to mock a WebSocket at the transport the way
    respx mocks HTTP, and a real handshake against the provider is not a unit test.
    """
    running = asyncio.Event()

    async def fake_run(_self: aisstream.AisStreamClient) -> None:
        running.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(aisstream.AisStreamClient, "run", fake_run)
    app = create_app(
        _settings(aisstream_api_key="test-key", adsb_poll_seconds=3_600.0),
        start_background_tasks=True,
        http_client=http,
    )

    async with respx.mock(assert_all_called=False) as router:
        router.get(url__startswith=PRIMARY).mock(
            return_value=httpx.Response(200, content=TWO_AIRCRAFT)
        )
        router.get(url__startswith=DIGITRAFFIC).mock(return_value=httpx.Response(503))
        router.get(url__startswith=CELESTRAK_URL).mock(return_value=httpx.Response(503))
        async with app.router.lifespan_context(app):
            state = app.state.tracker
            assert state.aisstream is not None
            await asyncio.wait_for(running.wait(), timeout=2.0)
            assert state.aisstream._task is not None

    assert state.aisstream._task is None


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
    assert len(ATTRIBUTIONS) == 7
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


# ---------------------------------------------------------------- the vessel union
#
# Phase 2 acceptance 6 to 9 live here, because the union is wiring rather than adapter
# behaviour: three providers, one store, and the failure modes that would either draw a
# phantom fleet or empty the sea.
#
# The Fintraffic side runs on the real 2026-08-19 capture through the real parser. The
# AISHub side is built inline and says so: no successful AISHub response has ever been
# captured, because access needs a physical AIS receiver, so nothing here pretends to be a
# recording.

DIGITRAFFIC = "https://meri.digitraffic.fi"
LOCATIONS_URL = f"{DIGITRAFFIC}/api/ais/v1/locations"
VESSELS_URL = f"{DIGITRAFFIC}/api/ais/v1/vessels"
AISHUB_URL = "https://data.aishub.net/ws.php"
CELESTRAK_URL = "https://celestrak.org/NORAD/elements/gp.php"

AISHUB_USERNAME = "tracker-test-user"

FINTRAFFIC_VESSELS = 109
"""Vessels that map out of the 110-feature capture. One is a placeholder MMSI and is dropped."""

SHARED_MMSI = "230992610"
"""The first feature of the capture, used wherever a test needs two providers on one ship."""

ABSENT_MMSI = "265513460"
"""A real MMSI from the static capture that has no position in it, so nothing overwrites it."""

FINTRAFFIC_FIX = datetime(2026, 8, 19, 22, 41, 27, 522000, tzinfo=UTC)
"""``timestampExternal`` for :data:`SHARED_MMSI` in the capture, to the millisecond."""

AISHUB_NEWER = "2026-08-19 23:00:00 GMT"
AISHUB_OLDER = "2026-08-19 20:00:00 GMT"


def _mock_fintraffic(respx_mock: respx.Router) -> None:
    """Serve both Digitraffic endpoints from the recorded 2026-08-19 bodies."""
    respx_mock.get(VESSELS_URL).mock(
        return_value=httpx.Response(200, content=fixture_bytes("digitraffic_ais_vessels_live.json"))
    )
    respx_mock.get(LOCATIONS_URL).mock(
        return_value=httpx.Response(
            200, content=fixture_bytes("digitraffic_ais_locations_live.json")
        )
    )


def _aishub_body(*, mmsi: str = SHARED_MMSI, time: str = AISHUB_NEWER) -> bytes:
    """One-record AISHub success body, built inline from the provider's published fields."""
    envelope = {"ERROR": False, "USERNAME": AISHUB_USERNAME, "FORMAT": "HUMAN", "RECORDS": 1}
    record = {
        "MMSI": int(mmsi),
        "TIME": time,
        "LONGITUDE": 22.3,
        "LATITUDE": 60.5,
        "COG": 143.2,
        "SOG": 12.4,
        "HEADING": 141,
        "NAVSTAT": 0,
        "NAME": "AISHUB SHIP",
    }
    return json.dumps([envelope, [record]]).encode()


def _position_report(mmsi: str = SHARED_MMSI, *, lon: float = 22.4, lat: float = 60.6) -> str:
    """One aisstream.io position report, in the documented envelope."""
    return json.dumps(
        {
            "MessageType": "PositionReport",
            "Message": {
                "PositionReport": {
                    "UserID": int(mmsi),
                    "Latitude": lat,
                    "Longitude": lon,
                    "Cog": 100.0,
                    "Sog": 8.0,
                    "TrueHeading": 99,
                }
            },
        }
    )


def _vessel_poller(state: AppState) -> Poller:
    return next(p for p in state.pollers if p.name == "vessels/union")


def _satellite_poller(state: AppState) -> Poller:
    return next(p for p in state.pollers if p.name == "celestrak/gp")


@respx.mock(assert_all_called=True)
async def test_two_vessel_providers_produce_one_record_per_mmsi(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 6. Two networks, one ship, one record, and the evidence on the record."""
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    _mock_fintraffic(respx_mock)
    respx_mock.get(AISHUB_URL).mock(return_value=httpx.Response(200, content=_aishub_body()))
    poller = _vessel_poller(state)

    assert await poller.run_once() is True

    union = state.vessel_union
    assert union is not None
    assert len(union.records) == FINTRAFFIC_VESSELS
    assert len(state.vessels) == FINTRAFFIC_VESSELS
    assert len({v.mmsi for v in state.vessels.snapshot()}) == FINTRAFFIC_VESSELS
    assert poller.health.entity_count == FINTRAFFIC_VESSELS
    merged = next(record for record in union.records if record.key == SHARED_MMSI)
    assert merged.providers == ("aishub", "digitraffic")
    assert len(merged.sightings) == 2


@respx.mock(assert_all_called=True)
async def test_every_vessel_record_names_its_provider_and_the_age_of_that_report(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """ADR 010: per record, never per layer, or the merged store is unauditable."""
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    _mock_fintraffic(respx_mock)
    respx_mock.get(AISHUB_URL).mock(return_value=httpx.Response(200, content=_aishub_body()))

    await _vessel_poller(state).run_once()

    union = state.vessel_union
    assert union is not None
    assert {vessel.source for vessel in state.vessels.snapshot()} == {"digitraffic", "aishub"}
    assert all(vessel.position_age_s >= 0.0 for vessel in state.vessels.snapshot())
    for record in union.records:
        assert record.sightings
        assert all(sighting.age_s >= 0.0 for sighting in record.sightings)
        assert all(sighting.provider for sighting in record.sightings)


@respx.mock(assert_all_called=True)
async def test_a_vessel_conflict_resolves_to_the_newer_report(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 6, the recency half. AISHub's fix is later, so AISHub supplies the record."""
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    _mock_fintraffic(respx_mock)
    respx_mock.get(AISHUB_URL).mock(
        return_value=httpx.Response(200, content=_aishub_body(time=AISHUB_NEWER))
    )

    await _vessel_poller(state).run_once()

    winner = state.vessels.get(SHARED_MMSI)
    assert winner is not None
    assert winner.source == "aishub"
    # Nothing averaged: the position is the one that provider actually reported.
    assert (winner.point.lon, winner.point.lat) == (22.3, 60.5)


@respx.mock(assert_all_called=True)
async def test_provider_precedence_never_beats_recency(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """The same pair the other way round: an older AISHub fix must lose."""
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    _mock_fintraffic(respx_mock)
    respx_mock.get(AISHUB_URL).mock(
        return_value=httpx.Response(200, content=_aishub_body(time=AISHUB_OLDER))
    )

    await _vessel_poller(state).run_once()

    winner = state.vessels.get(SHARED_MMSI)
    assert winner is not None
    assert winner.source == "digitraffic"
    assert winner.observed_at - timedelta(seconds=winner.position_age_s) == FINTRAFFIC_FIX


@respx.mock(assert_all_called=True)
async def test_the_provider_attributable_count_is_measured_per_cycle(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """ADR 010 wants "ships only this network can see" measured, not asserted."""
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    _mock_fintraffic(respx_mock)
    respx_mock.get(AISHUB_URL).mock(return_value=httpx.Response(200, content=_aishub_body()))

    await _vessel_poller(state).run_once()

    union = state.vessel_union
    assert union is not None
    assert union.attributable_counts() == {
        "digitraffic": FINTRAFFIC_VESSELS - 1,
        "aishub": 0,
    }


def test_the_vessel_cycle_floor_is_the_strictest_provider_floor(http: httpx.AsyncClient) -> None:
    """Acceptance 7. A constant in code, and configuration can only slow the cycle down."""
    state = build_state(
        _settings(
            aishub_username=AISHUB_USERNAME, fintraffic_poll_seconds=1.0, aishub_poll_seconds=1.0
        ),
        http,
    )
    poller = _vessel_poller(state)

    assert VESSEL_UNION_MIN_INTERVAL_SECONDS == 60.0
    assert VESSEL_UNION_MIN_INTERVAL_SECONDS == aishub.MIN_INTERVAL_SECONDS
    assert VESSEL_UNION_MIN_INTERVAL_SECONDS == fintraffic.MIN_INTERVAL_SECONDS
    assert poller.min_interval_seconds == VESSEL_UNION_MIN_INTERVAL_SECONDS
    assert poller.effective_interval == VESSEL_UNION_MIN_INTERVAL_SECONDS


def test_a_slower_configured_vessel_cadence_is_honoured(http: httpx.AsyncClient) -> None:
    state = build_state(_settings(fintraffic_poll_seconds=300.0), http)

    assert _vessel_poller(state).effective_interval == 300.0


@respx.mock(assert_all_called=True)
async def test_aishub_is_called_at_most_once_a_minute(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 7, driven rather than inspected: the second cycle inside the floor is skipped."""
    state = build_state(
        _settings(aishub_username=AISHUB_USERNAME, fintraffic_poll_seconds=1.0), http
    )
    _mock_fintraffic(respx_mock)
    route = respx_mock.get(AISHUB_URL).mock(
        return_value=httpx.Response(200, content=_aishub_body())
    )
    poller = _vessel_poller(state)

    assert await poller.run_once() is True
    assert await poller.run_once() is False

    assert route.call_count == 1


@respx.mock(assert_all_called=True)
async def test_the_adapter_floor_still_holds_when_the_cycle_is_driven_by_hand(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Two guards, not one. The client refuses the second call and the layer keeps serving."""
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    _mock_fintraffic(respx_mock)
    route = respx_mock.get(AISHUB_URL).mock(
        return_value=httpx.Response(200, content=_aishub_body())
    )
    poll = _vessel_poller(state).poll

    await poll()
    await poll()

    assert route.call_count == 1
    union = state.vessel_union
    assert union is not None
    assert union.missing == ("aishub",)
    assert len(state.vessels) == FINTRAFFIC_VESSELS


@respx.mock(assert_all_called=True)
async def test_an_empty_200_from_aishub_is_a_failed_poll_that_leaves_the_vessels_alone(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 8. An empty success is an error, never an empty sea."""
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    _mock_fintraffic(respx_mock)
    respx_mock.get(AISHUB_URL).mock(return_value=httpx.Response(200, content=b""))
    state.vessels.upsert(ABSENT_MMSI, make_vessel(mmsi=ABSENT_MMSI))

    await _vessel_poller(state).run_once()

    union = state.vessel_union
    assert union is not None
    assert union.missing == ("aishub",)
    assert union.degraded is True
    reason = union.degraded_reason
    assert reason is not None
    assert "aishub" in reason
    assert ABSENT_MMSI in state.vessels
    assert len(state.vessels) == FINTRAFFIC_VESSELS + 1


@respx.mock(assert_all_called=True)
async def test_every_vessel_provider_failing_at_once_never_empties_the_store(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 8, the worst case. Nothing reported, so nothing is removed."""
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    respx_mock.get(url__startswith=DIGITRAFFIC).mock(return_value=httpx.Response(503))
    respx_mock.get(AISHUB_URL).mock(return_value=httpx.Response(200, content=b""))
    state.vessels.upsert(ABSENT_MMSI, make_vessel(mmsi=ABSENT_MMSI))
    poller = _vessel_poller(state)

    await poller.run_once()

    union = state.vessel_union
    assert union is not None
    assert set(union.missing) == {"digitraffic", "aishub"}
    assert state.vessels.keys() == frozenset({ABSENT_MMSI})
    # Healthy-and-empty would be the same lie an empty AISHub 200 tells.
    assert poller.health.healthy is False
    assert poller.health.last_error is not None


@respx.mock(assert_all_called=True)
async def test_a_failing_provider_degrades_the_layer_without_failing_it(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """ADR 010: a provider that drops out costs coverage, not the layer."""
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    _mock_fintraffic(respx_mock)
    respx_mock.get(AISHUB_URL).mock(return_value=httpx.Response(500))
    poller = _vessel_poller(state)

    await poller.run_once()

    assert poller.health.healthy is True
    assert poller.health.entity_count == FINTRAFFIC_VESSELS
    union = state.vessel_union
    assert union is not None
    assert union.reporting == ("digitraffic",)
    assert union.missing == ("aishub",)


@respx.mock(assert_all_called=True)
async def test_with_no_aishub_username_the_layer_runs_on_the_other_providers(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 9. Unconfigured is not missing: AISHub is never called and never reported."""
    state = build_state(_settings(), http)
    _mock_fintraffic(respx_mock)

    await _vessel_poller(state).run_once()

    union = state.vessel_union
    assert union is not None
    assert union.reporting == ("digitraffic",)
    assert union.degraded is False
    assert union.missing == ()
    assert len(state.vessels) == FINTRAFFIC_VESSELS


# ---------------------------------------------------------------- the aisstream subscription


def test_no_aisstream_key_means_no_subscription(http: httpx.AsyncClient) -> None:
    state = build_state(_settings(), http)

    assert state.aisstream is None


def test_an_aisstream_key_builds_the_subscription_from_the_configured_box(
    http: httpx.AsyncClient,
) -> None:
    """The box flips to latitude-first for the provider, which is the trap in that API."""
    state = build_state(
        _settings(
            aisstream_api_key="test-key",
            aisstream_bbox_west=1.0,
            aisstream_bbox_south=51.0,
            aisstream_bbox_east=8.0,
            aisstream_bbox_north=58.0,
        ),
        http,
    )
    client = state.aisstream
    assert client is not None

    frame = json.loads(client.subscribe_frame())

    assert frame["BoundingBoxes"] == [[[51.0, 1.0], [58.0, 8.0]]]
    assert frame["APIKey"] == "test-key"


def test_configuration_cannot_speed_up_aisstream_reconnection(http: httpx.AsyncClient) -> None:
    state = build_state(
        _settings(aisstream_api_key="test-key", aisstream_reconnect_seconds=0.01), http
    )
    client = state.aisstream
    assert client is not None

    assert client.effective_reconnect_delay == aisstream.MIN_RECONNECT_DELAY_SECONDS


@respx.mock(assert_all_called=True)
async def test_a_streamed_vessel_joins_the_union_and_wins_on_recency(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """The socket is not polled, so its reports are buffered and drained by each cycle."""
    state = build_state(_settings(aisstream_api_key="test-key"), http)
    _mock_fintraffic(respx_mock)
    client = state.aisstream
    assert client is not None
    client.connected = True
    client.handle_message(_position_report())

    await _vessel_poller(state).run_once()

    winner = state.vessels.get(SHARED_MMSI)
    assert winner is not None
    assert winner.source == "aisstream"
    assert len(state.vessels) == FINTRAFFIC_VESSELS
    union = state.vessel_union
    assert union is not None
    assert set(union.reporting) == {"digitraffic", "aisstream"}


@respx.mock(assert_all_called=True)
async def test_the_stream_buffer_is_drained_rather_than_replayed(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """A report already merged must not be counted again next cycle as if it were fresh."""
    state = build_state(_settings(aisstream_api_key="test-key"), http)
    _mock_fintraffic(respx_mock)
    client = state.aisstream
    assert client is not None
    client.connected = True
    client.handle_message(_position_report())
    poll = _vessel_poller(state).poll

    await poll()
    await poll()

    union = state.vessel_union
    assert union is not None
    assert union.empty == ("aisstream",), "a connected socket with nothing new is not a failure"
    assert union.degraded is False


@respx.mock(assert_all_called=True)
async def test_a_disconnected_stream_is_a_missing_provider(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    state = build_state(_settings(aisstream_api_key="test-key"), http)
    _mock_fintraffic(respx_mock)
    client = state.aisstream
    assert client is not None
    client.connected = False
    client.last_error = "connection closed"

    await _vessel_poller(state).run_once()

    union = state.vessel_union
    assert union is not None
    assert union.missing == ("aisstream",)
    assert len(state.vessels) == FINTRAFFIC_VESSELS


# ---------------------------------------------------------------- the satellite poller


@respx.mock(assert_all_called=True)
async def test_the_satellite_poller_fills_the_store_from_the_element_cache(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    state = build_state(_settings(), http)
    route = respx_mock.get(url__startswith=CELESTRAK_URL).mock(
        return_value=httpx.Response(
            200, content=fixture_bytes("celestrak_catnr19548_omm_wayback20260310.json")
        )
    )
    poller = _satellite_poller(state)

    assert await poller.run_once() is True

    assert route.call_count == 1
    assert state.satellites.keys() == frozenset({"19548"})
    assert poller.health.entity_count == 1
    assert state.celestrak.unavailable_reason is None


def test_the_celestrak_two_hour_floor_sits_below_configuration(http: httpx.AsyncClient) -> None:
    """Acceptance 4. CelesTrak firewalls abusive clients, so this is not configurable."""
    state = build_state(_settings(celestrak_poll_seconds=1.0), http)
    poller = _satellite_poller(state)

    assert celestrak.MIN_GROUP_INTERVAL_S == 7200.0
    assert poller.min_interval_seconds == celestrak.MIN_GROUP_INTERVAL_S
    assert poller.effective_interval == celestrak.MIN_GROUP_INTERVAL_S


@respx.mock(assert_all_called=True)
async def test_a_second_satellite_cycle_inside_the_window_makes_no_request(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 4, driven by hand past the poller's own floor."""
    state = build_state(_settings(), http)
    route = respx_mock.get(url__startswith=CELESTRAK_URL).mock(
        return_value=httpx.Response(
            200, content=fixture_bytes("celestrak_catnr19548_omm_wayback20260310.json")
        )
    )
    poll = _satellite_poller(state).poll

    assert await poll() == 1
    assert await poll() == 1

    assert route.call_count == 1


@respx.mock(assert_all_called=True)
async def test_an_unreachable_celestrak_reports_the_layer_unavailable(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Today's reality: TCP 443 never answered during the phase 2 recon."""
    state = build_state(_settings(), http)
    respx_mock.get(url__startswith=CELESTRAK_URL).mock(
        side_effect=httpx.ConnectTimeout("timed out")
    )
    poller = _satellite_poller(state)

    await poller.run_once()

    assert poller.health.healthy is False
    assert len(state.satellites) == 0
    reason = state.celestrak.unavailable_reason
    assert reason is not None
    assert "unreachable" in reason


# ---------------------------------------------------------------- store lifetimes


def test_the_vessel_and_satellite_stores_outlive_their_own_cadences(
    http: httpx.AsyncClient,
) -> None:
    """The aircraft time to live would retire every ship and satellite between two polls."""
    state = build_state(
        _settings(fintraffic_poll_seconds=300.0, celestrak_poll_seconds=21_600.0), http
    )

    assert state.vessels.ttl_seconds == 300.0 * TTL_MISSED_POLLS
    assert state.satellites.ttl_seconds == 21_600.0 * TTL_MISSED_POLLS
    assert state.aircraft.ttl_seconds < state.vessels.ttl_seconds
