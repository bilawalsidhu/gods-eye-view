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

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Final

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from tracker.api import routes_entities, routes_meta, routes_ws
from tracker.api.state import AppState, Attribution
from tracker.config import Settings, get_settings
from tracker.contracts.geo import BoundingBox
from tracker.contracts.vessel import Vessel
from tracker.services.hub import Hub
from tracker.services.poller import Poller, PollerGroup
from tracker.services.store import EntityStore
from tracker.services.union import ProviderResult, merge_providers
from tracker.sources import aishub, aisstream, celestrak, fintraffic
from tracker.sources.adsb import AdsbClient
from tracker.sources.base import SourceError
from tracker.sources.celestrak import CelestrakClient

if TYPE_CHECKING:
    from tracker.contracts.aircraft import Aircraft
    from tracker.contracts.satellite import Satellite

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

VESSEL_UNION_MIN_INTERVAL_SECONDS = max(
    fintraffic.MIN_INTERVAL_SECONDS, aishub.MIN_INTERVAL_SECONDS
)
"""Hard floor for one vessel cycle, taken from the strictest provider in the union.

One cycle calls every provider, so the floor is the slowest of theirs rather than an
average of them. Fintraffic caches for sixty seconds and AISHub answers an over-frequent
call with an empty body, so both are sixty, and a faster cycle would make AISHub refuse its
own call and the layer read degraded when nothing is wrong.

It also settles the rate-limit question. A provider that throttles us drops out of the
union for that cycle (ADR 010 names rate limiting as one of those cases) rather than
raising into the poller, and retrying at this floor stays inside both providers' published
caps, so nothing is hammered.
"""

VESSEL_LAYER: Final = "vessels"
"""The layer name the vessel union serves, used as its poller layer and its error source."""

