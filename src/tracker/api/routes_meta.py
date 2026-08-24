"""Health, capability and attribution endpoints.

``/api/capabilities`` is what lets the frontend degrade honestly. Rather than the browser
guessing which layers exist, it asks, and the server answers based on which credentials
are actually configured. A layer with no key renders as unavailable with the reason,
instead of as an empty layer that looks like a bug.
"""

from collections.abc import Mapping
from datetime import datetime
from typing import Annotated, Final

from fastapi import APIRouter, Query

from tracker.api import routes_media
from tracker.api.routes_entities import CITY_LAYER, TRANSIT_LAYER
from tracker.api.state import AppState, StateDep, aircraft_provider_gate
from tracker.config import Settings
from tracker.contracts import person
from tracker.contracts.base import StrictModel
from tracker.contracts.messages import FeedHealth
from tracker.services.search import DEFAULT_LIMIT, SearchResponse
from tracker.services.suppression import Suppression
from tracker.sources import adsb, aishub, aisstream, geonames, gtfsrt, sec


class CreditedOperatorEntry(StrictModel):
    """One data owner inside a grouped credit, with the terms binding that owner alone."""

    name: str
    url: str


class AttributionEntry(StrictModel):
    """One licence credit the UI is required to display.

    **A row is compliant, not a field.** 183 transit credits are served as 8 rows, and that
    collapse is only honest because a row names every owner in ``operators``, links the terms
    binding each of them, and carries in ``as_of`` the date Etalab 2.0 demands. ``text`` is the
    headline sentence; on its own it discharges the single-source rows and not the grouped
    ones, because no static string can carry a per-request date.
    """

    source: str
    text: str
    url: str
    licence: str
    operators: tuple[CreditedOperatorEntry, ...] = ()
    as_of: datetime | None = None


class LayerCapability(StrictModel):
    """Whether one layer can run, and why not when it cannot.

    A merged layer also names its gated providers, as ``vessels/aishub`` and
    ``vessels/aisstream``. The layer itself stays available because its keyless providers
    carry it, and the entry for the gated provider says what is missing. Without that split
    a vessel layer serving Baltic ships would read as entirely off.
    """

    layer: str
    available: bool
    reason: str | None = None


class Capabilities(StrictModel):
    """What this deployment can actually do, given its configuration.

    No Cesium ion token, and there is nothing here for one to go in. The globe is built
    from keyless imagery served through us, Cesium's own library and assets come from our
    origin, and the token Cesium 1.144 bundles is blanked in the browser
    (``frontend/src/globe/viewer.ts``). A field here would be a field asking for a key.
    """

    layers: tuple[LayerCapability, ...]
    attribution: tuple[AttributionEntry, ...]

    media_types: tuple[str, ...] = ()
    """What the media proxy will serve, so a client does not have to guess.

    Not a row in ``layers``, because the proxy is not a layer and would sit among things a
    viewer can switch on. Not on ``/api/health`` either, because health is about what is
    working now and this never changes at runtime. A client reads capabilities once at boot,
    which is exactly when it wants to know this.

    SVG is deliberately absent and will stay absent: an SVG is a document a browser runs script
    from, and serving one from our own origin would put a provider's markup inside our security
    context. Commons holds a great many.
    """

    suppressions: tuple[Suppression, ...] = ()
    """Every suppression under ADR 008, with its reason and when it happened.

    **This is how "the suppression shows in the product with its reason" is satisfied**, and it
    carries no identity of any kind. A ``Suppression`` is a reason and a timestamp, so the
    product can say a person record was removed on request without being able to say whose,
    which is the whole design of the store rather than an omission here.
    """


class Health(StrictModel):
    """Liveness plus per-feed health."""

    status: str
    feeds: tuple[FeedHealth, ...]
    connected_clients: int


router = APIRouter(prefix="/api", tags=["meta"])

SEARCH_LIMIT_MAX: Final = 25
"""Hits per group one request may ask for.

A grouped typeahead shows a handful per group, and the cap is what stops a caller turning
search into a bulk export of every live entity by asking for a limit of a million.
"""

SOCIAL_SCOPE_REASON: Final = (
    "Posts near one point, not worldwide: 10km radius, 500 files per provider."
)
"""What the social layer answers, since it is bounded rather than gated.

The layer is keyless and works, so this is scope rather than a failure, the same shape the
transit row uses. It is worth a viewer's attention because "no posts here" and "you have not
asked about anywhere" look identical on a map, and because both numbers are the providers' own
caps: Wikimedia Commons geosearch takes a radius of at most 10km and returns at most 500 files
per request. Before this row existed the social layer was the only live layer that could never
report itself bounded, and its limits reached a viewer only as a transient notice.
"""

