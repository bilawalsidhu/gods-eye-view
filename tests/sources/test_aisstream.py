"""The aisstream.io vessel subscription: lifecycle, reconnection and mapping.

No network. The lifecycle tests run a real websocket server on loopback, because that is
the only way to prove a reconnect actually reconnects: respx intercepts HTTP transports and
this feed is not HTTP. The mapping tests need no socket at all and drive
``handle_message`` directly.

**There is no recorded fixture for this feed and there cannot be one yet.** The recon
reached the gate and stopped: with no key the provider closes the connection about half a
second after the subscribe having sent zero bytes, so there is nothing to record. Every
payload below is built from the field names the provider documents, quoted in the vessels
recon, and is labelled as such. They are not presented as captured traffic.

Reconnection gets most of the attention here because it is the phase 2 acceptance
criterion, and the silent-close tests get the rest because a rejected key is
indistinguishable from a dropped network on this feed.
"""

import asyncio
import json
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import pytest
from websockets.asyncio.server import ServerConnection, serve

from tracker.contracts.base import ContractViolationError
from tracker.contracts.geo import KNOTS_TO_METRES_PER_SECOND, BoundingBox
from tracker.contracts.vessel import Vessel
from tracker.sources.aisstream import (
    AISSTREAM_URL,
    MAX_MMSI_FILTER_VALUES,
    MAX_SILENT_CONNECTIONS,
    MAX_UNRECOGNISED_MESSAGES,
    MIN_RECONNECT_DELAY_SECONDS,
    MIN_SUBSCRIPTION_UPDATE_INTERVAL_SECONDS,
    POSITION_REPORT,
    SUBSCRIBE_DEADLINE_SECONDS,
    UNAVAILABLE_REASON,
    AisStreamAuthError,
    AisStreamClient,
    AisStreamUnavailableError,
    bounding_boxes_to_wire,
)

API_KEY = "aisstream-test-key-not-a-real-one"

RECONNECT_DEADLINE_SECONDS = 15.0
"""Phase 2 acceptance criterion 3: killing the connection reconnects and resubscribes
inside this."""

# The North Sea, deliberately not square so a latitude/longitude transposition cannot pass
# a test by symmetry.
NORTH_SEA = BoundingBox(west=1.0, south=51.0, east=8.0, north=58.0)


def position_report(**overrides: Any) -> str:
    """A message in the shape the provider documents, with the envelope filled in.

    Not captured traffic: see the module docstring. ``UserID`` defaults to a real Finnish
    ship-station MMSI so the identity rules in the vessel contract are exercised rather
    than sidestepped.
    """
    report: dict[str, Any] = {
        "UserID": 230713000,
        "MessageID": 1,
        "Latitude": 60.913175,
        "Longitude": 18.831058,
        "Cog": 347.2,
        "Sog": 10.9,
        "TrueHeading": 347.0,
        "Timestamp": 42,
    }
    report.update(overrides)
    return json.dumps({"MessageType": POSITION_REPORT, "Message": {POSITION_REPORT: report}})


def make_client(
    url: str,
    sink: list[Vessel],
    **overrides: Any,
) -> AisStreamClient:
    """A client pointed at a local server, collecting into ``sink``."""
    kwargs: dict[str, Any] = {
        "api_key": API_KEY,
        "boxes": [NORTH_SEA],
        "on_vessel": sink.append,
        "url": url,
    }
    kwargs.update(overrides)
    return AisStreamClient(**kwargs)


# ---------------------------------------------------------------- local provider stand-in


@dataclass(slots=True)
class FakeStream:
    """A websocket server on loopback standing in for the provider.

    Records the first frame of every connection, which is what proves the subscribe is
    sent first and what proves a reconnect resubscribed.
    """

    url: str
    subscribes: asyncio.Queue[tuple[float, str]] = field(default_factory=asyncio.Queue)
    connections: int = 0


