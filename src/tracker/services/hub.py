"""WebSocket fan-out.

The hub is the only thing that talks to browsers. It holds a set of connections, sends
each new one a full snapshot, then pushes batched deltas on a fixed interval.

Batching on an interval rather than per feed update is what keeps this cheap. An aircraft
feed covering a busy viewport produces hundreds of position changes a second; without
batching that is hundreds of socket writes per client. With it, each client gets one
message per interval carrying only the latest value for each entity that moved.

A slow or dead client is dropped rather than waited on. One browser on a bad connection
must not be able to stall the broadcast loop for everyone else.
"""

import asyncio
import contextlib
import logging
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Protocol

from pydantic import TypeAdapter

from tracker.contracts.messages import (
    Entity,
    FeedHealth,
    FeedStatus,
    LayerName,
    Remove,
    ServerMessage,
    Snapshot,
    Upsert,
)
from tracker.services.store import EntityStore

_log = logging.getLogger(__name__)

_SERVER_MESSAGE_ADAPTER: TypeAdapter[ServerMessage] = TypeAdapter(ServerMessage)

SEND_TIMEOUT_SECONDS = 5.0
"""How long a single client gets to accept a message before we consider it dead."""


class SocketLike(Protocol):
    """The slice of a Starlette WebSocket the hub actually uses.

    Narrow on purpose: it lets tests drive the hub with a list-backed fake and no event
    loop plumbing, and it documents exactly what a transport must provide.
    """

    async def send_text(self, data: str) -> None:
        """Send one text frame to the client."""
        ...

    async def close(self, code: int = 1000) -> None:
        """Close the connection with a WebSocket status code."""
        ...


class Connection:
    """One connected browser and what it has asked to receive."""

    __slots__ = ("layers", "socket")

    def __init__(self, socket: SocketLike, layers: frozenset[LayerName]) -> None:
        self.socket = socket
        self.layers = layers

    def wants(self, layer: LayerName) -> bool:
        """Whether this client has subscribed to the given layer."""
        return layer in self.layers


