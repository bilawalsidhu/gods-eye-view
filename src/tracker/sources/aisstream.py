"""aisstream.io global vessel feed.

A WebSocket subscription, not a poll, and that is the whole reason this module looks
different from :mod:`tracker.sources.adsb`. There is no request to make on a cadence: you
connect once, send one subscribe message, and read until the socket dies. So
:class:`tracker.services.poller.Poller` does not wrap it. A ``poll`` function that blocks
for the process lifetime would never return an entity count, health would never update,
and the cadence floor a poller exists to enforce has nothing to enforce. This module owns
its own supervised task instead, and reconnecting is the point of it rather than an
afterthought.

**What is verified and what is not.** Everything about the connection was checked live on
2026-08-19 and is recorded in the vessels recon (section 5). Nothing about the message
payload was, because no key is configured and the key page sits behind a login. The field
names in :class:`PositionReportWire` come from the provider's own documentation as quoted
in that recon, not from a captured message, and they are the one part of this file that
could be wrong. :data:`MAX_UNRECOGNISED_MESSAGES` is the guard: a stream whose envelope we
cannot read fails loudly rather than reporting a healthy feed with nothing on the globe,
which is the failure mode ``adsb.py`` already learned the hard way. Confirming the shape
needs a key.

**The gate behaviour, all observed.** The handshake succeeds with no credentials at all
(HTTP 101, ``server: envoy``), so authentication happens in the first application message
and never in the handshake. A bad key, an empty key and no key at all all produce the same
thing: a raw TCP close about half a second after the subscribe, with no close frame, no
code, no reason and zero bytes. The documented ``{"error": "Api Key Is Not Valid"}`` does
not arrive. On the wire, "bad key" is indistinguishable from "the network dropped", which
is why :data:`MAX_SILENT_CONNECTIONS` exists: connections that close having carried no
message at all are counted, and a run of them stops the client instead of reconnecting
forever against a service the provider itself calls beta.

**Two provider caps and one coordinate trap, all in constants below.** The subscribe must
be the first thing sent or the connection is closed after three seconds. Subscription
updates are capped at one a second, and since every reconnect sends a subscribe, that cap
is the floor on the reconnect delay. Bounding boxes are ``[latitude, longitude]``, the
opposite of this project's rule, the same class of trap as the NASA Worldview ``BBOX``
note in ``AGENTS.md``: get it wrong and you subscribe to a valid box somewhere else.

The key never leaves this module. It appears in exactly one place, the subscribe frame,
and :meth:`AisStreamClient.__repr__` omits it so it cannot reach a log line or an error
message that a browser might see.
"""

import asyncio
import json
import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final

from pydantic import Field, TypeAdapter
from websockets.asyncio.client import connect
from websockets.exceptions import WebSocketException

from tracker.contracts.base import ContractViolationError, WireModel, validate_payload
from tracker.contracts.geo import BoundingBox, Point
from tracker.contracts.vessel import (
    AIS_COG_NOT_AVAILABLE,
    AIS_HEADING_NOT_AVAILABLE,
    Vessel,
    ais_bearing,
    speed_over_ground_mps,
)
from tracker.sources.base import SourceError

_log = logging.getLogger(__name__)

SOURCE_NAME: Final = "aisstream"
"""Per-record provider name, as ADR 010 requires on every merged record."""

AISSTREAM_URL: Final = "wss://stream.aisstream.io/v0/stream"
"""The only endpoint. Verified 2026-08-19: HTTP 101 with no credentials sent."""

UNAVAILABLE_REASON: Final = (
    "Set TRACKER_AISSTREAM_API_KEY (free key from aisstream.io) to enable global ships. "
    "Without it the vessel layer runs on the keyless regional providers only."
)
"""Why the layer is off, worded for ``/api/capabilities`` rather than for a log."""

SUBSCRIBE_DEADLINE_SECONDS: Final = 3.0
"""Provider-stated: a connection that has not subscribed inside this is closed.

Quoted from the provider's documentation: "if a subscription message is not received by
the server in 3 seconds or less the connection will be closed". So the subscribe is the
first thing sent after the handshake and nothing else happens before it.
"""

MIN_SUBSCRIPTION_UPDATE_INTERVAL_SECONDS: Final = 1.0
"""Provider-stated cap: "a maximum of 1 subscription update a second"."""

