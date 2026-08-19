"""WebSocket fan-out, driven by a fake socket.

``SocketLike`` is a two-method protocol precisely so this file needs no event-loop
plumbing: a list-backed fake records what a browser would have received.

The behaviour that matters most is isolation. One browser on a dead connection must not be
able to stall or break delivery to everybody else, so the "healthy client still got its
message" assertion is the one to keep.
"""

import asyncio
import json
from datetime import UTC, datetime
from typing import Any

import pytest
from pydantic import TypeAdapter

from tests.conftest import FrozenClock, make_aircraft
from tracker.contracts.aircraft import Aircraft
from tracker.contracts.messages import (
    Entity,
    FeedHealth,
    FeedStatus,
    Remove,
    ServerMessage,
    Snapshot,
    Upsert,
)
from tracker.services.hub import Hub
from tracker.services.store import EntityStore, StoreChanges

_SERVER_MESSAGE_ADAPTER: TypeAdapter[ServerMessage] = TypeAdapter(ServerMessage)


class FakeSocket:
    """A list-backed :class:`SocketLike`.

    ``fail`` makes ``send_text`` raise the way a socket to a browser that has gone away
    does; ``block_forever`` makes it hang, which is the case the send timeout exists for.
    """

    __slots__ = ("closed", "fail", "hang", "sent")

    def __init__(self, *, fail: bool = False, hang: bool = False) -> None:
        self.sent: list[str] = []
        self.closed = False
        self.fail = fail
        self.hang = hang

    async def send_text(self, data: str) -> None:
        if self.fail:
            raise ConnectionResetError("client went away")
        if self.hang:
            await asyncio.Event().wait()
        self.sent.append(data)

    async def close(self, code: int = 1000) -> None:
        self.closed = True

    def messages(self) -> list[dict[str, Any]]:
        return [json.loads(raw) for raw in self.sent]

    def types(self) -> list[str]:
        return [m["type"] for m in self.messages()]


def _validated(socket: FakeSocket) -> list[ServerMessage]:
    """Every message the socket received, re-validated against the wire contract.

    Validated exactly as sent, with no preprocessing. That is the point: the hub's output
    must be valid input to its own contract, and stripping anything first would hide the
    regression this is here to catch.
    """
    return [_SERVER_MESSAGE_ADAPTER.validate_json(raw) for raw in socket.sent]


def _hub(
    *,
    health: tuple[FeedHealth, ...] | None = None,
    clock: FrozenClock | None = None,
) -> tuple[Hub, EntityStore[Entity], EntityStore[Entity]]:
    """A hub with the two aircraft layers the app registers, plus their stores.

    Passing a ``clock`` makes expiry, and therefore the ``remove`` messages a flush emits,
    deterministic instead of a race against wall time.
    """
    ticker = clock if clock is not None else FrozenClock()
    aircraft: EntityStore[Entity] = EntityStore(ttl_seconds=90.0, clock=ticker)
    military: EntityStore[Entity] = EntityStore(ttl_seconds=90.0, clock=ticker)
    hub = Hub(
        broadcast_interval_seconds=0.01,
        health_provider=(lambda: health) if health is not None else None,
    )
    hub.register_layer("aircraft", aircraft)
    hub.register_layer("military", military)
    return hub, aircraft, military


def _health(source: str = "adsb.lol/point") -> FeedHealth:
    return FeedHealth(
        source=source,
        layer="aircraft",
        healthy=True,
        entity_count=65,
        last_success_at=datetime.now(UTC),
        poll_interval_seconds=8.0,
    )


# ---------------------------------------------------------------- registration


def test_registering_layers_records_them() -> None:
    hub, _, _ = _hub()

    assert hub.layers == ("aircraft", "military")
    assert hub.connection_count == 0


def test_registering_the_same_layer_twice_replaces_its_store() -> None:
    hub, _, _ = _hub()
    replacement: EntityStore[Entity] = EntityStore(ttl_seconds=1.0)

    hub.register_layer("aircraft", replacement)

    assert hub.layers == ("aircraft", "military")


# ---------------------------------------------------------------- connect


async def test_connect_sends_a_snapshot_per_registered_layer() -> None:
    hub, aircraft, military = _hub()
    aircraft.upsert("aaaaaa", make_aircraft("aaaaaa"))
    military.upsert("bbbbbb", make_aircraft("bbbbbb", is_military=True))
    socket = FakeSocket()

    await hub.connect(socket)

    assert socket.types() == ["snapshot", "snapshot"]
    layers = [m["layer"] for m in socket.messages()]
    assert layers == ["aircraft", "military"]
    assert hub.connection_count == 1


def _entity_ids(message: dict[str, Any]) -> set[str]:
    return {e["icao24"] for e in message["entities"]}


