"""The live WebSocket endpoint.

Starlette's ``TestClient`` is used rather than an ASGI transport because it is the only way
to drive a real WebSocket handshake in-process.

The malformed-message case is the important one. This is a trust boundary: everything
arriving here came from a browser and may have been typed by hand, so anything that does
not match the client contract closes the socket rather than being partially applied.
"""

import json
import time
import warnings
from collections.abc import Callable, Iterator

import pytest
from fastapi import FastAPI
from pydantic import TypeAdapter, ValidationError
from starlette.websockets import WebSocketDisconnect

from tests.conftest import make_aircraft
from tracker.api.routes_ws import WS_POLICY_VIOLATION
from tracker.api.state import AppState
from tracker.contracts.messages import ClientMessage

with warnings.catch_warnings():
    # Starlette warns that its TestClient would rather use httpx2, which this project does
    # not depend on, and pytest turns warnings into errors. Suppressed at the one import
    # that triggers it rather than by loosening the project's warning policy.
    warnings.simplefilter("ignore")
    from starlette.testclient import TestClient


@pytest.fixture
def ws_client(tracker_app: FastAPI) -> Iterator[TestClient]:
    """A test client with the application lifespan running."""
    with TestClient(tracker_app) as client:
        yield client


def _state(client: TestClient) -> AppState:
    state: AppState = client.app.state.tracker  # type: ignore[attr-defined]
    return state


