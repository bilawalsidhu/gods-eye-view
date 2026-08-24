"""Application wiring: the poller closures, the lifespan and the entry point.

The poller closures in ``tracker.app`` are the only place the source clients, the stores and
the viewport meet, so they are driven here with intercepted HTTP rather than left to be
discovered in production. The viewport branch matters: a client that has panned somewhere
must change which circle gets queried. The vessel union matters more: it is where three
providers become one record per ship, or fail to.
"""

import asyncio
import json
import zipfile
from collections import Counter
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from io import BytesIO
from pathlib import Path

import httpx
import pytest
import respx

from tests.conftest import fixture_bytes, fixture_json, make_aircraft, make_satellite, make_vessel
from tracker import __main__
from tracker.api.routes_entities import layer_summary
from tracker.api.state import AppState, aircraft_provider_gate
from tracker.app import (
    ADSB_MIL_MIN_INTERVAL_SECONDS,
    ATTRIBUTIONS,
    CITY_RETRY_SECONDS,
    NO_ELEMENTS_DETAIL,
    TTL_MISSED_POLLS,
    VESSEL_UNION_MIN_INTERVAL_SECONDS,
    _aircraft_client,
    _aircraft_union_members,
    _prime_satellites_from_cache,
    _refresh_cities_forever,
    build_state,
    create_app,
    refresh_cities,
)
from tracker.config import Settings, get_settings
from tracker.contracts.aircraft import AircraftClass
from tracker.contracts.geo import BoundingBox, Point
from tracker.contracts.transit import TransitVehicle
from tracker.services.poller import Poller
from tracker.sources import adsb, aishub, aisstream, celestrak, fintraffic, geonames, gtfsrt
from tracker.sources.adsb import parse_response
from tracker.sources.base import SourceError
from tracker.sources.gtfsrt import SweepResult

PRIMARY = "https://api.adsb.lol"
FAILOVER = "https://opendata.adsb.fi/api"

TWO_AIRCRAFT = json.dumps(
    {
        "now": 1787165611001,
        "msg": "No error",
        "ac": [
            {"hex": "aaaaaa", "lat": 51.5, "lon": -0.12, "flight": "BAW123  "},
            {"hex": "bbbbbb", "lat": 51.6, "lon": 0.1, "flight": "EZY456  "},
        ],
    }
).encode()


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient() as client:
        yield client


def _settings(**overrides: object) -> Settings:
    return Settings(adsb_base_url=PRIMARY, adsb_failover_base_url="", **overrides)  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]


# ---------------------------------------------------------------- build_state


def test_build_state_registers_every_store_and_poller(http: httpx.AsyncClient) -> None:
    state = build_state(_settings(), http)

    assert len(state.pollers) == 5
    assert [p.name for p in state.pollers] == [
        "aircraft/union",
        "adsb.lol/mil",
        "vessels/union",
        "celestrak/gp",
        "transit/gtfsrt",
    ]
    assert state.hub.layers == ("aircraft", "military", "vessels", "transit", "satellites")
    assert len(state.aircraft) == 0
    assert len(state.military) == 0
    assert len(state.vessels) == 0
    assert len(state.satellites) == 0
    assert len(state.transit) == 0
    assert state.viewport is None
    assert state.aircraft_union is None
    assert state.aircraft_providers == {}
    assert state.vessel_union is None
    assert state.vessel_providers == {}
    assert state.transit_refusals == Counter()
    assert state.transit_tally.polls == 0
    assert state.transit_client is not None
    assert state.registry is not None
    assert state.attribution == ATTRIBUTIONS


def test_the_hard_cadence_floors_are_applied_below_configuration(
    http: httpx.AsyncClient,
) -> None:
    """A careless environment variable must not be able to speed either feed up."""
    state = build_state(_settings(adsb_poll_seconds=0.5), http)
    point, military = tuple(state.pollers)[:2]

    assert point.min_interval_seconds == adsb.UNION_MIN_INTERVAL_SECONDS
    assert point.effective_interval == adsb.UNION_MIN_INTERVAL_SECONDS
    assert military.min_interval_seconds == ADSB_MIL_MIN_INTERVAL_SECONDS
    assert military.effective_interval == ADSB_MIL_MIN_INTERVAL_SECONDS
    assert military.effective_interval > point.effective_interval


def test_a_slower_configured_cadence_is_honoured(http: httpx.AsyncClient) -> None:
    state = build_state(_settings(adsb_poll_seconds=60.0), http)
    point, military = tuple(state.pollers)[:2]

    assert point.effective_interval == 60.0
    assert military.effective_interval == 240.0


def test_the_health_provider_is_wired_to_the_poller_group(http: httpx.AsyncClient) -> None:
    state = build_state(_settings(), http)

    assert len(state.pollers.health()) == 5


# ---------------------------------------------------------------- the viewport poller