def _stream_server(
    behaviour: Callable[[FakeStream, ServerConnection], Any],
) -> Any:
    """Build a pytest fixture serving ``behaviour`` on a free loopback port."""

    @pytest.fixture
    async def _fixture() -> AsyncIterator[FakeStream]:
        stream = FakeStream(url="")

        async def handler(socket: ServerConnection) -> None:
            stream.connections += 1
            first = await socket.recv()
            await stream.subscribes.put((time.monotonic(), str(first)))
            await behaviour(stream, socket)

        server = await serve(handler, "127.0.0.1", 0)
        stream.url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
        try:
            yield stream
        finally:
            server.close()
            await server.wait_closed()

    return _fixture


async def _send_one_then_close(_stream: FakeStream, socket: ServerConnection) -> None:
    """One valid message, then a clean close. A healthy connection that drops."""
    await socket.send(position_report())
    await socket.close()


async def _close_silently(_stream: FakeStream, socket: ServerConnection) -> None:
    """Close immediately after the subscribe, sending nothing.

    What the provider actually does for a bad, empty or absent key: no close frame, no
    code, no error text, zero bytes.
    """
    await socket.close()


async def _stay_open(_stream: FakeStream, socket: ServerConnection) -> None:
    """Send one message and hold the connection open until someone closes it."""
    await socket.send(position_report())
    await socket.wait_closed()


dropping_stream = _stream_server(_send_one_then_close)
silent_stream = _stream_server(_close_silently)
open_stream = _stream_server(_stay_open)


async def _wait_until(condition: Callable[[], bool]) -> None:
    """Wait for a background task to reach a state, polling.

    Polling rather than an event because the states waited on live partly on the client
    and partly on the fake server, and threading an event through both would bury the
    assertion. ASYNC110 is aimed at production busy-waits; every call here is bounded by
    an ``asyncio.timeout``.
    """
    while not condition():  # noqa: ASYNC110
        await asyncio.sleep(0.01)


async def _run_briefly(client: AisStreamClient, condition: Callable[[], bool]) -> None:
    """Run the client until ``condition`` holds, then stop it."""
    client.start()
    try:
        async with asyncio.timeout(RECONNECT_DEADLINE_SECONDS):
            await _wait_until(condition)
    finally:
        await client.stop()


# ---------------------------------------------------------------- construction guards


def test_a_missing_key_is_unavailable_not_broken() -> None:
    """No key means the layer reports itself off, with the reason a user can act on."""
    with pytest.raises(AisStreamUnavailableError) as caught:
        AisStreamClient(api_key="", boxes=[NORTH_SEA], on_vessel=lambda _v: None)
    assert caught.value.detail == UNAVAILABLE_REASON
    assert "TRACKER_AISSTREAM_API_KEY" in str(caught.value)


def test_whitespace_is_not_a_key() -> None:
    with pytest.raises(AisStreamUnavailableError):
        AisStreamClient(api_key="   ", boxes=[NORTH_SEA], on_vessel=lambda _v: None)


def test_a_subscription_needs_a_bounding_box() -> None:
    """The provider requires one, and a global box is 300 messages a second."""
    with pytest.raises(ValueError, match="bounding box"):
        AisStreamClient(api_key=API_KEY, boxes=[], on_vessel=lambda _v: None)


def test_the_mmsi_filter_cap_is_refused_not_truncated() -> None:
    """Silently dropping the fifty-first MMSI loses a vessel with nothing said."""
    too_many = [f"2307130{n:02d}" for n in range(MAX_MMSI_FILTER_VALUES + 1)]
    with pytest.raises(ValueError, match=str(MAX_MMSI_FILTER_VALUES)):
        AisStreamClient(
            api_key=API_KEY, boxes=[NORTH_SEA], on_vessel=lambda _v: None, mmsi_filter=too_many
        )


def test_the_mmsi_filter_cap_itself_is_allowed() -> None:
    client = AisStreamClient(
        api_key=API_KEY,
        boxes=[NORTH_SEA],
        on_vessel=lambda _v: None,
        mmsi_filter=[f"2307130{n:02d}" for n in range(MAX_MMSI_FILTER_VALUES)],
    )
    assert len(json.loads(client.subscribe_frame())["FiltersShipMMSI"]) == MAX_MMSI_FILTER_VALUES


