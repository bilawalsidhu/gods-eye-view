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

# Aliased: this module already has a `settings` fixture, and hypothesis's `settings` is a
# different thing entirely.
from hypothesis import HealthCheck
from hypothesis import settings as hypothesis_settings

from tracker.api.state import AppState
from tracker.app import create_app
from tracker.config import Settings
from tracker.contracts.aircraft import Aircraft, AircraftClass, EmergencyState
from tracker.contracts.geo import Point
from tracker.contracts.satellite import Satellite
from tracker.contracts.vessel import NavigationalStatus, Vessel, VesselEta

# ---------------------------------------------------------------- hypothesis

# **No per-example deadline.** Hypothesis defaults to 200ms per example, and a property test
# asserts a property rather than a latency, so a wall-clock bound inside a run competing with
# other work fails by luck and reports as a logic error.
#
# Measured 2026-08-23: `test_contains_agrees_with_a_manual_check_for_a_non_crossing_box` failed
# once in a loaded full run, then passed in isolation, passed on the next full run, and survived
# 20,000 examples of its own strategies with no counterexample. Nothing was wrong with
# `BoundingBox.contains`; the machine was busy. A geospatial correctness test that cries wolf is
# worse than one that is merely slow, because this project's rules make a bounding-box defect a
# thing you must stop and investigate.
#
# Same family as the local Playwright worker cap in `frontend/playwright.config.ts` and the
# vitest timing assertion deleted from the clustering tests. `max_examples` still bounds the
# work, so dropping the deadline cannot make the suite run away.
hypothesis_settings.register_profile(
    "tracker",
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)
hypothesis_settings.load_profile("tracker")

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


def make_vessel(
    mmsi: str = "230992610",
    *,
    lon: float = 22.216732,
    lat: float = 60.432413,
    name: str | None = "TEST VESSEL",
    call_sign: str | None = None,
    imo: int | None = None,
    ship_type: int | None = None,
    course_over_ground_deg: float | None = 143.0,
    speed_over_ground_mps: float | None = 5.0,
    true_heading_deg: float | None = 143.0,
    rate_of_turn_deg_per_min: float | None = None,
    navigational_status: NavigationalStatus | None = NavigationalStatus.MOORED,
    draught_m: float | None = None,
    length_m: float | None = None,
    beam_m: float | None = None,
    destination: str | None = None,
    eta: VesselEta | None = None,
    observed_at: datetime | None = None,
    position_age_s: float = 12.0,
    source: str = "digitraffic",
) -> Vessel:
    """Build a valid :class:`Vessel` with only the fields a test cares about spelled out.

    The MMSI default is a real ship-station number from the 2026-08-19 Digitraffic capture,
    so it passes the ITU category check without a test having to know the prefix rules.
    """
    return Vessel(
        mmsi=mmsi,
        name=name,
        call_sign=call_sign,
        imo=imo,
        ship_type=ship_type,
        point=Point(lon=lon, lat=lat),
        course_over_ground_deg=course_over_ground_deg,
        speed_over_ground_mps=speed_over_ground_mps,
        true_heading_deg=true_heading_deg,
        rate_of_turn_deg_per_min=rate_of_turn_deg_per_min,
        navigational_status=navigational_status,
        draught_m=draught_m,
        length_m=length_m,
        beam_m=beam_m,
        destination=destination,
        eta=eta,
        observed_at=observed_at if observed_at is not None else REFERENCE_TIME,
        position_age_s=position_age_s,
        source=source,
    )


def make_satellite(
    norad_cat_id: int = 25544,
    *,
    object_name: str | None = "ISS (ZARYA)",
    object_id: str | None = "1998-067A",
    classification_type: str = "U",
    epoch: datetime | None = None,
    mean_motion: float = 15.4951252,
    eccentricity: float = 0.00076648,
    inclination_deg: float = 51.6332,
    ra_of_asc_node_deg: float = 346.5707,
    arg_of_pericenter_deg: float = 63.0282,
    mean_anomaly_deg: float = 297.1489,
    bstar: float = 0.00020501314,
    mean_motion_dot: float = 0.00011071,
    mean_motion_ddot: float = 0.0,
    ephemeris_type: int = 0,
    element_set_no: int = 999,
    rev_at_epoch: int = 58157,
    group: str = "stations",
    fetched_at: datetime | None = None,
    source: str = "celestrak",
) -> Satellite:
    """Build a valid :class:`Satellite`, defaulted to the recorded real ISS element set."""
    return Satellite(
        norad_cat_id=norad_cat_id,
        object_name=object_name,
        object_id=object_id,
        classification_type=classification_type,
        epoch=epoch if epoch is not None else REFERENCE_TIME,
        mean_motion=mean_motion,
        eccentricity=eccentricity,
        inclination_deg=inclination_deg,
        ra_of_asc_node_deg=ra_of_asc_node_deg,
        arg_of_pericenter_deg=arg_of_pericenter_deg,
        mean_anomaly_deg=mean_anomaly_deg,
        bstar=bstar,
        mean_motion_dot=mean_motion_dot,
        mean_motion_ddot=mean_motion_ddot,
        ephemeris_type=ephemeris_type,
        element_set_no=element_set_no,
        rev_at_epoch=rev_at_epoch,
        group=group,
        fetched_at=fetched_at if fetched_at is not None else REFERENCE_TIME,
        source=source,
    )


# ---------------------------------------------------------------- application


@pytest.fixture(autouse=True)
def isolated_cache_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Give every ``Settings()`` in the suite its own disk cache directory.

    Autouse, because the disk cache does its job whether a test asked for it or not: a rate
    floor one run writes is a floor the next run honours, and the default points at the repo.
    Sharing one file across a session made that leak sideways, which showed up as a poller
    refusing its very first call because an unrelated test had already spent the slot. Per
    test, the persistence stays real and the tests stay independent.

    Returned so a test that wants to assert on the file, or reuse it across two constructions
    to stand in for a restart, can ask for the same directory.
    """
    directory = tmp_path / "cache"
    monkeypatch.setenv("TRACKER_CACHE_DIR", str(directory))
    return directory


@pytest.fixture
def keyless_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove every credential from the environment.

    Without this a developer with real keys exported would see the capability tests
    disagree with CI, which is exactly the kind of failure nobody trusts.
    """
    for name in (
        "TRACKER_AISSTREAM_API_KEY",
        "TRACKER_AISHUB_USERNAME",
        "TRACKER_DIGITRAFFIC_USER",
        "TRACKER_WINDY_API_KEY",
        "TRACKER_TFL_APP_KEY",
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
