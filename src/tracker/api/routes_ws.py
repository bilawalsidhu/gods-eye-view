"""The live WebSocket endpoint.

One socket per client, carrying every layer. The read loop exists to accept viewport and
layer changes; all outbound traffic comes from the hub's broadcast loop, so a client that
never speaks still receives updates.

Client messages are validated against a strict contract and a malformed one closes the
socket. This is a trust boundary: anything arriving here came from a browser and may have
been crafted by hand.
"""

import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError

from tracker.api.state import AppState
from tracker.contracts.messages import ClientMessage, LayerName, SetLayers, SetViewport
from tracker.services.hub import Connection

_log = logging.getLogger(__name__)

router = APIRouter(tags=["live"])

_CLIENT_MESSAGE_ADAPTER: TypeAdapter[ClientMessage] = TypeAdapter(ClientMessage)

WS_POLICY_VIOLATION = 1008
"""Close code for a client that sent something we will not accept."""


@router.websocket("/ws")
async def live_feed(websocket: WebSocket) -> None:
    """Stream live entity updates to one browser.

    The hub sends a snapshot of every subscribed layer on connect, then batched deltas on
    its own interval. This handler only reads.
    """
    state: AppState = websocket.app.state.tracker
    await websocket.accept()
    connection = await state.hub.connect(websocket)

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                message = _CLIENT_MESSAGE_ADAPTER.validate_json(raw)
            except ValidationError as exc:
                _log.info("closing socket after malformed client message: %s", exc.error_count())
                await websocket.close(code=WS_POLICY_VIOLATION, reason="malformed message")
                return
            _apply(state, connection, message)
    except WebSocketDisconnect:
        _log.debug("client disconnected")
    finally:
        state.hub.disconnect(connection)


def _apply(state: AppState, connection: Connection, message: ClientMessage) -> None:
    """Apply a validated client message.

    A viewport change is recorded for the aircraft poller to pick up on its next cycle
    rather than triggering an immediate fetch. That indirection is deliberate: a client
    panning the globe would otherwise drive one upstream request per camera movement.
    """
    match message:
        case SetViewport():
            state.viewport = message.box
        case SetLayers():
            wanted: frozenset[LayerName] = frozenset(message.layers)
            state.hub.set_layers(connection, wanted)