MIN_RECONNECT_DELAY_SECONDS: Final = MIN_SUBSCRIPTION_UPDATE_INTERVAL_SECONDS
"""Hard floor on the reconnect delay, in code and not in configuration.

Every reconnect sends a subscribe frame, so a reconnect *is* a subscription update and the
provider's one-per-second cap binds it directly. Configuration can slow reconnection down
and can never speed it past this, the same guard as ``Poller.effective_interval``.
"""

MAX_RECONNECT_DELAY_SECONDS: Final = 60.0
"""Ceiling on the backoff. A minute keeps a recovered feed from taking an hour to notice."""

CONNECT_TIMEOUT_SECONDS: Final = 10.0
"""Handshake timeout. The first retry fires at the one-second floor, so a normal reconnect
lands far inside the fifteen seconds the phase 2 acceptance criterion allows."""

MAX_MMSI_FILTER_VALUES: Final = 50
"""Provider-stated maximum on ``FiltersShipMMSI``.

Enforced at construction rather than by truncating the list, because a silently truncated
filter means the fifty-first vessel is missing and nothing anywhere says so.
"""

MAX_SILENT_CONNECTIONS: Final = 3
"""Consecutive connections that closed carrying no message before we call the key dead.

One is a network blip. Three, with the backoff between them, is the provider refusing us:
the observed behaviour for a bad, empty or absent key is a close about half a second after
the subscribe with zero bytes and no close frame, so silence is the only signal there is.
"""

MAX_UNRECOGNISED_MESSAGES: Final = 20
"""Consecutive unreadable messages before this becomes a contract violation.

The safety net under the unverified payload shape. If the documented field names are
wrong, every message fails to map and the layer would otherwise sit connected, healthy and
empty. Twenty in a row on a stream that runs at hundreds a second means the shape changed
or was never right, and a named error is worth more than a silent zero.
"""

POSITION_REPORT: Final = "PositionReport"
"""The only message type this phase renders, and a documented ``FilterMessageTypes`` value.

Subscribing with the filter cuts the traffic the provider warns about: a global bounding
box averages 300 messages a second across all types.
"""

_ANTIMERIDIAN_EAST: Final = 180.0
_ANTIMERIDIAN_WEST: Final = -180.0


class AisStreamUnavailableError(SourceError):
    """No usable API key, so the layer is configured-but-unavailable.

    Raised at construction so the wiring never starts a task that cannot work. Carries
    :data:`UNAVAILABLE_REASON` as its detail, which is the text the capabilities endpoint
    shows.
    """


class AisStreamAuthError(SourceError):
    """The provider closed us out without ever sending a message.

    Almost certainly a rejected key. Ends the client rather than reconnecting, because a
    key the provider refuses is not going to start working and this is a beta service.
    Deliberately carries no part of the key in its message.
    """


class PositionReportWire(WireModel):
    """One AIS position report as aisstream.io is documented to send it.

    **Every field name here is from the provider's documentation, not from a captured
    message.** No key exists, so the recon reached the gate and stopped: see the module
    docstring. Everything is optional so that a wrong guess about one field drops one
    record rather than failing the whole envelope, and the record it drops is counted.

    ``Timestamp`` is the trap. Per ITU-R M.1371 it is the UTC second of the minute, 0 to
    63, with 60 to 63 meaning not available, manual, dead reckoning and inoperative. It is
    not an epoch, exactly as Digitraffic's ``properties.timestamp`` is not, and anything
    that parses it as one dates every vessel to 1970. Nothing here reads it.
    """

    user_id: int | None = Field(default=None, alias="UserID")
    message_id: int | None = Field(default=None, alias="MessageID")
    latitude: float | None = Field(default=None, alias="Latitude")
    longitude: float | None = Field(default=None, alias="Longitude")
    cog: float | None = Field(default=None, alias="Cog")
    sog: float | None = Field(default=None, alias="Sog")
    true_heading: float | None = Field(default=None, alias="TrueHeading")
    timestamp: int | None = Field(default=None, alias="Timestamp")


class StreamPayloadWire(WireModel):
    """The ``Message`` object, keyed by message type.

    Only the position report is read in this phase. Static data would arrive under its own
    key and is ignored rather than dropped, because it is a valid message we do not render
    yet, not a broken one.
    """

    position_report: PositionReportWire | None = Field(default=None, alias=POSITION_REPORT)