@respx.mock(assert_all_called=True)
async def test_with_no_viewport_the_layer_still_sweeps_the_globe(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    # Replaces a test that asserted the configured default point was queried when no client had
    # sent a viewport. That default is no longer how the layer decides where to look: with no
    # camera there is nothing to favour, so it takes the next cell of the global rotation, and
    # the first cell of a fresh rotation is the first of `sweep_cells()`.
    state = build_state(_settings(), http)
    first = adsb.sweep_cells()[0]
    expected = f"{PRIMARY}/v2/lat/{first[0]:.4f}/lon/{first[1]:.4f}/dist/{adsb.SWEEP_RADIUS_NM}"
    route = respx_mock.get(expected).mock(return_value=httpx.Response(200, content=TWO_AIRCRAFT))
    poller = next(iter(state.pollers))

    assert await poller.run_once() is True

    assert route.call_count == 1
    assert poller.health.entity_count == 2
    assert state.aircraft.keys() == frozenset({"aaaaaa", "bbbbbb"})


@respx.mock(assert_all_called=True)
async def test_the_sweep_favours_the_grid_cell_holding_the_camera(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    # The camera is honoured by asking for the grid cell that contains it, not by asking for a
    # circle around it. That is the whole reason the layer became global without spending any
    # more requests: the local refresh and the global rotation are now the same request. A test
    # that accepted any circle at the camera's own latitude would pass on the old behaviour too.
    state = build_state(_settings(), http)
    state.viewport = BoundingBox(west=-1.0, south=51.0, east=1.0, north=52.0)
    centre = state.viewport.centre
    cell = adsb.GlobalSweep().cell_containing(centre.lat, centre.lon)
    assert cell != (centre.lat, centre.lon), "the grid centre must not be the camera itself"
    expected = f"{PRIMARY}/v2/lat/{cell[0]:.4f}/lon/{cell[1]:.4f}/dist/{adsb.SWEEP_RADIUS_NM}"
    route = respx_mock.get(expected).mock(return_value=httpx.Response(200, content=TWO_AIRCRAFT))
    poller = next(iter(state.pollers))

    await poller.run_once()

    assert route.call_count == 1
    assert state.aircraft.keys() == frozenset({"aaaaaa", "bbbbbb"})


@respx.mock(assert_all_called=True)
async def test_the_viewport_poller_upserts_rather_than_replacing(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """A viewport query knows nothing about aircraft outside it, so it must not evict them."""
    state = build_state(_settings(), http)
    respx_mock.get(url__startswith=f"{PRIMARY}/v2/lat/").mock(
        return_value=httpx.Response(200, content=TWO_AIRCRAFT)
    )
    state.aircraft.upsert("cccccc", make_aircraft("cccccc"))

    await next(iter(state.pollers)).run_once()

    assert state.aircraft.keys() == frozenset({"aaaaaa", "bbbbbb", "cccccc"})


def _one_aircraft(*, now_ms: int, lon: float) -> bytes:
    """One readsb envelope, with the batch timestamp and the position under our control."""
    return json.dumps(
        {
            "now": now_ms,
            "msg": "No error",
            "ac": [{"hex": "aaaaaa", "lat": 51.5, "lon": lon, "flight": "BAW123  ", "seen_pos": 0}],
        }
    ).encode()


@respx.mock(assert_all_called=True)
async def test_a_stale_response_never_walks_an_aircraft_backwards(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """ADR 010's recency rule binds the aircraft layer too, and it has the failover today.

    adsb.lol falling over to adsb.fi mid-flight hands the store a fix from a different
    network, and nothing in the response says whether it is the newer one. The guard is on
    the store rather than in the vessel path so both layers get it from one place.
    """
    state = build_state(_settings(), http)
    respx_mock.get(url__startswith=f"{PRIMARY}/v2/lat/").mock(
        side_effect=[
            httpx.Response(200, content=_one_aircraft(now_ms=1787165611001, lon=-0.12)),
            httpx.Response(200, content=_one_aircraft(now_ms=1787165011001, lon=-0.50)),
        ]
    )
    poll = next(iter(state.pollers)).poll

    await poll()
    await poll()

    held = state.aircraft.get("aaaaaa")
    assert held is not None
    assert held.point.lon == -0.12, "the ten-minute-older batch replaced the fresher fix"


@respx.mock(assert_all_called=True)
async def test_a_failing_viewport_poll_marks_the_feed_unhealthy(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    state = build_state(_settings(), http)
    respx_mock.get(url__startswith=f"{PRIMARY}/v2/lat/").mock(return_value=httpx.Response(503))
    poller = next(iter(state.pollers))

    assert await poller.run_once() is True

    assert poller.health.healthy is False
    assert poller.health.consecutive_failures == 1
    assert len(state.aircraft) == 0


# ---------------------------------------------------------------- the military poller


@respx.mock(assert_all_called=True)
async def test_the_military_poller_replaces_the_whole_store(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """``/v2/mil`` is a complete worldwide picture, so anything absent has left the feed."""
    state = build_state(_settings(), http)
    respx_mock.get(f"{PRIMARY}/v2/mil").mock(
        return_value=httpx.Response(200, content=fixture_bytes("adsb_mil_live.json"))
    )
    military_poller = list(state.pollers)[1]

    await military_poller.run_once()

    assert len(state.military) == 310
    assert military_poller.health.entity_count == 310
    assert all(a.is_military for a in state.military.snapshot())


@respx.mock(assert_all_called=True)
async def test_the_military_poller_drops_aircraft_that_left_the_feed(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    state = build_state(_settings(), http)
    respx_mock.get(f"{PRIMARY}/v2/mil").mock(return_value=httpx.Response(200, content=TWO_AIRCRAFT))
    state.military.upsert("999999", make_aircraft("999999", is_military=True))

    await list(state.pollers)[1].run_once()

    assert state.military.keys() == frozenset({"aaaaaa", "bbbbbb"})
    assert "999999" in state.military.take_changes().removed


# ---------------------------------------------------------------- lifespan


async def test_the_lifespan_builds_state_and_leaves_the_injected_client_open(
    http: httpx.AsyncClient,
) -> None:
    app = create_app(_settings(), start_background_tasks=False, http_client=http)

    async with app.router.lifespan_context(app):
        assert app.state.tracker.http is http

    assert http.is_closed is False, "an injected client belongs to the caller"


async def test_the_lifespan_closes_a_client_it_created_itself() -> None:
    app = create_app(_settings(), start_background_tasks=False)

    async with app.router.lifespan_context(app):
        created = app.state.tracker.http
        assert created.is_closed is False

    assert created.is_closed is True


async def test_the_lifespan_starts_and_stops_the_background_tasks(
    http: httpx.AsyncClient,
) -> None:
    """Every poller and the broadcast loop must be torn down, or a test run leaks tasks."""
    app = create_app(
        _settings(adsb_poll_seconds=3_600.0), start_background_tasks=True, http_client=http
    )

    async with respx.mock(assert_all_called=False) as router:
        router.get(url__startswith=PRIMARY).mock(
            return_value=httpx.Response(200, content=TWO_AIRCRAFT)
        )
        async with app.router.lifespan_context(app):
            state = app.state.tracker
            assert all(p._task is not None for p in state.pollers)

    assert all(p._task is None for p in state.pollers)
    assert state.hub.connection_count == 0


async def test_the_lifespan_starts_and_stops_the_vessel_subscription(
    monkeypatch: pytest.MonkeyPatch, http: httpx.AsyncClient
) -> None:
    """The socket is not a poller, so the lifespan owns it directly, both ends.

    ``run`` is replaced because there is no way to mock a WebSocket at the transport the way
    respx mocks HTTP, and a real handshake against the provider is not a unit test.
    """
    running = asyncio.Event()

    async def fake_run(_self: aisstream.AisStreamClient) -> None:
        running.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(aisstream.AisStreamClient, "run", fake_run)
    app = create_app(
        _settings(aisstream_api_key="test-key", adsb_poll_seconds=3_600.0),
        start_background_tasks=True,
        http_client=http,
    )

    async with respx.mock(assert_all_called=False) as router:
        router.get(url__startswith=PRIMARY).mock(
            return_value=httpx.Response(200, content=TWO_AIRCRAFT)
        )
        router.get(url__startswith=DIGITRAFFIC).mock(return_value=httpx.Response(503))
        for host in ELEMENT_HOSTS:
            router.get(url__startswith=host).mock(return_value=httpx.Response(503))
        async with app.router.lifespan_context(app):
            state = app.state.tracker
            assert state.aisstream is not None
            await asyncio.wait_for(running.wait(), timeout=2.0)
            assert state.aisstream._task is not None

    assert state.aisstream._task is None


async def test_the_user_agent_carries_contact_details_when_configured() -> None:
    """Nominatim, Overpass and the Wikimedia APIs require this in their usage policies."""
    keyless = Settings(contact_email="")
    keyed = Settings(contact_email="ops@example.com")

    assert "(" in keyed.user_agent
    assert "ops@example.com" in keyed.user_agent
    assert "ops@example.com" not in keyless.user_agent
    assert keyless.user_agent.startswith("tracker/0.1")


def test_a_trailing_slash_is_stripped_from_a_configured_base_url() -> None:
    settings = Settings(
        adsb_base_url="https://api.adsb.lol/", adsb_failover_base_url="https://x.example/api//"
    )

    assert settings.adsb_base_url == "https://api.adsb.lol"
    assert settings.adsb_failover_base_url == "https://x.example/api"


def test_settings_are_cached_process_wide() -> None:
    get_settings.cache_clear()

    assert get_settings() is get_settings()

    get_settings.cache_clear()


def test_the_two_cache_directories_share_one_root_by_default() -> None:
    """One directory for the project, not one per source, asserted rather than hoped.

    The disk cache and the GeoNames dump are separate settings on purpose: a 3.3MB zip is a
    file and a rate floor is a row, and they want different storage. What they must not lose is
    a single place to go for a reset or a removal, so the default for one is the parent of the
    default for the other.

    Read off the field defaults rather than an instance, because the suite's autouse fixture
    points ``TRACKER_CACHE_DIR`` at a temporary directory per test. Asserting an instance here
    would assert the fixture.
    """
    cache_default = Settings.model_fields["cache_dir"].default
    geonames_default = Settings.model_fields["geonames_cache_dir"].default

    assert geonames_default.parent == cache_default


def test_moving_the_cache_root_does_not_silently_take_geonames_with_it(tmp_path: Path) -> None:
    """The trap in holding the two as independent settings, stated so it cannot surprise.

    Overriding one and not the other splits the project cache across two places, and a reset
    that deletes one then leaves the other. Nothing enforces the relationship at runtime, so
    the honest thing is a test saying so out loud and a description that repeats it. If this
    ever starts failing, the settings were made to derive from each other and the warning on
    ``cache_dir`` should come out.
    """
    moved = Settings(cache_dir=tmp_path)

    assert moved.geonames_cache_dir.parent != moved.cache_dir


def test_every_attribution_is_complete() -> None:
    """A new source cannot ship without its credit; several licences require one."""
    # 17 hand-written rows plus 8 computed for transit: 2 verbatim licensor mandates and 6
    # licence groups covering 258 feeds. Grouped rather than one row per operator because 183
    # rows would defeat the menu, and because three of the six licences require different
    # things said. See `_transit_attributions`.
    assert len(ATTRIBUTIONS) == 25
    for entry in ATTRIBUTIONS:
        assert entry.source
        assert entry.text
        assert entry.licence
        # Every credit has to give a viewer a followable link to the terms that bind it, and
        # the row is not always where that link can live. The "operator terms" group is 39
        # operators across 38 different terms pages, so a single row-level URL would state
        # one operator's terms and misattribute the other 38: it carries them per operator
        # instead. So the invariant is that a link exists, not that it sits on the row.
        links = [entry.url, *(operator.url for operator in entry.operators)]
        # Four are plain http, which is the URL those four operators actually publish
        # (Halifax, Madison, Mississauga, Votran). Linking the terms that really bind beats
        # rewriting a provider's own address to a scheme it may not answer on, so the scheme
        # is not asserted. Flagged to whoever owns the registry rather than silently upgraded.
        assert any(link.startswith(("https://", "http://")) for link in links), entry.source
        assert all(link.startswith(("https://", "http://")) for link in links if link)


def test_the_transit_credits_are_eight_rows_carrying_every_one_of_the_183() -> None:
    """183 credits as 8 rows, and the collapse is only honest if nothing is lost.

    Grouped by licence because that is what the obligations are keyed to, not to save space.
    Every operator has to survive the grouping: 181 inside the six licence groups plus the two
    verbatim mandates that get their own rows.
    """
    transit = [a for a in ATTRIBUTIONS if a.source.startswith("Transit feeds under")]
    mandated = {f.attribution for f in gtfsrt.FEEDS if f.attribution}
    verbatim = [a for a in ATTRIBUTIONS if a.text in mandated]

    assert len(transit) == 6, "one row per licence family"
    assert len(verbatim) == 2, "King County and Hamilton are never merged into a group"

    # Credited pairs, not names, and that is not pedantry: **one operator publishes under two
    # different licences.** Oise Mobilité has feeds under both Etalab 2.0 and ODbL 1.0, which
    # require different things said, so a grouping by licence has to credit it in both groups.
    # Counting distinct names would report a loss that had not happened, and would hide the
    # day a real one did.
    credited = {(o.name, a.licence) for a in transit for o in a.operators}
    credited |= {(a.source, a.licence) for a in verbatim}
    assert len(credited) == len(gtfsrt.ATTRIBUTIONS), "every credit survives the grouping"
    assert len({name for name, _ in credited}) == len(credited) - 1, (
        "exactly one operator is dual-licensed; if this moves, check the registry"
    )


def test_a_verbatim_licensor_mandate_is_reproduced_exactly_and_never_grouped() -> None:
    """King County requires its sentence prominently displayed unless agreed otherwise in
    writing, and Hamilton reserves the right to require removal.

    So the words are the licensor's, not ours, and a grouping that reworded or absorbed them
    would breach the term it was trying to satisfy. Both come straight off the registry.
    """
    mandated = {f.provider: f.attribution for f in gtfsrt.FEEDS if f.attribution}
    assert mandated, "the registry must carry the two mandated wordings"
    by_source = {a.source: a for a in ATTRIBUTIONS}
    for provider, wording in mandated.items():
        assert by_source[provider].text == wording
        assert by_source[provider].operators == (), "a mandate is one licensor, never a group"


def test_the_odbl_group_names_the_licence_and_not_only_the_operators() -> None:
    """ODbL wants a notice reasonably calculated to convey both the source and the licence.

    A line reading "Prague, Rome, Warsaw" satisfies neither half of that, so the licence is in
    the sentence rather than only in a neighbouring field a client might not render.
    """
    odbl = next(a for a in ATTRIBUTIONS if a.licence == "ODbL 1.0" and a.operators)
    assert "Contains information from" in odbl.text
    assert "Open Database License" in odbl.text
    assert odbl.url.startswith("https://opendatacommons.org/")


def test_the_cc0_group_says_the_credit_is_not_owed() -> None:
    """The affirmer waived attribution, so these 18 are courtesy. They are kept anyway.

    Dropping them would be the only place in this project where provenance was traded for
    space, and a credit nobody is owed still tells a viewer where the data came from.
    """
    cc0 = next(a for a in ATTRIBUTIONS if a.licence == "CC0 1.0" and a.operators)
    assert "public domain" in cc0.text
    assert cc0.operators


def test_the_bespoke_terms_group_links_each_operators_own_terms() -> None:
    """39 operators, 38 different terms pages, so one row-level URL would misattribute 38.

    This is why the credit carries operators structurally rather than as a comma-joined
    sentence with a single link: the group URL is deliberately empty and each operator carries
    its own.
    """
    group = next(a for a in ATTRIBUTIONS if a.licence == "operator terms" and a.operators)
    assert group.url == "", "no single URL describes 38 unrelated terms pages"
    assert len({o.url for o in group.operators}) > 1, "the operators really do differ"
    assert all(o.url for o in group.operators), "every operator links its own terms"


def test_a_named_licence_family_links_its_canonical_text() -> None:
    """CC-BY 4.0 makes the licence URI mandatory, so an empty group URL would breach it.

    The registry stores variants of the same text (``/legalcode`` and ``/deed.ja`` beside the
    deed), and the canonical human-readable one is what a viewer should land on.
    """
    for licence, expected in (
        ("CC-BY 4.0", "https://creativecommons.org/licenses/by/4.0/"),
        ("CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/"),
        ("Etalab 2.0", "https://www.data.gouv.fr/pages/legal/licences/etalab-2.0"),
    ):
        row = next(a for a in ATTRIBUTIONS if a.licence == licence and a.operators)
        assert row.url == expected


async def test_the_shared_client_claims_no_content_type_it_cannot_honour() -> None:
    """It used to send ``Accept: application/json`` to every upstream in the project.

    That was a claim about all of them and it was false. Measured live 2026-08-24: **32 transit
    requests answered HTTP 406 Not Acceptable** and 12 to 16 feeds failed on every sweep,
    because GTFS-Realtime is protobuf and a server honouring the header will not send protobuf
    to a client asking for JSON. The same header was wrong for the Kystverket NMEA stream, the
    GeoNames zip, the imagery layers and every CSV registry.

    Nothing here relies on content negotiation for JSON: the adapters say ``format=json``,
    ``f=json`` or ``[out:json]`` in the request, or POST JSON and get JSON back. So the honest
    header is none, and httpx then sends ``*/*``.
    """
    app = create_app(_settings(), start_background_tasks=False)
    async with app.router.lifespan_context(app):
        state: AppState = app.state.tracker
        headers = state.http.headers

    assert "accept" not in headers or headers["accept"] == "*/*"
    assert headers["user-agent"].startswith("tracker/")


def test_the_console_entry_point_serves_a_single_worker(monkeypatch: pytest.MonkeyPatch) -> None:
    """A second uvicorn worker would run the lifespan again and double every feed request."""
    captured: dict[str, object] = {}

    def _fake_run(target: str, **kwargs: object) -> None:
        captured["target"] = target
        captured.update(kwargs)

    monkeypatch.setattr("tracker.__main__.uvicorn.run", _fake_run)

    __main__.main()

    assert captured["target"] == "tracker.app:create_app"
    assert captured["factory"] is True
    assert captured["workers"] == 1


# ---------------------------------------------------------------- the aircraft union
#
# ADR 010 and plan phase 3 acceptance 4 to 8. Two real recorded provider payloads, merged on
# the ICAO 24-bit address.
#
# The second provider's body is the real adsb.fi capture served from the airplanes.live base
# URL, and that is deliberate rather than a shortcut. airplanes.live answers HTTP 403 until
# an access email is answered, so there is no capture from it to record; the adsb.fi capture
# is a real second-provider readsb `/v2` payload with a genuinely different envelope (the
# aircraft list under `aircraft` rather than `ac`, and `now` in seconds rather than
# milliseconds), which is exactly the second-provider shape the merge has to survive. Under
# R3 adsb.fi itself is not a union member: what stands in for the missing provider here is
# its payload, not its licence.

AIRPLANESLIVE = "https://api.airplanes.live"
# No exact sweep path is pinned here on purpose. The aircraft layer asks for a grid cell of
# its own choosing rather than a circle around the camera, so a test naming the full URL would
# be asserting where the grid happens to put its centres. The two tests that care about which
# cell is chosen say so explicitly; everything else matches on the prefix.

ADSB_LOL_AIRCRAFT = 65
"""Records in the recorded adsb.lol viewport capture, all of which carry a position."""

SECOND_PROVIDER_AIRCRAFT = 57
"""Records in the recorded second-provider capture."""

UNION_AIRCRAFT = 118
"""Distinct ICAO addresses across both captures: 65 plus 57 less the 4 both saw."""

SHARED_HEXES = frozenset({"42584b", "42584c", "4cad97", "4d20f4"})
"""The four addresses both captures carry. Everything else is exclusive to one of them."""


def _two_provider_settings(**overrides: object) -> Settings:
    """Settings whose aircraft union has two members rather than one.

    ``airplaneslive_access_granted`` is the access gate rather than a key, because the
    provider allowlists a requester by email and there is no credential to hold.
    """
    return _settings(airplaneslive_access_granted=True, **overrides)


def _aircraft_poller(state: AppState) -> Poller:
    return next(p for p in state.pollers if p.name == "aircraft/union")


def _mock_two_providers(respx_mock: respx.Router) -> None:
    respx_mock.get(url__startswith=f"{PRIMARY}/v2/lat/").mock(
        return_value=httpx.Response(200, content=fixture_bytes("adsb_point_live.json"))
    )
    respx_mock.get(url__startswith=f"{AIRPLANESLIVE}/v2/lat/").mock(
        return_value=httpx.Response(200, content=fixture_bytes("adsbfi_point_live.json"))
    )


def test_the_per_provider_cadence_floors_are_constants_in_code() -> None:
    """Every floor is a module constant, and configuration can only ever slow a feed down.

    ADR 003's reasoning, ADR 010's per-provider version of it. A floor in an environment
    variable is one careless override away from a ban, and at least one provider in this
    project bans permanently and without appeal.

    The three numbers are not interchangeable and the differences are the point. ADS-B
    Exchange's floor is two orders of magnitude slower than adsb.lol's because its only
    published plan is a monthly quota rather than a rate, which is why it is demand-driven
    rather than swept, and why the cycle floor must not be taken from it.
    """
    assert adsb.ADSB_LOL.min_interval_seconds == adsb.ADSB_LOL_MIN_INTERVAL_SECONDS == 5.0
    assert (
        adsb.AIRPLANES_LIVE.min_interval_seconds == adsb.AIRPLANESLIVE_MIN_INTERVAL_SECONDS == 1.0
    )
    assert adsb.ADSBEXCHANGE.min_interval_seconds == adsb.ADSBEXCHANGE_MIN_INTERVAL_SECONDS == 260.0

    assert adsb.ADSBEXCHANGE.swept is False
    assert adsb.ADSBEXCHANGE not in adsb.SWEPT_PROVIDERS
    assert adsb.UNION_MIN_INTERVAL_SECONDS == 5.0

    # No setting can reach any of them, in either direction.
    fields = set(Settings.model_fields)
    assert not {f for f in fields if "min_interval" in f or "floor" in f}


def test_the_union_has_one_live_member_and_names_why_the_others_are_out(
    http: httpx.AsyncClient,
) -> None:
    """The single-member reality, asserted rather than glossed over.

    ADR 010's coverage argument rests on the unfiltered providers, and neither is reachable:
    ADS-B Exchange answered HTTP 401 without a paid key, airplanes.live answers HTTP 403
    until an access email is answered, adsb.one is Cloudflare-blocked. So the union is
    correctly implemented with an access blocker in front of it, and the honest reporting of
    that is the deliverable.
    """
    state = build_state(_settings(), http)
    members = _aircraft_union_members(state)

    assert [provider.name for provider, _ in members] == ["adsb.lol"]
    assert [p.name for p in adsb.UNION_PROVIDERS if p.unfiltered] == [
        "adsbexchange",
        "airplanes.live",
    ]
    for provider in adsb.UNION_PROVIDERS:
        if provider.unfiltered:
            assert provider.gate_reason is not None
    # adsb.fi is the failover inside the adsb.lol client, never a member. R3.
    assert "adsb.fi" not in {p.name for p in adsb.UNION_PROVIDERS}


def test_every_provider_row_names_settings_that_exist() -> None:
    """The row is plain data, so the names on it have to resolve or the wiring dies at runtime."""
    fields = set(Settings.model_fields) | {
        name for name in dir(Settings) if isinstance(getattr(Settings, name, None), property)
    }
    for provider in adsb.UNION_PROVIDERS:
        for setting in (
            provider.base_url_setting,
            provider.failover_setting,
            provider.access_setting,
        ):
            assert setting is None or setting in fields, f"{provider.name}: {setting}"


# The default host is registered and must stay uncalled, which is the assertion.
@respx.mock(assert_all_called=False)
async def test_adding_a_provider_is_a_row_rather_than_a_code_change(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """What three documents in this repo promise, asserted rather than assumed.

    ``sources/adsb.py``, ``docs/architecture.md`` and the plan's phase 3 all say adding a
    provider is a row plus a base URL. It was not: both consumers of a row compared it against
    a module constant with ``is``, so a new row fell through to the else branch and was handed
    adsb.lol's host and adsb.lol's name. The union then polled adsb.lol twice a cycle against
    the floor that exists to stop exactly that, ``/api/layers`` reported two providers where
    one origin had answered twice, and every aircraft looked seen-by-both so the
    provider-attributable count collapsed to zero for both.

    The row below borrows an existing settings attribute for its host, because the point is
    that the row decides which host, not which attribute happens to be spare.
    """
    row = adsb.AdsbProvider(
        name="adsb.one",
        min_interval_seconds=2.0,
        unfiltered=True,
        swept=True,
        base_url_setting="airplaneslive_base_url",
    )
    state = build_state(_settings(), http)
    route = respx_mock.get(url__startswith=f"{AIRPLANESLIVE}/v2/lat/").mock(
        return_value=httpx.Response(200, content=fixture_bytes("adsb_point_live.json"))
    )
    primary = respx_mock.get(url__startswith=f"{PRIMARY}/v2/lat/")

    found = await _aircraft_client(state, row).aircraft_near(lat=51.5, lon=-0.12, radius_nm=250)

    assert route.call_count == 1
    assert primary.call_count == 0, "the row's own host, not the default one"
    assert {aircraft.source for aircraft in found} == {"adsb.one"}


def test_a_row_that_carries_a_gate_reason_is_refused_unless_a_setting_clears_it() -> None:
    """Fail-safe rather than fail-open, which is the direction the identity version had wrong.

    A blocked provider with no credential that could clear it used to report itself available
    on ``/api/capabilities`` with a null reason, and join the poll.
    """
    blocked = adsb.AdsbProvider(
        name="adsb.one",
        min_interval_seconds=2.0,
        unfiltered=True,
        swept=True,
        gate_reason="Cloudflare answered HTTP 403 from our network on 2026-08-20.",
    )
    clearable = adsb.AdsbProvider(
        name="somewhere",
        min_interval_seconds=2.0,
        unfiltered=True,
        swept=True,
        access_setting="airplaneslive_access_granted",
        gate_reason="No access.",
    )
    open_row = adsb.AdsbProvider(
        name="open", min_interval_seconds=2.0, unfiltered=False, swept=True
    )

    assert aircraft_provider_gate(_settings(), blocked) == blocked.gate_reason
    assert aircraft_provider_gate(_two_provider_settings(), blocked) == blocked.gate_reason
    assert aircraft_provider_gate(_settings(), clearable) == clearable.gate_reason
    assert aircraft_provider_gate(_two_provider_settings(), clearable) is None
    assert aircraft_provider_gate(_settings(), open_row) is None


def test_a_provider_we_hold_no_host_for_cannot_be_polled(http: httpx.AsyncClient) -> None:
    """ADS-B Exchange has no base URL setting, so wiring it into the poll fails loudly.

    Louder than the alternative, which was a request to whatever host happened to be the
    default while the record claimed to come from the provider that was never called.
    """
    state = build_state(_settings(), http)

    with pytest.raises(ValueError, match="no base URL setting"):
        _aircraft_client(state, adsb.ADSBEXCHANGE)


@respx.mock(assert_all_called=True)
async def test_two_aircraft_providers_produce_one_record_per_icao_address(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 5. The same aircraft on two networks is one aircraft, not a phantom fleet."""
    state = build_state(_two_provider_settings(), http)
    _mock_two_providers(respx_mock)

    assert await _aircraft_poller(state).run_once() is True

    union = state.aircraft_union
    assert union is not None
    assert len(union.records) == UNION_AIRCRAFT
    assert len(union.records) < ADSB_LOL_AIRCRAFT + SECOND_PROVIDER_AIRCRAFT
    addresses = [record.key for record in union.records]
    assert len(addresses) == len(set(addresses))
    assert len(state.aircraft) == UNION_AIRCRAFT


@respx.mock(assert_all_called=True)
async def test_every_aircraft_record_names_its_provider_and_the_age_of_that_report(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 6, first half. Per record, never per layer, or the store is unauditable."""
    state = build_state(_two_provider_settings(), http)
    _mock_two_providers(respx_mock)

    await _aircraft_poller(state).run_once()

    stored = state.aircraft.snapshot()
    assert len(stored) == UNION_AIRCRAFT
    for aircraft in stored:
        assert aircraft.source in {"adsb.lol", "airplanes.live"}
        assert aircraft.providers[0] == aircraft.source
        assert aircraft.position_age_s >= 0.0
    assert {a.icao24 for a in stored if len(a.providers) == 2} == SHARED_HEXES


@respx.mock(assert_all_called=True)
async def test_two_providers_on_one_hex_resolve_to_the_newer_position_and_list_both(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 6, second half. Recency decides, both providers are listed, nothing averaged.

    The winning position is asserted equal to one real input's position rather than merely
    inside the two, because an average of two fixes is a point no receiver reported and it
    would still pass a range check.
    """
    state = build_state(_two_provider_settings(), http)
    _mock_two_providers(respx_mock)
    newer = {
        a.icao24: a
        for a in parse_response(fixture_bytes("adsbfi_point_live.json"), source="airplanes.live")
    }
    older = {
        a.icao24: a
        for a in parse_response(fixture_bytes("adsb_point_live.json"), source="adsb.lol")
    }

    await _aircraft_poller(state).run_once()

    for hexcode in SHARED_HEXES:
        stored = state.aircraft.get(hexcode)
        assert stored is not None
        # The second capture is 5,047 seconds later than the first, so it wins every shared
        # address on recency. Provider order in the list is freshest first.
        assert stored.source == "airplanes.live"
        assert stored.providers == ("airplanes.live", "adsb.lol")
        # Byte-identical to the record the winning provider's own response produced, bar
        # the provider list the merge adds. Nothing combined and nothing interpolated: the
        # position is one a receiver actually reported, and the older report's own fields
        # (its message count, its age, its observation time) are nowhere on it.
        assert stored.model_copy(update={"providers": ()}) == newer[hexcode]
        assert stored.observed_at == newer[hexcode].observed_at
        assert stored.observed_at > older[hexcode].observed_at
        assert stored.messages_received != older[hexcode].messages_received


@respx.mock(assert_all_called=True)
async def test_the_aircraft_attributable_count_is_measured_per_cycle(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 8's machinery: how many aircraft only one provider could see.

    Measured from what came back rather than asserted. On the real captures 61 aircraft were
    seen only by the first provider and 53 only by the second, and the four both saw count
    for neither. Live this number is zero for every unfiltered provider, because none of them
    is reachable, and reporting the zero is the point rather than omitting it.
    """
    state = build_state(_two_provider_settings(), http)
    _mock_two_providers(respx_mock)

    await _aircraft_poller(state).run_once()

    union = state.aircraft_union
    assert union is not None
    assert union.attributable_counts() == {"adsb.lol": 61, "airplanes.live": 53}
    assert sum(union.attributable_counts().values()) + len(SHARED_HEXES) == UNION_AIRCRAFT


@respx.mock(assert_all_called=True)
async def test_the_api_serves_the_aircraft_provider_coverage(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """The count reaches the wire, so the demo can put it on screen rather than in a log."""
    state = build_state(_two_provider_settings(), http)
    _mock_two_providers(respx_mock)

    await _aircraft_poller(state).run_once()
    summary = await layer_summary(state)

    rows = {row.provider: row for row in summary.providers if row.layer == "aircraft"}
    assert set(rows) == {"adsb.lol", "airplanes.live"}
    assert rows["adsb.lol"].exclusive == 61
    assert rows["adsb.lol"].records == ADSB_LOL_AIRCRAFT
    assert rows["airplanes.live"].exclusive == 53
    assert all(row.error is None for row in rows.values())
    assert all(row.polls == 1 for row in rows.values())


@respx.mock(assert_all_called=True)
async def test_killing_one_aircraft_provider_leaves_the_layer_up_and_degraded(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 7. The layer serves, reads degraded, and names the provider that is gone."""
    state = build_state(_two_provider_settings(), http)
    respx_mock.get(url__startswith=f"{PRIMARY}/v2/lat/").mock(
        return_value=httpx.Response(200, content=fixture_bytes("adsb_point_live.json"))
    )
    respx_mock.get(url__startswith=f"{AIRPLANESLIVE}/v2/lat/").mock(
        return_value=httpx.Response(503)
    )
    poller = _aircraft_poller(state)

    assert await poller.run_once() is True

    union = state.aircraft_union
    assert union is not None
    assert union.degraded is True
    assert union.missing == ("airplanes.live",)
    assert union.reporting == ("adsb.lol",)
    reason = union.degraded_reason
    assert reason is not None
    assert "airplanes.live" in reason
    # Up, not down: the layer keeps serving what the surviving provider saw.
    assert len(state.aircraft) == ADSB_LOL_AIRCRAFT
    assert poller.health.healthy is True


@respx.mock(assert_all_called=True)
async def test_every_aircraft_provider_failing_at_once_never_empties_the_store(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """A dead layer must read unhealthy rather than healthy and empty.

    Healthy-and-empty is the same lie AISHub's empty HTTP 200 tells, one level up: a viewer
    cannot tell an empty sky from a broken feed.
    """
    state = build_state(_two_provider_settings(), http)
    state.aircraft.upsert("aaaaaa", make_aircraft("aaaaaa"))
    respx_mock.get(url__startswith=f"{PRIMARY}/v2/lat/").mock(return_value=httpx.Response(503))
    respx_mock.get(url__startswith=f"{AIRPLANESLIVE}/v2/lat/").mock(
        return_value=httpx.Response(503)
    )
    poller = _aircraft_poller(state)

    # It ran; it failed. `run_once` reports whether the cadence let it run, so the feed's own
    # health is what says the cycle came back with nothing.
    assert await poller.run_once() is True

    assert poller.health.healthy is False
    assert poller.health.last_error is not None
    assert "adsb.lol" in poller.health.last_error
    assert "airplanes.live" in poller.health.last_error
    assert len(state.aircraft) == 1


@respx.mock(assert_all_called=True)
async def test_the_union_member_falls_over_to_its_own_failover(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 4. Killing the primary keeps the layer up through the within-provider failover.

    This is ADR 003's failover surviving underneath ADR 010's union: adsb.fi is not a member
    and never appears in the provider list, so the union still reports one provider reporting
    while the records themselves name adsb.fi as the source that answered. That distinction is
    the whole of R3: the licence exposure is confined to outage windows and is visible on the
    record rather than inferred.
    """
    state = build_state(Settings(adsb_base_url=PRIMARY, adsb_failover_base_url=FAILOVER), http)
    respx_mock.get(url__startswith=f"{PRIMARY}/v2/lat/").mock(return_value=httpx.Response(500))
    respx_mock.get(url__startswith=f"{FAILOVER}/v2/lat/").mock(
        return_value=httpx.Response(200, content=fixture_bytes("adsbfi_point_live.json"))
    )

    assert await _aircraft_poller(state).run_once() is True

    union = state.aircraft_union
    assert union is not None
    assert union.degraded is False
    assert union.reporting == ("adsb.lol",)
    assert len(state.aircraft) == SECOND_PROVIDER_AIRCRAFT
    stored = state.aircraft.snapshot()
    assert {a.source for a in stored} == {"adsb.fi"}

    # The half of "visible on the record" this test used to leave out, and the reason two of
    # 1,040 live aircraft reached the API on 2026-08-23 reading `source: adsb.fi` beside
    # `providers: ["adsb.lol"]`. The union credited the member it polled while the adapter
    # recorded the host that answered, and only `source` was ever asserted, so nothing failed.
    #
    # It is a licence statement, not a label: adsb.lol is ODbL 1.0 and adsb.fi is
    # non-commercial, so the wrong name here puts the wrong terms on the aircraft on screen.
    # R3 confines that exposure to outage windows *on the condition* that the record says so.
    assert {a.providers for a in stored} == {("adsb.fi",)}
    for aircraft in stored:
        assert aircraft.providers[0] == aircraft.source

    # And the member is still the one we polled, because coverage is a different question.
    assert union.reporting == ("adsb.lol",)
    assert union.attributable_counts() == {"adsb.lol": SECOND_PROVIDER_AIRCRAFT}


@respx.mock(assert_all_called=True)
async def test_the_aircraft_a_provider_refused_are_counted_where_they_can_be_read(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Dropped and counted has to mean counted somewhere a person can read it.

    Two of the three records below cannot map: one was heard without ever being located, and
    one carries an address that is not six hex digits. Both are dropped rather than defaulted,
    because a record placed at (0, 0) draws a phantom aircraft in the Gulf of Guinea.
    """
    state = build_state(_settings(), http)
    payload = json.dumps(
        {
            "now": 1787165611001,
            "ac": [
                {"hex": "aaaaaa", "lat": 51.5, "lon": -0.12},
                {"hex": "bbbbbb"},
                {"hex": "nothex", "lat": 51.5, "lon": -0.12},
            ],
        }
    ).encode()
    respx_mock.get(url__startswith=f"{PRIMARY}/v2/lat/").mock(
        return_value=httpx.Response(200, content=payload)
    )

    await _aircraft_poller(state).run_once()

    assert state.aircraft_providers["adsb.lol"].drops == 2
    summary = await layer_summary(state)
    row = next(r for r in summary.providers if r.layer == "aircraft")
    assert row.drops == 2
    assert row.records == 1


@respx.mock(assert_all_called=True)
async def test_one_cycle_of_drops_is_counted_once_and_not_again_next_cycle(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """The client counts cumulatively, so the wiring must add the difference, not the total."""
    state = build_state(_settings(), http)
    payload = json.dumps({"now": 1787165611001, "ac": [{"hex": "bbbbbb"}]}).encode()
    respx_mock.get(url__startswith=f"{PRIMARY}/v2/lat/").mock(
        return_value=httpx.Response(200, content=payload)
    )
    poll = _aircraft_poller(state).poll

    await poll()
    await poll()

    assert state.aircraft_providers["adsb.lol"].drops == 2


@respx.mock(assert_all_called=True)
async def test_a_union_record_still_carries_its_resolved_class(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Classification survives the merge and the store, which is where it could be lost.

    The adapter classifies on the way into the domain and the union copies the record to add
    its provider list. A copy that dropped the class would leave every aircraft ``unknown`` on
    screen with nothing failing anywhere.
    """
    state = build_state(_settings(), http)
    respx_mock.get(url__startswith=f"{PRIMARY}/v2/lat/").mock(
        return_value=httpx.Response(200, content=fixture_bytes("adsb_type_glf6_live.json"))
    )

    await _aircraft_poller(state).run_once()

    jet = state.aircraft.get("ab374c")
    assert jet is not None
    assert jet.aircraft_class is AircraftClass.BUSINESS_JET
    assert jet.on_ladd is True
    assert jet.providers == ("adsb.lol",)
    on_ladd = [a for a in state.aircraft.snapshot() if a.on_ladd]
    assert len(on_ladd) == 16
    assert all(a.aircraft_class is AircraftClass.BUSINESS_JET for a in on_ladd)


# ---------------------------------------------------------------- the vessel union
#
# Phase 2 acceptance 6 to 9 live here, because the union is wiring rather than adapter
# behaviour: four providers, one store, and the failure modes that would either draw a
# phantom fleet or empty the sea.
#
# Both keyless sides run on real captures through the real parsers: Fintraffic from
# 2026-08-19 and Kystdatahuset from 2026-08-23. The AISHub side is built inline and says so:
# no successful AISHub response has ever been captured, because access needs a physical AIS
# receiver, so nothing here pretends to be a recording.

DIGITRAFFIC = "https://meri.digitraffic.fi"
LOCATIONS_URL = f"{DIGITRAFFIC}/api/ais/v1/locations"
VESSELS_URL = f"{DIGITRAFFIC}/api/ais/v1/vessels"
KYSTDATAHUSET_URL = "https://kystdatahuset.no/ws/api/ais/realtime/geojson"
TRANSPORDIAMET_URL = (
    "https://gis.transpordiamet.ee/arcgis/rest/services/Hosted/"
    "AIS_vessels_feature_view/FeatureServer/0/query"
)
SEAWAY_URL = "https://vis.seaway.ca/graphql"
SEAWAY_CAPTURE_TIME = datetime(2026, 8, 23, 10, 46, tzinfo=UTC)
SEAWAY_WINDOW_SECONDS = 600.0
"""The Seaway freshness window, mirrored here so ``_fresh_seaway`` can respect it."""
AISHUB_URL = "https://data.aishub.net/ws.php"
ELEMENTS_URL = "https://retlector.eu"
"""The primary orbital element host.

ReTLEctor, not CelesTrak. CelesTrak is the last row of the chain in
``sources/celestrak.py`` and it refuses this network, so a test that mocked only
``celestrak.org`` would exercise a provider the poller never reaches on a healthy cycle.
"""
ELEMENT_HOSTS = (
    ELEMENTS_URL,
    "https://raw.githubusercontent.com",
    "https://celestrak.org/NORAD/elements/gp.php",
)
"""Every host the element chain may reach, for the tests that must mock all of them."""


def _fresh_elements(*, catalogue_number: int = 25544) -> bytes:
    """The recorded ReTLEctor ISS record with its epoch moved to an hour ago.

    The poller runs on the real clock, and ``sources/celestrak.py`` drops an element set
    older than ``MAX_ELEMENT_AGE_S``. A recorded capture is fresh on the day it was taken
    and stale a fortnight later, so serving one here would make these tests pass now and
    fail in September for a reason that has nothing to do with the poller. Only ``EPOCH``
    moves; the rest is the capture, mixed int and float numerics included.
    """
    record = dict(json.loads(fixture_bytes("retlector_iss_omm_live.json"))[0])
    record["NORAD_CAT_ID"] = catalogue_number
    record["EPOCH"] = (datetime.now(UTC) - timedelta(hours=1)).replace(tzinfo=None).isoformat()
    return json.dumps([record]).encode()


AISHUB_USERNAME = "tracker-test-user"

FINTRAFFIC_VESSELS = 109
"""Vessels that map out of the 110-feature capture. One is a placeholder MMSI and is dropped."""

KYSTDATAHUSET_VESSELS = 103
"""Vessels that map out of the 120-feature Kystdatahuset capture.

15 are dropped, mostly fishing-gear buoys and auxiliary craft on non-ship ITU prefixes, and
two are superseded duplicate reports of a ship the provider sent twice.
"""

TRANSPORDIAMET_VESSELS = 86
"""Vessels that map out of the 88-feature Estonian capture. Two are non-vessel stations."""

SEAWAY_VESSELS = 73
"""Vessels that map out of the 106-record Seaway capture once the freshness window is applied.

33 are refused, of which 24 are reports outside the ten-minute window: the provider serves a
sixty-day roster rather than a snapshot.
"""

SHARED_BY_FINLAND_AND_ESTONIA = ("273429690", "276752000", "276835000")
"""The only MMSIs two keyless providers both see in these captures.

Three ships in the Gulf of Finland on Russian and Estonian MIDs, reported by Fintraffic and
Transpordiamet alike, which is exactly what two authorities either side of the same strait
should produce. Named rather than left as a number because it is the one place the union does
real merging work on keyless data, so a change to it is a change worth noticing.
"""

KEYLESS_VESSELS = (
    FINTRAFFIC_VESSELS
    + KYSTDATAHUSET_VESSELS
    + TRANSPORDIAMET_VESSELS
    + SEAWAY_VESSELS
    - len(SHARED_BY_FINLAND_AND_ESTONIA)
)
"""The whole vessel layer with no credentials at all, across four national authorities.

They almost entirely add rather than overlap, and the measured overlap is three ships. Finnish
and Åland vessels sit on MIDs 230 to 232, the Norwegian body is almost all 257 to 259, the
Estonian slice runs 230 to 276 and the Seaway is 316 and 338 to 369. The only collisions are
the three in :data:`SHARED_BY_FINLAND_AND_ESTONIA`. That is the coverage argument ADR 010
exists to make, measured rather than asserted, and it is what a fifth authority has to beat to
be worth adding.
"""

SHARED_MMSI = "230992610"
"""The first feature of the capture, used wherever a test needs two providers on one ship."""

ABSENT_MMSI = "265513460"
"""A real MMSI from the static capture that has no position in it, so nothing overwrites it."""

FINTRAFFIC_FIX = datetime(2026, 8, 19, 22, 41, 27, 522000, tzinfo=UTC)
"""``timestampExternal`` for :data:`SHARED_MMSI` in the capture, to the millisecond."""

AISHUB_NEWER = "2026-08-19 23:00:00 GMT"
AISHUB_OLDER = "2026-08-19 20:00:00 GMT"


def _mock_fintraffic(respx_mock: respx.Router) -> None:
    """Serve both Digitraffic endpoints from the recorded 2026-08-19 bodies."""
    respx_mock.get(VESSELS_URL).mock(
        return_value=httpx.Response(200, content=fixture_bytes("digitraffic_ais_vessels_live.json"))
    )
    respx_mock.get(LOCATIONS_URL).mock(
        return_value=httpx.Response(
            200, content=fixture_bytes("digitraffic_ais_locations_live.json")
        )
    )


def _mock_kystdatahuset(respx_mock: respx.Router) -> None:
    """Serve the realtime endpoint from the recorded 2026-08-23 body."""
    respx_mock.get(KYSTDATAHUSET_URL).mock(
        return_value=httpx.Response(
            200, content=fixture_bytes("kystdatahuset_ais_realtime_live.json")
        )
    )


def _mock_transpordiamet(respx_mock: respx.Router) -> None:
    """Serve the Estonian FeatureServer from the recorded 2026-08-23 body."""
    respx_mock.get(TRANSPORDIAMET_URL).mock(
        return_value=httpx.Response(
            200, content=fixture_bytes("transpordiamet_ais_vessels_live.json")
        )
    )


def _fresh_seaway() -> bytes:
    """The recorded Seaway body with every report's ``age`` moved to just now.

    The same problem ``_fresh_elements`` solves for orbital elements, and for the same reason.
    ``sources/seaway.py`` refuses any report older than its ten-minute freshness window,
    because the provider serves a sixty-day roster and rendering it draws ghost ships. A
    recorded capture is inside that window on the day it was taken and outside it an hour
    later, so serving the file as recorded would make these tests pass today and fail
    tomorrow, for a reason that has nothing to do with the wiring.

    Only ``age`` moves, and only on the records that were fresh at capture. The stale tail is
    left stale on purpose, so the drop count these tests see is the real one.
    """
    body = fixture_json("seaway_ais_vessels_live.json")
    now = datetime.now(UTC)
    for record in body["data"]["aisOnlyVessels"]:
        ais = record["aisInformation"]
        captured = datetime.fromisoformat(ais["age"])
        if (SEAWAY_CAPTURE_TIME - captured).total_seconds() <= SEAWAY_WINDOW_SECONDS:
            ais["age"] = now.isoformat().replace("+00:00", "Z")
    return json.dumps(body).encode()


def _mock_seaway(respx_mock: respx.Router) -> None:
    """Serve the Seaway GraphQL endpoint, freshened so the window admits it."""
    respx_mock.post(SEAWAY_URL).mock(return_value=httpx.Response(200, content=_fresh_seaway()))


def _mock_keyless_vessels(respx_mock: respx.Router) -> None:
    """Serve both keyless vessel providers, which is the layer with no credentials at all.

    They are mocked together rather than separately because they are always both in the
    union: neither needs a key, so a test that mocked one would leave the other reaching an
    unmocked host, and ``_provider_result`` swallows that into a degraded provider row. The
    layer would still serve, the test would still pass, and it would be exercising a broken
    union without saying so.
    """
    _mock_fintraffic(respx_mock)
    _mock_kystdatahuset(respx_mock)
    _mock_transpordiamet(respx_mock)
    _mock_seaway(respx_mock)


def _aishub_body(*, mmsi: str = SHARED_MMSI, time: str = AISHUB_NEWER) -> bytes:
    """One-record AISHub success body, built inline from the provider's published fields."""
    envelope = {"ERROR": False, "USERNAME": AISHUB_USERNAME, "FORMAT": "HUMAN", "RECORDS": 1}
    record = {
        "MMSI": int(mmsi),
        "TIME": time,
        "LONGITUDE": 22.3,
        "LATITUDE": 60.5,
        "COG": 143.2,
        "SOG": 12.4,
        "HEADING": 141,
        "NAVSTAT": 0,
        "NAME": "AISHUB SHIP",
    }
    return json.dumps([envelope, [record]]).encode()


def _position_report(mmsi: str = SHARED_MMSI, *, lon: float = 22.4, lat: float = 60.6) -> str:
    """One aisstream.io position report, in the documented envelope."""
    return json.dumps(
        {
            "MessageType": "PositionReport",
            "Message": {
                "PositionReport": {
                    "UserID": int(mmsi),
                    "Latitude": lat,
                    "Longitude": lon,
                    "Cog": 100.0,
                    "Sog": 8.0,
                    "TrueHeading": 99,
                }
            },
        }
    )


def _vessel_poller(state: AppState) -> Poller:
    return next(p for p in state.pollers if p.name == "vessels/union")


def _satellite_poller(state: AppState) -> Poller:
    return next(p for p in state.pollers if p.name == "celestrak/gp")


@respx.mock(assert_all_called=True)
async def test_two_vessel_providers_produce_one_record_per_mmsi(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 6. Two networks, one ship, one record, and the evidence on the record."""
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    _mock_keyless_vessels(respx_mock)
    respx_mock.get(AISHUB_URL).mock(return_value=httpx.Response(200, content=_aishub_body()))
    poller = _vessel_poller(state)

    assert await poller.run_once() is True

    union = state.vessel_union
    assert union is not None
    assert len(union.records) == KEYLESS_VESSELS
    assert len(state.vessels) == KEYLESS_VESSELS
    assert len({v.mmsi for v in state.vessels.snapshot()}) == KEYLESS_VESSELS
    assert poller.health.entity_count == KEYLESS_VESSELS
    merged = next(record for record in union.records if record.key == SHARED_MMSI)
    assert merged.providers == ("aishub", "digitraffic")
    assert len(merged.sightings) == 2


@respx.mock(assert_all_called=True)
async def test_every_vessel_record_names_its_provider_and_the_age_of_that_report(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """ADR 010: per record, never per layer, or the merged store is unauditable."""
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    _mock_keyless_vessels(respx_mock)
    respx_mock.get(AISHUB_URL).mock(return_value=httpx.Response(200, content=_aishub_body()))

    await _vessel_poller(state).run_once()

    union = state.vessel_union
    assert union is not None
    assert {vessel.source for vessel in state.vessels.snapshot()} == {
        "digitraffic",
        "kystdatahuset",
        "transpordiamet",
        "seaway",
        "aishub",
    }
    assert all(vessel.position_age_s >= 0.0 for vessel in state.vessels.snapshot())
    for record in union.records:
        assert record.sightings
        assert all(sighting.age_s >= 0.0 for sighting in record.sightings)
        assert all(sighting.provider for sighting in record.sightings)


@respx.mock(assert_all_called=True)
async def test_a_vessel_conflict_resolves_to_the_newer_report(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 6, the recency half. AISHub's fix is later, so AISHub supplies the record."""
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    _mock_keyless_vessels(respx_mock)
    respx_mock.get(AISHUB_URL).mock(
        return_value=httpx.Response(200, content=_aishub_body(time=AISHUB_NEWER))
    )

    await _vessel_poller(state).run_once()

    winner = state.vessels.get(SHARED_MMSI)
    assert winner is not None
    assert winner.source == "aishub"
    # Nothing averaged: the position is the one that provider actually reported.
    assert (winner.point.lon, winner.point.lat) == (22.3, 60.5)


@respx.mock(assert_all_called=True)
async def test_provider_precedence_never_beats_recency(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """The same pair the other way round: an older AISHub fix must lose."""
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    _mock_keyless_vessels(respx_mock)
    respx_mock.get(AISHUB_URL).mock(
        return_value=httpx.Response(200, content=_aishub_body(time=AISHUB_OLDER))
    )

    await _vessel_poller(state).run_once()

    winner = state.vessels.get(SHARED_MMSI)
    assert winner is not None
    assert winner.source == "digitraffic"
    assert winner.observed_at - timedelta(seconds=winner.position_age_s) == FINTRAFFIC_FIX


@respx.mock(assert_all_called=True)
async def test_the_provider_attributable_count_is_measured_per_cycle(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """ADR 010 wants "ships only this network can see" measured, not asserted."""
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    _mock_keyless_vessels(respx_mock)
    respx_mock.get(AISHUB_URL).mock(return_value=httpx.Response(200, content=_aishub_body()))

    await _vessel_poller(state).run_once()

    union = state.vessel_union
    assert union is not None
    # The coverage argument ADR 010 exists to make, and it is now a real number rather than
    # a claim: every Norwegian vessel here is one only Kystdatahuset saw, and every Finnish
    # one but the shared ship is one only Fintraffic saw. AISHub is on the shared ship alone,
    # so it adds nothing this cycle and says so with a zero rather than dropping out.
    assert union.attributable_counts() == {
        # One fewer than the capture holds, because AISHub also sees SHARED_MMSI, and three
        # fewer again because Transpordiamet sees three of the same Gulf of Finland ships.
        "digitraffic": FINTRAFFIC_VESSELS - 1 - len(SHARED_BY_FINLAND_AND_ESTONIA),
        "kystdatahuset": KYSTDATAHUSET_VESSELS,
        "transpordiamet": TRANSPORDIAMET_VESSELS - len(SHARED_BY_FINLAND_AND_ESTONIA),
        "seaway": SEAWAY_VESSELS,
        "aishub": 0,
    }


def test_the_vessel_cycle_floor_is_the_strictest_provider_floor(http: httpx.AsyncClient) -> None:
    """Acceptance 7. A constant in code, and configuration can only slow the cycle down."""
    state = build_state(
        _settings(
            aishub_username=AISHUB_USERNAME, fintraffic_poll_seconds=1.0, aishub_poll_seconds=1.0
        ),
        http,
    )
    poller = _vessel_poller(state)

    assert VESSEL_UNION_MIN_INTERVAL_SECONDS == 60.0
    assert VESSEL_UNION_MIN_INTERVAL_SECONDS == aishub.MIN_INTERVAL_SECONDS
    assert VESSEL_UNION_MIN_INTERVAL_SECONDS == fintraffic.MIN_INTERVAL_SECONDS
    assert poller.min_interval_seconds == VESSEL_UNION_MIN_INTERVAL_SECONDS
    assert poller.effective_interval == VESSEL_UNION_MIN_INTERVAL_SECONDS


def test_a_slower_configured_vessel_cadence_is_honoured(http: httpx.AsyncClient) -> None:
    state = build_state(_settings(fintraffic_poll_seconds=300.0), http)

    assert _vessel_poller(state).effective_interval == 300.0


@respx.mock(assert_all_called=True)
async def test_aishub_is_called_at_most_once_a_minute(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 7, driven rather than inspected: the second cycle inside the floor is skipped."""
    state = build_state(
        _settings(aishub_username=AISHUB_USERNAME, fintraffic_poll_seconds=1.0), http
    )
    _mock_keyless_vessels(respx_mock)
    route = respx_mock.get(AISHUB_URL).mock(
        return_value=httpx.Response(200, content=_aishub_body())
    )
    poller = _vessel_poller(state)

    assert await poller.run_once() is True
    assert await poller.run_once() is False

    assert route.call_count == 1


@respx.mock(assert_all_called=True)
async def test_the_adapter_floor_still_holds_when_the_cycle_is_driven_by_hand(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Two guards, not one. The client refuses the second call and the layer keeps serving."""
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    _mock_keyless_vessels(respx_mock)
    route = respx_mock.get(AISHUB_URL).mock(
        return_value=httpx.Response(200, content=_aishub_body())
    )
    poll = _vessel_poller(state).poll

    await poll()
    await poll()

    assert route.call_count == 1
    union = state.vessel_union
    assert union is not None
    assert union.missing == ("aishub",)
    assert len(state.vessels) == KEYLESS_VESSELS


@respx.mock(assert_all_called=True)
async def test_an_empty_200_from_aishub_is_a_failed_poll_that_leaves_the_vessels_alone(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 8. An empty success is an error, never an empty sea."""
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    _mock_keyless_vessels(respx_mock)
    respx_mock.get(AISHUB_URL).mock(return_value=httpx.Response(200, content=b""))
    state.vessels.upsert(ABSENT_MMSI, make_vessel(mmsi=ABSENT_MMSI))

    await _vessel_poller(state).run_once()

    union = state.vessel_union
    assert union is not None
    assert union.missing == ("aishub",)
    assert union.degraded is True
    reason = union.degraded_reason
    assert reason is not None
    assert "aishub" in reason
    assert ABSENT_MMSI in state.vessels
    assert len(state.vessels) == KEYLESS_VESSELS + 1


@respx.mock(assert_all_called=True)
async def test_every_vessel_provider_failing_at_once_never_empties_the_store(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 8, the worst case. Nothing reported, so nothing is removed."""
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    respx_mock.get(url__startswith=DIGITRAFFIC).mock(return_value=httpx.Response(503))
    respx_mock.get(KYSTDATAHUSET_URL).mock(return_value=httpx.Response(503))
    respx_mock.get(AISHUB_URL).mock(return_value=httpx.Response(200, content=b""))
    state.vessels.upsert(ABSENT_MMSI, make_vessel(mmsi=ABSENT_MMSI))
    poller = _vessel_poller(state)

    await poller.run_once()

    union = state.vessel_union
    assert union is not None
    assert set(union.missing) == {
        "digitraffic",
        "kystdatahuset",
        "transpordiamet",
        "seaway",
        "aishub",
    }
    assert state.vessels.keys() == frozenset({ABSENT_MMSI})
    # Healthy-and-empty would be the same lie an empty AISHub 200 tells.
    assert poller.health.healthy is False
    assert poller.health.last_error is not None


@respx.mock(assert_all_called=True)
async def test_a_failing_provider_degrades_the_layer_without_failing_it(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """ADR 010: a provider that drops out costs coverage, not the layer."""
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    _mock_keyless_vessels(respx_mock)
    respx_mock.get(AISHUB_URL).mock(return_value=httpx.Response(500))
    poller = _vessel_poller(state)

    await poller.run_once()

    assert poller.health.healthy is True
    assert poller.health.entity_count == KEYLESS_VESSELS
    union = state.vessel_union
    assert union is not None
    assert set(union.reporting) == {
        "digitraffic",
        "kystdatahuset",
        "transpordiamet",
        "seaway",
    }
    assert union.missing == ("aishub",)


@respx.mock(assert_all_called=True)
async def test_with_no_aishub_username_the_layer_runs_on_the_other_providers(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 9. Unconfigured is not missing: AISHub is never called and never reported."""
    state = build_state(_settings(), http)
    _mock_keyless_vessels(respx_mock)

    await _vessel_poller(state).run_once()

    union = state.vessel_union
    assert union is not None
    assert set(union.reporting) == {
        "digitraffic",
        "kystdatahuset",
        "transpordiamet",
        "seaway",
    }
    assert union.degraded is False
    assert union.missing == ()
    assert len(state.vessels) == KEYLESS_VESSELS


@respx.mock(assert_all_called=True)
async def test_a_stale_provider_never_walks_a_ship_backwards_across_cycles(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """ADR 010 recency has to hold between cycles, not only inside one.

    The merge compares the reports of its own cycle. The store then took whatever it was
    handed, so on the next cycle AISHub dropping out on its own 60-second floor let
    Digitraffic's stale fix, re-served for the whole of its 600-second window, replace the
    newer position we already held: 18 minutes and about 9km backwards on the globe.
    """
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    _mock_keyless_vessels(respx_mock)
    respx_mock.get(AISHUB_URL).mock(
        return_value=httpx.Response(200, content=_aishub_body(time=AISHUB_NEWER))
    )
    poll = _vessel_poller(state).poll

    await poll()
    first = state.vessels.get(SHARED_MMSI)
    await poll()
    second = state.vessels.get(SHARED_MMSI)

    assert first is not None
    assert second is not None
    assert first.source == "aishub"
    assert second.source == "aishub", "the second cycle took an older Digitraffic fix"
    assert (second.point.lon, second.point.lat) == (22.3, 60.5)
    union = state.vessel_union
    assert union is not None
    assert union.missing == ("aishub",), "AISHub refused the second call on its own floor"
    assert len(state.vessels) == KEYLESS_VESSELS


@respx.mock(assert_all_called=True)
async def test_a_backwards_report_is_never_broadcast_to_a_client(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """The regressed record must not reach the hub either, or the ship jumps on screen."""
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    _mock_keyless_vessels(respx_mock)
    respx_mock.get(AISHUB_URL).mock(
        return_value=httpx.Response(200, content=_aishub_body(time=AISHUB_NEWER))
    )
    poll = _vessel_poller(state).poll

    await poll()
    state.vessels.take_changes()
    await poll()

    changed = {vessel.mmsi for vessel in state.vessels.take_changes().upserted}
    assert SHARED_MMSI not in changed


@respx.mock(assert_all_called=True)
async def test_every_stored_vessel_names_every_provider_that_saw_it(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """ADR 010: per record, never per layer, and it has to survive the store boundary.

    The merge computed the list and ``keyed()`` dropped it one line later, so from then on
    nothing the API or the card could reach said a second network had seen the ship.
    """
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    _mock_keyless_vessels(respx_mock)
    respx_mock.get(AISHUB_URL).mock(return_value=httpx.Response(200, content=_aishub_body()))

    await _vessel_poller(state).run_once()

    shared = state.vessels.get(SHARED_MMSI)
    assert shared is not None
    assert shared.providers == ("aishub", "digitraffic")
    for vessel in state.vessels.snapshot():
        assert vessel.providers, "a merged record always names at least the provider it came from"
        assert vessel.providers[0] == vessel.source, "freshest first, so the first is the winner"
    only_one = next(v for v in state.vessels.snapshot() if v.mmsi != SHARED_MMSI)
    assert only_one.providers == ("digitraffic",)


@respx.mock(assert_all_called=True)
async def test_three_providers_in_one_cycle_are_still_one_record_per_mmsi(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 6 with every provider configured, counting the inputs as well as the output.

    Two providers can each duplicate a ship; the phantom-fleet check is the input count
    against the merged count, the way tests/services/test_union.py does it for aircraft.
    """
    state = build_state(
        _settings(aishub_username=AISHUB_USERNAME, aisstream_api_key="test-key"), http
    )
    _mock_keyless_vessels(respx_mock)
    respx_mock.get(AISHUB_URL).mock(return_value=httpx.Response(200, content=_aishub_body()))
    client = state.aisstream
    assert client is not None
    client.connected = True
    client.handle_message(_position_report())

    await _vessel_poller(state).run_once()

    union = state.vessel_union
    assert union is not None
    assert set(union.reporting) == {
        "digitraffic",
        "kystdatahuset",
        "transpordiamet",
        "seaway",
        "aishub",
        "aisstream",
    }
    # Sightings, not ships. The union holds one record per MMSI; the providers between them
    # reported five more sightings than that, and every one is accounted for: SHARED_MMSI was
    # seen by three providers rather than one, and the three Gulf of Finland ships in
    # SHARED_BY_FINLAND_AND_ESTONIA were each seen by two. That gap is the whole point of the
    # merge, so it is asserted as arithmetic rather than as a magic number.
    duplicate_sightings = 2 + len(SHARED_BY_FINLAND_AND_ESTONIA)
    reported = sum(len(result.records) for result in union.provider_results)
    assert reported == KEYLESS_VESSELS + duplicate_sightings
    assert len(union.records) == KEYLESS_VESSELS, "one record per MMSI, whatever saw it"
    assert len(union.records) == KEYLESS_VESSELS
    assert len(state.vessels) == KEYLESS_VESSELS
    shared = state.vessels.get(SHARED_MMSI)
    assert shared is not None
    assert set(shared.providers) == {"digitraffic", "aishub", "aisstream"}


@respx.mock(assert_all_called=True)
async def test_an_empty_200_from_aishub_is_counted_cycle_after_cycle(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 8, the counting half. One failure and a week of them must look different.

    The union poller stays healthy while a single provider is down, by design, so its own
    counters never move. Without a per-provider tally the only record was the current
    cycle's union result, which the next cycle overwrites.
    """
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    _mock_keyless_vessels(respx_mock)
    respx_mock.get(AISHUB_URL).mock(return_value=httpx.Response(200, content=b""))
    poller = _vessel_poller(state)
    poll = poller.poll

    await poll()
    await poll()

    aishub_tally = state.vessel_providers["aishub"]
    assert aishub_tally.polls == 2
    assert aishub_tally.failures == 2
    assert aishub_tally.last_success_at is None
    assert poller.health.total_failures == 0, "one dead provider does not fail the layer"
    digitraffic_tally = state.vessel_providers["digitraffic"]
    assert digitraffic_tally.failures == 0
    assert digitraffic_tally.last_success_at is not None


@respx.mock(assert_all_called=True)
async def test_the_records_an_adapter_refused_are_counted_where_they_can_be_read(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Dropped and counted has to mean counted somewhere, not logged and thrown away.

    MMSI 111265583 is the real trap: the ITU allocates the 111 prefix to search-and-rescue
    aircraft, so the adapter refuses it rather than putting a helicopter on the ship layer.
    """
    state = build_state(_settings(aishub_username=AISHUB_USERNAME), http)
    _mock_keyless_vessels(respx_mock)
    respx_mock.get(AISHUB_URL).mock(
        return_value=httpx.Response(200, content=_aishub_body(mmsi="111265583"))
    )

    await _vessel_poller(state).run_once()

    assert state.vessel_providers["aishub"].drops == 1
    union = state.vessel_union
    assert union is not None
    assert union.empty == ("aishub",), "it answered, and nothing in it was a ship"
    assert state.vessel_providers["aishub"].empty_polls == 1


@respx.mock(assert_all_called=True)
async def test_the_api_serves_the_drop_count_the_adapter_measured(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Read through ``/api/layers``, because that is where the number was wrong.

    Measured on the live run of 2026-08-20: the log said "digitraffic: kept 658 vessels,
    dropped 3" and ``/api/layers`` said ``drops: 0`` for the same cycle, because
    ``parse_locations`` computed the count, logged it and dropped it on the floor. The
    110-feature capture carries one placeholder MMSI, so the served figure is 1.
    """
    app = create_app(_settings(), start_background_tasks=False, http_client=http)
    _mock_keyless_vessels(respx_mock)

    async with app.router.lifespan_context(app):
        state: AppState = app.state.tracker
        await _vessel_poller(state).run_once()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://tracker.test"
        ) as client:
            body = (await client.get("/api/layers")).json()

    providers = {row["provider"]: row for row in body["providers"]}
    assert providers["digitraffic"]["records"] == FINTRAFFIC_VESSELS
    assert providers["digitraffic"]["drops"] == 1


@respx.mock(assert_all_called=True)
async def test_the_streams_drops_are_counted_once_and_not_again_next_cycle(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """aisstream has no responses, so it counts cumulatively and the drain takes the delta.

    Adding the running total every cycle would inflate one refused message into one per
    cycle for as long as the process lived.
    """
    state = build_state(_settings(aisstream_api_key="test-key"), http)
    _mock_keyless_vessels(respx_mock)
    client = state.aisstream
    assert client is not None
    client.connected = True
    # A message that declares a position report and carries none. Counted as a drop by the
    # adapter, which is the count this assertion follows all the way to the tally.
    client.handle_message(json.dumps({"MessageType": "PositionReport", "Message": {}}))

    poll = _vessel_poller(state).poll
    await poll()
    await poll()

    assert client.stats.dropped == 1
    assert state.vessel_providers["aisstream"].drops == 1


def test_the_vessel_time_to_live_covers_the_cycle_the_poller_actually_runs(
    http: httpx.AsyncClient,
) -> None:
    """Two settings drive one cycle, so a time to live read off one of them can be too short.

    With AISHub slowed to five minutes the cycle is five minutes and the store used to keep
    a ship for three, so every ship expired between two polls and the layer blinked empty.
    """
    state = build_state(_settings(aishub_username=AISHUB_USERNAME, aishub_poll_seconds=300.0), http)

    poller = _vessel_poller(state)
    assert poller.effective_interval == 300.0
    assert state.vessels.ttl_seconds >= poller.effective_interval * TTL_MISSED_POLLS


async def test_a_satellite_cycle_with_nothing_cached_never_empties_the_store(
    http: httpx.AsyncClient,
) -> None:
    """An empty publish must not blank the layer on a poll that reads healthy.

    No group configured is the reachable version: the loop runs zero times, the cache is
    empty and ``replace_all(())`` would delete every satellite and tell every browser to
    remove it, with the feed reporting success and a count of zero.
    """
    state = build_state(_settings(celestrak_groups=()), http)
    state.satellites.upsert("25544", make_satellite())
    poller = _satellite_poller(state)

    await poller.run_once()

    assert state.satellites.keys() == frozenset({"25544"})
    assert poller.health.healthy is False
    assert poller.health.last_error is not None
    assert NO_ELEMENTS_DETAIL in poller.health.last_error
    assert state.satellites.take_changes().removed == ()


# ---------------------------------------------------------------- the aisstream subscription


def test_no_aisstream_key_means_no_subscription(http: httpx.AsyncClient) -> None:
    state = build_state(_settings(), http)

    assert state.aisstream is None


def test_an_aisstream_key_builds_the_subscription_from_the_configured_box(
    http: httpx.AsyncClient,
) -> None:
    """The box flips to latitude-first for the provider, which is the trap in that API."""
    state = build_state(
        _settings(
            aisstream_api_key="test-key",
            aisstream_bbox_west=1.0,
            aisstream_bbox_south=51.0,
            aisstream_bbox_east=8.0,
            aisstream_bbox_north=58.0,
        ),
        http,
    )
    client = state.aisstream
    assert client is not None

    frame = json.loads(client.subscribe_frame())

    assert frame["BoundingBoxes"] == [[[51.0, 1.0], [58.0, 8.0]]]
    assert frame["APIKey"] == "test-key"


def test_configuration_cannot_speed_up_aisstream_reconnection(http: httpx.AsyncClient) -> None:
    state = build_state(
        _settings(aisstream_api_key="test-key", aisstream_reconnect_seconds=0.01), http
    )
    client = state.aisstream
    assert client is not None

    assert client.effective_reconnect_delay == aisstream.MIN_RECONNECT_DELAY_SECONDS


@respx.mock(assert_all_called=True)
async def test_a_streamed_vessel_joins_the_union_and_wins_on_recency(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """The socket is not polled, so its reports are buffered and drained by each cycle."""
    state = build_state(_settings(aisstream_api_key="test-key"), http)
    _mock_keyless_vessels(respx_mock)
    client = state.aisstream
    assert client is not None
    client.connected = True
    client.handle_message(_position_report())

    await _vessel_poller(state).run_once()

    winner = state.vessels.get(SHARED_MMSI)
    assert winner is not None
    assert winner.source == "aisstream"
    assert len(state.vessels) == KEYLESS_VESSELS
    union = state.vessel_union
    assert union is not None
    assert set(union.reporting) == {
        "digitraffic",
        "kystdatahuset",
        "transpordiamet",
        "seaway",
        "aisstream",
    }


@respx.mock(assert_all_called=True)
async def test_the_stream_buffer_is_drained_rather_than_replayed(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """A report already merged must not be counted again next cycle as if it were fresh."""
    state = build_state(_settings(aisstream_api_key="test-key"), http)
    _mock_keyless_vessels(respx_mock)
    client = state.aisstream
    assert client is not None
    client.connected = True
    client.handle_message(_position_report())
    poll = _vessel_poller(state).poll

    await poll()
    await poll()

    union = state.vessel_union
    assert union is not None
    assert union.empty == ("aisstream",), "a connected socket with nothing new is not a failure"
    assert union.degraded is False


@respx.mock(assert_all_called=True)
async def test_a_disconnected_stream_is_a_missing_provider(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    state = build_state(_settings(aisstream_api_key="test-key"), http)
    _mock_keyless_vessels(respx_mock)
    client = state.aisstream
    assert client is not None
    client.connected = False
    client.last_error = "connection closed"

    await _vessel_poller(state).run_once()

    union = state.vessel_union
    assert union is not None
    assert union.missing == ("aisstream",)
    assert len(state.vessels) == KEYLESS_VESSELS


# ---------------------------------------------------------------- the satellite poller


@respx.mock(assert_all_called=True)
async def test_the_satellite_poller_fills_the_store_from_the_element_cache(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    # One group, pinned. This asserts the poller's own behaviour, so it must not move
    # every time the default group list does: the shipped default is fourteen groups.
    state = build_state(_settings(celestrak_groups=("stations",)), http)
    route = respx_mock.get(url__startswith=ELEMENTS_URL).mock(
        return_value=httpx.Response(200, content=_fresh_elements())
    )
    poller = _satellite_poller(state)

    assert await poller.run_once() is True

    assert route.call_count == 1
    assert state.satellites.keys() == frozenset({"25544"})
    assert poller.health.entity_count == 1
    assert state.celestrak.unavailable_reason is None


@respx.mock(assert_all_called=True)
async def test_a_restart_inside_the_poll_window_still_serves_the_cached_satellites(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """The satellite layer must not be empty just because the poller is inside its floor.

    Both guards are correct and neither used to seed the store: the poller persists its
    next-allowed-poll time, so a restart inside the six-hour window declines to poll, and
    the store was only ever filled by the poll itself. Measured on 2026-08-23, a restart
    four minutes after a successful fetch served 0 satellites from a cache holding 698.
    """
    settings = _settings(celestrak_groups=("stations",))
    respx_mock.get(url__startswith=ELEMENTS_URL).mock(
        return_value=httpx.Response(200, content=_fresh_elements())
    )

    warm = build_state(settings, http)
    assert await _satellite_poller(warm).poll() == 1

    # A second process against the same warm client cache, with no poll at all.
    restarted = build_state(settings, http)
    assert len(restarted.satellites) == 0

    _prime_satellites_from_cache(restarted)

    assert restarted.satellites.keys() == warm.satellites.keys()


def test_priming_an_empty_element_cache_leaves_the_store_alone(http: httpx.AsyncClient) -> None:
    """A cold start has nothing to prime, and must not call replace_all with nothing.

    ``replace_all`` on an empty iterable empties the store and tells every browser to drop
    every satellite. On a cold start there is nothing to drop, but the guard matters because
    this runs before the pollers on every single boot.
    """
    state = build_state(_settings(), http)

    _prime_satellites_from_cache(state)

    assert len(state.satellites) == 0
    assert state.satellites.take_changes().is_empty


def test_the_celestrak_two_hour_floor_sits_below_configuration(http: httpx.AsyncClient) -> None:
    """Acceptance 4. CelesTrak firewalls abusive clients, so this is not configurable."""
    state = build_state(_settings(celestrak_poll_seconds=1.0), http)
    poller = _satellite_poller(state)

    assert celestrak.MIN_GROUP_INTERVAL_S == 7200.0
    assert poller.min_interval_seconds == celestrak.MIN_GROUP_INTERVAL_S
    assert poller.effective_interval == celestrak.MIN_GROUP_INTERVAL_S


@respx.mock(assert_all_called=True)
async def test_a_second_satellite_cycle_inside_the_window_makes_no_request(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Acceptance 4, driven by hand past the poller's own floor."""
    # One group, pinned, for the same reason as the test above: the floor is per group,
    # so counting requests only means something when the group count is fixed here.
    state = build_state(_settings(celestrak_groups=("stations",)), http)
    route = respx_mock.get(url__startswith=ELEMENTS_URL).mock(
        return_value=httpx.Response(200, content=_fresh_elements())
    )
    poll = _satellite_poller(state).poll

    assert await poll() == 1
    assert await poll() == 1

    assert route.call_count == 1


@respx.mock(assert_all_called=True)
async def test_an_unreachable_celestrak_reports_the_layer_unavailable(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Today's reality: TCP 443 never answered during the phase 2 recon."""
    state = build_state(_settings(), http)
    for host in ELEMENT_HOSTS:
        respx_mock.get(url__startswith=host).mock(side_effect=httpx.ConnectTimeout("timed out"))
    poller = _satellite_poller(state)

    await poller.run_once()

    assert poller.health.healthy is False
    assert len(state.satellites) == 0
    reason = state.celestrak.unavailable_reason
    assert reason is not None
    assert "unreachable" in reason


# ---------------------------------------------------------------- store lifetimes


def test_the_vessel_and_satellite_stores_outlive_their_own_cadences(
    http: httpx.AsyncClient,
) -> None:
    """The aircraft time to live would retire every ship and satellite between two polls."""
    state = build_state(
        _settings(fintraffic_poll_seconds=300.0, celestrak_poll_seconds=21_600.0), http
    )

    assert state.vessels.ttl_seconds == 300.0 * TTL_MISSED_POLLS
    assert state.satellites.ttl_seconds == 21_600.0 * TTL_MISSED_POLLS
    assert state.aircraft.ttl_seconds < state.vessels.ttl_seconds


# ---------------------------------------------------------------- the city gazetteer
#
# Cities do not move, so this layer is a weekly download into an in-memory index rather than
# a poller feeding a time-to-live store. Both halves of that are asserted below: nothing is
# registered with the hub, no poller carries it, and the refresh is one conditional request a
# week enforced by the adapter rather than by whatever wakes it up.
#
# The fetch itself rests on R4 in docs/pending-decisions.md, which is unratified. The URL and
# the reasoning live together in sources/geonames.py, and its own tests hold the conditional
# request and the weekly floor. What is asserted here is the wiring on top.

CITY_ROWS_FIXTURE = "geonames_cities15000_london_dead_extract.tsv"
CITY_ROWS_LIVE = 5
CITY_ROWS_DEAD = 4
"""Four of the nine recorded rows are historical, abandoned or destroyed places. They are
dropped by the adapter and counted, and the count has to reach /api/layers."""

LONDON_GB_ID = 2643743


def _city_settings(cache_dir: Path) -> Settings:
    """Settings whose GeoNames cache is a temporary directory, never the working tree."""
    return _settings(geonames_cache_dir=cache_dir)


def _city_archive() -> bytes:
    """The recorded rows in the same single-member zip the provider serves."""
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr(geonames.MEMBER_NAME, fixture_bytes(CITY_ROWS_FIXTURE))
    return buffer.getvalue()


def test_the_city_layer_is_an_index_rather_than_a_store(
    http: httpx.AsyncClient, tmp_path: Path
) -> None:
    """No hub layer and no poller, because there is nothing to expire and nothing to push.

    A time-to-live store would drop London ninety seconds after start-up, and the only thing
    that could write London back would be a poller against a file that changes once a week.
    """
    state = build_state(_city_settings(tmp_path), http)

    assert "cities" not in state.hub.layers
    assert not any("cit" in poller.name for poller in state.pollers)
    assert len(state.city_index) == 0
    assert state.cities == ()
    assert state.city_tally.polls == 0, "nothing has been asked yet, and the row says so"


@respx.mock(assert_all_called=True)
async def test_the_city_refresh_indexes_the_dump_and_counts_what_it_refused(
    respx_mock: respx.Router, http: httpx.AsyncClient, tmp_path: Path
) -> None:
    """One refresh: the index answers, the layer counts, and the dead rows are counted too."""
    respx_mock.get(geonames.DUMP_URL).mock(
        return_value=httpx.Response(
            200, content=_city_archive(), headers={"ETag": '"327468-6595cb9b7a5b7"'}
        )
    )
    state = build_state(_city_settings(tmp_path), http)

    assert await refresh_cities(state) == CITY_ROWS_LIVE

    assert state.city_index.get(LONDON_GB_ID) is not None
    assert state.cities[0].geonames_id == LONDON_GB_ID, "biggest first"
    summary = await layer_summary(state)
    assert summary.layers["cities"] == CITY_ROWS_LIVE
    row = next(entry for entry in summary.providers if entry.layer == "cities")
    assert (row.provider, row.records, row.exclusive) == (geonames.SOURCE_NAME, 5, 5)
    assert (row.polls, row.failures, row.drops) == (1, 0, CITY_ROWS_DEAD)
    assert row.error is None
    assert row.last_success_at is not None


@respx.mock(assert_all_called=True)
async def test_a_second_refresh_inside_the_week_never_reaches_the_provider(
    respx_mock: respx.Router, http: httpx.AsyncClient, tmp_path: Path
) -> None:
    """The weekly floor holds against the wiring, not just against the adapter's own tests.

    Whatever wakes the refresh up, the request goes out at most once a week: the floor is
    measured off the mtime of the copy on disk inside the adapter, so calling this more often
    is cheap rather than rude.
    """
    route = respx_mock.get(geonames.DUMP_URL).mock(
        return_value=httpx.Response(200, content=_city_archive())
    )
    state = build_state(_city_settings(tmp_path), http)

    assert await refresh_cities(state) == CITY_ROWS_LIVE
    assert await refresh_cities(state) == CITY_ROWS_LIVE

    assert route.call_count == 1, "the second pass served the copy on disk"
    assert state.city_tally.polls == 2
    assert state.city_tally.drops == CITY_ROWS_DEAD * 2, "each pass counts its own drops"


@respx.mock(assert_all_called=True)
async def test_a_failed_refresh_with_nothing_on_disk_leaves_the_layer_empty_and_says_why(
    respx_mock: respx.Router, http: httpx.AsyncClient, tmp_path: Path
) -> None:
    """A supervised job, so a dead provider is recorded rather than raised into the loop."""
    respx_mock.get(geonames.DUMP_URL).mock(return_value=httpx.Response(503))
    state = build_state(_city_settings(tmp_path), http)

    assert await refresh_cities(state) == 0

    assert state.cities == ()
    assert state.city_tally.failures == 1
    row = next(entry for entry in (await layer_summary(state)).providers if entry.layer == "cities")
    assert row.error is not None
    assert "503" in row.error


@respx.mock(assert_all_called=True)
async def test_a_failed_refresh_keeps_the_cities_it_already_had(
    respx_mock: respx.Router, http: httpx.AsyncClient, tmp_path: Path
) -> None:
    """A week-old gazetteer beats an empty one, because cities do not move."""
    respx_mock.get(geonames.DUMP_URL).mock(
        return_value=httpx.Response(200, content=_city_archive())
    )
    state = build_state(_city_settings(tmp_path), http)
    await refresh_cities(state)

    # The copy on disk goes and the provider stops answering, which is the one combination
    # that makes the adapter raise rather than serve what it already has. The index has to
    # survive it, because a gazetteer from last week answers London correctly.
    (tmp_path / geonames.ARCHIVE_NAME).unlink()
    respx_mock.get(geonames.DUMP_URL).mock(return_value=httpx.Response(500))

    assert await refresh_cities(state) == CITY_ROWS_LIVE
    assert state.city_index.get(LONDON_GB_ID) is not None, "London survived a failed refresh"
    assert state.city_tally.failures == 1


async def _run_refresh_loop_once(
    monkeypatch: pytest.MonkeyPatch,
    state: AppState,
    indexed: int,
) -> tuple[int, list[float]]:
    """Drive one pass of the refresh loop, returning the pass count and what it slept for."""
    passes = 0
    slept: list[float] = []

    async def count_pass(_: AppState) -> int:
        nonlocal passes
        passes += 1
        return indexed

    async def record_sleep(seconds: float) -> None:
        slept.append(seconds)
        raise asyncio.CancelledError

    monkeypatch.setattr("tracker.app.refresh_cities", count_pass)
    monkeypatch.setattr(asyncio, "sleep", record_sleep)

    with pytest.raises(asyncio.CancelledError):
        await _refresh_cities_forever(state)
    return passes, slept


async def test_the_refresh_loop_runs_once_then_waits_a_week(
    monkeypatch: pytest.MonkeyPatch, http: httpx.AsyncClient, tmp_path: Path
) -> None:
    """The wake-up is the adapter's own floor, so the two can never disagree on "weekly"."""
    state = build_state(_city_settings(tmp_path), http)

    passes, slept = await _run_refresh_loop_once(monkeypatch, state, indexed=CITY_ROWS_LIVE)

    assert passes == 1, "the first pass runs immediately rather than a week from now"
    assert slept == [geonames.MIN_REFRESH_INTERVAL_S]


async def test_a_pass_that_indexed_nothing_retries_in_minutes_not_in_a_week(
    monkeypatch: pytest.MonkeyPatch, http: httpx.AsyncClient, tmp_path: Path
) -> None:
    """A network blip at boot with no copy on disk must not empty the gazetteer for a week.

    ``refresh_cities`` never raises, so a failure and a success used to be followed by the same
    seven-day sleep. Seven days of no city resolving, no label drawn, and every city query
    falling through to a geocoder whose own policy calls that unacceptable use.
    """
    state = build_state(_city_settings(tmp_path), http)

    passes, slept = await _run_refresh_loop_once(monkeypatch, state, indexed=0)

    assert passes == 1
    assert slept == [CITY_RETRY_SECONDS]
    assert CITY_RETRY_SECONDS < geonames.MIN_REFRESH_INTERVAL_S


def test_no_contact_email_means_no_geocoder(http: httpx.AsyncClient) -> None:
    """Nominatim requires contact details, so an unconfigured deployment holds no client."""
    assert build_state(_settings(), http).nominatim is None


def test_a_contact_email_builds_the_geocoder(http: httpx.AsyncClient) -> None:
    assert build_state(_settings(contact_email="tests@tracker.invalid"), http).nominatim is not None


# ---------------------------------------------------------------- the transit poller


def _transit_poller(state: AppState) -> Poller:
    return next(p for p in state.pollers if p.name == "transit/gtfsrt")


def _sweep(
    *,
    records: tuple[TransitVehicle, ...] = (),
    polled: int = 0,
    unchanged: int = 0,
    skipped: int = 0,
    failures: dict[str, str] | None = None,
    drops: Counter[str] | None = None,
) -> SweepResult:
    return SweepResult(
        records=records,
        drops=drops or Counter(),
        polled=polled,
        unchanged=unchanged,
        skipped=skipped,
        failures=failures or {},
    )


def _vehicle(feed_id: str = "mdb-1", entity_id: str = "e1") -> TransitVehicle:
    return TransitVehicle(
        feed_id=feed_id,
        entity_id=entity_id,
        point=Point(lon=-0.12, lat=51.5),
        observed_at=datetime(2026, 8, 23, 12, 0, tzinfo=UTC),
        timestamp_basis="vehicle",
        position_age_s=3.0,
        source="Test Operator",
        licence="CC0 1.0",
        country="GB",
    )


async def test_the_transit_poller_upserts_rather_than_replacing(
    http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A skipped or unchanged host means the records already held still stand.

    Replacing the store from one sweep would delete every vehicle on every host that was
    inside its floor or answered 304, which is most of the registry on most passes.
    """
    state = build_state(_settings(), http)
    held = _vehicle(feed_id="mdb-held", entity_id="stays")
    state.transit.upsert("mdb-held/stays", held)

    async def sweep() -> SweepResult:
        return _sweep(records=(_vehicle(),), polled=1, skipped=200)

    assert state.transit_client is not None
    monkeypatch.setattr(state.transit_client, "sweep", sweep)

    kept = await _transit_poller(state).poll()

    assert kept == 1
    assert len(state.transit) == 2
    assert state.transit.get("mdb-held/stays") is held


async def test_a_pass_with_every_host_inside_its_floor_leaves_the_store_alone(
    http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The flicker failure mode, and the reason the cadence is allowed to outrun the floors.

    A 30-second poller against hosts whose floors are 30, 120 and 350 seconds means most
    passes legitimately skip most of the registry, and a pass landing entirely inside every
    floor is normal rather than exceptional. It has to leave every held vehicle in place: a
    store emptied by the rate discipline working correctly would read on the globe as the whole
    layer blinking out and back roughly every other pass.

    It is still a failed poll, because nothing was read and nothing was confirmed unchanged, so
    the feed reports unhealthy rather than healthy-and-empty. Skipped is not a failure though,
    which is why the reason falls back to a plain sentence rather than naming a broken feed.
    """
    state = build_state(_settings(), http)
    held = _vehicle(feed_id="mdb-held", entity_id="stays")
    state.transit.upsert("mdb-held/stays", held)

    async def sweep() -> SweepResult:
        return _sweep(skipped=258)

    assert state.transit_client is not None
    monkeypatch.setattr(state.transit_client, "sweep", sweep)

    with pytest.raises(SourceError, match="no feed answered"):
        await _transit_poller(state).poll()

    assert len(state.transit) == 1
    assert state.transit.get("mdb-held/stays") is held


async def test_a_pass_of_nothing_but_304s_keeps_the_store_and_is_not_a_failure(
    http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A 304 is a host confirming its held records still stand, which is a success.

    Roughly 55% of this layer's traffic is 304s, so treating "not modified" as "returned
    nothing" would fail most passes and empty most of the store.
    """
    state = build_state(_settings(), http)
    held = _vehicle(feed_id="mdb-held", entity_id="stays")
    state.transit.upsert("mdb-held/stays", held)

    async def sweep() -> SweepResult:
        return _sweep(unchanged=258)

    assert state.transit_client is not None
    monkeypatch.setattr(state.transit_client, "sweep", sweep)

    assert await _transit_poller(state).poll() == 0
    assert state.transit.get("mdb-held/stays") is held


async def test_the_sweep_is_recorded_so_the_layers_route_can_report_it(
    http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """What a pass did does not survive in the store, which holds vehicles.

    ``/api/layers`` reports "258 of 258 polled, zero failures" off this, so it is measured
    rather than asserted.
    """
    state = build_state(_settings(), http)

    async def sweep() -> SweepResult:
        return _sweep(records=(_vehicle(),), polled=257, unchanged=1, drops=Counter({"a": 2}))

    assert state.transit_client is not None
    monkeypatch.setattr(state.transit_client, "sweep", sweep)

    await _transit_poller(state).poll()

    assert state.transit_sweep is not None
    assert state.transit_sweep.polled == 257
    assert state.transit_sweep.unchanged == 1
    assert state.transit_refusals["a"] == 2
    assert state.transit_tally.polls == 1, "one sweep is one poll, not one per feed"


async def test_a_transit_pass_where_nothing_answered_is_a_failed_poll(
    http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    state = build_state(_settings(), http)

    async def sweep() -> SweepResult:
        return _sweep(failures={"mdb-1": "ConnectTimeout"})

    assert state.transit_client is not None
    monkeypatch.setattr(state.transit_client, "sweep", sweep)

    with pytest.raises(SourceError, match="ConnectTimeout"):
        await _transit_poller(state).poll()


async def test_a_transit_pass_where_every_host_was_held_is_still_a_failed_poll(
    http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Nothing was read and nothing was confirmed unchanged, so nothing stands behind the store."""
    state = build_state(_settings(), http)

    async def sweep() -> SweepResult:
        return _sweep(skipped=258)

    assert state.transit_client is not None
    monkeypatch.setattr(state.transit_client, "sweep", sweep)

    with pytest.raises(SourceError, match="no feed answered"):
        await _transit_poller(state).poll()


async def test_a_transit_pass_of_only_not_modified_responses_succeeds(
    http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """33 of 39 feeds offering a validator answer 304. That is the feed confirming itself."""
    state = build_state(_settings(), http)

    async def sweep() -> SweepResult:
        return _sweep(unchanged=258)

    assert state.transit_client is not None
    monkeypatch.setattr(state.transit_client, "sweep", sweep)

    assert await _transit_poller(state).poll() == 0


async def test_transit_drops_reach_the_provider_tally(
    http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A count kept only in the log is a count nobody can read."""
    state = build_state(_settings(), http)

    async def sweep() -> SweepResult:
        return _sweep(
            records=(_vehicle(),),
            polled=1,
            drops=Counter({"positioned at 0,0": 251, "report older than 15 minutes": 1733}),
            failures={"mdb-9": "HTTPStatusError"},
        )

    assert state.transit_client is not None
    monkeypatch.setattr(state.transit_client, "sweep", sweep)

    await _transit_poller(state).poll()

    assert state.transit_refusals["positioned at 0,0"] == 251
    assert state.transit_refusals["report older than 15 minutes"] == 1733
