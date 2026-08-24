"""REST endpoints, in-process and with no network.

These read the stores and never touch an upstream, which is asserted implicitly: no respx
mock is installed anywhere in this file, so a route that tried to fetch would fail.

``/api/capabilities`` gets the most attention because it is what lets the frontend degrade
honestly. A layer with no credential must report itself unavailable with a reason, not
render as an empty layer that looks like a bug.
"""

import json
import logging
import time
from collections import Counter
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
import respx
from fastapi import FastAPI

from tests.conftest import REFERENCE_TIME, fixture_bytes, make_aircraft, make_satellite, make_vessel
from tracker.api.routes_meta import CITIES_PENDING_REASON
from tracker.api.state import AppState
from tracker.app import create_app, index_cities
from tracker.config import Settings
from tracker.contracts.city import City
from tracker.contracts.geo import Point
from tracker.contracts.transit import TransitVehicle
from tracker.services.search import PLACES_UNAVAILABLE_REASON
from tracker.services.union import ProviderResult, count_drops, merge_providers, record_cycle
from tracker.sources.adsb import parse_response
from tracker.sources.aishub import NO_USERNAME_REASON
from tracker.sources.celestrak import RETLECTOR, ElementBatch
from tracker.sources.geonames import parse_cities
from tracker.sources.gtfsrt import SweepResult
from tracker.sources.nominatim import ATTRIBUTION as NOMINATIM_ATTRIBUTION
from tracker.sources.nominatim import BASE_URL as NOMINATIM_BASE_URL
from tracker.sources.nominatim import SEARCH_PATH as NOMINATIM_SEARCH_PATH

_log = logging.getLogger(__name__)

LOCAL_SEARCH_BUDGET_S = 0.3
"""Phase 4 acceptance 1. Measured over the HTTP round trip, not just the service call."""


def make_transit(**overrides: Any) -> TransitVehicle:
    """One transit vehicle, built here rather than in ``conftest.py``.

    Local because the only thing these tests need it for is a licence and an ``observed_at``,
    and because ``conftest.py`` belongs to whoever is still working on the GTFS-Realtime
    adapter. A shared helper is worth adding once the shape has settled.
    """
    fields: dict[str, Any] = {
        "feed_id": "mdb-1646",
        "entity_id": "vehicle-1",
        "point": Point(lon=2.35, lat=48.86),
        "observed_at": REFERENCE_TIME,
        "timestamp_basis": "vehicle",
        "position_age_s": 12.0,
        "source": "Test Operator",
        "licence": "Etalab 2.0",
        "country": "FR",
    }
    fields.update(overrides)
    return TransitVehicle(**fields)


async def _capabilities(settings: Settings) -> dict[str, Any]:
    """Build a throwaway app on ``settings`` and read ``/api/capabilities`` from it."""
    app = create_app(settings, start_background_tasks=False)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://tracker.test"
        ) as client,
    ):
        body: dict[str, Any] = (await client.get("/api/capabilities")).json()
    return body


# ---------------------------------------------------------------- health