CITIES_PENDING_REASON: Final = f"the weekly {geonames.SOURCE_NAME} city dump has not been read yet"
"""Why the city layer is off before the first refresh has finished.

Not a missing credential: GeoNames is keyless, so availability here is a runtime fact like
CelesTrak's, and the honest answer before the file has been read is that there are no cities
rather than that the layer is broken. A refresh that failed reports its own reason instead.
"""


def _city_capability(state: AppState) -> LayerCapability:
    """Whether the gazetteer holds anything, and why not when it does not.

    Read off the index rather than off configuration, because there is nothing to configure:
    the dump is keyless and the only reasons to have no cities are that the refresh has not
    run yet or that it failed with nothing on disk to fall back on.

    A refresh that failed while a disk copy was still servable is deliberately **not**
    unavailable here. Cities do not move, so a week-old gazetteer answers correctly, and the
    failure surfaces as the ``error`` on the layer's row in ``/api/layers`` instead of hiding
    a working layer behind a banner.
    """
    if state.cities:
        return LayerCapability(layer=CITY_LAYER, available=True)
    return LayerCapability(
        layer=CITY_LAYER,
        available=False,
        reason=state.geonames.last_error or CITIES_PENDING_REASON,
    )


def _ownership_reason(state: AppState) -> str | None:
    """Why the ownership layer is degraded, or ``None`` while it is working.

    **This reports the register and nothing else.** The filings are a separate condition with
    their own row, because they are gated on configuration while this is a runtime fact, and
    conflating the two is what switched the register off for want of a contact address the
    register never needed.
    """
    if state.faa.index is None:
        return state.faa.last_error or "Aircraft register has not loaded yet."
    return state.ownership_error


def _provider_capability(settings: Settings, provider: adsb.AdsbProvider) -> LayerCapability:
    """One union provider's capability row: available, or why not.

    Only providers with something standing in their way get a row. adsb.lol is keyless and
    open, so it has no gate and the layer's own entry is the whole story for it.
    """
    gate = aircraft_provider_gate(settings, provider)
    return LayerCapability(layer=f"aircraft/{provider.name}", available=gate is None, reason=gate)


@router.get("/health")
async def health(state: StateDep) -> Health:
    """Liveness and upstream feed health.

    Reports ``ok`` whenever the process is serving, even with every feed down, because
    this is a liveness probe rather than a data-quality judgement. Feed trouble is
    visible in ``feeds`` and is what the UI banners read.
    """
    return Health(
        status="ok",
        feeds=state.pollers.health(),
        connected_clients=state.hub.connection_count,
    )