class StreamMessageWire(WireModel):
    """The envelope around every message on the stream.

    ``MessageType`` is required, and it is the whole shape check: a payload without it is
    not something this adapter can read, which is what :data:`MAX_UNRECOGNISED_MESSAGES`
    counts. ``Metadata`` is deliberately not modelled. The recon never saw a message, so
    what it contains is unknown, and guessing at a timestamp field in there would be worse
    than dating a record to when we received it.
    """

    message_type: str = Field(alias="MessageType")
    message: StreamPayloadWire = Field(default_factory=StreamPayloadWire, alias="Message")


_ENVELOPE_ADAPTER: Final = TypeAdapter(StreamMessageWire)


@dataclass(slots=True)
class AisStreamStats:
    """Running counts for one client. Every drop is counted, none is silent."""

    connections: int = 0
    subscribes: int = 0
    messages: int = 0
    vessels: int = 0
    dropped: int = 0
    ignored: int = 0
    unrecognised: int = 0


def bounding_boxes_to_wire(boxes: Sequence[BoundingBox]) -> list[list[list[float]]]:
    """Convert domain boxes to aisstream's corner pairs.

    **The order flips here and nowhere else.** This project is ``[longitude, latitude]``
    throughout; the provider documents ``[[lat, lon], [lat, lon]]``, latitude first. A
    transposed box is still a valid box, just somewhere else on Earth, so nothing upstream
    complains and the layer looks like it has no ships in it.

    A box crossing the antimeridian is emitted as two, split at 180 degrees. The corner
    format has no documented wrap convention, and sending ``west > east`` would subscribe
    to the complement of the intended area, which on a global stream is the 300-messages-a-
    second case the provider warns about.

    Args:
        boxes: One or more domain boxes.

    Returns:
        The ``BoundingBoxes`` value, each entry two ``[latitude, longitude]`` corners.
    """
    wire: list[list[list[float]]] = []
    for box in boxes:
        if box.crosses_antimeridian:
            wire.append([[box.south, box.west], [box.north, _ANTIMERIDIAN_EAST]])
            wire.append([[box.south, _ANTIMERIDIAN_WEST], [box.north, box.east]])
        else:
            wire.append([[box.south, box.west], [box.north, box.east]])
    return wire


def _to_domain(wire: PositionReportWire, *, received_at: datetime) -> Vessel | None:
    """Map one position report to the domain contract, or ``None`` if unusable.

    A report without an identity or without a position is dropped rather than defaulted,
    for the same reason ``adsb.py`` drops an aircraft with no position: (0, 0) would draw
    a permanent phantom fleet in the Gulf of Guinea.

    ``observed_at`` is when we received the message and ``position_age_s`` is zero. That
    is honest for a push stream: the provider sends on receipt, and the only time-like
    field in the documented payload is the AIS second of the minute, which is not a
    timestamp. If ``Metadata`` turns out to carry an upstream time once a key exists, the
    age becomes a real measurement and this is the line that changes.

    An MMSI that is not a ship station raises out of the contract and is counted by the
    caller. That covers the 111-prefix search-and-rescue aircraft and the 999999999
    placeholder without either being special-cased here.
    """
    if wire.user_id is None or wire.latitude is None or wire.longitude is None:
        return None
    return Vessel(
        mmsi=f"{wire.user_id:09d}",
        point=Point(lon=float(wire.longitude), lat=float(wire.latitude)),
        course_over_ground_deg=ais_bearing(wire.cog, AIS_COG_NOT_AVAILABLE),
        speed_over_ground_mps=speed_over_ground_mps(wire.sog),
        true_heading_deg=ais_bearing(wire.true_heading, AIS_HEADING_NOT_AVAILABLE),
        observed_at=received_at,
        position_age_s=0.0,
        source=SOURCE_NAME,
    )


