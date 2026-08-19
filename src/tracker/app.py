"""Application factory and lifespan.

A factory rather than a module-level ``app`` object, because tests need to build an
application with an injected HTTP client and no background tasks. The lifespan is where
every long-lived resource is created and, more importantly, torn down: one HTTP client,
the poller group, and the hub's broadcast loop.

Pollers start here, which means they run once per process. Under multiple uvicorn workers
each worker would run its own lifespan and duplicate every upstream request. Until a
cross-process lock exists, this app runs with a single worker, and
``start_background_tasks=False`` is how tests and any future poller-less web tier opt out.
"""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from tracker.api import routes_entities, routes_meta, routes_ws
from tracker.api.state import AppState, Attribution
from tracker.config import Settings, get_settings
from tracker.services.hub import Hub
from tracker.services.poller import Poller, PollerGroup
from tracker.services.store import EntityStore
from tracker.sources.adsb import AdsbClient

if TYPE_CHECKING:
    from tracker.contracts.aircraft import Aircraft

_log = logging.getLogger(__name__)

ADSB_MIN_INTERVAL_SECONDS = 5.0
"""Hard floor for the aircraft feed.

adsb.lol aggregates roughly every five seconds, so polling faster returns identical data
and spends someone else's bandwidth for nothing. Enforced below configuration so it
cannot be lowered by an environment variable.
"""

ADSB_MIL_MIN_INTERVAL_SECONDS = 30.0
"""Hard floor for the worldwide military endpoint, four times the viewport floor.

``/v2/mil`` returns every military aircraft on the planet in one response (391 records,
168KB when measured on 2026-08-19) and adsb.lol throttled it with HTTP 420 on the first
live run of this app. It is a far more expensive call than a viewport query and gets a
correspondingly slower cadence. Military aircraft positions do not become stale in
thirty seconds in any way a user would notice.
"""

ATTRIBUTIONS: tuple[Attribution, ...] = (
    Attribution(
        source="adsb.lol",
        text="Aircraft data from adsb.lol",
        url="https://adsb.lol",
        licence="ODbL 1.0",
    ),
    Attribution(
        source="adsb.fi",
        text="Aircraft failover data from adsb.fi",
        url="https://adsb.fi",
        licence="Non-commercial use",
    ),
    Attribution(
        source="NASA GIBS",
        text="Imagery courtesy of NASA EOSDIS GIBS",
        url="https://gibs.earthdata.nasa.gov",
        licence="Public domain, attribution requested",
    ),
)
"""Credits the UI must display. Served from the API so a new source cannot ship without one."""


def build_state(settings: Settings, http: httpx.AsyncClient) -> AppState:
    """Construct application state without starting anything.

    Separate from the lifespan so tests can build state, drive a poller by hand and
    inspect the stores, with no background tasks and no sleeping.
    """
    aircraft: EntityStore[Aircraft] = EntityStore(ttl_seconds=settings.entity_ttl_seconds)
    military: EntityStore[Aircraft] = EntityStore(ttl_seconds=settings.entity_ttl_seconds)
    pollers = PollerGroup()
    hub = Hub(
        broadcast_interval_seconds=settings.broadcast_interval_seconds,
        health_provider=pollers.health,
    )
    hub.register_layer("aircraft", aircraft)
    hub.register_layer("military", military)

    state = AppState(
        settings=settings,
        http=http,
        hub=hub,
        pollers=pollers,
        aircraft=aircraft,
        military=military,
        attribution=ATTRIBUTIONS,
    )
    _register_aircraft_pollers(state)
    return state


def _register_aircraft_pollers(state: AppState) -> None:
    """Attach the aircraft and military pollers to the state's poller group.

    Two pollers, two stores. The viewport poller replaces nothing outside its own results
    and relies on the store's time to live to retire aircraft that leave the view. The
    military poller uses ``replace_all`` because ``/v2/mil`` returns a complete worldwide
    picture each call, so anything absent has genuinely gone off the feed.
    """
    settings = state.settings
    client = AdsbClient(
        state.http,
        base_url=settings.adsb_base_url,
        failover_base_url=settings.adsb_failover_base_url,
    )

    async def poll_viewport() -> int:
        box = state.viewport
        if box is None:
            found = await client.aircraft_near(
                lat=settings.adsb_default_lat,
                lon=settings.adsb_default_lon,
                radius_nm=settings.adsb_radius_nm,
            )
        else:
            found = await client.aircraft_in_box(box)
        state.aircraft.upsert_many((a.icao24, a) for a in found)
        return len(found)

    async def poll_military() -> int:
        found = await client.military()
        state.military.replace_all((a.icao24, a) for a in found)
        return len(found)

    state.pollers.add(
        Poller(
            name="adsb.lol/point",
            layer="aircraft",
            poll=poll_viewport,
            interval_seconds=settings.adsb_poll_seconds,
            min_interval_seconds=ADSB_MIN_INTERVAL_SECONDS,
        )
    )
    state.pollers.add(
        Poller(
            name="adsb.lol/mil",
            layer="military",
            poll=poll_military,
            interval_seconds=max(settings.adsb_poll_seconds * 4, ADSB_MIL_MIN_INTERVAL_SECONDS),
            min_interval_seconds=ADSB_MIL_MIN_INTERVAL_SECONDS,
        )
    )


def create_app(
    settings: Settings | None = None,
    *,
    start_background_tasks: bool = True,
    http_client: httpx.AsyncClient | None = None,
) -> FastAPI:
    """Build the application.

    ``start_background_tasks=False`` builds a fully working API over empty stores, which
    is what almost every test wants: real routing and real contracts, no network and no
    clock dependence.
    """
    resolved = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        client = http_client or httpx.AsyncClient(
            timeout=httpx.Timeout(resolved.http_timeout_seconds),
            limits=httpx.Limits(
                max_connections=resolved.http_max_connections,
                max_keepalive_connections=resolved.http_max_keepalive,
            ),
            headers={"User-Agent": resolved.user_agent, "Accept": "application/json"},
            follow_redirects=True,
        )
        state = build_state(resolved, client)
        app.state.tracker = state

        if start_background_tasks:
            state.pollers.start_all()
            state.hub.start()
            _log.info("started %d pollers and the broadcast loop", len(state.pollers))

        try:
            yield
        finally:
            if start_background_tasks:
                await state.pollers.stop_all()
                await state.hub.stop()
            if http_client is None:
                await client.aclose()

    app = FastAPI(
        title="Tracker",
        version="0.1.0",
        summary="Real public data on an interactive globe",
        description=(
            "Live aircraft, ships, satellites, public cameras and geolocated events, "
            "served from real public feeds. Every response names its source and licence."
        ),
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved.cors_origins),
        allow_credentials=False,
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    app.include_router(routes_meta.router)
    app.include_router(routes_entities.router)
    app.include_router(routes_ws.router)
    return app
