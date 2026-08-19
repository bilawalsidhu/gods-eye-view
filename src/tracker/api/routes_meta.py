"""Health, capability and attribution endpoints.

``/api/capabilities`` is what lets the frontend degrade honestly. Rather than the browser
guessing which layers exist, it asks, and the server answers based on which credentials
are actually configured. A layer with no key renders as unavailable with the reason,
instead of as an empty layer that looks like a bug.
"""

from fastapi import APIRouter

from tracker.api.state import StateDep
from tracker.contracts.base import StrictModel
from tracker.contracts.messages import FeedHealth


class AttributionEntry(StrictModel):
    """One licence credit the UI is required to display."""

    source: str
    text: str
    url: str
    licence: str


class LayerCapability(StrictModel):
    """Whether one layer can run, and why not when it cannot."""

    layer: str
    available: bool
    reason: str | None = None


class Capabilities(StrictModel):
    """What this deployment can actually do, given its configuration."""

    layers: tuple[LayerCapability, ...]
    attribution: tuple[AttributionEntry, ...]
    cesium_ion_token: str | None = None


class Health(StrictModel):
    """Liveness plus per-feed health."""

    status: str
    feeds: tuple[FeedHealth, ...]
    connected_clients: int


router = APIRouter(prefix="/api", tags=["meta"])


@router.get("/health", response_model=Health)
async def health(state: StateDep) -> Health:
    """Liveness and upstream feed health.

    Reports ``ok`` whenever the process is serving, even with every feed down, because
    this is a liveness probe rather than a data-quality judgement. Feed trouble is
    visible in ``feeds`` and is what the UI banners read.
    """
    return Health(
        status="ok",
        feeds=state.pollers.health(),
        connected_clients=state.hub.connection_count,
    )


@router.get("/capabilities", response_model=Capabilities)
async def capabilities(state: StateDep) -> Capabilities:
    """Which layers this deployment can serve, and the attributions it must display.

    The Cesium ion token is returned to the browser deliberately: it is a client-side
    token by design, scoped to the assets it can stream, unlike the feed keys which never
    leave the server.
    """
    settings = state.settings
    layers = (
        LayerCapability(layer="aircraft", available=True),
        LayerCapability(layer="military", available=True),
        LayerCapability(
            layer="vessels",
            available=settings.ship_layer_available,
            reason=None
            if settings.ship_layer_available
            else "Set TRACKER_AISSTREAM_API_KEY (free key from aisstream.io) to enable ships.",
        ),
        LayerCapability(
            layer="cameras",
            available=settings.camera_layer_available,
            reason=None
            if settings.camera_layer_available
            else "Set TRACKER_WINDY_API_KEY or TRACKER_TFL_APP_KEY to enable public cameras.",
        ),
        LayerCapability(
            layer="buildings",
            available=settings.buildings_layer_available,
            reason=None
            if settings.buildings_layer_available
            else "Set TRACKER_CESIUM_ION_TOKEN to stream 3D buildings.",
        ),
        LayerCapability(
            layer="places",
            available=settings.osm_services_available,
            reason=None
            if settings.osm_services_available
            else "Set TRACKER_CONTACT_EMAIL. Nominatim and Overpass require contact "
            "details in the User-Agent under their usage policies.",
        ),
    )
    return Capabilities(
        layers=layers,
        attribution=tuple(
            AttributionEntry(source=a.source, text=a.text, url=a.url, licence=a.licence)
            for a in state.attribution
        ),
        cesium_ion_token=settings.cesium_ion_token or None,
    )