async def test_a_snapshot_carries_the_current_contents_of_its_layer() -> None:
    hub, aircraft, military = _hub()
    aircraft.upsert("aaaaaa", make_aircraft("aaaaaa"))
    aircraft.upsert("cccccc", make_aircraft("cccccc"))
    military.upsert("bbbbbb", make_aircraft("bbbbbb", is_military=True))
    socket = FakeSocket()

    await hub.connect(socket)

    by_layer = {m["layer"]: m for m in socket.messages()}
    assert _entity_ids(by_layer["aircraft"]) == {"aaaaaa", "cccccc"}
    assert _entity_ids(by_layer["military"]) == {"bbbbbb"}


async def test_connect_sends_snapshots_only_for_the_layers_the_client_wants() -> None:
    hub, aircraft, military = _hub()
    aircraft.upsert("aaaaaa", make_aircraft("aaaaaa"))
    military.upsert("bbbbbb", make_aircraft("bbbbbb", is_military=True))
    socket = FakeSocket()

    await hub.connect(socket, layers=frozenset({"military"}))

    assert [m["layer"] for m in socket.messages()] == ["military"]


async def test_connect_with_no_layers_wanted_sends_nothing() -> None:
    hub, aircraft, _ = _hub()
    aircraft.upsert("aaaaaa", make_aircraft("aaaaaa"))
    socket = FakeSocket()

    connection = await hub.connect(socket, layers=frozenset())

    assert socket.sent == []
    assert hub.connection_count == 1
    assert connection.wants("aircraft") is False


async def test_a_snapshot_of_an_empty_layer_is_still_sent() -> None:
    """A client must be told a layer is empty, not left waiting to find out."""
    hub, _, _ = _hub()
    socket = FakeSocket()

    await hub.connect(socket)

    assert socket.types() == ["snapshot", "snapshot"]
    assert all(m["entities"] == [] for m in socket.messages())


async def test_disconnect_removes_the_connection() -> None:
    hub, _, _ = _hub()
    connection = await hub.connect(FakeSocket())

    hub.disconnect(connection)

    assert hub.connection_count == 0

    hub.disconnect(connection)
    assert hub.connection_count == 0


# ---------------------------------------------------------------- flush


async def test_flush_sends_an_upsert_for_changed_entities() -> None:
    hub, aircraft, _ = _hub()
    socket = FakeSocket()
    await hub.connect(socket)
    socket.sent.clear()

    aircraft.upsert("aaaaaa", make_aircraft("aaaaaa", callsign="MOVED"))
    sent = await hub.flush()

    assert sent == 1
    assert socket.types() == ["upsert"]
    message = socket.messages()[0]
    assert message["layer"] == "aircraft"
    assert _entity_ids(message) == {"aaaaaa"}


async def test_flush_sends_a_remove_for_expired_entities(frozen_clock: FrozenClock) -> None:
    hub, aircraft, _ = _hub(clock=frozen_clock)
    aircraft.upsert("aaaaaa", make_aircraft("aaaaaa"))
    socket = FakeSocket()
    await hub.connect(socket)
    await hub.flush()
    socket.sent.clear()

    frozen_clock.advance(120.0)
    sent = await hub.flush()

    assert sent == 1
    assert socket.types() == ["remove"]
    assert socket.messages()[0]["ids"] == ["aaaaaa"]


async def test_flush_sends_both_an_upsert_and_a_remove_when_both_happened(
    frozen_clock: FrozenClock,
) -> None:
    hub, aircraft, _ = _hub(clock=frozen_clock)
    aircraft.upsert("aaaaaa", make_aircraft("aaaaaa"))
    socket = FakeSocket()
    await hub.connect(socket)
    await hub.flush()
    socket.sent.clear()

    frozen_clock.advance(120.0)
    aircraft.upsert("bbbbbb", make_aircraft("bbbbbb"))
    sent = await hub.flush()

    assert sent == 2
    assert socket.types() == ["upsert", "remove"]
    assert socket.messages()[1]["ids"] == ["aaaaaa"]


async def test_flush_sends_nothing_when_nothing_changed() -> None:
    hub, _, _ = _hub()
    socket = FakeSocket()
    await hub.connect(socket)
    socket.sent.clear()

    assert await hub.flush() == 0
    assert socket.sent == []


async def test_flush_with_no_clients_still_drains_the_stores() -> None:
    """Otherwise the first client to connect would receive a backlog as a delta."""
    hub, aircraft, _ = _hub()
    aircraft.upsert("aaaaaa", make_aircraft("aaaaaa"))

    assert await hub.flush() == 0