def _wait_for(predicate: Callable[[], bool], *, timeout: float = 2.0) -> bool:
    """Wait for the server thread to have applied a client message.

    The socket sends nothing back in acknowledgement, so the only honest way to know the
    handler has processed a message is to watch the state it changes.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return False


# ---------------------------------------------------------------- connect


def test_connecting_receives_a_snapshot_per_layer(ws_client: TestClient) -> None:
    with ws_client.websocket_connect("/ws") as socket:
        first = socket.receive_json()
        second = socket.receive_json()

    assert first["type"] == "snapshot"
    assert second["type"] == "snapshot"
    assert {first["layer"], second["layer"]} == {"aircraft", "military"}


def test_a_snapshot_carries_the_entities_already_in_the_store(ws_client: TestClient) -> None:
    state = _state(ws_client)
    state.aircraft.upsert("3c6444", make_aircraft("3c6444", callsign="BAW123"))

    with ws_client.websocket_connect("/ws") as socket:
        messages = [socket.receive_json(), socket.receive_json()]

    by_layer = {m["layer"]: m for m in messages}
    assert [e["icao24"] for e in by_layer["aircraft"]["entities"]] == ["3c6444"]
    assert by_layer["aircraft"]["entities"][0]["callsign"] == "BAW123"
    assert by_layer["military"]["entities"] == []


def test_a_snapshot_carries_a_server_time(ws_client: TestClient) -> None:
    with ws_client.websocket_connect("/ws") as socket:
        message = socket.receive_json()

    assert message["server_time"].endswith("Z") or "+00:00" in message["server_time"]


def test_connecting_registers_the_client_with_the_hub(ws_client: TestClient) -> None:
    state = _state(ws_client)

    with ws_client.websocket_connect("/ws") as socket:
        socket.receive_json()
        socket.receive_json()
        assert state.hub.connection_count == 1

    assert _wait_for(lambda: state.hub.connection_count == 0)


def test_two_clients_are_both_registered(ws_client: TestClient) -> None:
    state = _state(ws_client)

    with ws_client.websocket_connect("/ws") as first, ws_client.websocket_connect("/ws") as second:
        for socket in (first, second):
            socket.receive_json()
            socket.receive_json()
        assert state.hub.connection_count == 2


# ---------------------------------------------------------------- set_layers


def test_set_layers_is_accepted_and_narrows_what_the_client_receives(
    ws_client: TestClient,
) -> None:
    state = _state(ws_client)

    with ws_client.websocket_connect("/ws") as socket:
        socket.receive_json()
        socket.receive_json()

        socket.send_json({"type": "set_layers", "layers": ["military"]})

        assert _wait_for(
            lambda: all(c.layers == frozenset({"military"}) for c in state.hub._connections)
        )
        connection = next(iter(state.hub._connections))
        assert connection.wants("military") is True
        assert connection.wants("aircraft") is False


def test_set_layers_to_an_empty_list_silences_the_client(ws_client: TestClient) -> None:
    state = _state(ws_client)

    with ws_client.websocket_connect("/ws") as socket:
        socket.receive_json()
        socket.receive_json()

        socket.send_json({"type": "set_layers", "layers": []})

        assert _wait_for(lambda: all(c.layers == frozenset() for c in state.hub._connections))


def test_set_layers_can_name_a_layer_that_is_not_registered_yet(ws_client: TestClient) -> None:
    """Phase 2 adds vessels and satellites; a client asking early is not an error."""
    state = _state(ws_client)

    with ws_client.websocket_connect("/ws") as socket:
        socket.receive_json()
        socket.receive_json()

        socket.send_json({"type": "set_layers", "layers": ["aircraft", "satellites"]})

        assert _wait_for(lambda: all(c.wants("satellites") for c in state.hub._connections))


# ---------------------------------------------------------------- set_viewport


def test_set_viewport_updates_the_application_state(ws_client: TestClient) -> None:
    state = _state(ws_client)
    assert _state(ws_client).viewport is None

    with ws_client.websocket_connect("/ws") as socket:
        socket.receive_json()
        socket.receive_json()

        socket.send_json(
            {
                "type": "set_viewport",
                "box": {"west": -1.0, "south": 51.0, "east": 1.0, "north": 52.0},
            }
        )

        assert _wait_for(lambda: state.viewport is not None)

    box = state.viewport
    assert box is not None
    assert (box.west, box.south, box.east, box.north) == (-1.0, 51.0, 1.0, 52.0)


def test_a_later_viewport_replaces_an_earlier_one(ws_client: TestClient) -> None:
    state = _state(ws_client)

    with ws_client.websocket_connect("/ws") as socket:
        socket.receive_json()
        socket.receive_json()

        socket.send_json(
            {
                "type": "set_viewport",
                "box": {"west": -1.0, "south": 51.0, "east": 1.0, "north": 52.0},
            }
        )
        assert _wait_for(lambda: state.viewport is not None)

        socket.send_json(
            {
                "type": "set_viewport",
                "box": {"west": 10.0, "south": 40.0, "east": 20.0, "north": 50.0},
            }
        )
        assert _wait_for(lambda: state.viewport is not None and state.viewport.west == 10.0)


def test_a_viewport_across_the_antimeridian_is_accepted(ws_client: TestClient) -> None:
    state = _state(ws_client)

    with ws_client.websocket_connect("/ws") as socket:
        socket.receive_json()
        socket.receive_json()

        socket.send_json(
            {
                "type": "set_viewport",
                "box": {"west": 170.0, "south": -10.0, "east": -170.0, "north": 10.0},
            }
        )

        assert _wait_for(lambda: state.viewport is not None)

    box = state.viewport
    assert box is not None
    assert box.crosses_antimeridian is True


# ---------------------------------------------------------------- protocol violations


@pytest.mark.parametrize(
    "raw",
    [
        pytest.param("not json at all", id="not-json"),
        pytest.param("", id="empty-string"),
        pytest.param("[]", id="json-array"),
        pytest.param('{"type": "set_layers"}', id="missing-layers"),
        pytest.param('{"type": "wibble"}', id="unknown-type"),
        pytest.param('{"layers": ["aircraft"]}', id="missing-discriminator"),
        pytest.param('{"type": "set_layers", "layers": ["not-a-layer"]}', id="unknown-layer-name"),
        pytest.param('{"type": "set_viewport", "box": {"west": 0}}', id="incomplete-box"),
        pytest.param(
            '{"type": "set_viewport", "box": {"west": 0, "south": 52, "east": 1, "north": 51}}',
            id="inverted-box",
        ),
        pytest.param('{"type": "snapshot", "layer": "aircraft"}', id="server-message-sent-up"),
    ],
)
def test_a_malformed_message_closes_the_socket_with_a_policy_violation(
    ws_client: TestClient, raw: str
) -> None:
    with ws_client.websocket_connect("/ws") as socket:
        socket.receive_json()
        socket.receive_json()

        socket.send_text(raw)

        with pytest.raises(WebSocketDisconnect) as caught:
            socket.receive_text()

    assert caught.value.code == WS_POLICY_VIOLATION
    assert WS_POLICY_VIOLATION == 1008


def test_a_malformed_message_disconnects_the_client_from_the_hub(ws_client: TestClient) -> None:
    state = _state(ws_client)

    with ws_client.websocket_connect("/ws") as socket:
        socket.receive_json()
        socket.receive_json()
        socket.send_text("{")
        with pytest.raises(WebSocketDisconnect):
            socket.receive_text()

    assert _wait_for(lambda: state.hub.connection_count == 0)


def test_a_valid_message_after_a_valid_one_keeps_the_socket_open(ws_client: TestClient) -> None:
    state = _state(ws_client)

    with ws_client.websocket_connect("/ws") as socket:
        socket.receive_json()
        socket.receive_json()

        socket.send_json({"type": "set_layers", "layers": ["aircraft"]})
        socket.send_json(
            {
                "type": "set_viewport",
                "box": {"west": -1.0, "south": 51.0, "east": 1.0, "north": 52.0},
            }
        )

        assert _wait_for(lambda: state.viewport is not None)
        assert state.hub.connection_count == 1


def test_the_client_contract_rejects_a_server_message_shape() -> None:
    """The two directions are separate unions on purpose, so a client cannot inject state."""
    adapter: TypeAdapter[ClientMessage] = TypeAdapter(ClientMessage)

    with pytest.raises(ValidationError):
        adapter.validate_json(json.dumps({"type": "upsert", "layer": "aircraft", "entities": []}))