def test_the_default_url_is_the_provider() -> None:
    assert AISSTREAM_URL == "wss://stream.aisstream.io/v0/stream"


# ---------------------------------------------------------------- cadence floors


def test_configuration_cannot_reconnect_faster_than_the_provider_allows() -> None:
    """The floor is a constant in code, so an environment variable cannot lower it.

    Every reconnect sends a subscribe frame, and the provider caps subscription updates at
    one a second, so this floor is that cap.
    """
    client = AisStreamClient(
        api_key=API_KEY,
        boxes=[NORTH_SEA],
        on_vessel=lambda _v: None,
        reconnect_delay_seconds=0.001,
    )
    assert client.effective_reconnect_delay == MIN_RECONNECT_DELAY_SECONDS
    assert MIN_RECONNECT_DELAY_SECONDS == MIN_SUBSCRIPTION_UPDATE_INTERVAL_SECONDS


def test_configuration_can_still_slow_reconnection_down() -> None:
    client = AisStreamClient(
        api_key=API_KEY,
        boxes=[NORTH_SEA],
        on_vessel=lambda _v: None,
        reconnect_delay_seconds=30.0,
    )
    assert client.effective_reconnect_delay == 30.0


def test_the_subscribe_deadline_is_the_providers_own_figure() -> None:
    """Quoted from the provider: subscribe inside three seconds or be closed."""
    assert SUBSCRIBE_DEADLINE_SECONDS == 3.0


# ---------------------------------------------------------------- the subscribe frame


def test_the_bounding_box_order_is_flipped_for_the_provider() -> None:
    """Latitude first, the opposite of this project's rule.

    The box is not square on purpose: a transposed pair would still be a valid box and
    would pass any symmetric assertion.
    """
    assert bounding_boxes_to_wire([NORTH_SEA]) == [[[51.0, 1.0], [58.0, 8.0]]]


def test_an_antimeridian_box_is_split_rather_than_sent_inverted() -> None:
    """``west > east`` has no documented meaning here, and inverted means the whole world."""
    wrapping = BoundingBox(west=170.0, south=-20.0, east=-170.0, north=-10.0)
    assert bounding_boxes_to_wire([wrapping]) == [
        [[-20.0, 170.0], [-10.0, 180.0]],
        [[-20.0, -180.0], [-10.0, -170.0]],
    ]


def test_the_subscribe_frame_carries_the_required_pair_and_the_type_filter() -> None:
    client = AisStreamClient(api_key=API_KEY, boxes=[NORTH_SEA], on_vessel=lambda _v: None)
    frame = json.loads(client.subscribe_frame())
    assert frame["APIKey"] == API_KEY
    assert frame["BoundingBoxes"] == [[[51.0, 1.0], [58.0, 8.0]]]
    assert frame["FilterMessageTypes"] == [POSITION_REPORT]
    assert "FiltersShipMMSI" not in frame


def test_the_key_never_appears_in_the_repr() -> None:
    """The one thing that must not reach a log line or a browser."""
    client = AisStreamClient(api_key=API_KEY, boxes=[NORTH_SEA], on_vessel=lambda _v: None)
    assert API_KEY not in repr(client)
    assert "ws" in repr(client)


def test_the_key_never_appears_in_an_auth_error() -> None:
    error = AisStreamAuthError("aisstream", "three silent connections")
    assert API_KEY not in str(error)


# ---------------------------------------------------------------- mapping


def _client_for_mapping(sink: list[Vessel]) -> AisStreamClient:
    return AisStreamClient(api_key=API_KEY, boxes=[NORTH_SEA], on_vessel=sink.append)