async def test_flush_only_reaches_clients_subscribed_to_that_layer() -> None:
    hub, aircraft, military = _hub()
    all_layers = FakeSocket()
    military_only = FakeSocket()
    await hub.connect(all_layers)
    await hub.connect(military_only, layers=frozenset({"military"}))
    all_layers.sent.clear()
    military_only.sent.clear()

    aircraft.upsert("aaaaaa", make_aircraft("aaaaaa"))
    military.upsert("bbbbbb", make_aircraft("bbbbbb", is_military=True))
    await hub.flush()

    assert [m["layer"] for m in all_layers.messages()] == ["aircraft", "military"]
    assert [m["layer"] for m in military_only.messages()] == ["military"]


async def test_flush_reaches_every_subscribed_client() -> None:
    hub, aircraft, _ = _hub()
    sockets = [FakeSocket(), FakeSocket(), FakeSocket()]
    for socket in sockets:
        await hub.connect(socket)
        socket.sent.clear()

    aircraft.upsert("aaaaaa", make_aircraft("aaaaaa"))
    sent = await hub.flush()

    assert sent == 3
    assert all(s.types() == ["upsert"] for s in sockets)


# ---------------------------------------------------------------- set_layers


async def test_set_layers_changes_what_a_client_receives_on_the_next_flush() -> None:
    hub, aircraft, military = _hub()
    socket = FakeSocket()
    connection = await hub.connect(socket)
    socket.sent.clear()

    hub.set_layers(connection, frozenset({"military"}))
    aircraft.upsert("aaaaaa", make_aircraft("aaaaaa"))
    military.upsert("bbbbbb", make_aircraft("bbbbbb", is_military=True))
    await hub.flush()

    assert [m["layer"] for m in socket.messages()] == ["military"]


async def test_set_layers_can_widen_a_subscription() -> None:
    hub, aircraft, _ = _hub()
    socket = FakeSocket()
    connection = await hub.connect(socket, layers=frozenset({"military"}))
    socket.sent.clear()

    hub.set_layers(connection, frozenset({"aircraft", "military"}))
    aircraft.upsert("aaaaaa", make_aircraft("aaaaaa"))
    await hub.flush()

    assert [m["layer"] for m in socket.messages()] == ["aircraft"]


async def test_set_layers_to_nothing_silences_a_client() -> None:
    hub, aircraft, _ = _hub()
    socket = FakeSocket()
    connection = await hub.connect(socket)
    socket.sent.clear()

    hub.set_layers(connection, frozenset())
    aircraft.upsert("aaaaaa", make_aircraft("aaaaaa"))

    assert await hub.flush() == 0
    assert socket.sent == []


# ---------------------------------------------------------------- failing clients


async def test_a_client_whose_send_raises_is_dropped_without_breaking_the_others() -> None:
    """One browser on a dead connection must not cost everybody else their update."""
    hub, aircraft, _ = _hub()
    healthy = FakeSocket()
    broken = FakeSocket(fail=True)
    await hub.connect(healthy)
    await hub.connect(broken)
    healthy.sent.clear()
    assert hub.connection_count == 1, "the broken client failed its snapshot and was dropped"

    aircraft.upsert("aaaaaa", make_aircraft("aaaaaa"))
    sent = await hub.flush()

    assert sent == 1
    assert healthy.types() == ["upsert"]
    assert broken.sent == []


async def test_a_client_that_fails_mid_broadcast_is_dropped() -> None:
    hub, aircraft, _ = _hub()
    healthy = FakeSocket()
    flaky = FakeSocket()
    await hub.connect(healthy)
    await hub.connect(flaky)
    healthy.sent.clear()
    flaky.sent.clear()
    assert hub.connection_count == 2

    flaky.fail = True
    aircraft.upsert("aaaaaa", make_aircraft("aaaaaa"))
    sent = await hub.flush()

    assert sent == 1
    assert healthy.types() == ["upsert"]
    assert hub.connection_count == 1


async def test_a_failing_snapshot_drops_the_client_immediately() -> None:
    hub, _, _ = _hub()
    broken = FakeSocket(fail=True)

    await hub.connect(broken)

    assert hub.connection_count == 0


