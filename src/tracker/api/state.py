"""Shared application state and the dependency accessors routers use to reach it.

Everything mutable the app owns lives on one object attached to ``app.state``. Routers
reach it through FastAPI dependencies rather than importing a module-level singleton, so
a test can build an app with a different HTTP client or a frozen clock and nothing has to
know.
"""

from dataclasses import dataclass, field
from typing import Annotated

import httpx
from fastapi import Depends, Request

from tracker.config import Settings
from tracker.contracts.aircraft import Aircraft
from tracker.contracts.geo import BoundingBox
from tracker.contracts.satellite import Satellite
from tracker.contracts.vessel import Vessel
from tracker.services.hub import Hub
from tracker.services.poller import PollerGroup
from tracker.services.store import EntityStore
from tracker.services.union import UnionResult
from tracker.sources.aisstream import AisStreamClient
from tracker.sources.celestrak import CelestrakClient


@dataclass(slots=True)
class AppState:
    """Everything the running application owns.

    One HTTP client for the whole process: connection pooling across feeds is the single
    biggest win available here, and building a client per request would leak sockets
    under load.
    """

    settings: Settings
    http: httpx.AsyncClient
    hub: Hub
    pollers: PollerGroup
    aircraft: EntityStore[Aircraft]
    military: EntityStore[Aircraft]
    vessels: EntityStore[Vessel]
    satellites: EntityStore[Satellite]
    celestrak: CelestrakClient
    """The satellite feed, held rather than rebuilt because it owns the two-hour floor.

    ``/api/satellites/elements`` reads its cache and ``/api/capabilities`` reads its
    unavailable reason, so the layer's availability is a runtime fact from the client
    rather than a credential check: CelesTrak is keyless and there is nothing to check.
    """

    attribution: tuple["Attribution", ...] = field(default_factory=tuple)
    viewport: BoundingBox | None = None
    """The area the most recent client asked for.

    One viewport for the whole server, not one per client. With a handful of clients that
    is the right trade: the aircraft feed is queried once for the union of interest rather
    than once per browser, which is what keeps us inside a free provider's tolerance. If
    this ever serves many simultaneous users it becomes a merged set of boxes, and the
    poller reading it is the only thing that changes.
    """

    aisstream: AisStreamClient | None = None
    """The global vessel subscription, or ``None`` when no aisstream.io key is configured.

    A supervised WebSocket rather than a poller, so the lifespan starts and stops it
    directly. Absent it, the vessel layer runs on the keyless providers and reports
    aisstream unavailable, exactly like any other missing key.
    """

    vessel_union: UnionResult[Vessel] | None = None
    """What the last vessel cycle merged, kept for reporting rather than for rendering.

    ADR 010 asks for a provider-attributable count and for a degraded layer to name which
    provider is missing. Both are derived from this, so ``/api/layers`` reports what
    actually came back instead of a summary somebody has to remember to update.
    """


@dataclass(frozen=True, slots=True)
class Attribution:
    """A licence credit that the UI must display for a data source.

    Served to the frontend rather than hardcoded there, so adding a source cannot
    accidentally ship without its attribution. Several of these licences make
    attribution a condition of use.
    """

    source: str
    text: str
    url: str
    licence: str


def get_state(request: Request) -> AppState:
    """The application state attached at startup, as a FastAPI dependency."""
    state: AppState = request.app.state.tracker
    return state


def get_settings_dep(request: Request) -> Settings:
    """Settings read off the application state, as a FastAPI dependency."""
    return get_state(request).settings


StateDep = Annotated[AppState, Depends(get_state)]
SettingsDep = Annotated[Settings, Depends(get_settings_dep)]
