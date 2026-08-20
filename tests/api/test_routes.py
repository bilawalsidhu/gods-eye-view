"""REST endpoints, in-process and with no network.

These read the stores and never touch an upstream, which is asserted implicitly: no respx
mock is installed anywhere in this file, so a route that tried to fetch would fail.

``/api/capabilities`` gets the most attention because it is what lets the frontend degrade
honestly. A layer with no credential must report itself unavailable with a reason, not
render as an empty layer that looks like a bug.
"""

from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from tests.conftest import REFERENCE_TIME, make_aircraft, make_satellite, make_vessel
from tracker.api.state import AppState
from tracker.app import create_app
from tracker.config import Settings
from tracker.services.union import ProviderResult, merge_providers
from tracker.sources.aishub import NO_USERNAME_REASON
from tracker.sources.celestrak import _CachedGroup


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
        "adsb.lol/point",
        "adsb.lol/mil",
        "vessels/union",
        "celestrak/gp",
    }
    assert {feed["layer"] for feed in body["feeds"]} == {
        "aircraft",
        "military",
        "vessels",
        "satellites",
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


@pytest.mark.parametrize("layer", ["vessels/aisstream", "cameras", "buildings", "places"])
async def test_capabilities_reports_keyed_layers_unavailable_with_a_reason(
    app_client: httpx.AsyncClient, layer: str
) -> None:
    layers = {
        entry["layer"]: entry
        for entry in (await app_client.get("/api/capabilities")).json()["layers"]
    }

    assert layers[layer]["available"] is False
    assert isinstance(layers[layer]["reason"], str)
    assert layers[layer]["reason"].strip(), "an unavailable layer must say why"
    assert "TRACKER_" in layers[layer]["reason"]


async def test_capabilities_returns_no_cesium_token_when_none_is_configured(
    app_client: httpx.AsyncClient,
) -> None:
    assert (await app_client.get("/api/capabilities")).json()["cesium_ion_token"] is None


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
        assert entry["url"].startswith("https://")
        assert entry["licence"].strip()


async def test_capabilities_reports_keyed_layers_available_when_keys_are_set(
    keyless_env: None,
) -> None:
    settings = Settings(
        aisstream_api_key="ais-key",
        windy_api_key="windy-key",
        cesium_ion_token="ion-token",
        contact_email="ops@example.com",
    )

    body = await _capabilities(settings)

    layers = {entry["layer"]: entry for entry in body["layers"]}
    for name in ("vessels/aisstream", "cameras", "buildings", "places"):
        assert layers[name]["available"] is True, name
        assert layers[name]["reason"] is None, name
    assert body["cesium_ion_token"] == "ion-token"


async def test_a_tfl_key_alone_enables_the_camera_layer(keyless_env: None) -> None:
    """Either provider is enough for public cameras, so the layer must not need both."""
    body = await _capabilities(Settings(tfl_app_key="tfl-key"))

    layers = {entry["layer"]: entry for entry in body["layers"]}
    assert layers["cameras"]["available"] is True
    assert layers["vessels/aisstream"]["available"] is False
    assert layers["vessels"]["available"] is True, "the keyless providers carry the layer"


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


async def test_one_aircraft_by_address(app_client: httpx.AsyncClient, app_state: AppState) -> None:
    app_state.aircraft.upsert("3c6444", make_aircraft("3c6444", callsign="DLH123"))

    body = (await app_client.get("/api/aircraft/3c6444")).json()

    assert body["icao24"] == "3c6444"
    assert body["callsign"] == "DLH123"


@pytest.mark.parametrize("requested", ["3C6444", "3c6444", " 3c6444 ", "3C6444 "])
async def test_one_aircraft_lookup_is_case_insensitive_and_trimmed(
    app_client: httpx.AsyncClient, app_state: AppState, requested: str
) -> None:
    app_state.aircraft.upsert("3c6444", make_aircraft("3c6444"))

    response = await app_client.get(f"/api/aircraft/{requested}")

    assert response.status_code == 200
    assert response.json()["icao24"] == "3c6444"


async def test_one_aircraft_is_found_in_the_military_store_too(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    app_state.military.upsert("3c6444", make_aircraft("3c6444", is_military=True))

    body = (await app_client.get("/api/aircraft/3C6444")).json()

    assert body["icao24"] == "3c6444"
    assert body["is_military"] is True


async def test_the_civil_store_wins_when_an_address_is_in_both(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    app_state.aircraft.upsert("3c6444", make_aircraft("3c6444", callsign="CIVIL"))
    app_state.military.upsert("3c6444", make_aircraft("3c6444", callsign="MIL"))

    assert (await app_client.get("/api/aircraft/3c6444")).json()["callsign"] == "CIVIL"


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

    assert body["layers"] == {"aircraft": 2, "military": 1, "vessels": 0, "satellites": 0}
    assert {"adsb.lol/point", "adsb.lol/mil"} <= {feed["source"] for feed in body["feeds"]}


async def test_layers_reports_zero_counts_on_a_cold_start(
    app_client: httpx.AsyncClient,
) -> None:
    body = (await app_client.get("/api/layers")).json()

    assert body["layers"] == {"aircraft": 0, "military": 0, "vessels": 0, "satellites": 0}
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
        "/api/satellites",
        "/api/satellites/elements",
        "/api/layers",
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
    app_state.celestrak._cache["stations"] = _CachedGroup(
        fetched_at=REFERENCE_TIME, satellites=(make_satellite(),)
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
    }
    assert providers["aishub"]["records"] == 1
    assert providers["aishub"]["exclusive"] == 0
    assert providers["aisstream"]["error"] == "SourceError: connection closed"
    assert providers["aisstream"]["records"] == 0


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


async def test_capabilities_reports_satellites_unavailable_until_celestrak_answers(
    app_client: httpx.AsyncClient,
) -> None:
    """Keyless, so availability is a runtime fact rather than a credential check."""
    layers = {
        entry["layer"]: entry
        for entry in (await app_client.get("/api/capabilities")).json()["layers"]
    }

    assert layers["satellites"]["available"] is False
    assert layers["satellites"]["reason"] == "CelesTrak has not been queried yet"


async def test_capabilities_reports_satellites_available_once_elements_are_cached(
    app_client: httpx.AsyncClient, app_state: AppState
) -> None:
    app_state.celestrak._cache["stations"] = _CachedGroup(
        fetched_at=REFERENCE_TIME, satellites=(make_satellite(),)
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
    assert "AISHub" in by_source
    assert "aisstream.io" in by_source