@router.get("/capabilities")
async def capabilities(state: StateDep) -> Capabilities:
    """Which layers this deployment can serve, and the attributions it must display.

    The Cesium ion token is returned to the browser deliberately: it is a client-side
    token by design, scoped to the assets it can stream, unlike the feed keys which never
    leave the server.
    """
    settings = state.settings
    layers = (
        # Available with no credential at all: adsb.lol is keyless and carries the layer.
        # The two unfiltered providers ADR 010's coverage argument rests on are reported
        # separately with their reasons, so "the aircraft layer works" and "the aircraft
        # layer sees the aircraft a wealth profile is about" stay different statements.
        LayerCapability(layer="aircraft", available=True),
        # Configured, not answering: this reads the credential, while /api/layers reads the
        # last cycle. ADR 010 needs both, because a provider that was never configured is a
        # different sentence from one that dropped out.
        *(
            _provider_capability(settings, provider)
            for provider in adsb.UNION_PROVIDERS
            if provider.gate_reason is not None
        ),
        LayerCapability(layer="military", available=True),
        # Available with no credential at all: Fintraffic Digitraffic is keyless. The two
        # gated providers add coverage and are reported separately, so an unconfigured one
        # never reads as an empty layer. Plan phase 2 acceptance 9.
        LayerCapability(layer="vessels", available=True),
        # Available rather than gated: every one of the 258 feeds is keyless. What the reason
        # carries is the coverage, because "transit" invites an assumption of worldwide and
        # the honest answer is 17 countries. 184 catalogue feeds were excluded for having no
        # licence recorded anywhere and 7 more for sitting behind an acceptance agreement,
        # which is this project's own drop-unlicensed rule rather than a judgement call.
        LayerCapability(
            layer="transit",
            available=True,
            reason=gtfsrt.COVERAGE_REASON,
        ),
        # Available and bounded, the same shape as the transit row above. The layer is keyless
        # and works; what a viewer needs to know is that it answers about a point rather than
        # about the globe, because "no posts here" and "you have not asked about anywhere" look
        # identical on a map. Both figures are the providers' own caps, not ours.
        LayerCapability(
            layer="social",
            available=True,
            reason=SOCIAL_SCOPE_REASON,
        ),
        LayerCapability(
            layer="vessels/aisstream",
            available=settings.aisstream_available,
            reason=None if settings.aisstream_available else _vessel_coverage_reason(state),
        ),
        LayerCapability(
            layer="vessels/aishub",
            available=settings.aishub_available,
            reason=None if settings.aishub_available else aishub.NO_USERNAME_REASON,
        ),
        # Keyless, so availability is a runtime fact from the client rather than a
        # credential check: a feed that has never served an element set is unavailable with
        # the reason, not healthy and empty.
        LayerCapability(
            layer="satellites",
            available=state.celestrak.unavailable_reason is None,
            reason=state.celestrak.unavailable_reason,
        ),
        # No cameras row, and it is the buildings row's lesson applied a second time. It used
        # to read "Set TRACKER_WINDY_API_KEY or TRACKER_TFL_APP_KEY to enable public cameras",
        # which was wrong three ways at once: there is no camera adapter anywhere in the tree so
        # neither key would enable anything, TfL JamCams are verified as needing no key at all,
        # and New York 511 is keyless too. A row asking for two credentials to unlock a layer
        # that does not exist, from providers that do not require them, is worse than no row.
        # The opportunity is real and it is recorded in docs/status.md where an unbuilt layer
        # belongs, rather than on a rail a viewer reads as a thing they could switch on.
        # No buildings row. It used to sit here reading "Set TRACKER_CESIUM_ION_TOKEN to
        # stream 3D buildings", which is the product asking the user for the one key the
        # project has ruled out, for a layer that has no keyless implementation behind it
        # either: Cesium OSM Buildings is an ion asset, the two keyless 3D Tiles sets found
        # are Switzerland only, and the Overpass route is a megabyte of JSON per square
        # kilometre with no height tag on 62 per cent of the ways. A permanently
        # unavailable feature asking for a credential is worse than no feature.
        # Keyless and local, so availability is a runtime fact rather than a credential
        # check, the same as satellites. The gazetteer is what keeps Nominatim off the hot
        # path, so a city layer that is off is the reason a search reaches the geocoder.
        _city_capability(state),
        # The ownership spine: a named officer from a primary filing, the company, and its
        # aircraft. Gated on a contact address rather than on a key, and naming the variable
        # is right here for the same reason the places row does it: the SEC returns an
        # "Undeclared Automated Tool" error without one, so setting it enables the layer
        # rather than asking the viewer for a credential this project has ruled out.
        # Keyless and local once the register is down, so availability is a runtime fact
        # rather than a credential check, the same as satellites and cities. The register is
        # fetched through cloudscraper because the FAA's CDN answers 403 to any descriptive
        # User-Agent, and a bot filter is not a declared-client requirement.
        LayerCapability(
            layer="ownership",
            available=state.faa.index is not None,
            reason=_ownership_reason(state),
        ),
        # The half that is gated, reported separately so an unset contact address reads as
        # missing officers rather than as a missing layer. Same shape as the vessels row,
        # which is available while naming two providers that are not.
        LayerCapability(
            layer="ownership/officers",
            available=settings.filings_available,
            reason=None if settings.filings_available else sec.UNAVAILABLE_REASON,
        ),
        # Permanently unavailable, and saying so is the point. A profile built from public
        # filings carries five filled fields and eleven empty ones, and a viewer reads an
        # empty wealth tier as a bug unless the product says why it is empty. This is not the
        # buildings row: it asks for nothing, it reports a fact about what public data holds.
        LayerCapability(
            layer="ownership/wealth-tier",
            available=False,
            reason=person.WEALTH_TIER_REASON,
        ),
        LayerCapability(
            layer="places",
            available=settings.osm_services_available,
            reason=None
            if settings.osm_services_available
            else "Set TRACKER_CONTACT_EMAIL. Nominatim and Overpass require contact "
            "details in the User-Agent under their usage policies.",
        ),
    )
    return Capabilities(
        layers=layers,
        attribution=_attribution_entries(state, layers),
        media_types=tuple(routes_media.accepted_types()),
        suppressions=state.suppression.suppressions(),
    )


def _vessel_coverage_reason(state: AppState) -> str:
    """What the vessel layer covers, counted rather than described.

    **Derived because the described version went stale in a day.** It read "Ships shown for
    Northern Europe only" until 2026-08-24, by which time the Seaway feed had put 26.9% of the
    layer on the Great Lakes and the St Lawrence, and the rail was showing that sentence
    directly above a provider line reading ``seaway only: 1,624``. A viewer looking at Lake Erie
    was told there was no coverage there while counting the ships.

    So this names no region. It counts the providers that actually reported, which is the same
    data the provider lines beneath it are built from, so the two cannot contradict each other
    again. Adding a fifth authority changes the number without anyone having to remember this
    string exists.

    The claim that survives either way is about what is **absent**: no worldwide AIS feed is
    available keylessly. That only stops being true on the day this row disappears.
    """
    union = state.vessel_union
    reporting = len(union.reporting) if union is not None else 0
    if reporting == 0:
        return aisstream.UNAVAILABLE_REASON
    feeds = "feed" if reporting == 1 else "feeds"
    return (
        f"No worldwide AIS feed is available. Coverage is the {reporting} regional "
        f"{feeds} reporting."
    )