class Hub:
    """Holds client connections and broadcasts store changes to them.

    Layers are registered rather than hardcoded, so phase 2 adds vessels and satellites
    by calling :meth:`register_layer` and changes nothing else in here.
    """

    def __init__(
        self,
        *,
        broadcast_interval_seconds: float,
        health_provider: Callable[[], tuple[FeedHealth, ...]] | None = None,
    ) -> None:
        self._interval = broadcast_interval_seconds
        self._health_provider = health_provider
        self._connections: set[Connection] = set()
        self._layers: dict[LayerName, EntityStore[Any]] = {}
        self._task: asyncio.Task[None] | None = None
        self._stopping = asyncio.Event()

    # ------------------------------------------------------------------ layers

    def register_layer[T: Entity](self, layer: LayerName, store: EntityStore[T]) -> None:
        """Attach a store to a layer name.

        The hub never needs to derive an entity's identity itself: the store already
        tracks keys, and hands them back in :attr:`StoreChanges.removed`.

        Generic in the entity type, and it has to be. ``EntityStore[T]`` is invariant
        because ``upsert_many`` takes a ``T``, so once ``Entity`` became a union in phase 2
        an ``EntityStore[Aircraft]`` stopped satisfying ``EntityStore[Entity]``. The hub
        only ever reads out of a store, so the bound keeps the call site checked while the
        registry holds them read-only.
        """
        self._layers[layer] = store

    @property
    def layers(self) -> tuple[LayerName, ...]:
        """The registered layer names, in registration order."""
        return tuple(self._layers)

    @property
    def connection_count(self) -> int:
        """How many clients are connected right now."""
        return len(self._connections)

    # ------------------------------------------------------------------ connections

    async def connect(
        self, socket: SocketLike, *, layers: frozenset[LayerName] | None = None
    ) -> Connection:
        """Register a client and immediately send it a snapshot of every layer it wants.

        Snapshot first, then deltas. A client that only received deltas would start with
        an empty globe and fill in over minutes as aircraft happened to move.
        """
        wanted = layers if layers is not None else frozenset(self._layers)
        connection = Connection(socket, wanted)
        self._connections.add(connection)

        now = datetime.now(UTC)
        for layer, store in self._layers.items():
            if not connection.wants(layer):
                continue
            await self._send(
                connection,
                Snapshot(layer=layer, entities=store.snapshot(), server_time=now),
            )
        _log.info("client connected (%d total), layers=%s", len(self._connections), sorted(wanted))
        return connection

    def disconnect(self, connection: Connection) -> None:
        """Forget a client. Safe to call for one that has already gone."""
        self._connections.discard(connection)

    def set_layers(self, connection: Connection, layers: frozenset[LayerName]) -> None:
        """Replace what a connected client is subscribed to."""
        connection.layers = layers

    # ------------------------------------------------------------------ broadcasting

    def start(self) -> None:
        """Start the broadcast loop, raising if it is already running."""
        if self._task is not None and not self._task.done():
            msg = "hub broadcast loop is already running"
            raise RuntimeError(msg)
        self._stopping.clear()
        self._task = asyncio.create_task(self._run(), name="hub:broadcast")

    async def stop(self) -> None:
        """Stop the broadcast loop and close every connected client."""
        self._stopping.set()
        task = self._task
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            self._task = None
        await asyncio.gather(
            *(self._close(c) for c in tuple(self._connections)), return_exceptions=True
        )
        self._connections.clear()

    async def flush(self) -> int:
        """Drain every store and push one batch per layer. Returns messages sent.

        Called on an interval by the broadcast loop, and directly by tests so they never
        have to sleep.
        """
        now = datetime.now(UTC)
        sent = 0
        for layer, store in self._layers.items():
            store.expire()
            changes = store.take_changes()
            if changes.is_empty:
                continue
            recipients = [c for c in self._connections if c.wants(layer)]
            if not recipients:
                continue
            messages: list[ServerMessage] = []
            if changes.upserted:
                messages.append(Upsert(layer=layer, entities=changes.upserted, server_time=now))
            if changes.removed:
                messages.append(Remove(layer=layer, ids=changes.removed, server_time=now))
            for message in messages:
                sent += await self._broadcast(message, recipients)
        return sent

    async def broadcast_health(self) -> int:
        """Push current feed health to every client, if a provider was supplied."""
        if self._health_provider is None:
            return 0
        message = FeedStatus(feeds=self._health_provider(), server_time=datetime.now(UTC))
        return await self._broadcast(message, list(self._connections))

    async def _broadcast(self, message: ServerMessage, recipients: list[Connection]) -> int:
        payload = _SERVER_MESSAGE_ADAPTER.dump_json(message).decode()
        results = await asyncio.gather(
            *(self._send_raw(c, payload) for c in recipients), return_exceptions=True
        )
        return sum(1 for r in results if r is True)

    async def _send(self, connection: Connection, message: ServerMessage) -> bool:
        return await self._send_raw(connection, _SERVER_MESSAGE_ADAPTER.dump_json(message).decode())

    async def _send_raw(self, connection: Connection, payload: str) -> bool:
        """Send to one client, dropping it on error or timeout.

        The timeout is the load-bearing part. Without it a client that has stopped
        reading, but whose TCP connection is still nominally open, blocks the gather and
        therefore every other client's update.
        """
        try:
            async with asyncio.timeout(SEND_TIMEOUT_SECONDS):
                await connection.socket.send_text(payload)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - one bad socket must not stop the broadcast
            _log.debug("dropping client after send failure: %s", exc)
            self._connections.discard(connection)
            return False
        return True

    async def _close(self, connection: Connection) -> None:
        with contextlib.suppress(Exception):
            await connection.socket.close()

    async def _run(self) -> None:
        while not self._stopping.is_set():
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=self._interval)
            except TimeoutError:
                pass
            else:
                break
            try:
                await self.flush()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - supervised loop must survive any upstream fault
                _log.exception("broadcast flush failed")
