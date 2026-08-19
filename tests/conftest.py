"""Shared fixtures and helpers for the backend test suite.

Three things live here and nothing else: readers for the recorded upstream payloads under
``tests/fixtures``, a hand-driven clock so store and poller behaviour can be asserted
without sleeping, and an in-process HTTP client over the real application.

The recorded payloads are real responses captured from the live feeds on 2026-08-19. They
are used by tests only. Nothing in the running product ever reads them.
"""

import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from tracker.api.state import AppState
from tracker.app import create_app
from tracker.config import Settings
from tracker.contracts.aircraft import Aircraft, AircraftClass, EmergencyState
from tracker.contracts.geo import Point

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"

REFERENCE_TIME = datetime(2026, 8, 19, 12, 0, 0, tzinfo=UTC)
"""A fixed instant used wherever a test needs a timestamp it can reason about."""


# ---------------------------------------------------------------- fixture payloads


def fixture_bytes(name: str) -> bytes:
    """Read a recorded upstream payload as raw bytes.

    Bytes rather than a parsed object because the adapters validate JSON directly and a
    test that pre-parses would exercise a path the product never takes.
    """
    path = FIXTURE_DIR / name
    if not path.is_file():
        raise FileNotFoundError(f"missing recorded payload: {path}")
    return path.read_bytes()


def fixture_json(name: str) -> Any:
    """Read a recorded upstream payload as Python objects, for building variants of it."""
    return json.loads(fixture_bytes(name))


@pytest.fixture
def adsb_point_payload() -> bytes:
    """Live ``/v2/point`` response, 65 aircraft, captured 2026-08-19."""
    return fixture_bytes("adsb_point_live.json")


@pytest.fixture
def adsb_mil_payload() -> bytes:
    """Live ``/v2/mil`` response, 391 records of which 81 carry no position."""
    return fixture_bytes("adsb_mil_live.json")


@pytest.fixture
def adsb_type_payload() -> bytes:
    """Live ``/v2/type/GLF6`` response, 18 aircraft."""
    return fixture_bytes("adsb_type_glf6_live.json")


# ---------------------------------------------------------------- clock


class FrozenClock:
    """A clock a test moves by hand.

    The store and the poller both take their time from an injected callable so expiry and
    cadence can be asserted exactly rather than approximated with ``asyncio.sleep``. A
    sleeping test is a slow test and, worse, a flaky one on a loaded CI box.
    """

    __slots__ = ("now",)

    def __init__(self, start: datetime | None = None) -> None:
        self.now = start if start is not None else REFERENCE_TIME

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> datetime:
        self.now = self.now + timedelta(seconds=seconds)
        return self.now


@pytest.fixture
def frozen_clock() -> FrozenClock:
    """A clock starting at :data:`REFERENCE_TIME`, injectable anywhere a clock is taken."""
    return FrozenClock()


# ---------------------------------------------------------------- entity factory


def make_aircraft(
    icao24: str = "abc123",
    *,
    lon: float = -0.12,
    lat: float = 51.5,
    altitude_m: float | None = 10_000.0,
    callsign: str | None = "TEST123",
    registration: str | None = None,
    squawk: str | None = None,
    emergency: EmergencyState = EmergencyState.NONE,
    aircraft_class: AircraftClass = AircraftClass.UNKNOWN,
    is_military: bool = False,
    observed_at: datetime | None = None,
    position_age_s: float = 1.0,
    source: str = "adsb.lol",
) -> Aircraft:
    """Build a valid :class:`Aircraft` with only the fields a test cares about spelled out."""
    return Aircraft(
        icao24=icao24,
        callsign=callsign,
        registration=registration,
        point=Point(lon=lon, lat=lat, altitude_m=altitude_m),
        squawk=squawk,
        emergency=emergency,
        aircraft_class=aircraft_class,
        is_military=is_military,
        observed_at=observed_at if observed_at is not None else REFERENCE_TIME,
        position_age_s=position_age_s,
        source=source,
    )


# ---------------------------------------------------------------- application


@pytest.fixture
def keyless_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove every credential from the environment.

    Without this a developer with real keys exported would see the capability tests
    disagree with CI, which is exactly the kind of failure nobody trusts.
    """
    for name in (
        "TRACKER_AISSTREAM_API_KEY",
        "TRACKER_WINDY_API_KEY",
        "TRACKER_TFL_APP_KEY",
        "TRACKER_CESIUM_ION_TOKEN",
        "TRACKER_CONTACT_EMAIL",
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def settings(keyless_env: None) -> Settings:
    """Keyless settings, the configuration the app is designed to run under by default."""
    return Settings()


@pytest.fixture
def tracker_app(settings: Settings) -> FastAPI:
    """The real application with routing and contracts, but no background tasks.

    ``start_background_tasks=False`` is the whole point: real routers over empty stores,
    no network, no pollers, no clock dependence.
    """
    return create_app(settings, start_background_tasks=False)


@pytest.fixture
async def app_client(tracker_app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    """An HTTP client speaking to the app in-process, with the lifespan open.

    The lifespan is entered explicitly because it is what builds ``app.state.tracker``;
    an ASGI transport alone would leave every route reaching for state that is not there.
    """
    async with (
        tracker_app.router.lifespan_context(tracker_app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=tracker_app),
            base_url="http://tracker.test",
        ) as client,
    ):
        yield client


@pytest.fixture
def app_state(tracker_app: FastAPI, app_client: httpx.AsyncClient) -> AppState:
    """The live :class:`AppState` behind ``app_client``, for placing entities directly.

    Depends on ``app_client`` so the lifespan has already run; the state does not exist
    before it.
    """
    state: AppState = tracker_app.state.tracker
    return state


# ---------------------------------------------------------------- computed-field helper


ADSBFI_POINT_AIRCRAFT = 57
"""Records in the captured adsb.fi response, all of which carry a position."""

ADSBFI_POINT_ON_GROUND = 32
"""How many of those reported ``alt_baro`` as the string ``"ground"``."""


@pytest.fixture
def adsbfi_point_payload() -> bytes:
    """Live adsb.fi response, 57 aircraft under the ``aircraft`` key, captured 2026-08-19."""
    return fixture_bytes("adsbfi_point_live.json")