def _attribution_entries(
    state: AppState, layers: tuple[LayerCapability, ...]
) -> tuple[AttributionEntry, ...]:
    """Every credit this deployment owes for a source that is actually serving.

    **A credit is a statement in the present tense, and four of them were false.** ADS-B
    Exchange, airplanes.live, aisstream.io and AISHub are gated, reported ``available: false``
    in this same payload, and appeared in no provider tally, while their credits said we were
    using them. ADS-B Exchange's asserted "Unfiltered aircraft data from ADS-B Exchange" beside
    a licence field saying redistribution to a browser is prohibited: a provenance panel
    confessing to a breach we are not committing.

    They are filtered rather than deleted, because a credit exists so that a source cannot ship
    uncredited and that has to keep working. The gate is the capability row the credit names, so
    there is one computation of "can this serve" rather than two that can drift, and the credit
    reappears by itself the day the source does.
    """
    available = {layer.layer: layer.available for layer in layers}
    latest = _latest_transit_update(state)
    return tuple(
        AttributionEntry(
            source=a.source,
            text=a.text,
            url=a.url,
            licence=a.licence,
            operators=tuple(CreditedOperatorEntry(name=o.name, url=o.url) for o in a.operators),
            # Keyed on the layer as well as the licence, because licence names are not
            # unique across sources: adsb.lol, Nominatim and 46 transit feeds are all
            # "ODbL 1.0", and matching on licence alone dated the aircraft feed and the
            # geocoder to a French bus's last report. Measured live 2026-08-24.
            as_of=a.as_of or (latest.get(a.licence) if a.layer == TRANSIT_LAYER else None),
        )
        for a in state.attribution
        if a.requires is None or available.get(a.requires, False)
    )


def _latest_transit_update(state: AppState) -> Mapping[str, datetime]:
    """The freshest observation currently held, per licence, for credits that need a date.

    **Etalab 2.0 requires the date of the last update of the information reused**, not merely
    the producer's name: "sa source (a minima le nom du Concedant) et la date de la derniere
    mise a jour de l'Information reutilisee". 101 of the 258 transit feeds are under Etalab,
    and Bizkaia's CTB states the same in its own terms, so a credit list carrying no date does
    not satisfy the largest block in this layer.

    Resolved per request rather than baked in when the registry is read, and that is the whole
    reason it is computed at all: the licence asks about the information *being reused*, which
    is what is on screen now. A build-time constant would describe when the registry was
    compiled and would be wrong the moment the first bus moved.

    One pass over the transit store, keyed on the licence every record already carries. A
    licence holding nothing gets no entry and its credit then carries no date, which is correct
    rather than a gap: nothing is being reused, so there is nothing to date.
    """
    latest: dict[str, datetime] = {}
    for vehicle in state.transit.snapshot():
        held = latest.get(vehicle.licence)
        if held is None or vehicle.observed_at > held:
            latest[vehicle.licence] = vehicle.observed_at
    return latest


@router.get("/search")
async def search(
    state: StateDep,
    q: Annotated[str, Query(min_length=1, max_length=200)],
    limit: Annotated[int, Query(ge=1, le=SEARCH_LIMIT_MAX)] = DEFAULT_LIMIT,
) -> SearchResponse:
    """Resolve one query against everything the server holds, grouped and ranked.

    A callsign, a registration, an ICAO address, a vessel name, an MMSI, an IMO number, a
    satellite name, a NORAD catalogue number, a city, or an address: one field for all of it,
    because the search box is the only navigation this globe has.

    Local first, and almost always local only. Live entities are scanned in the stores the
    WebSocket already serves and cities come from the in-process gazetteer, so a hit costs no
    network at all. Nominatim is consulted only when every local group came back empty **and
    the gazetteer holds something**, which is what keeps a typeahead inside a usage policy that
    names systematic querying as unacceptable use. Before the weekly download lands there is
    nothing local to have missed, so the cities group comes back carrying that reason instead
    and no query leaves the process.

    A group with no hits and no reason was asked and found nothing. A group carrying a reason
    could not be asked, which is the same rule ``/api/capabilities`` follows for a missing key.
    """
    return await state.search_service().search(q, limit=limit)