def test_a_position_report_maps_to_a_vessel() -> None:
    sink: list[Vessel] = []
    client = _client_for_mapping(sink)
    client.handle_message(position_report())

    vessel = sink[0]
    assert vessel.mmsi == "230713000"
    assert vessel.point.lon == pytest.approx(18.831058)
    assert vessel.point.lat == pytest.approx(60.913175)
    assert vessel.point.altitude_m is None
    assert vessel.course_over_ground_deg == pytest.approx(347.2)
    assert vessel.true_heading_deg == pytest.approx(347.0)
    assert vessel.source == "aisstream"
    assert client.stats.vessels == 1
    assert client.stats.dropped == 0


def test_speed_is_converted_from_knots_in_the_adapter() -> None:
    sink: list[Vessel] = []
    _client_for_mapping(sink).handle_message(position_report(Sog=10.9))
    assert sink[0].speed_over_ground_mps == pytest.approx(10.9 * KNOTS_TO_METRES_PER_SECOND)


@pytest.mark.parametrize(
    ("overrides", "attribute"),
    [
        ({"Cog": 360.0}, "course_over_ground_deg"),
        ({"Sog": 102.3}, "speed_over_ground_mps"),
        ({"Sog": 102.4}, "speed_over_ground_mps"),
        ({"Sog": -3.0}, "speed_over_ground_mps"),
        ({"TrueHeading": 511.0}, "true_heading_deg"),
    ],
)
def test_ais_sentinels_become_none_rather_than_a_reading(
    overrides: dict[str, Any], attribute: str
) -> None:
    """The sentinels are the AIS standard, so this feed carries the same ones.

    A negative speed is in the list because it used to be clamped to zero here, and zero
    claims the receiver reported a stopped vessel. It reported nothing.
    """
    sink: list[Vessel] = []
    client = _client_for_mapping(sink)
    client.handle_message(position_report(**overrides))
    assert getattr(sink[0], attribute) is None
    assert client.stats.dropped == 0


def test_a_real_course_due_north_survives_the_sentinel_check() -> None:
    """Course 0.0 is due north, not missing. Checking the range first loses real vessels."""
    sink: list[Vessel] = []
    _client_for_mapping(sink).handle_message(position_report(Cog=0.0))
    assert sink[0].course_over_ground_deg == 0.0


def test_the_ais_second_of_minute_is_never_read_as_a_time() -> None:
    """``Timestamp`` 0 to 63 is the UTC second, not an epoch. Parsed as one it is 1970."""
    sink: list[Vessel] = []
    _client_for_mapping(sink).handle_message(position_report(Timestamp=63))
    assert (datetime.now(UTC) - sink[0].observed_at).total_seconds() < 5.0


def test_a_search_and_rescue_aircraft_is_dropped_and_counted() -> None:
    """MMSI 111265583 is LIFEGUARD 003, a helicopter, and was doing 36 knots on the wire."""
    sink: list[Vessel] = []
    client = _client_for_mapping(sink)
    client.handle_message(position_report(UserID=111265583))
    assert sink == []
    assert client.stats.dropped == 1


def test_a_placeholder_mmsi_is_dropped_and_counted() -> None:
    """999999999 is not an allocation, so several ships would merge into one record."""
    sink: list[Vessel] = []
    client = _client_for_mapping(sink)
    client.handle_message(position_report(UserID=999999999))
    assert sink == []
    assert client.stats.dropped == 1


@pytest.mark.parametrize("overrides", [{"Latitude": None}, {"Longitude": None}, {"UserID": None}])
def test_a_report_without_an_identity_or_a_position_is_dropped(
    overrides: dict[str, Any],
) -> None:
    """Never defaulted to (0, 0): that draws a phantom fleet off West Africa."""
    sink: list[Vessel] = []
    client = _client_for_mapping(sink)
    client.handle_message(position_report(**overrides))
    assert sink == []
    assert client.stats.dropped == 1


def test_another_message_type_is_ignored_not_dropped() -> None:
    """Static data is a valid message this phase does not render. Different from broken."""
    sink: list[Vessel] = []
    client = _client_for_mapping(sink)
    client.handle_message(json.dumps({"MessageType": "ShipStaticData", "Message": {}}))
    assert client.stats.ignored == 1
    assert client.stats.dropped == 0


