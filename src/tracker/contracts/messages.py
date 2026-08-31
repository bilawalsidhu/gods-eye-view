"""The client/server wire protocol for the live WebSocket.

One socket carries every layer, discriminated on ``type``. A single multiplexed
connection rather than one per layer, because browsers cap concurrent connections per
host and because a client needs a consistent view: layers arriving on separate sockets
would tear against each other during a viewport change.
"""

from typing import Annotated, Literal

from pydantic import Field

from tracker.contracts.aircraft import Aircraft
from tracker.contracts.base import StrictModel, UtcDatetime
from tracker.contracts.geo import BoundingBox
from tracker.contracts.satellite import Satellite
from tracker.contracts.transit import TransitVehicle
from tracker.contracts.vessel import Vessel

type Entity = Annotated[Aircraft | Vessel | Satellite | TransitVehicle, Field(discriminator="kind")]
"""The entity union, discriminated on ``kind``.

Widened in phase 2 and the claim that it would touch no consumer held: every domain
contract already carries the ``kind`` literal, so nothing downstream changed. Pydantic
picks the member off ``kind`` rather than trying each in turn, which is why a vessel that
fails validation reports a vessel error instead of three unrelated ones.
"""

type LayerName = Literal[
    "aircraft", "military", "vessels", "satellites", "transit", "events", "cameras"
]


class FeedHealth(StrictModel):
    """Whether one upstream feed is currently working.

    Sent to clients so the UI can show a per-source degraded banner instead of silently
    displaying a frozen layer as if it were live. ``consecutive_failures`` is included
    because one failed poll is noise and five is an outage.
    """

    source: str
    layer: LayerName
    healthy: bool
    entity_count: int = Field(ge=0)
    last_success_at: UtcDatetime | None = None
    last_error: str | None = None
    consecutive_failures: int = Field(default=0, ge=0)
    poll_interval_seconds: float = Field(gt=0.0)
    rate_limited_until: UtcDatetime | None = Field(
        default=None,
        description="Set when the upstream returned a throttling response. The UI says "
        "'rate limited until X' rather than 'feed down', which is a materially different "
        "message: the data is fine, we are being asked to wait.",
    )

    @property
    def is_stale(self) -> bool:
        """True when the feed has missed enough polls to be considered degraded."""
        return not self.healthy or self.consecutive_failures > 1


class Snapshot(StrictModel):
    """The full current state of one layer, sent when a client connects or subscribes."""

    type: Literal["snapshot"] = "snapshot"
    layer: LayerName
    entities: tuple[Entity, ...]
    server_time: UtcDatetime


class Upsert(StrictModel):
    """Entities that were added or moved since the last flush."""

    type: Literal["upsert"] = "upsert"
    layer: LayerName
    entities: tuple[Entity, ...]
    server_time: UtcDatetime


class Remove(StrictModel):
    """Entity keys that should be taken off the globe.

    Sent when a feed stops reporting an entity for longer than its time to live. The
    client must remove them; keeping a last known position on screen indefinitely would
    show assets that are not there.
    """

    type: Literal["remove"] = "remove"
    layer: LayerName
    ids: tuple[str, ...]
    server_time: UtcDatetime


class FeedStatus(StrictModel):
    """Health of every upstream feed."""

    type: Literal["feed_status"] = "feed_status"
    feeds: tuple[FeedHealth, ...]
    server_time: UtcDatetime


type ServerMessage = Annotated[
    Snapshot | Upsert | Remove | FeedStatus,
    Field(discriminator="type"),
]
"""Anything the server sends down the socket."""


class SetViewport(StrictModel):
    """Client tells the server which part of the world it is looking at.

    Drives viewport-scoped upstream subscriptions. Sent on camera idle with a debounce,
    never per frame: each one of these can turn into an upstream request, and providers
    like Overpass and CelesTrak will block a client that treats their API as a mousemove
    handler.
    """

    type: Literal["set_viewport"] = "set_viewport"
    box: BoundingBox


class SetLayers(StrictModel):
    """Client tells the server which layers it wants pushed to it."""

    type: Literal["set_layers"] = "set_layers"
    layers: tuple[LayerName, ...]


type ClientMessage = Annotated[
    SetViewport | SetLayers,
    Field(discriminator="type"),
]
"""Anything a client may send up the socket. Anything else is a protocol error."""