TTL_MISSED_POLLS = 3.0
"""How many missed polls a vessel or satellite survives before the store drops it.

The aircraft time to live is tuned to a feed that publishes every few seconds. Vessels are
polled every minute and element sets every six hours, so the same ninety seconds would
retire every ship and every satellite between two polls.
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
        source="Fintraffic",
        # Verbatim from the provider's terms page, which specifies the wording. Shortening
        # it would drop the licence name the licence itself asks us to carry.
        text="Source: Fintraffic / digitraffic.fi, license CC 4.0 BY",
        url=fintraffic.ATTRIBUTION_URL,
        licence=fintraffic.LICENCE,
    ),
    Attribution(
        source="aisstream.io",
        text="Global vessel positions from aisstream.io",
        url="https://aisstream.io",
        licence="Provider terms, redistribution not granted; check before commercial use",
    ),
    Attribution(
        source="AISHub",
        text="Vessel data from the AISHub contributor network",
        url="https://www.aishub.net",
        licence="Contributor terms, redistribution not granted",
    ),
    Attribution(
        source="CelesTrak",
        text="Orbital element sets from CelesTrak",
        url="https://celestrak.org",
        licence="Not stated by the provider; credit is courtesy",
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
    vessels: EntityStore[Vessel] = EntityStore(
        ttl_seconds=max(
            settings.entity_ttl_seconds, settings.fintraffic_poll_seconds * TTL_MISSED_POLLS
        )
    )
    satellites: EntityStore[Satellite] = EntityStore(
        ttl_seconds=settings.celestrak_poll_seconds * TTL_MISSED_POLLS
    )
    pollers = PollerGroup()
    hub = Hub(
        broadcast_interval_seconds=settings.broadcast_interval_seconds,
        health_provider=pollers.health,
    )
    hub.register_layer("aircraft", aircraft)
    hub.register_layer("military", military)
    hub.register_layer("vessels", vessels)
    hub.register_layer("satellites", satellites)

    state = AppState(
        settings=settings,
        http=http,
        hub=hub,
        pollers=pollers,
        aircraft=aircraft,
        military=military,
        vessels=vessels,
        satellites=satellites,
        celestrak=CelestrakClient(http),
        attribution=ATTRIBUTIONS,
    )
    _register_aircraft_pollers(state)
    _register_vessel_poller(state)
    _register_satellite_poller(state)
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


def _vessel_key(vessel: Vessel) -> str:
    """The merge identity for a vessel: its MMSI, per ADR 010.

    The source's own stable identity, never a generated or positional key, or a ship
    duplicates itself every time it moves.
    """
    return vessel.mmsi


def _vessel_fix_time(vessel: Vessel) -> datetime:
    """When this report's position was actually fixed.

    ``observed_at`` is when the provider built the response and the position inside it can
    be seconds or hours older, so this is what recency has to be judged on. Resolving on
    response time would let a slow provider's stale fix win.
    """
    return vessel.observed_at - timedelta(seconds=vessel.position_age_s)


async def _provider_result(
    provider: str, fetch: Callable[[], Awaitable[tuple[Vessel, ...]]]
) -> ProviderResult[Vessel]:
    """Run one provider's fetch, turning any failure into a provider that dropped out.

    ADR 010: a provider that errors, rate-limits or loses its key leaves the union for that
    cycle and the layer reports itself degraded with which provider is missing. It does not
    fail the layer, so the exception is recorded here rather than raised into the poller.
    """
    try:
        return ProviderResult(provider=provider, records=await fetch())
    except Exception as exc:  # noqa: BLE001 - one provider must never fail the whole layer
        _log.warning("%s dropped out of the vessel union: %s", provider, exc)
        return ProviderResult.from_error(provider, exc)


def _connect_stream(
    settings: Settings, on_vessel: Callable[[Vessel], None]
) -> aisstream.AisStreamClient | None:
    """Build the aisstream.io subscription, or ``None`` when no key is configured.

    Constructed here and started by the lifespan, so ``build_state`` opens no sockets and a
    test can inspect the wiring with no network. No key is a configured-but-unavailable
    provider rather than an error: the layer runs on the keyless providers and
    ``/api/capabilities`` reports the reason.
    """
    if not settings.aisstream_available:
        _log.info("aisstream.io: %s", aisstream.UNAVAILABLE_REASON)
        return None
    box = BoundingBox(
        west=settings.aisstream_bbox_west,
        south=settings.aisstream_bbox_south,
        east=settings.aisstream_bbox_east,
        north=settings.aisstream_bbox_north,
    )
    return aisstream.AisStreamClient(
        api_key=settings.aisstream_api_key,
        boxes=(box,),
        on_vessel=on_vessel,
        reconnect_delay_seconds=settings.aisstream_reconnect_seconds,
    )


def _register_vessel_poller(state: AppState) -> None:
    """Attach the vessel union to the state's poller group.

    One poller, up to three providers, per ADR 010: the layer is the union of what its
    providers return rather than whichever one answered. They merge on MMSI, the freshest
    fix supplies the record, nothing is averaged, and a provider that fails drops out of
    that cycle instead of failing the layer.

    aisstream.io is a persistent subscription rather than a polled endpoint, so it keeps its
    newest report per MMSI in a buffer that each cycle drains. That is what keeps one merge
    point and therefore one record per ship, which is the phantom-fleet bug ADR 010 names.

    A provider with no credential is left out of the union entirely rather than added and
    failed every cycle, so an unconfigured AISHub does not make the layer read degraded
    forever. It reports itself unavailable from ``/api/capabilities`` instead.

    Recency deciding a conflict outright, with the superseded report dropped, is R2 in
    ``docs/pending-decisions.md`` and is unratified. It lives in ``services/union.py``; this
    function only feeds it the fix time.
    """
    settings = state.settings
    fetches: list[tuple[str, Callable[[], Awaitable[tuple[Vessel, ...]]]]] = []

    baltic = fintraffic.FintrafficClient(
        state.http,
        base_url=settings.fintraffic_base_url,
        digitraffic_user=settings.digitraffic_user or settings.user_agent,
        window_seconds=settings.fintraffic_window_seconds,
    )
    fetches.append((baltic.name, baltic.all_vessels))

    worldwide = aishub.AishubClient(state.http, username=settings.aishub_username)

    async def aishub_vessels() -> tuple[Vessel, ...]:
        parsed = await worldwide.vessels(interval_minutes=settings.aishub_interval_minutes)
        return parsed.vessels

    if worldwide.available:
        fetches.append((worldwide.name, aishub_vessels))

    streamed: dict[str, Vessel] = {}

    def receive(vessel: Vessel) -> None:
        """Hold the newest report per MMSI until the next cycle drains it."""
        streamed[vessel.mmsi] = vessel

    stream = _connect_stream(settings, receive)
    state.aisstream = stream

    def drain(client: aisstream.AisStreamClient) -> ProviderResult[Vessel]:
        """This provider's contribution for one cycle, drained from the socket's buffer.

        A connected socket that carried nothing is an empty answer, not a failure: thin
        traffic in the subscribed box is a legitimate result. A disconnected socket with an
        empty buffer is a provider that dropped out, named so the layer reads degraded.
        """
        records = tuple(streamed.values())
        streamed.clear()
        if records or client.connected:
            return ProviderResult(provider=aisstream.SOURCE_NAME, records=records)
        return ProviderResult(
            provider=aisstream.SOURCE_NAME,
            error=client.last_error or "not connected",
        )

    async def poll_vessels() -> int:
        results = list(await asyncio.gather(*(_provider_result(name, f) for name, f in fetches)))
        if stream is not None:
            results.append(drain(stream))
        union = merge_providers(results, key=_vessel_key, reported_at=_vessel_fix_time)
        state.vessel_union = union
        # upsert_many, never replace_all: each provider covers its own patch of sea, and
        # replacing would delete every ship only a missing provider could see.
        state.vessels.upsert_many(union.keyed())
        if not union.reporting:
            # Every provider dropped out. The store keeps what it has, but the feed has to
            # read unhealthy rather than healthy-and-empty: that is the same lie AISHub's
            # empty HTTP 200 tells, one level up.
            detail = union.degraded_reason or "no provider answered"
            raise SourceError(VESSEL_LAYER, detail)
        if union.degraded:
            _log.warning("vessel layer degraded: %s", union.degraded_reason)
        return len(union.records)

    state.pollers.add(
        Poller(
            name="vessels/union",
            layer=VESSEL_LAYER,
            poll=poll_vessels,
            interval_seconds=max(settings.fintraffic_poll_seconds, settings.aishub_poll_seconds),
            min_interval_seconds=VESSEL_UNION_MIN_INTERVAL_SECONDS,
        )
    )


def _register_satellite_poller(state: AppState) -> None:
    """Attach the CelesTrak poller, one fetch per configured group per cycle.

    ``replace_all`` because a group is a complete published list: an object CelesTrak has
    dropped has decayed or been withdrawn and must leave the globe. The store is filled from
    the client's deduplicated cache rather than from this cycle's fetch, because groups
    overlap (``stations`` is a subset of ``active``) and the same object arriving twice would
    otherwise be drawn twice.

    The two-hour floor lives in the adapter, so the client serves from cache inside the
    window with no HTTP at all and the poller cadence cannot breach it.
    """
    settings = state.settings

    async def poll_elements() -> int:
        for group in settings.celestrak_groups:
            await state.celestrak.elements(group)
        found = state.celestrak.cached_elements()
        state.satellites.replace_all((str(s.norad_cat_id), s) for s in found)
        return len(found)

    state.pollers.add(
        Poller(
            name="celestrak/gp",
            layer="satellites",
            poll=poll_elements,
            interval_seconds=settings.celestrak_poll_seconds,
            min_interval_seconds=celestrak.MIN_GROUP_INTERVAL_S,
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
            if state.aisstream is not None:
                state.aisstream.start()
            state.hub.start()
            _log.info("started %d pollers and the broadcast loop", len(state.pollers))

        try:
            yield
        finally:
            if start_background_tasks:
                await state.pollers.stop_all()
                if state.aisstream is not None:
                    await state.aisstream.stop()
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