def test_a_declared_position_report_with_no_report_in_it_is_dropped() -> None:
    sink: list[Vessel] = []
    client = _client_for_mapping(sink)
    client.handle_message(json.dumps({"MessageType": POSITION_REPORT, "Message": {}}))
    assert client.stats.dropped == 1
    assert client.stats.ignored == 0


def test_one_unreadable_message_is_counted_and_survived() -> None:
    sink: list[Vessel] = []
    client = _client_for_mapping(sink)
    client.handle_message(b"not json at all")
    client.handle_message(position_report())
    assert client.stats.unrecognised == 1
    assert client.stats.vessels == 1


def test_a_stream_we_cannot_read_fails_loudly_rather_than_silently_empty() -> None:
    """The guard under the unverified payload shape.

    If the documented field names are wrong, every message fails and the layer would sit
    connected, healthy and empty forever. That is the worst available failure, so a run of
    unreadable messages becomes a named contract violation instead.
    """
    sink: list[Vessel] = []
    client = _client_for_mapping(sink)
    junk = json.dumps({"NotOurEnvelope": True})
    for _ in range(MAX_UNRECOGNISED_MESSAGES - 1):
        client.handle_message(junk)
    with pytest.raises(ContractViolationError, match="documented payload shape"):
        client.handle_message(junk)
    assert client.stats.unrecognised == MAX_UNRECOGNISED_MESSAGES


def test_a_good_message_resets_the_unreadable_run() -> None:
    sink: list[Vessel] = []
    client = _client_for_mapping(sink)
    junk = json.dumps({"NotOurEnvelope": True})
    for _ in range(MAX_UNRECOGNISED_MESSAGES - 1):
        client.handle_message(junk)
    client.handle_message(position_report())
    for _ in range(MAX_UNRECOGNISED_MESSAGES - 1):
        client.handle_message(junk)
    assert client.stats.vessels == 1


def test_unknown_fields_on_the_wire_are_ignored_not_rejected() -> None:
    """Permissive at the wire layer: the provider is beta and will add fields."""
    sink: list[Vessel] = []
    client = _client_for_mapping(sink)
    client.handle_message(
        json.dumps(
            {
                "MessageType": POSITION_REPORT,
                "Metadata": {"anything": "at all"},
                "Message": {
                    POSITION_REPORT: {
                        "UserID": 230713000,
                        "Latitude": 60.9,
                        "Longitude": 18.8,
                        "SomethingNew": 7,
                    }
                },
            }
        )
    )
    assert client.stats.vessels == 1


# ---------------------------------------------------------------- lifecycle


async def test_the_subscribe_is_the_first_frame_and_lands_inside_the_deadline(
    open_stream: FakeStream,
) -> None:
    """The provider closes a connection that has not subscribed within three seconds."""
    sink: list[Vessel] = []
    client = make_client(open_stream.url, sink)
    started = time.monotonic()
    await _run_briefly(client, lambda: bool(sink))

    sent_at, frame = open_stream.subscribes.get_nowait()
    assert sent_at - started < SUBSCRIBE_DEADLINE_SECONDS
    assert json.loads(frame)["APIKey"] == API_KEY
    assert open_stream.subscribes.empty()


async def test_vessels_from_the_socket_reach_the_callback(open_stream: FakeStream) -> None:
    sink: list[Vessel] = []
    client = make_client(open_stream.url, sink)
    await _run_briefly(client, lambda: bool(sink))
    assert sink[0].mmsi == "230713000"
    assert client.stats.subscribes == 1


async def test_killing_the_connection_reconnects_and_resubscribes(
    dropping_stream: FakeStream,
) -> None:
    """Phase 2 acceptance criterion 3.

    The server sends one message and closes. The client must come back and send a fresh
    subscribe, not merely reconnect: a reconnection that forgets to resubscribe leaves a
    connected socket that will never carry a vessel.
    """
    sink: list[Vessel] = []
    client = make_client(dropping_stream.url, sink)
    client.start()
    try:
        async with asyncio.timeout(RECONNECT_DEADLINE_SECONDS):
            first_at, first = await dropping_stream.subscribes.get()
            second_at, second = await dropping_stream.subscribes.get()
    finally:
        await client.stop()

    assert second_at - first_at < RECONNECT_DEADLINE_SECONDS
    assert json.loads(second) == json.loads(first)
    assert client.stats.connections >= 2
    assert client.stats.subscribes >= 2