class AisStreamClient:
    """A supervised aisstream.io subscription.

    Connects, subscribes, reads, and reconnects for the process lifetime. Every vessel it
    maps goes straight to ``on_vessel``; the client owns no store, so the same class works
    whether the caller is the vessel store or a test collecting into a list.

    Construction fails rather than degrades when it cannot possibly work: no key, no
    bounding box, or an MMSI filter above the provider's cap. Everything after that is a
    runtime condition the loop survives.
    """

    def __init__(
        self,
        *,
        api_key: str,
        boxes: Sequence[BoundingBox],
        on_vessel: Callable[[Vessel], None],
        mmsi_filter: Sequence[str] = (),
        url: str = AISSTREAM_URL,
        reconnect_delay_seconds: float = MIN_RECONNECT_DELAY_SECONDS,
    ) -> None:
        if not api_key.strip():
            raise AisStreamUnavailableError(SOURCE_NAME, UNAVAILABLE_REASON)
        if not boxes:
            msg = (
                "at least one bounding box is required; the provider rejects a "
                "subscription without one and a global box averages 300 messages a second"
            )
            raise ValueError(msg)
        if len(mmsi_filter) > MAX_MMSI_FILTER_VALUES:
            msg = (
                f"mmsi_filter holds {len(mmsi_filter)} values, above the provider's "
                f"cap of {MAX_MMSI_FILTER_VALUES}; truncating would silently lose vessels"
            )
            raise ValueError(msg)

        self._api_key = api_key
        self._boxes = tuple(boxes)
        self._on_vessel = on_vessel
        self._mmsi_filter = tuple(mmsi_filter)
        self._url = url
        self._reconnect_delay_seconds = reconnect_delay_seconds

        self.stats = AisStreamStats()
        self.connected = False
        self.last_error: str | None = None
        self._stopping = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._silent_connections = 0
        self._failures = 0
        self._unrecognised_run = 0

    def __repr__(self) -> str:
        """Describe the client without its key.

        The key must never reach a log line, an error message or anything a browser could
        see, so it is omitted here rather than masked: a masked value still tells a reader
        its length.
        """
        return (
            f"AisStreamClient(url={self._url!r}, boxes={len(self._boxes)}, "
            f"mmsi_filter={len(self._mmsi_filter)}, connected={self.connected})"
        )

    @property
    def effective_reconnect_delay(self) -> float:
        """The base reconnect delay actually used, never below the provider's floor.

        Configuration can slow this down and cannot speed it up, because a reconnect sends
        a subscribe frame and the provider caps subscription updates at one a second.
        """
        return max(self._reconnect_delay_seconds, MIN_RECONNECT_DELAY_SECONDS)

    def subscribe_frame(self) -> str:
        """The one message that authenticates and subscribes, as JSON text.

        Sent first on every connection, including every reconnection. ``APIKey`` and
        ``BoundingBoxes`` are the required pair; the two filters are optional and both are
        sent, the message-type filter because it cuts traffic the provider warns about.
        """
        payload: dict[str, Any] = {
            "APIKey": self._api_key,
            "BoundingBoxes": bounding_boxes_to_wire(self._boxes),
            "FilterMessageTypes": [POSITION_REPORT],
        }
        if self._mmsi_filter:
            payload["FiltersShipMMSI"] = list(self._mmsi_filter)
        return json.dumps(payload)

    def handle_message(self, raw: str | bytes) -> None:
        """Map one raw stream message, handing any vessel to the callback.

        Public because it is how tests drive the mapping without a socket, the same reason
        ``Poller.run_once`` is public.

        Three outcomes that are not a vessel, and they are counted separately because they
        mean different things: ``ignored`` is a valid message of a type this phase does not
        render, ``dropped`` is a position report that would not map, and ``unrecognised``
        is a payload this adapter cannot read at all.

        Raises:
            ContractViolationError: after :data:`MAX_UNRECOGNISED_MESSAGES` unreadable
                messages in a row. That is the documented-but-unverified payload shape
                being wrong, and it has to be loud: a connected, healthy, permanently
                empty layer is the worst of the available failures.
        """
        self.stats.messages += 1
        try:
            envelope = validate_payload(_ENVELOPE_ADAPTER, raw, source=SOURCE_NAME)
        except ContractViolationError as exc:
            self.stats.unrecognised += 1
            self._unrecognised_run += 1
            if self._unrecognised_run >= MAX_UNRECOGNISED_MESSAGES:
                self._unrecognised_run = 0
                detail = (
                    f"{MAX_UNRECOGNISED_MESSAGES} consecutive unreadable messages; the "
                    f"documented payload shape does not match the stream ({exc.detail})"
                )
                raise ContractViolationError(SOURCE_NAME, detail) from exc
            _log.debug("unreadable aisstream message: %s", exc.detail)
            return

        self._unrecognised_run = 0
        if envelope.message_type != POSITION_REPORT:
            self.stats.ignored += 1
            return
        report = envelope.message.position_report
        if report is None:
            # Declared a position report and sent something else. That is a shape problem
            # rather than a message type we choose not to render, so it is a drop.
            self.stats.dropped += 1
            return

        try:
            vessel = _to_domain(report, received_at=datetime.now(UTC))
        except ValueError as exc:
            self.stats.dropped += 1
            _log.debug("dropping unmappable position report: %s", exc)
            return
        if vessel is None:
            self.stats.dropped += 1
            return

        self.stats.vessels += 1
        self._on_vessel(vessel)

    def start(self) -> None:
        """Run the subscription as a background task, raising if already running."""
        if self._task is not None and not self._task.done():
            msg = f"{SOURCE_NAME} client is already running"
            raise RuntimeError(msg)
        self._task = asyncio.create_task(self.run(), name=f"stream:{SOURCE_NAME}")

    async def stop(self) -> None:
        """Signal the loop to finish and wait for it.

        Swallows a source failure rather than raising out of shutdown: a rejected key must
        not stop the application closing cleanly. It is already on ``last_error``.
        """
        self._stopping.set()
        task = self._task
        if task is None:
            return
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, SourceError):
            pass
        finally:
            self._task = None

    async def run(self) -> None:
        """Stay subscribed for the process lifetime, reconnecting after every drop.

        Survives anything the socket or the provider does, with one exception. A run of
        connections that closed carrying no message at all is the provider refusing the
        key, and the only signal it gives: it sends no close frame, no code and no error
        text. Reconnecting into that forever would hammer a beta service that has already
        said no, so it ends the client instead.

        Raises:
            AisStreamAuthError: after :data:`MAX_SILENT_CONNECTIONS` connections in a row
                that carried no message.
        """
        self._stopping.clear()
        _log.info("%s: subscribing to %d bounding box(es)", SOURCE_NAME, len(self._boxes))
        while not self._stopping.is_set():
            received = 0
            try:
                received = await self._session()
            except asyncio.CancelledError:
                raise
            except (WebSocketException, OSError, TimeoutError, ContractViolationError) as exc:
                self.last_error = f"{type(exc).__name__}: {exc}"
                _log.warning("%s: connection ended: %s", SOURCE_NAME, exc)
            self._failures = 0 if received else self._failures + 1

            if self._silent_connections >= MAX_SILENT_CONNECTIONS:
                detail = (
                    f"{self._silent_connections} connections closed without a single "
                    "message; the provider closes a rejected key silently, so this is "
                    "almost certainly the key being refused"
                )
                self.last_error = detail
                raise AisStreamAuthError(SOURCE_NAME, detail)

            await self._wait_before_reconnect()
        _log.info("%s: stopped", SOURCE_NAME)

    async def _session(self) -> int:
        """One connection: subscribe first, then read until it closes.

        The subscribe is sent before anything else and under its own timeout, because the
        provider closes a connection that has not subscribed within three seconds.

        A connection that closes having carried no message is counted on the way out,
        whether it ended cleanly or was aborted mid-flight, because a rejected key looks
        exactly like an abort. A handshake that never connects does not reach that count:
        an unreachable provider is a different fault from a refused key and must not end
        the client.

        Returns:
            How many messages this connection carried.
        """
        received = 0
        async with connect(self._url, open_timeout=CONNECT_TIMEOUT_SECONDS) as socket:
            self.stats.connections += 1
            self.connected = True
            try:
                async with asyncio.timeout(SUBSCRIBE_DEADLINE_SECONDS):
                    await socket.send(self.subscribe_frame())
                self.stats.subscribes += 1
                async for raw in socket:
                    received += 1
                    self.handle_message(raw)
            finally:
                self.connected = False
                self._silent_connections = 0 if received else self._silent_connections + 1
        return received

    async def _wait_before_reconnect(self) -> None:
        """Sleep before the next connection, backing off while it keeps failing.

        Never faster than :data:`MIN_RECONNECT_DELAY_SECONDS`, and interruptible so a
        shutdown does not wait out a minute of backoff. A connection that carried messages
        resets the backoff, so the reconnect after a healthy stream drops fires at the
        floor: that is what keeps a dropped connection inside the fifteen seconds the
        phase 2 acceptance criterion allows.
        """
        delay = min(
            self.effective_reconnect_delay * (2.0 ** max(0, self._failures - 1)),
            MAX_RECONNECT_DELAY_SECONDS,
        )
        try:
            await asyncio.wait_for(self._stopping.wait(), timeout=delay)
        except TimeoutError:
            return