async def test_health_returns_ok(app_client: httpx.AsyncClient) -> None:
    response = await app_client.get("/api/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["connected_clients"] == 0
    assert isinstance(body["feeds"], list)


async def test_health_lists_the_registered_feeds(app_client: httpx.AsyncClient) -> None:
    """Every poller wired at startup should name itself, one per feed."""
    body = (await app_client.get("/api/health")).json()

    assert {feed["source"] for feed in body["feeds"]} == {
        "aircraft/union",
        "adsb.lol/mil",
        "vessels/union",
        "celestrak/gp",
        "transit/gtfsrt",
    }
    assert {feed["layer"] for feed in body["feeds"]} == {
        "aircraft",
        "military",
        "vessels",
        "satellites",
        "transit",
    }
    assert all(feed["healthy"] is False for feed in body["feeds"])


async def test_health_reports_ok_even_with_every_feed_down(
    app_client: httpx.AsyncClient,
) -> None:
    """This is a liveness probe, not a data-quality judgement."""
    body = (await app_client.get("/api/health")).json()

    assert body["status"] == "ok"
    assert all(not feed["healthy"] for feed in body["feeds"])


# ---------------------------------------------------------------- capabilities


async def test_capabilities_reports_aircraft_available_without_any_key(
    app_client: httpx.AsyncClient,
) -> None:
    body = (await app_client.get("/api/capabilities")).json()
    layers = {entry["layer"]: entry for entry in body["layers"]}

    assert layers["aircraft"]["available"] is True
    assert layers["aircraft"]["reason"] is None
    assert layers["military"]["available"] is True


@pytest.mark.parametrize(
    "layer", ["vessels/aisstream", "places", "ownership/officers", "ownership/wealth-tier"]
)
async def test_capabilities_reports_keyed_layers_unavailable_with_a_reason(
    app_client: httpx.AsyncClient, layer: str
) -> None:
    layers = {
        entry["layer"]: entry
        for entry in (await app_client.get("/api/capabilities")).json()["layers"]
    }

    reason = layers[layer]["reason"]

    assert layers[layer]["available"] is False
    assert isinstance(reason, str)
    assert reason.strip(), "an unavailable layer must say why"
    # Short enough to render on a card over the globe rather than wrap across it. The
    # three-line versions of these strings were most of what the layer rail was made of on a
    # 1400px viewport, which is what Alexander Fanthome meant on 2026-08-20 by the UI
    # obscuring the view.
    assert len(reason) <= 120, f"{layer} reason is {len(reason)} chars and renders on a card"


async def test_capabilities_never_asks_for_a_cesium_key(
    app_client: httpx.AsyncClient,
) -> None:
    """The globe is keyless, so nothing here may carry or request a Cesium ion token.

    Two things this guards. There is no ``cesium_ion_token`` field to put one in, and there
    is no buildings row: that row read "Set TRACKER_CESIUM_ION_TOKEN to stream 3D
    buildings" and the layer rail renders one row per advertised layer, so it reached the
    screen as the product asking for a key the project has ruled out. Asserted on the whole
    body rather than on the field, because a reason string on any future layer naming a
    Cesium key would be the same mistake in a different row.
    """
    body = (await app_client.get("/api/capabilities")).json()

    assert "cesium_ion_token" not in body
    assert [entry["layer"] for entry in body["layers"] if entry["layer"] == "buildings"] == []
    for entry in body["layers"]:
        assert "CESIUM" not in (entry["reason"] or "").upper(), entry["layer"]


async def test_capabilities_always_returns_the_required_attributions(
    app_client: httpx.AsyncClient,
) -> None:
    """Several of these licences make attribution a condition of use."""
    attribution = (await app_client.get("/api/capabilities")).json()["attribution"]
    by_source = {entry["source"]: entry for entry in attribution}

    assert "adsb.lol" in by_source
    assert "NASA GIBS" in by_source
    assert by_source["adsb.lol"]["licence"] == "ODbL 1.0"
    assert by_source["adsb.lol"]["url"] == "https://adsb.lol"
    assert "NASA EOSDIS GIBS" in by_source["NASA GIBS"]["text"]
    for entry in attribution:
        assert entry["text"].strip()
        assert entry["licence"].strip()
        # A link to the binding terms must exist; it is on the row for a single licence and on
        # each operator for the "operator terms" group, whose 39 operators have 38 different
        # terms pages. See the same invariant in tests/test_app.py.
        links = [entry["url"], *(operator["url"] for operator in entry["operators"])]
        # Scheme not asserted: four operators publish their terms on plain http, and linking
        # the terms that really bind beats rewriting a provider's own address.
        assert any(link.startswith(("https://", "http://")) for link in links), entry["source"]
        assert all(link.startswith(("https://", "http://")) for link in links if link)


async def test_the_etalab_credit_carries_the_date_the_licence_demands(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """Etalab 2.0 wants the date of the last update, not just the producer's name.

    "sa source (a minima le nom du Concedant) **et la date de la derniere mise a jour de
    l'Information reutilisee**". 101 of the 258 transit feeds are under Etalab, so a credit
    list with no date on it fails the largest block in the layer.

    Resolved from the freshest record actually held rather than from a build-time constant,
    because the licence asks about the information being reused, which is what is on screen.
    """
    observed = datetime(2026, 8, 24, 9, 30, tzinfo=UTC)
    app_state.transit.upsert(
        "mdb-1/bus-1",
        make_transit(licence="Etalab 2.0", observed_at=observed),
    )

    body = (await app_client.get("/api/capabilities")).json()
    etalab = next(
        entry
        for entry in body["attribution"]
        if entry["licence"] == "Etalab 2.0" and entry["operators"]
    )

    assert etalab["as_of"] is not None
    assert datetime.fromisoformat(etalab["as_of"]) == observed


async def test_a_credit_with_nothing_held_carries_no_date(
    app_client: httpx.AsyncClient,
) -> None:
    """No date is correct rather than a gap: nothing is being reused, so there is nothing to
    date, and an invented date would be the one thing worse than none."""
    body = (await app_client.get("/api/capabilities")).json()
    etalab = next(
        entry
        for entry in body["attribution"]
        if entry["licence"] == "Etalab 2.0" and entry["operators"]
    )

    assert etalab["as_of"] is None


async def test_the_date_follows_the_freshest_record_of_that_licence_only(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """One date per licence, taken from that licence's own records.

    Stamping every credit with one layer-wide maximum would date a French operator's data to a
    Dutch operator's last update, which is a different producer's information.
    """
    older = datetime(2026, 8, 24, 8, 0, tzinfo=UTC)
    newer = datetime(2026, 8, 24, 9, 0, tzinfo=UTC)
    app_state.transit.upsert("a/1", make_transit(licence="Etalab 2.0", observed_at=older))
    app_state.transit.upsert("b/1", make_transit(licence="ODbL 1.0", observed_at=newer))

    body = (await app_client.get("/api/capabilities")).json()
    dates = {
        entry["licence"]: entry["as_of"]
        for entry in body["attribution"]
        if entry["operators"] and entry["as_of"]
    }

    assert datetime.fromisoformat(dates["Etalab 2.0"]) == older
    assert datetime.fromisoformat(dates["ODbL 1.0"]) == newer


async def test_a_date_never_lands_on_a_credit_for_another_layer(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """Licence names are not unique across sources, and matching on licence alone got it wrong.

    adsb.lol, Nominatim and 46 of the transit feeds are all under ODbL 1.0. Resolving the
    per-request date by licence stamped the aircraft feed's credit and the geocoder's credit
    with a French bus's last observation, which dates one provider's data to another's.
    Measured live 2026-08-24: 10 rows carried a date and only 8 should have.

    A transit vehicle is the only thing held here, so any date on a non-transit row is wrong by
    construction.
    """
    app_state.transit.upsert("mdb-1/bus-1", make_transit(licence="ODbL 1.0"))

    body = (await app_client.get("/api/capabilities")).json()
    dated = [entry for entry in body["attribution"] if entry["as_of"]]

    assert dated, "the transit ODbL group must be dated"
    assert all(entry["source"].startswith("Transit feeds under") for entry in dated)
    non_transit_odbl = [
        entry
        for entry in body["attribution"]
        if entry["licence"] == "ODbL 1.0" and not entry["operators"]
    ]
    assert non_transit_odbl, "adsb.lol and nominatim are ODbL and must stay in the sample"
    assert all(entry["as_of"] is None for entry in non_transit_odbl)


async def test_transit_drops_reach_the_layers_route_by_reason(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """Per reason, not per feed, and that is the deliberate part.

    258 feeds would be 258 rows nobody reads. The useful question is what *kind* of record is
    being refused: 1,733 stale reports is a feed-freshness story and 251 vehicles at 0,0 is a
    null-island story, and those have different fixes. A single drops integer hides which is
    happening, which is why ADR 010's "an error, counted" needs the breakdown.
    """
    app_state.transit_sweep = SweepResult(
        records=(),
        drops=Counter(),
        polled=258,
        unchanged=0,
        skipped=0,
        failures={},
    )
    app_state.transit_refusals.update(
        {
            "report older than 15 minutes": 1733,
            "positioned at 0,0": 251,
            "reported without a position": 151,
            "entity id repeated inside one message": 17,
            "report timestamped in the future": 0,
        }
    )

    body = (await app_client.get("/api/layers")).json()
    sweep = next(row for row in body["sweeps"] if row["layer"] == "transit")
    refused = {entry["reason"]: entry["count"] for entry in sweep["refused"]}

    assert refused["report older than 15 minutes"] == 1733
    assert refused["positioned at 0,0"] == 251
    assert refused["reported without a position"] == 151
    assert refused["entity id repeated inside one message"] == 17
    # **Only non-zero reasons reach the wire.** Five zeros on the layer rail was the visible
    # half of this bug, and filtering at the presenter would have left the wrong shape
    # underneath for every other client. A reason that has never fired is not information.
    assert "report timestamped in the future" not in refused
    # And a reason is never rendered as a provider: that is what produced rows reading
    # "report older than 5 minutes only: 0" on the rail.
    assert not [row for row in body["providers"] if "/" in row["provider"]]


async def test_the_sweep_row_counts_feeds_and_the_provider_row_counts_passes(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """The split that fixes ``empty_polls`` reading 175 against 83 polls.

    Both were true of a 258-feed registry and neither was true of one provider: 83 feeds read
    and 175 held back inside a host floor. A poll is one sweep; a feed is a feed. Putting the
    second set of numbers in fields named for the first is what produced the contradiction.

    ``unchanged`` counts towards nothing being wrong: a 304 is a host confirming its held
    records still stand, and roughly 55% of this layer's traffic is 304s.
    """
    app_state.transit.upsert("mdb-1/bus-1", make_transit())
    app_state.transit_sweep = SweepResult(
        records=(),
        drops=Counter(),
        polled=83,
        unchanged=57,
        skipped=175,
        failures={"mdb-999": "ReadTimeout"},
    )
    app_state.transit_tally.polls = 4
    app_state.transit_tally.failures = 1
    app_state.transit_tally.empty_polls = 1
    app_state.transit_tally.drops = 2152

    body = (await app_client.get("/api/layers")).json()
    sweep = next(row for row in body["sweeps"] if row["layer"] == "transit")
    provider = next(
        row
        for row in body["providers"]
        if row["layer"] == "transit" and row["provider"] == "gtfs-rt"
    )

    # Feeds, named as feeds.
    assert sweep["feeds"] == 258
    assert sweep["read"] == 83
    assert sweep["unchanged"] == 57
    assert sweep["skipped"] == 175
    assert sweep["failed"] == 1
    assert sweep["records"] == 1
    assert sweep["error"] == "ReadTimeout"

    # Passes, named as polls. Four sweeps, not 258 feeds and not 83.
    assert provider["polls"] == 4
    assert provider["failures"] == 1
    assert provider["empty_polls"] == 1
    assert provider["drops"] == 2152
    assert provider["records"] == 1
    assert provider["exclusive"] == 1, "one adapter supplied every vehicle"


async def test_no_transit_rows_before_a_sweep_has_run(
    app_client: httpx.AsyncClient,
) -> None:
    """A row of zeroes reads as a pass that found nothing, which is not never having swept.

    The same rule the merged layers and the city dump already follow.
    """
    body = (await app_client.get("/api/layers")).json()

    assert not [row for row in body["providers"] if row["layer"] == "transit"]
    assert not body["sweeps"]
    assert body["layers"]["transit"] == 0


async def test_capabilities_reports_keyed_layers_available_when_keys_are_set(
    keyless_env: None,
) -> None:
    settings = Settings(aisstream_api_key="ais-key", contact_email="ops@example.com")

    body = await _capabilities(settings)

    layers = {entry["layer"]: entry for entry in body["layers"]}
    for name in ("vessels/aisstream", "places", "ownership/officers"):
        assert layers[name]["available"] is True, name
        assert layers[name]["reason"] is None, name


async def test_there_is_no_cameras_row_because_there_is_no_camera_adapter(
    keyless_env: None,
) -> None:
    """It used to ask for two keys to unlock a layer that does not exist.

    Neither would have enabled anything, and both providers are verified keyless anyway: TfL
    JamCams need no key and New York 511 is keyless too. Same lesson as the buildings row.
    """
    body = await _capabilities(Settings(windy_api_key="windy-key", tfl_app_key="tfl-key"))

    assert "cameras" not in {entry["layer"] for entry in body["layers"]}


async def test_no_capability_reason_asks_for_a_key_that_would_not_enable_anything(
    keyless_env: None,
) -> None:
    """A reason may name a variable only when setting it actually turns the layer on.

    ``ownership`` and ``places`` both name one, and both are free and genuinely required by
    the provider. Nothing else may, and a layer with no adapter behind it may not have a row
    at all.
    """
    body = await _capabilities(Settings())

    for entry in body["layers"]:
        reason = entry["reason"]
        if reason is None or "TRACKER_" not in reason:
            continue
        assert entry["layer"] in {
            "ownership/officers",
            "places",
            "vessels/aisstream",
            "vessels/aishub",
        }, f"{entry['layer']} asks for a credential; check it actually enables the layer"


async def test_only_the_officers_are_gated_on_the_contact_address(keyless_env: None) -> None:
    """The register needs no contact address and the filings do. Two conditions, two rows.

    One used to govern both, which switched the FAA register off for want of an address it
    never needed, and every aircraft came back with no owner at all.
    """
    body = await _capabilities(Settings(contact_email=""))

    layers = {entry["layer"]: entry for entry in body["layers"]}
    assert layers["ownership/officers"]["available"] is False
    assert "TRACKER_CONTACT_EMAIL" in layers["ownership/officers"]["reason"]
    # The layer's own row reports the register, which is a runtime fact rather than a
    # credential check, so it says the register has not loaded rather than asking for a key.
    assert "TRACKER_" not in (layers["ownership"]["reason"] or "")


async def test_the_wealth_tier_row_says_why_it_is_empty_and_asks_for_nothing(
    keyless_env: None,
) -> None:
    """Eleven empty fields on a profile read as a bug unless the product says why."""
    body = await _capabilities(Settings(contact_email="ops@example.com"))

    layers = {entry["layer"]: entry for entry in body["layers"]}
    row = layers["ownership/wealth-tier"]
    assert row["available"] is False
    assert "TRACKER_" not in row["reason"]
    assert "not established" in row["reason"]


# ---------------------------------------------------------------- /api/aircraft


async def test_aircraft_returns_what_is_in_the_store(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    app_state.aircraft.upsert("3c6444", make_aircraft("3c6444", callsign="BAW123"))

    body = (await app_client.get("/api/aircraft")).json()

    assert body["count"] == 1
    assert body["aircraft"][0]["icao24"] == "3c6444"
    assert body["aircraft"][0]["callsign"] == "BAW123"


async def test_aircraft_is_empty_when_nothing_has_been_polled(
    app_client: httpx.AsyncClient,
) -> None:
    body = (await app_client.get("/api/aircraft")).json()

    assert body == {"count": 0, "aircraft": []}


async def test_aircraft_filters_by_bounding_box(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    app_state.aircraft.upsert("aaaaaa", make_aircraft("aaaaaa", lon=-0.12, lat=51.5))
    app_state.aircraft.upsert("bbbbbb", make_aircraft("bbbbbb", lon=2.35, lat=48.86))

    body = (
        await app_client.get(
            "/api/aircraft", params={"west": -1.0, "south": 51.0, "east": 1.0, "north": 52.0}
        )
    ).json()

    assert body["count"] == 1
    assert body["aircraft"][0]["icao24"] == "aaaaaa"


async def test_aircraft_filters_across_the_antimeridian(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    app_state.aircraft.upsert("aaaaaa", make_aircraft("aaaaaa", lon=179.0, lat=0.0))
    app_state.aircraft.upsert("bbbbbb", make_aircraft("bbbbbb", lon=-179.0, lat=0.0))
    app_state.aircraft.upsert("cccccc", make_aircraft("cccccc", lon=0.0, lat=0.0))

    body = (
        await app_client.get(
            "/api/aircraft",
            params={"west": 170.0, "south": -10.0, "east": -170.0, "north": 10.0},
        )
    ).json()

    assert {a["icao24"] for a in body["aircraft"]} == {"aaaaaa", "bbbbbb"}


@pytest.mark.parametrize(
    "params",
    [
        pytest.param({"west": -1.0}, id="west-only"),
        pytest.param({"west": -1.0, "south": 51.0}, id="west-and-south"),
        pytest.param({"west": -1.0, "south": 51.0, "east": 1.0}, id="three-of-four"),
        pytest.param({"north": 52.0}, id="north-only"),
        pytest.param({"south": 51.0, "east": 1.0, "north": 52.0}, id="missing-west"),
    ],
)
async def test_a_partial_bounding_box_is_a_422_not_a_500(
    app_client: httpx.AsyncClient, params: dict[str, float]
) -> None:
    """Silently defaulting a missing edge to the world would return everything."""
    response = await app_client.get("/api/aircraft", params=params)

    assert response.status_code == 422
    assert "all four" in response.json()["detail"]


async def test_an_out_of_range_bounding_box_edge_is_rejected(
    app_client: httpx.AsyncClient,
) -> None:
    response = await app_client.get(
        "/api/aircraft", params={"west": -181.0, "south": 0.0, "east": 1.0, "north": 1.0}
    )

    assert response.status_code == 422


async def test_an_inverted_bounding_box_escapes_as_a_validation_error() -> None:
    """Pins a real defect: ``south > north`` from a client is a server error, not a 422.

    An inverted box (south above north) is the caller's mistake, so it must read as 422
    exactly as a partial box does, rather than as a 500 that implicates the server.
    Note that west above east is NOT inverted: it means the box crosses the antimeridian
    and is legitimate, which is asserted separately.
    """
    app = create_app(Settings(), start_background_tasks=False)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://tracker.test",
        ) as client,
    ):
        response = await client.get(
            "/api/aircraft", params={"west": 0.0, "south": 52.0, "east": 1.0, "north": 51.0}
        )

    assert response.status_code == 422
    assert "north" in response.json()["detail"]


async def test_military_only_reads_the_military_store(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """The two stores are separate so a worldwide feed cannot evict the local one."""
    app_state.aircraft.upsert("aaaaaa", make_aircraft("aaaaaa"))
    app_state.military.upsert("bbbbbb", make_aircraft("bbbbbb", is_military=True))

    civil = (await app_client.get("/api/aircraft")).json()
    military = (await app_client.get("/api/aircraft", params={"military_only": True})).json()

    assert {a["icao24"] for a in civil["aircraft"]} == {"aaaaaa"}
    assert {a["icao24"] for a in military["aircraft"]} == {"bbbbbb"}


async def test_military_only_respects_the_bounding_box_too(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    app_state.military.upsert("aaaaaa", make_aircraft("aaaaaa", lon=-0.12, lat=51.5))
    app_state.military.upsert("bbbbbb", make_aircraft("bbbbbb", lon=100.0, lat=10.0))

    body = (
        await app_client.get(
            "/api/aircraft",
            params={
                "military_only": True,
                "west": -1.0,
                "south": 51.0,
                "east": 1.0,
                "north": 52.0,
            },
        )
    ).json()

    assert {a["icao24"] for a in body["aircraft"]} == {"aaaaaa"}


# ---------------------------------------------------------------- /api/aircraft/{icao24}
#
# This is the card path, so every test here goes through the registry join. adsbdb is
# intercepted rather than called: `respx` fails a test that reaches a host it does not
# recognise, which is what stops the demand-driven lookup quietly becoming a live request
# from the suite. A 404 body is the default because it is the commonest real answer, about
# one live aircraft in five.

REGISTRY_HOST = "https://api.adsbdb.com"
UNKNOWN_AIRFRAME = json.dumps({"response": "unknown aircraft"}).encode()


def _registry_does_not_hold_it(respx_mock: respx.Router) -> None:
    respx_mock.get(url__startswith=f"{REGISTRY_HOST}/v0/aircraft/").mock(
        return_value=httpx.Response(404, content=UNKNOWN_AIRFRAME)
    )


async def test_one_aircraft_by_address(
    respx_mock: respx.Router, app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    _registry_does_not_hold_it(respx_mock)
    app_state.aircraft.upsert("3c6444", make_aircraft("3c6444", callsign="DLH123"))

    body = (await app_client.get("/api/aircraft/3c6444")).json()

    assert body["aircraft"]["icao24"] == "3c6444"
    assert body["aircraft"]["callsign"] == "DLH123"


@pytest.mark.parametrize("requested", ["3C6444", "3c6444", " 3c6444 ", "3C6444 "])
async def test_one_aircraft_lookup_is_case_insensitive_and_trimmed(
    respx_mock: respx.Router,
    app_client: httpx.AsyncClient,
    app_state: AppState,
    requested: str,
) -> None:
    _registry_does_not_hold_it(respx_mock)
    app_state.aircraft.upsert("3c6444", make_aircraft("3c6444"))

    response = await app_client.get(f"/api/aircraft/{requested}")

    assert response.status_code == 200
    assert response.json()["aircraft"]["icao24"] == "3c6444"


async def test_one_aircraft_is_found_in_the_military_store_too(
    respx_mock: respx.Router, app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    _registry_does_not_hold_it(respx_mock)
    app_state.military.upsert("3c6444", make_aircraft("3c6444", is_military=True))

    body = (await app_client.get("/api/aircraft/3C6444")).json()

    assert body["aircraft"]["icao24"] == "3c6444"
    assert body["aircraft"]["is_military"] is True


async def test_the_civil_store_wins_when_an_address_is_in_both(
    respx_mock: respx.Router, app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    _registry_does_not_hold_it(respx_mock)
    app_state.aircraft.upsert("3c6444", make_aircraft("3c6444", callsign="CIVIL"))
    app_state.military.upsert("3c6444", make_aircraft("3c6444", callsign="MIL"))

    body = (await app_client.get("/api/aircraft/3c6444")).json()

    assert body["aircraft"]["callsign"] == "CIVIL"


async def test_a_register_that_does_not_hold_the_airframe_is_not_a_degraded_card(
    respx_mock: respx.Router, app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """ "This register does not hold that airframe" is an answer, not a fault."""
    _registry_does_not_hold_it(respx_mock)
    app_state.aircraft.upsert("3c6444", make_aircraft("3c6444"))

    body = (await app_client.get("/api/aircraft/3c6444")).json()

    assert body["registry"] is None
    assert body["degraded_reason"] is None
    assert body["aircraft"]["owner"] is None


async def test_a_registry_failure_degrades_the_card_to_feed_only_data(
    respx_mock: respx.Router, app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """Phase 3 deliverable: enrichment failure degrades the card, never errors it."""
    respx_mock.get(url__startswith=f"{REGISTRY_HOST}/v0/aircraft/").mock(
        side_effect=httpx.ConnectTimeout("")
    )
    app_state.aircraft.upsert("3c6444", make_aircraft("3c6444", callsign="DLH123"))

    response = await app_client.get("/api/aircraft/3c6444")

    assert response.status_code == 200
    body = response.json()
    assert body["aircraft"]["callsign"] == "DLH123"
    assert body["registry"] is None
    assert body["degraded_reason"] == "ConnectTimeout"


async def test_a_live_business_jet_shows_its_registered_owner(
    respx_mock: respx.Router, app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """Phase 3 acceptance 1 and 2, on one real pair of records.

    ``ab374c`` is a real Gulfstream G650 out of the recorded ``/v2/type/GLF6`` sweep. It
    classifies ``business_jet`` from its Doc 8643 type designator, it carries ``dbFlags``
    bit 8 so it is on the FAA LADD programme, and adsbdb's real answer for that address
    names Adobe Inc as the registered owner. It renders like any other aircraft: the LADD
    flag is an attribute on the card and nothing suppresses anything, per ADR 009.

    The designator conflict in here is real and load-bearing. The feed says ``GLF6``, which
    is the Doc 8643 designator for a G650; adsbdb says ``G650``, which is not a designator.
    The feed keeps the field, the disagreement is shown, and the aircraft stays classified.
    """
    respx_mock.get(f"{REGISTRY_HOST}/v0/aircraft/AB374C").mock(
        return_value=httpx.Response(200, content=fixture_bytes("adsbdb_ab374c_live.json"))
    )
    jet = next(
        a
        for a in parse_response(fixture_bytes("adsb_type_glf6_live.json"), source="adsb.lol")
        if a.icao24 == "ab374c"
    )
    app_state.aircraft.upsert(jet.icao24, jet)

    body = (await app_client.get("/api/aircraft/ab374c")).json()

    assert body["aircraft"]["aircraft_class"] == "business_jet"
    assert body["aircraft"]["on_ladd"] is True
    assert body["aircraft"]["owner"] == "Adobe Inc"
    assert body["aircraft"]["registered_country"] == "United States"
    assert body["registry"] == "adsbdb"
    assert body["registry_attribution"] is not None
    assert body["joined_at"] is not None
    assert body["degraded_reason"] is None
    # The feed keeps the designator it supplied, and the class survives the join.
    assert body["aircraft"]["type_designator"] == "GLF6"
    assert body["conflicts"] == [
        {"attribute": "type_designator", "feed_value": "GLF6", "registry_value": "G650"}
    ]


async def test_a_designator_the_registry_supplies_reclassifies_the_aircraft(
    respx_mock: respx.Router, app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """A register can supply the field the class is derived from, so the class is recomputed.

    ``a184ca`` is real on both sides. It is one of the 18 Gulfstreams in the recorded
    ``/v2/type/GLF6`` sweep, and adsbdb's live answer for that address on 2026-08-20 gives
    ``GLF5`` with Nike Inc as the registered owner. Feed it as a record with no type
    designator, which is what about 4% of a live viewport looks like and what every phase 5
    register produces (the FAA gives a model string, not a designator), and the join fills the
    designator in.

    Without the recompute the card printed "Type GLF5" beside "Class Unknown", the globe
    painted it with the unknown colour, and a real business jet stayed out of the business-jet
    count, which is the one classification this demo exists to make. Nothing errored.
    """
    respx_mock.get(f"{REGISTRY_HOST}/v0/aircraft/A184CA").mock(
        return_value=httpx.Response(200, content=fixture_bytes("adsbdb_a184ca_live.json"))
    )
    app_state.aircraft.upsert("a184ca", make_aircraft("a184ca", callsign="N1972"))

    body = (await app_client.get("/api/aircraft/a184ca")).json()

    assert body["aircraft"]["type_designator"] == "GLF5"
    assert body["aircraft"]["aircraft_class"] == "business_jet"
    assert body["aircraft"]["owner"] == "Nike Inc"
    # Filled from empty rather than overridden, so there is nothing to disagree about.
    assert body["conflicts"] == []
    assert body["degraded_reason"] is None


async def test_a_registry_lookup_is_cached_with_no_repeat_call_for_the_same_hex(
    respx_mock: respx.Router, app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """Phase 3 acceptance 3, asserted on the route rather than on the adapter alone.

    Two card opens on one aircraft in one session cost one registry request. The cache lives
    in the lookup and the lookup lives on the app state, so the guarantee only holds while
    both survive the request: rebuilding either per request would re-fetch every owner.
    """
    route = respx_mock.get(f"{REGISTRY_HOST}/v0/aircraft/AB374C").mock(
        return_value=httpx.Response(200, content=fixture_bytes("adsbdb_ab374c_live.json"))
    )
    app_state.aircraft.upsert("ab374c", make_aircraft("ab374c"))

    first = (await app_client.get("/api/aircraft/ab374c")).json()
    second = (await app_client.get("/api/aircraft/ab374c")).json()

    assert route.call_count == 1
    assert first["aircraft"]["owner"] == "Adobe Inc"
    assert second["aircraft"]["owner"] == "Adobe Inc"


async def test_an_unknown_aircraft_returns_200_with_a_null_body(
    app_client: httpx.AsyncClient,
) -> None:
    """A 404 would make a normal "not currently seen" look like a broken URL."""
    response = await app_client.get("/api/aircraft/ffffff")

    assert response.status_code == 200
    assert response.json() is None


async def test_a_nonsense_address_returns_a_null_body_rather_than_an_error(
    app_client: httpx.AsyncClient,
) -> None:
    response = await app_client.get("/api/aircraft/not-an-address")

    assert response.status_code == 200
    assert response.json() is None


# ---------------------------------------------------------------- /api/layers


async def test_layers_reports_per_layer_counts(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    app_state.aircraft.upsert_many(
        [("aaaaaa", make_aircraft("aaaaaa")), ("bbbbbb", make_aircraft("bbbbbb"))]
    )
    app_state.military.upsert("cccccc", make_aircraft("cccccc", is_military=True))

    body = (await app_client.get("/api/layers")).json()

    assert body["layers"] == {
        "aircraft": 2,
        "military": 1,
        "vessels": 0,
        "transit": 0,
        "satellites": 0,
        "cities": 0,
    }
    assert {"aircraft/union", "adsb.lol/mil"} <= {feed["source"] for feed in body["feeds"]}


async def test_layers_reports_zero_counts_on_a_cold_start(
    app_client: httpx.AsyncClient,
) -> None:
    body = (await app_client.get("/api/layers")).json()

    assert body["layers"] == {
        "aircraft": 0,
        "military": 0,
        "vessels": 0,
        "transit": 0,
        "satellites": 0,
        "cities": 0,
    }
    assert body["providers"] == [], "no cycle has run, so no provider has reported"


# ---------------------------------------------------------------- wiring


async def test_the_openapi_schema_is_served(app_client: httpx.AsyncClient) -> None:
    schema = (await app_client.get("/openapi.json")).json()

    assert set(schema["paths"]) == {
        "/api/health",
        "/api/capabilities",
        "/api/aircraft",
        "/api/aircraft/{icao24}",
        "/api/vessels",
        "/api/vessels/{mmsi}",
        "/api/transit",
        "/api/satellites",
        "/api/satellites/elements",
        "/api/cities",
        "/api/cities/{geonames_id}",
        "/api/layers",
        "/api/search",
        # The media proxy ADR 005 requires: post media is fetched and cached by us rather than
        # hot-linked from a provider, which is a licence condition on several sources here.
        "/api/media",
        # Social posts, ADR 005. The pin a post draws is about its subject, because no source
        # in this layer reports an author position.
        "/api/social",
        # The removal control ADR 008 requires: removal is immediate, with no queue and no
        # human step, so the control is exposed rather than described.
        "/api/removals",
    }


async def test_cors_allows_the_configured_dev_origin(app_client: httpx.AsyncClient) -> None:
    """The Vite dev server runs on another port, so the browser needs this header."""
    response = await app_client.get("/api/health", headers={"Origin": "http://127.0.0.1:5173"})

    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"


def test_the_app_carries_its_published_identity(tracker_app: FastAPI) -> None:
    assert tracker_app.title == "Tracker"
    assert tracker_app.version == "0.1.0"


# ---------------------------------------------------------------- /api/vessels


async def test_vessels_returns_what_is_in_the_store(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    app_state.vessels.upsert("230992610", make_vessel(name="AURORA"))

    body = (await app_client.get("/api/vessels")).json()

    assert body["count"] == 1
    assert body["vessels"][0]["mmsi"] == "230992610"
    assert body["vessels"][0]["name"] == "AURORA"
    assert body["vessels"][0]["source"] == "digitraffic"


async def test_vessels_is_empty_when_nothing_has_been_polled(
    app_client: httpx.AsyncClient,
) -> None:
    body = (await app_client.get("/api/vessels")).json()

    assert body == {"count": 0, "vessels": []}


async def test_vessels_filters_by_bounding_box(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    app_state.vessels.upsert("230992610", make_vessel(lon=22.2, lat=60.4))
    app_state.vessels.upsert("265513460", make_vessel(mmsi="265513460", lon=-0.1, lat=51.5))

    body = (
        await app_client.get(
            "/api/vessels", params={"west": 20.0, "south": 59.0, "east": 24.0, "north": 62.0}
        )
    ).json()

    assert body["count"] == 1
    assert body["vessels"][0]["mmsi"] == "230992610"


@pytest.mark.parametrize(
    "params",
    [
        pytest.param({"west": 20.0}, id="west-only"),
        pytest.param({"south": 59.0, "east": 24.0, "north": 62.0}, id="missing-west"),
    ],
)
async def test_a_partial_vessel_bounding_box_is_a_422(
    app_client: httpx.AsyncClient, params: dict[str, float]
) -> None:
    """Same rule as the aircraft route: a missing edge is rejected, never defaulted."""
    response = await app_client.get("/api/vessels", params=params)

    assert response.status_code == 422
    assert "all four" in response.json()["detail"]


async def test_one_vessel_by_mmsi(app_client: httpx.AsyncClient, app_state: AppState) -> None:
    app_state.vessels.upsert("230992610", make_vessel(call_sign="OJKL"))

    body = (await app_client.get("/api/vessels/230992610")).json()

    assert body["mmsi"] == "230992610"
    assert body["call_sign"] == "OJKL"


async def test_a_served_vessel_names_every_provider_that_saw_it(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """ADR 010 wants the provider list on the record, so it has to reach the wire.

    The layer-level coverage on ``/api/layers`` is a fact about the layer: naming providers
    on a card from that would be a guess about this particular ship.
    """
    merged = make_vessel(source="aishub").model_copy(
        update={"providers": ("aishub", "digitraffic")}
    )
    app_state.vessels.upsert("230992610", merged)

    body = (await app_client.get("/api/vessels/230992610")).json()

    assert body["source"] == "aishub"
    assert body["providers"] == ["aishub", "digitraffic"]
    assert (await app_client.get("/api/vessels")).json()["vessels"][0]["providers"] == [
        "aishub",
        "digitraffic",
    ]


async def test_a_vessel_no_merge_has_touched_serves_an_empty_provider_list(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """Empty rather than absent: the field is always on the wire, so a client can read it."""
    app_state.vessels.upsert("230992610", make_vessel())

    assert (await app_client.get("/api/vessels/230992610")).json()["providers"] == []


async def test_an_unknown_vessel_returns_200_with_a_null_body(
    app_client: httpx.AsyncClient,
) -> None:
    """A 404 would make a normal "not currently seen" look like a broken URL."""
    response = await app_client.get("/api/vessels/999999999")

    assert response.status_code == 200
    assert response.json() is None


# ---------------------------------------------------------------- /api/satellites


async def test_satellites_returns_what_is_in_the_store(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    app_state.satellites.upsert("25544", make_satellite())

    body = (await app_client.get("/api/satellites")).json()

    assert body["count"] == 1
    assert body["satellites"][0]["norad_cat_id"] == 25544
    assert body["satellites"][0]["object_name"] == "ISS (ZARYA)"


async def test_satellites_is_empty_when_nothing_has_been_fetched(
    app_client: httpx.AsyncClient,
) -> None:
    assert (await app_client.get("/api/satellites")).json() == {"count": 0, "satellites": []}


async def test_satellite_elements_is_empty_before_the_first_fetch(
    app_client: httpx.AsyncClient,
) -> None:
    body = (await app_client.get("/api/satellites/elements")).json()

    assert body == {"count": 0, "fetched": {}, "satellites": []}


async def test_satellite_elements_serves_the_cache_and_says_when_it_was_fetched(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """The cache is filled directly because this file installs no HTTP mock by design.

    ``fetched`` is the fetch instant and not an element set's epoch, which is the
    distinction the two-hour floor is measured against.
    """
    app_state.celestrak._cache["stations"] = ElementBatch(
        provider=RETLECTOR.name,
        group="stations",
        fetched_at=REFERENCE_TIME,
        satellites=(make_satellite(),),
        dropped_unmappable=0,
        dropped_stale=0,
    )

    body = (await app_client.get("/api/satellites/elements")).json()

    assert body["count"] == 1
    assert body["satellites"][0]["norad_cat_id"] == 25544
    assert body["fetched"]["stations"].startswith("2026-08-19T12:00:00")


# ---------------------------------------------------------------- provider coverage


async def test_layers_reports_per_provider_coverage_after_a_merge(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """ADR 010: the provider-attributable count is measured and exposed, not asserted."""
    baltic = make_vessel(mmsi="230992610", source="digitraffic")
    both = make_vessel(mmsi="265513460", source="digitraffic")
    app_state.vessel_union = merge_providers(
        [
            ProviderResult(provider="digitraffic", records=(baltic, both)),
            ProviderResult(provider="aishub", records=(both,)),
            ProviderResult(provider="aisstream", error="SourceError: connection closed"),
        ],
        key=lambda vessel: vessel.mmsi,
        reported_at=lambda vessel: vessel.observed_at,
    )

    providers = {
        entry["provider"]: entry
        for entry in (await app_client.get("/api/layers")).json()["providers"]
    }

    assert providers["digitraffic"] == {
        "layer": "vessels",
        "provider": "digitraffic",
        "records": 2,
        "exclusive": 1,
        "error": None,
        # No cycle has been recorded through the poller here, so the running totals read
        # zero rather than being absent from the row.
        "polls": 0,
        "failures": 0,
        "empty_polls": 0,
        "drops": 0,
        "last_success_at": None,
    }
    assert providers["aishub"]["records"] == 1
    assert providers["aishub"]["exclusive"] == 0
    assert providers["aisstream"]["error"] == "SourceError: connection closed"
    assert providers["aisstream"]["records"] == 0


async def test_layers_carries_the_running_per_provider_totals(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """A provider failing every cycle for a week must not read like one that failed once.

    The per-cycle fields cannot say that, because the union result is replaced each cycle.
    """
    union = merge_providers(
        [
            ProviderResult(provider="digitraffic", records=(make_vessel(),)),
            ProviderResult(provider="aishub", error="AishubUnavailableError: empty body"),
        ],
        key=lambda vessel: vessel.mmsi,
        reported_at=lambda vessel: vessel.observed_at,
    )
    app_state.vessel_union = union
    for _ in range(3):
        record_cycle(app_state.vessel_providers, union)
    count_drops(app_state.vessel_providers, "aishub", 7)

    providers = {
        entry["provider"]: entry
        for entry in (await app_client.get("/api/layers")).json()["providers"]
    }

    assert providers["aishub"]["polls"] == 3
    assert providers["aishub"]["failures"] == 3
    assert providers["aishub"]["drops"] == 7
    assert providers["aishub"]["last_success_at"] is None
    assert providers["digitraffic"]["polls"] == 3
    assert providers["digitraffic"]["failures"] == 0
    assert providers["digitraffic"]["last_success_at"] is not None


async def test_the_military_sweep_drop_count_reaches_the_api(
    respx_mock: respx.Router, app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """Dropped and counted, on the layer with the worst drop rate in the project.

    81 of the 391 records in the recorded ``/v2/mil`` capture carry no position and are
    refused as heard-but-not-located. That count reached the parser's log line and stopped
    there: nothing read the military client's counter and ``/api/layers`` carried no military
    row at all, so the layer read "healthy, 310 tracked" with the other 81 nowhere.
    """
    respx_mock.get("https://api.adsb.lol/v2/mil").mock(
        return_value=httpx.Response(200, content=fixture_bytes("adsb_mil_live.json"))
    )
    military = next(p for p in app_state.pollers if p.name == "adsb.lol/mil")

    assert await military.run_once() is True

    rows = [
        row
        for row in (await app_client.get("/api/layers")).json()["providers"]
        if row["layer"] == "military"
    ]

    assert len(rows) == 1
    assert rows[0]["provider"] == "adsb.lol"
    assert rows[0]["records"] == 310
    assert rows[0]["drops"] == 81
    assert rows[0]["polls"] == 1
    assert rows[0]["failures"] == 0
    assert rows[0]["error"] is None


async def test_a_throttled_military_sweep_is_counted_and_still_backs_off(
    respx_mock: respx.Router, app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """The failure is recorded and then re-raised with its own type, which is the point.

    Routing this layer's failure through a provider result the way the union does would turn a
    ``RateLimitedError`` into a string, and the poller would then back off on its own curve
    instead of the provider's stated figure. Retrying a throttled free feed on a generic
    schedule is how an IP gets banned. So the count and the backoff both have to happen.
    """
    respx_mock.get("https://api.adsb.lol/v2/mil").mock(
        return_value=httpx.Response(429, headers={"Retry-After": "120"})
    )
    respx_mock.get("https://opendata.adsb.fi/api/v2/mil").mock(
        return_value=httpx.Response(429, headers={"Retry-After": "120"})
    )
    app_state.military.upsert("3c6444", make_aircraft("3c6444", is_military=True))
    military = next(p for p in app_state.pollers if p.name == "adsb.lol/mil")

    assert await military.run_once() is True

    body = (await app_client.get("/api/layers")).json()
    row = next(r for r in body["providers"] if r["layer"] == "military")
    feed = next(f for f in body["feeds"] if f["source"] == "adsb.lol/mil")

    assert row["polls"] == 1
    assert row["failures"] == 1
    assert row["error"] is not None
    assert feed["rate_limited_until"] is not None
    # A failed sweep must not empty the store: the aircraft it holds were really seen.
    assert body["layers"]["military"] == 1


# ---------------------------------------------------------------- registry coverage


async def test_the_registry_enrichment_counts_reach_the_api(
    respx_mock: respx.Router, app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """A registry failing every lookup since start-up must not look like a healthy one.

    The counters existed and nothing served them, so an operator on ``/api/layers`` could not
    tell the two apart. ``unmappable`` is the drop-and-count rule one layer up from the
    adapters and it has the same claim on being readable.
    """
    respx_mock.get(url__startswith=f"{REGISTRY_HOST}/v0/aircraft/").mock(
        side_effect=httpx.ConnectTimeout("")
    )
    app_state.aircraft.upsert("3c6444", make_aircraft("3c6444"))
    app_state.aircraft.upsert("a1b2c3", make_aircraft("a1b2c3"))

    await app_client.get("/api/aircraft/3c6444")
    await app_client.get("/api/aircraft/a1b2c3")
    registries = (await app_client.get("/api/layers")).json()["registries"]

    assert len(registries) == 1
    assert registries[0] == {
        "registry": "adsbdb",
        "requests": 2,
        "enriched": 0,
        "not_held": 0,
        "failures": 2,
        "unmappable": 0,
        "conflicts": 0,
        "last_error": "ConnectTimeout",
    }


# ---------------------------------------------------------------- aircraft provider capability


@pytest.mark.parametrize("layer", ["aircraft/adsbexchange", "aircraft/airplanes.live"])
async def test_capabilities_reports_the_two_unfiltered_providers_unavailable_with_a_reason(
    app_client: httpx.AsyncClient, layer: str
) -> None:
    """The honest-reporting half of phase 3 acceptance 8, which was asserted nowhere.

    ADR 010's unfiltered-coverage argument rests entirely on these two and neither answers, so
    the layer rail has to say so per provider. Deleting the generator that builds these rows
    used to leave the whole gate green at 99.5% coverage, and an inverted availability check
    would have advertised two unreachable providers as live.

    Their own test rather than the keyed-layer one above, because neither reason names an
    environment variable: there is no key to paste for airplanes.live, and a key would not
    clear ADS-B Exchange's redistribution terms.
    """
    layers = {
        entry["layer"]: entry
        for entry in (await app_client.get("/api/capabilities")).json()["layers"]
    }

    assert layers["aircraft"]["available"] is True
    assert layers[layer]["available"] is False
    assert isinstance(layers[layer]["reason"], str)
    assert layers[layer]["reason"].strip(), "an unavailable provider must say why"
    assert "TRACKER_" not in layers[layer]["reason"]


async def test_an_adsbexchange_key_cannot_flip_the_provider_to_available(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """There is no setting to set, and that is the fix rather than an oversight.

    ``TRACKER_ADSBEXCHANGE_API_KEY`` used to flip this row to ``available: true, reason: null``
    while no code path in the project could fetch a single record from the provider, and the
    layer rail builds the aircraft row's "missing" detail from unavailable providers, so the
    same environment variable also deleted the redistribution licence warning off the screen.
    """
    monkeypatch.setenv("TRACKER_ADSBEXCHANGE_API_KEY", "deadbeef")

    assert not {f for f in Settings.model_fields if "adsbexchange" in f}
    layers = {entry["layer"]: entry for entry in (await _capabilities(Settings()))["layers"]}

    assert layers["aircraft/adsbexchange"]["available"] is False
    assert "redistribution" in layers["aircraft/adsbexchange"]["reason"]


async def test_a_provider_left_out_of_the_union_has_no_coverage_row(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """Where the zero is reported, and where it is not.

    ``/api/layers`` carries a row per provider that was polled. A gated provider was never
    asked, and a row reading ``records: 0, error: null`` is ADR 010's reporting-but-empty
    state, which is a different sentence: folding one into the other would be the more
    misleading of the two. ``/api/capabilities`` carries the reason instead, asserted above.
    """
    union = merge_providers(
        [ProviderResult(provider="adsb.lol", records=(make_aircraft("3c6444"),))],
        key=lambda aircraft: aircraft.icao24,
        reported_at=lambda aircraft: aircraft.observed_at,
    )
    app_state.aircraft_union = union

    rows = (await app_client.get("/api/layers")).json()["providers"]
    aircraft_rows = {row["provider"] for row in rows if row["layer"] == "aircraft"}

    assert aircraft_rows == {"adsb.lol"}


# ---------------------------------------------------------------- vessel provider capability


async def test_capabilities_reports_aishub_unavailable_with_the_receiver_reason(
    app_client: httpx.AsyncClient,
) -> None:
    """Acceptance 9. There is no key to paste, so the reason names the hardware instead."""
    layers = {
        entry["layer"]: entry
        for entry in (await app_client.get("/api/capabilities")).json()["layers"]
    }

    assert layers["vessels"]["available"] is True
    assert layers["vessels/aishub"]["available"] is False
    assert layers["vessels/aishub"]["reason"] == NO_USERNAME_REASON
    assert "AIS receiver" in layers["vessels/aishub"]["reason"]
    assert "TRACKER_" not in layers["vessels/aishub"]["reason"]


async def test_an_aishub_username_makes_that_provider_available(keyless_env: None) -> None:
    body = await _capabilities(Settings(aishub_username="tracker-test-user"))

    layers = {entry["layer"]: entry for entry in body["layers"]}
    assert layers["vessels/aishub"]["available"] is True
    assert layers["vessels/aishub"]["reason"] is None


async def test_capabilities_reports_satellites_unavailable_until_a_provider_answers(
    app_client: httpx.AsyncClient,
) -> None:
    """Keyless, so availability is a runtime fact rather than a credential check.

    The reason names the providers rather than CelesTrak, because CelesTrak is one row of a
    chain now and is the one refusing this network.
    """
    layers = {
        entry["layer"]: entry
        for entry in (await app_client.get("/api/capabilities")).json()["layers"]
    }

    assert layers["satellites"]["available"] is False
    assert (
        layers["satellites"]["reason"] == "the orbital element providers have not been queried yet"
    )


async def test_capabilities_reports_satellites_available_once_elements_are_cached(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    app_state.celestrak._cache["stations"] = ElementBatch(
        provider=RETLECTOR.name,
        group="stations",
        fetched_at=REFERENCE_TIME,
        satellites=(make_satellite(),),
        dropped_unmappable=0,
        dropped_stale=0,
    )

    layers = {
        entry["layer"]: entry
        for entry in (await app_client.get("/api/capabilities")).json()["layers"]
    }

    assert layers["satellites"]["available"] is True
    assert layers["satellites"]["reason"] is None


async def test_the_fintraffic_attribution_is_the_wording_the_provider_specifies(
    app_client: httpx.AsyncClient,
) -> None:
    """CC BY 4.0 makes the credit a condition of use and the provider gives the exact string."""
    attribution = (await app_client.get("/api/capabilities")).json()["attribution"]
    by_source = {entry["source"]: entry for entry in attribution}

    assert (
        by_source["Fintraffic"]["text"] == "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY"
    )
    assert by_source["Fintraffic"]["licence"] == "CC BY 4.0"
    assert "CelesTrak" in by_source
    # AISHub and aisstream.io are **absent while gated**, and that is the point rather than an
    # omission: a credit is a statement in the present tense, and crediting a source we are not
    # using was a claim about our own conduct that was not true. See
    # `test_a_gated_source_is_not_credited_until_it_can_serve`.
    assert "AISHub" not in by_source
    assert "aisstream.io" not in by_source


async def test_a_gated_source_is_not_credited_until_it_can_serve(
    app_client: httpx.AsyncClient,
) -> None:
    """A credit is present tense, and four of them were asserting something untrue.

    ADS-B Exchange, airplanes.live, aisstream.io and AISHub are all gated and all reported
    ``available: false`` in this same payload, with none of them in any provider tally, while
    their credits said we were using them. **ADS-B Exchange is the sharp one**: its credit read
    "Unfiltered aircraft data from ADS-B Exchange" beside its own licence field saying
    redistribution to a browser is prohibited, so the panel whose whole purpose is provenance
    honesty was confessing to a breach we are not committing.

    The credits are filtered, never deleted: the reason they exist is that a source must not be
    able to ship uncredited, and the gate is the capability row so there is one computation of
    "can this serve" rather than two that drift.
    """
    body = (await app_client.get("/api/capabilities")).json()
    credited = {entry["source"] for entry in body["attribution"]}
    unavailable = {row["layer"] for row in body["layers"] if not row["available"]}

    assert "aircraft/adsbexchange" in unavailable
    assert "adsbexchange" not in credited, "redistribution is prohibited; do not claim we do it"
    for source, row in (
        ("airplanes.live", "aircraft/airplanes.live"),
        ("aisstream.io", "vessels/aisstream"),
        ("AISHub", "vessels/aishub"),
    ):
        assert row in unavailable
        assert source not in credited


async def test_a_gated_credit_returns_the_moment_its_source_can_serve() -> None:
    """Filtered, not deleted. The property that a source cannot ship uncredited must survive."""
    body = await _capabilities(Settings(aisstream_api_key="a-key", aishub_username="a-user"))
    credited = {entry["source"] for entry in body["attribution"]}

    assert "aisstream.io" in credited
    assert "AISHub" in credited


async def test_the_social_layer_reports_its_own_bounds(
    app_client: httpx.AsyncClient,
) -> None:
    """It was the only live layer with no capability row at all.

    So it could never report itself bounded, and its two real limits reached a viewer only as a
    transient notice. It is available rather than gated, because the layer is keyless and works;
    what a viewer needs is that it answers about a point rather than about the globe, since "no
    posts here" and "you have not asked about anywhere" look identical on a map.
    """
    body = (await app_client.get("/api/capabilities")).json()
    row = next(entry for entry in body["layers"] if entry["layer"] == "social")

    assert row["available"] is True
    assert row["reason"] is not None
    assert "10km" in row["reason"]
    assert "500" in row["reason"]


async def test_the_vessel_coverage_reason_is_counted_and_names_no_region(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """It read "Ships shown for Northern Europe only" while 26.9% of the ships were in America.

    1,624 of 6,036 vessels were west of 50 degrees west, every one from ``seaway``, and the rail
    showed that sentence directly above a provider line reading ``seaway only: 1,624``. A region
    named in a coverage string is invalidated by the next authority added, so the reason is now
    derived from the providers that actually reported and this test forbids the class of claim.
    """
    app_state.vessel_union = merge_providers(
        [
            ProviderResult(provider="digitraffic", records=(make_vessel(mmsi="230992610"),)),
            ProviderResult(provider="seaway", records=(make_vessel(mmsi="316001234"),)),
        ],
        key=lambda v: v.mmsi,
        reported_at=lambda v: v.observed_at,
    )

    body = (await app_client.get("/api/capabilities")).json()
    reason = next(row["reason"] for row in body["layers"] if row["layer"] == "vessels/aisstream")

    assert "2 regional feeds" in reason, "the count comes from the union, not from a constant"
    for region in ("Europe", "Nordic", "Baltic", "America", "Great Lakes", "Atlantic"):
        assert region.lower() not in reason.lower(), f"{region!r} goes stale on the next feed"


# ---------------------------------------------------------------- cities
#
# Nothing in this section touches a network and one test proves it rather than trusting it:
# `test_london_resolves_with_no_network_at_all` builds the app over a transport whose every
# request raises, so a search that reached for the geocoder fails the test loudly instead of
# passing because a route happened not to be hit.

LONDON_ROWS = "geonames_cities15000_london_dead_extract.tsv"
"""Nine recorded rows of the real cities15000 file: both Londons, three near misses, four
dead places the parser drops. Real bytes, so the ranking is exercised on real populations."""

ROTTERDAM_BODY = "nominatim_search_rotterdam_live.json"
"""Live Nominatim answer for "rotterdam", three results, recorded 2026-08-20."""

LONDON_GB = 2643743
LONDON_CA = 6058560
LONDONDERRY = 2643734
EAST_LONDON_ZA = 1006984
NEW_LONDON_US = 4839416
CITIES_BY_POPULATION = [LONDON_GB, EAST_LONDON_ZA, LONDON_CA, LONDONDERRY, NEW_LONDON_US]
"""The five live rows in population order: 8,961,989 down to 27,179.

East London ZA sits between the two Londons on population, which is exactly why the layer
read and the search disagree about it: the read is ordered by size and the search matches on
a prefix, so "London" never offers East London at all."""
LIVE_CITY_ROWS = 5
"""How many of the nine recorded rows survive the parser. The other four are dead places."""


def _recorded_cities() -> tuple[City, ...]:
    return parse_cities(fixture_bytes(LONDON_ROWS)).records


def _seed_cities(state: AppState) -> int:
    """Fill the gazetteer the way the weekly refresh does, with no download.

    Through the product's own indexing function rather than a second copy of the ordering, so
    the read tests cannot pass against an order the refresh does not produce.
    """
    return index_cities(state, _recorded_cities())


def _no_network_app(settings: Settings) -> tuple[FastAPI, httpx.AsyncClient]:
    """An app whose upstream client cannot reach anything. Any request at all fails.

    The contact email is set on purpose, so the Nominatim client really is built over this
    client: without it the places group would be skipped for the wrong reason and the test
    would prove nothing about the city index.
    """

    def explode(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"the request touched the network: {request.url}")

    upstream = httpx.AsyncClient(transport=httpx.MockTransport(explode))
    app = create_app(settings, start_background_tasks=False, http_client=upstream)
    return app, upstream


async def test_cities_are_served_biggest_first(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    assert _seed_cities(app_state) == LIVE_CITY_ROWS

    body = (await app_client.get("/api/cities")).json()

    assert body["count"] == LIVE_CITY_ROWS
    assert body["total"] == LIVE_CITY_ROWS
    assert [city["geonames_id"] for city in body["cities"]] == CITIES_BY_POPULATION
    assert body["cities"][0]["name"] == "London"
    assert body["cities"][0]["country_code"] == "GB"
    assert body["cities"][0]["point"] == {"lon": -0.12574, "lat": 51.50853, "altitude_m": None}


async def test_a_capped_city_read_says_how_many_matched(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """A truncated read must not read as everything the server holds."""
    _seed_cities(app_state)

    body = (await app_client.get("/api/cities", params={"limit": 2})).json()

    assert body["count"] == 2
    assert body["total"] == LIVE_CITY_ROWS
    assert [city["geonames_id"] for city in body["cities"]] == CITIES_BY_POPULATION[:2]


async def test_cities_can_be_filtered_to_a_bounding_box(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    _seed_cities(app_state)

    body = (
        await app_client.get(
            "/api/cities",
            params={"west": -8.0, "south": 49.0, "east": 2.0, "north": 56.0},
        )
    ).json()

    assert {city["geonames_id"] for city in body["cities"]} == {LONDON_GB, LONDONDERRY}
    assert body["total"] == 2


async def test_a_partial_city_bounding_box_is_rejected(app_client: httpx.AsyncClient) -> None:
    """Same rule as every other layer read: a missing edge is refused, never defaulted."""
    response = await app_client.get("/api/cities", params={"west": -8.0, "south": 49.0})

    assert response.status_code == 422
    assert "all four" in response.json()["detail"]


async def test_one_city_by_geonames_id(app_client: httpx.AsyncClient, app_state: AppState) -> None:
    _seed_cities(app_state)

    body = (await app_client.get(f"/api/cities/{LONDON_CA}")).json()

    assert body["name"] == "London"
    assert body["country_code"] == "CA"
    assert body["population"] == 422324


async def test_an_unknown_geonames_id_is_null_rather_than_an_error(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    _seed_cities(app_state)

    response = await app_client.get("/api/cities/1")

    assert response.status_code == 200
    assert response.json() is None


async def test_capabilities_reports_cities_off_until_the_dump_has_been_read(
    app_client: httpx.AsyncClient,
) -> None:
    """Keyless, so this is a runtime fact like satellites rather than a missing credential."""
    layers = {
        entry["layer"]: entry
        for entry in (await app_client.get("/api/capabilities")).json()["layers"]
    }

    assert layers["cities"]["available"] is False
    assert layers["cities"]["reason"] == CITIES_PENDING_REASON


async def test_capabilities_reports_cities_available_once_the_index_is_filled(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    _seed_cities(app_state)

    layers = {
        entry["layer"]: entry
        for entry in (await app_client.get("/api/capabilities")).json()["layers"]
    }

    assert layers["cities"]["available"] is True
    assert layers["cities"]["reason"] is None


async def test_the_geonames_credit_carries_both_links_the_licence_requires(
    app_client: httpx.AsyncClient,
) -> None:
    """CC BY 4.0 makes the credit a condition, and it wants the source and the licence."""
    by_source = {
        entry["source"]: entry
        for entry in (await app_client.get("/api/capabilities")).json()["attribution"]
    }

    assert by_source["geonames"]["text"] == "City data from GeoNames, CC BY 4.0"
    assert by_source["geonames"]["url"] == "https://www.geonames.org/"
    assert "creativecommons.org/licenses/by/4.0" in by_source["geonames"]["licence"]
    assert by_source["nominatim"]["text"] == NOMINATIM_ATTRIBUTION
    assert by_source["nominatim"]["licence"] == "ODbL 1.0"


# ---------------------------------------------------------------- /api/search


async def test_london_resolves_with_no_network_at_all() -> None:
    """Phase 4 acceptance 3, through the API this time.

    The English London first, Ontario directly below it, and a client underneath whose every
    request raises, so this fails rather than passes if anything reaches for the geocoder.
    """
    app, upstream = _no_network_app(Settings(contact_email="tests@tracker.invalid"))
    async with (
        upstream,
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://tracker.test"
        ) as client,
    ):
        state: AppState = app.state.tracker
        _seed_cities(state)

        body = (await client.get("/api/search", params={"q": "London"})).json()

        groups = {group["name"]: group for group in body["groups"]}
        assert list(groups) == ["cities"], "no group but cities should have answered"
        hits = groups["cities"]["hits"]
        assert [hit["entity_id"] for hit in hits] == [
            str(LONDON_GB),
            str(LONDON_CA),
            str(LONDONDERRY),
        ]
        assert hits[0]["detail"] == "GB · population 8,961,989"
        assert hits[0]["point"] == {"lon": -0.12574, "lat": 51.50853, "altitude_m": None}
        # The exploding transport is what proves nothing was sent: a geocoder call would have
        # raised rather than answered. This asserts the client really was wired, so the test
        # cannot pass by having skipped the places group for the wrong reason.
        assert state.nominatim is not None, "the geocoder must be wired for this to prove anything"


async def test_a_callsign_an_mmsi_and_iss_resolve_inside_the_budget(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """Phase 4 acceptance 1: under 300ms from local indices, measured over the HTTP round trip."""
    app_state.aircraft.upsert("4ca7b3", make_aircraft("4ca7b3", callsign="RYR8GR"))
    app_state.vessels.upsert("230992610", make_vessel("230992610", name="FINNMAID"))
    app_state.satellites.upsert("25544", make_satellite())
    _seed_cities(app_state)

    for query, group_name in (
        ("RYR8GR", "aircraft"),
        ("230992610", "vessels"),
        ("ISS", "satellites"),
        ("London", "cities"),
    ):
        started = time.perf_counter()
        body = (await app_client.get("/api/search", params={"q": query})).json()
        elapsed = time.perf_counter() - started

        groups = {group["name"]: group for group in body["groups"]}
        assert groups[group_name]["hits"], f"{query} resolved nothing"
        assert elapsed < LOCAL_SEARCH_BUDGET_S, f"{query} took {elapsed * 1000:.1f}ms"
        _log.info("%s resolved in %.1fms over HTTP", query, elapsed * 1000)


@respx.mock(assert_all_called=True)
async def test_the_geocoder_is_called_once_per_unique_query(respx_mock: respx.Router) -> None:
    """Phase 4 acceptance 2: Rotterdam resolves to the port, and the provider is asked once.

    Asked three times over HTTP with different case and spacing, because the cache key is the
    folded query: a typeahead that re-fetches on every keystroke is the pattern the OSMF
    usage policy calls faulty, and its cap is an absolute maximum of one request a second.
    """
    route = respx_mock.get(f"{NOMINATIM_BASE_URL}{NOMINATIM_SEARCH_PATH}").mock(
        return_value=httpx.Response(200, content=fixture_bytes(ROTTERDAM_BODY))
    )
    app = create_app(Settings(contact_email="tests@tracker.invalid"), start_background_tasks=False)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://tracker.test"
        ) as client,
    ):
        # The recorded city rows hold no Rotterdam, so the query falls through to the
        # geocoder exactly as it would for an address the gazetteer cannot know.
        _seed_cities(app.state.tracker)

        first = (await client.get("/api/search", params={"q": "Rotterdam"})).json()
        for repeat in ("rotterdam", "  ROTTERDAM "):
            again = (await client.get("/api/search", params={"q": repeat})).json()
            assert again["groups"] == first["groups"]

    assert route.call_count == 1
    hits = first["groups"][0]["hits"]
    assert first["groups"][0]["name"] == "places"
    assert hits[0]["label"] == "Rotterdam"
    assert hits[0]["entity_id"] == "relation/1411101"
    assert hits[0]["point"] == {"lon": 4.47775, "lat": 51.9244424, "altitude_m": None}


async def test_with_no_contact_email_the_places_group_says_why(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """The keyless default. The geocoder is never built, so it can never be called anonymously."""
    assert app_state.nominatim is None
    # A loaded gazetteer, so the one degraded group in the answer is the geocoder's and not the
    # gazetteer's: an empty index reports itself first and stops the fall-through entirely.
    _seed_cities(app_state)

    body = (await app_client.get("/api/search", params={"q": "Nowhere at all"})).json()

    assert body["groups"] == [
        {"name": "places", "hits": [], "unavailable_reason": PLACES_UNAVAILABLE_REASON}
    ]


async def test_search_refuses_an_empty_query_and_an_oversized_limit(
    app_client: httpx.AsyncClient,
) -> None:
    assert (await app_client.get("/api/search", params={"q": ""})).status_code == 422
    assert (
        await app_client.get("/api/search", params={"q": "London", "limit": 1000})
    ).status_code == 422


@respx.mock(assert_all_called=True)
async def test_a_long_address_against_a_failing_geocoder_is_a_200(respx_mock: respx.Router) -> None:
    """The blocker: a degraded places group used to answer HTTP 500 on ordinary input.

    The reason is built from the exception, an httpx status error renders the whole request URL,
    and the percent-encoded query rides inside it. Cyrillic is the worst case at three bytes a
    character, and this real Moscow address is 30 characters. The route itself accepts 200.
    """
    respx_mock.get(f"{NOMINATIM_BASE_URL}{NOMINATIM_SEARCH_PATH}").respond(503, content=b"down")
    app = create_app(Settings(contact_email="tests@tracker.invalid"), start_background_tasks=False)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://tracker.test"
        ) as client,
    ):
        _seed_cities(app.state.tracker)

        response = await client.get("/api/search", params={"q": "Улица Тверская, Москва, Россия"})

    assert response.status_code == 200
    groups = response.json()["groups"]
    assert groups[0]["name"] == "places"
    assert groups[0]["unavailable_reason"] is not None


async def test_the_city_read_is_compressed(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    """The browser asks for the whole gazetteer on every page load, 10.2MB of it uncompressed.

    Nothing else was ever going to compress it: FastAPI serves the built bundle itself, so
    there is no reverse proxy in front of this. Measured against the real dump, gzip takes the
    city read from 10.2MB to 1.57MB.
    """
    _seed_cities(app_state)

    response = await app_client.get("/api/cities", headers={"Accept-Encoding": "gzip, deflate, br"})

    assert response.status_code == 200
    assert response.headers["content-encoding"] == "gzip"
    # httpx decodes the body, so the compressed size is what the header says.
    assert int(response.headers["content-length"]) < len(response.content)


async def test_the_ownership_row_reports_the_register_not_a_credential(
    keyless_env: None,
) -> None:
    """The register is a runtime fact, so before it loads the reason says so.

    And asks for nothing, because no credential would make it load.
    """
    body = await _capabilities(Settings(contact_email="ops@example.com"))

    layers = {entry["layer"]: entry for entry in body["layers"]}
    row = layers["ownership"]
    assert row["available"] is False, "no register has loaded in a state built for a test"
    assert "TRACKER_" not in row["reason"]
    assert "register" in row["reason"].lower()


async def test_transit_can_be_filtered_to_a_viewport(app_client: httpx.AsyncClient) -> None:
    """The same optional box every other list route takes, so a card asks for what it draws."""
    body = (
        await app_client.get(
            "/api/transit", params={"west": -1.0, "south": 51.0, "east": 1.0, "north": 52.0}
        )
    ).json()

    assert body["count"] == 0
    assert body["vehicles"] == []


async def test_transit_without_a_viewport_returns_everything_held(
    app_client: httpx.AsyncClient,
) -> None:
    body = (await app_client.get("/api/transit")).json()

    assert body["count"] == 0
    assert body["vehicles"] == []