async def test_a_hanging_client_is_dropped_after_the_send_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without the timeout, a client that stopped reading blocks every other client."""
    monkeypatch.setattr("tracker.services.hub.SEND_TIMEOUT_SECONDS", 0.01)
    hub, aircraft, _ = _hub()
    healthy = FakeSocket()
    hanging = FakeSocket(hang=True)
    await hub.connect(healthy)
    await hub.connect(hanging)
    healthy.sent.clear()

    aircraft.upsert("aaaaaa", make_aircraft("aaaaaa"))
    sent = await hub.flush()

    assert sent == 1
    assert healthy.types() == ["upsert"]
    assert hub.connection_count == 1


# ---------------------------------------------------------------- health


async def test_broadcast_health_sends_a_feed_status() -> None:
    hub, _, _ = _hub(health=(_health(), _health("adsb.lol/mil")))
    socket = FakeSocket()
    await hub.connect(socket)
    socket.sent.clear()

    sent = await hub.broadcast_health()

    assert sent == 1
    assert socket.types() == ["feed_status"]
    message = socket.messages()[0]
    assert {f["source"] for f in message["feeds"]} == {"adsb.lol/point", "adsb.lol/mil"}


async def test_broadcast_health_sends_nothing_without_a_provider() -> None:
    hub, _, _ = _hub()
    socket = FakeSocket()
    await hub.connect(socket)
    socket.sent.clear()

    assert await hub.broadcast_health() == 0
    assert socket.sent == []


async def test_broadcast_health_reaches_clients_regardless_of_their_layers() -> None:
    """Feed health is not a layer; a client watching only ships still needs the banner."""
    hub, _, _ = _hub(health=(_health(),))
    socket = FakeSocket()
    await hub.connect(socket, layers=frozenset())

    assert await hub.broadcast_health() == 1
    assert socket.types() == ["feed_status"]


# ---------------------------------------------------------------- wire contract


async def test_every_message_the_hub_emits_validates_against_the_server_contract(
    frozen_clock: FrozenClock,
) -> None:
    hub, aircraft, military = _hub(health=(_health(),), clock=frozen_clock)
    socket = FakeSocket()
    await hub.connect(socket)

    aircraft.upsert("aaaaaa", make_aircraft("aaaaaa", callsign="BAW123", squawk="7700"))
    military.upsert("bbbbbb", make_aircraft("bbbbbb", is_military=True))
    await hub.flush()
    frozen_clock.advance(120.0)
    await hub.flush()
    await hub.broadcast_health()

    messages = _validated(socket)

    assert [type(m) for m in messages[:2]] == [Snapshot, Snapshot]
    assert any(isinstance(m, Upsert) for m in messages)
    assert any(isinstance(m, Remove) for m in messages)
    assert isinstance(messages[-1], FeedStatus)
    for message in messages:
        if isinstance(message, Snapshot | Upsert):
            assert all(isinstance(e, Aircraft) for e in message.entities)


async def test_every_emitted_message_carries_a_utc_server_time() -> None:
    hub, aircraft, _ = _hub()
    socket = FakeSocket()
    await hub.connect(socket)
    aircraft.upsert("aaaaaa", make_aircraft("aaaaaa"))
    await hub.flush()

    for message in _validated(socket):
        assert message.server_time.tzinfo is UTC


# ---------------------------------------------------------------- broadcast loop


async def test_start_then_stop_flushes_on_its_interval() -> None:
    hub, aircraft, _ = _hub()
    socket = FakeSocket()
    await hub.connect(socket)
    socket.sent.clear()

    hub.start()
    aircraft.upsert("aaaaaa", make_aircraft("aaaaaa"))
    await asyncio.sleep(0.05)
    await hub.stop()

    assert "upsert" in socket.types()
    assert socket.closed is True
    assert hub.connection_count == 0


async def test_starting_the_loop_twice_raises() -> None:
    hub, _, _ = _hub()
    hub.start()
    try:
        with pytest.raises(RuntimeError, match="already running"):
            hub.start()
    finally:
        await hub.stop()


async def test_stop_is_safe_when_never_started() -> None:
    hub, _, _ = _hub()

    await hub.stop()
    await hub.stop()


async def test_stop_closes_every_client_and_tolerates_a_close_that_raises() -> None:
    class _BadClose(FakeSocket):
        async def close(self, code: int = 1000) -> None:
            raise ConnectionResetError("already gone")

    hub, _, _ = _hub()
    good = FakeSocket()
    await hub.connect(good)
    await hub.connect(_BadClose())

    await hub.stop()

    assert good.closed is True
    assert hub.connection_count == 0


async def test_the_loop_keeps_running_when_a_flush_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A broken layer must not silence every other layer for the rest of the process."""
    hub, aircraft, _ = _hub()
    socket = FakeSocket()
    await hub.connect(socket)
    socket.sent.clear()

    calls = 0
    original = EntityStore.take_changes

    def _explode_once(store: EntityStore[Entity]) -> StoreChanges[Entity]:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("layer is broken")
        return original(store)

    monkeypatch.setattr(EntityStore, "take_changes", _explode_once)
    hub.start()
    aircraft.upsert("aaaaaa", make_aircraft("aaaaaa"))
    await asyncio.sleep(0.08)
    await hub.stop()

    assert calls >= 2, "the broadcast loop must survive a failing flush"