async def test_a_run_of_silent_connections_stops_rather_than_hammering(
    silent_stream: FakeStream,
) -> None:
    """A rejected key is silent on this feed, so silence has to end the client.

    The provider sends no close frame, no code and no error text: a bad key looks exactly
    like a dropped network. Reconnecting into that forever would hammer a service the
    provider itself calls beta.
    """
    sink: list[Vessel] = []
    client = make_client(silent_stream.url, sink)
    with pytest.raises(AisStreamAuthError, match="without a single message"):
        async with asyncio.timeout(RECONNECT_DEADLINE_SECONDS):
            await client.run()

    assert silent_stream.connections == MAX_SILENT_CONNECTIONS
    assert client.last_error is not None
    assert API_KEY not in client.last_error
    assert not client.connected


async def test_a_healthy_connection_clears_the_silence_count(
    dropping_stream: FakeStream,
) -> None:
    """One message is enough to prove the key works, so drops after it are just drops."""
    sink: list[Vessel] = []
    client = make_client(dropping_stream.url, sink)
    await _run_briefly(client, lambda: dropping_stream.connections > MAX_SILENT_CONNECTIONS)
    assert client.stats.vessels >= MAX_SILENT_CONNECTIONS


async def test_an_unreachable_provider_is_survived_not_treated_as_a_bad_key() -> None:
    """A handshake that never lands is a different fault and must not end the client."""
    sink: list[Vessel] = []
    client = make_client("ws://127.0.0.1:1", sink)
    client.start()
    try:
        async with asyncio.timeout(RECONNECT_DEADLINE_SECONDS):
            await _wait_until(lambda: client.last_error is not None)
            await asyncio.sleep(MIN_RECONNECT_DELAY_SECONDS * 1.5)
        assert client._task is not None
        assert not client._task.done()
    finally:
        await client.stop()


async def test_starting_twice_is_refused(open_stream: FakeStream) -> None:
    sink: list[Vessel] = []
    client = make_client(open_stream.url, sink)
    client.start()
    try:
        with pytest.raises(RuntimeError, match="already running"):
            client.start()
    finally:
        await client.stop()


async def test_stopping_a_client_that_never_started_is_harmless() -> None:
    sink: list[Vessel] = []
    client = make_client("ws://127.0.0.1:1", sink)
    await client.stop()
    assert not client.connected


def test_a_bearing_outside_the_domain_range_is_dropped_not_forced() -> None:
    """400 degrees is below the 511 sentinel and still not a bearing.

    Mapped to None rather than wrapped, because nothing on the wire says which real
    heading a nonsense one was meant to be, and the alternative is losing the vessel to a
    contract error over one optional field.
    """
    sink: list[Vessel] = []
    client = _client_for_mapping(sink)
    client.handle_message(position_report(TrueHeading=400.0, Cog=-5.0))
    assert sink[0].true_heading_deg is None
    assert sink[0].course_over_ground_deg is None
    assert client.stats.dropped == 0


async def test_the_stop_signal_ends_the_loop_without_a_cancellation(
    dropping_stream: FakeStream,
) -> None:
    """The loop must exit on the flag alone.

    ``stop`` also cancels, which would hide a loop that ignores its own stop flag and only
    ever dies from the outside. Signalled here without the cancel so the graceful path is
    the thing under test.
    """
    sink: list[Vessel] = []
    client = make_client(dropping_stream.url, sink)
    task = asyncio.create_task(client.run())
    try:
        async with asyncio.timeout(RECONNECT_DEADLINE_SECONDS):
            await dropping_stream.subscribes.get()
            client._stopping.set()
            await task
    finally:
        await client.stop()
    assert not client.connected
    assert task.done()
