"""Shared application state and the dependency accessors routers use to reach it.

Everything mutable the app owns lives on one object attached to ``app.state``. Routers
reach it through FastAPI dependencies rather than importing a module-level singleton, so
a test can build an app with a different HTTP client or a frozen clock and nothing has to
know.
"""

from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from typing import Annotated

import httpx
from fastapi import Depends, Request

from tracker.cache import DiskCache
from tracker.config import Settings
from tracker.contracts.aircraft import Aircraft
from tracker.contracts.city import City
from tracker.contracts.geo import BoundingBox
from tracker.contracts.satellite import Satellite
from tracker.contracts.transit import TransitVehicle
from tracker.contracts.vessel import Vessel
from tracker.services.enrich import Enricher
from tracker.services.gazetteer import CityIndex
from tracker.services.hub import Hub
from tracker.services.poller import PollerGroup
from tracker.services.search import SearchService
from tracker.services.social import SocialClients
from tracker.services.spine import CompanyIndex, SpineSummary
from tracker.services.store import EntityStore
from tracker.services.suppression import RemovalService, SuppressionStore
from tracker.services.union import ProviderTally, UnionResult
from tracker.sources.adsb import AdsbProvider
from tracker.sources.adsbdb import AircraftRegistration
from tracker.sources.aisstream import AisStreamClient
from tracker.sources.celestrak import CelestrakClient
from tracker.sources.commons import CommonsClient
from tracker.sources.faa_registry import FaaRegistry
from tracker.sources.geonames import SOURCE_NAME as GEONAMES_SOURCE
from tracker.sources.geonames import GeonamesDump
from tracker.sources.gtfsrt import SOURCE_NAME as GTFSRT_SOURCE
from tracker.sources.gtfsrt import GtfsRtClient, SweepResult
from tracker.sources.mastodon import MastodonClient, exact_city_resolver
from tracker.sources.nominatim import NominatimClient
from tracker.sources.sec import SecClient


@dataclass(slots=True)
class AppState:
    """Everything the running application owns.

    One HTTP client for the whole process: connection pooling across feeds is the single
    biggest win available here, and building a client per request would leak sockets
    under load.
    """

    settings: Settings
    http: httpx.AsyncClient
    hub: Hub
    pollers: PollerGroup
    aircraft: EntityStore[Aircraft]
    military: EntityStore[Aircraft]
    vessels: EntityStore[Vessel]
    transit: EntityStore[TransitVehicle]
    """Buses and trains from the GTFS-Realtime registry.

    Keyed on ``(feed_id, entity_id)`` rather than on the vehicle's own id, because 20% of
    id-carrying vehicles share an id with another agency: two buses in different countries
    would otherwise collapse into one record. See ``sources/gtfsrt.merge_key``.
    """

    satellites: EntityStore[Satellite]
    celestrak: CelestrakClient
    """The satellite feed, held rather than rebuilt because it owns the two-hour floor.

    ``/api/satellites/elements`` reads its cache and ``/api/capabilities`` reads its
    unavailable reason, so the layer's availability is a runtime fact from the client
    rather than a credential check: CelesTrak is keyless and there is nothing to check.
    """

    registry: Enricher[Aircraft, AircraftRegistration]
    """The aircraft-to-owner join.

    Held rather than rebuilt per request because the adsbdb lookup underneath it owns the
    cache and the request budget, and both only mean anything if one instance lives for the
    process. Rebuilding it per card open would re-fetch every owner and spend the budget.

    Demand-driven, so nothing polls through it: a card asks about one aircraft and the join
    happens then. A sweep over a live layer is thousands of records a cycle against a budget
    of 256 requests a minute, which would be throttled inside the first poll.

    Not optional. A state without it would give ``/api/aircraft/{icao24}`` a second code path
    that never runs in the product, and an untaken branch on the card route is where an
    ownership join quietly stops happening.
    """

    geonames: GeonamesDump
    """The weekly city download, held because it owns the disk cache and the weekly floor.

    Not optional, for the same reason ``registry`` is not: GeoNames is keyless, so a state
    without it would only ever exist in a test and every city read would carry a branch the
    product never takes.

    Two things are read off it rather than kept a second time. ``last_error`` is the layer's
    error on ``/api/layers`` and its reason on ``/api/capabilities`` when there are no cities
    at all, so a refresh that failed while a week-old copy still answers reads as a working
    layer with a warning rather than a dead one. ``refreshed_at`` is when the copy on disk was
    last confirmed against the provider, which is what the layer's ``last_success_at``
    reports: inside the week a refresh reads our own disk and asking GeoNames nothing is not
    a provider success.
    """

    cache: DiskCache
    """The one disk-backed cache, shared by every rate guard and response cache.

    Held on state rather than reached for per call, because the whole point is that there is
    one file for the project. Nothing personal goes in it: the adsbdb owner cache is
    deliberately in memory only, for the reasons on ``AdsbdbLookup``.

    Not optional, for the same reason ``registry`` and ``geonames`` are not: a state without
    it would give every guard a second code path that the product never takes, and an untaken
    branch on a rate guard is where a provider quietly starts getting hammered.
    """

    faa: FaaRegistry
    """The US aircraft register: the daily conditional download and the index built from it.

    Not optional, for the same reason ``geonames`` is not. It is keyless through
    ``cloudscraper`` and it is the only side of the ownership spine that carries assets, so a
    state without it would put a branch on every ownership read that the product never takes.

    **The freshness check is a conditional GET and never a HEAD.** Measured against the real
    host: a HEAD answers HTTP 503 with a 3KB body and a decoy ``Last-Modified`` of 2013, while
    a GET returns the file. The adapter owns that; this holds the object.
    """

    sec: SecClient
    """EDGAR, for the people half of the spine. Caches nothing, deliberately.

    Not optional for the same reason as the others, and unlike them it holds no state at all
    beyond its own rate floor: a cache of named people is a cache a removal under ADR 008 has
    to reach, so there is not one.
    """

    suppression: SuppressionStore
    """Who has been suppressed under ADR 008, keyed so the record cannot be read back.

    Not optional, for the same reason ``cache`` is not: a state without it would give every
    candidate-generation path a second branch where nothing is excluded, and an untaken branch
    on a suppression check is the one place an untaken branch is unacceptable.

    The key is an HMAC rather than a plain digest, which matters given what this project holds.
    A ``person_id`` is ``sec-{cik}``, a CIK is ten digits, and EDGAR publishes all 800,000 of
    them, so an unkeyed digest of one is reversible in seconds by anyone who obtains the file.
    """

    removals: RemovalService
    """The removal path: suppress, then sweep every cache that could still serve a name.

    ADR 008 makes removal immediate, with no queue and no human step, so this is a service
    rather than a request. :meth:`RemovalService.reaches` names the caches it actually sweeps,
    which is the honest answer to "did the removal work" and is deliberately not a claim about
    caches it cannot reach.
    """

    social: SocialClients = field(init=False)
    """The social layer's two clients and the last derived timeline page it served.

    **Built here rather than passed in, and that is the point.** It used to be a module-level
    singleton inside ``routes_social``, created lazily on the first request, which served fine
    and broke the removal: a copy constructed in ``build_state`` was a different object from the
    one the route answered out of, so a removal swept a page nobody read and reported reaching a
    cache it had never touched. Constructing it here makes one object per state by definition,
    so there is no wiring step that can be forgotten and no second copy to get out of step.

    Not optional, for the same reason ``registry`` and ``cache`` are not, and more sharply: this
    holds a Mastodon author handle and a Commons licence author, so it holds names of real
    people. A state where it were absent would give the removal path a branch in which nothing
    is swept, and an untaken branch on a removal is where a name survives being deleted.

    It opens no socket to build. Both clients only store the shared HTTP client, so this costs
    two objects and keeps ``build_state`` free of I/O like everything else here.
    """

    attribution: tuple["Attribution", ...] = field(default_factory=tuple)
    company_index: CompanyIndex | None = None
    """Every SEC-listed company, indexed for matching. ``None`` before the first refresh.

    796,148 bytes, and companies rather than people, so it is cached on disk between restarts.
    """

    ownership: SpineSummary | None = None
    """What the last ownership pass joined, counted by outcome. ``None`` before the first pass.

    ``asserted`` and ``possible`` are kept apart here rather than summed, because ADR 011
    excludes a possible match from every aggregate and a single number would make that
    impossible downstream.
    """

    ownership_error: str | None = None
    """Why the last ownership refresh failed, or ``None``. Served as the layer's reason."""

    city_index: CityIndex = field(default_factory=lambda: CityIndex(()))
    """The searchable gazetteer, replaced whole by each refresh.

    **Not an ``EntityStore`` and not registered with the hub.** Cities do not move and never
    expire, so a time-to-live store would drop London ninety seconds after start-up and the
    thing writing London back would be a poller against a file that changes once a week. It
    also cannot make an HTTP request: it holds no client and takes no URL, which is what
    makes "a city lookup issues zero requests" a property of the type rather than a rule.

    Empty until the refresh job has run once, which is why it starts as an empty index rather
    than ``None``: an empty gazetteer answers nothing, and that is the honest answer before
    the dump has been read.
    """

    cities: tuple[City, ...] = ()
    """The same rows the index holds, ordered by population descending.

    Held alongside the index rather than derived from it because the index answers by name
    and by id and does not iterate, and the layer read needs a bounding box filter and the
    biggest cities first. It is a tuple of references to the same frozen records, so the cost
    is 34,072 pointers rather than a second copy of the file.
    """

    city_tally: ProviderTally = field(
        default_factory=lambda: ProviderTally(provider=GEONAMES_SOURCE)
    )
    """Refresh attempts, failures and dropped rows since start-up, for ``/api/layers``.

    The same type the merged layers use, because the question is the same one: a refresh that
    has failed every week since start-up must not look like one that has never been asked.
    ``drops`` is where the 27 dead places the adapter refuses are counted somewhere a person
    can read them.
    """

    nominatim: NominatimClient | None = None
    """The geocoder behind the places group, or ``None`` with no contact email configured.

    Held for the process because it owns the query cache the OSMF usage policy requires and
    the one-request-per-second floor, and both mean nothing on an instance built per request.
    ``None`` is a configured-but-unavailable provider exactly like a missing key: the search
    reports the places group unavailable rather than calling the provider anonymously.
    """

    viewport: BoundingBox | None = None
    """The area the most recent client asked for.

    One viewport for the whole server, not one per client. With a handful of clients that
    is the right trade: the aircraft feed is queried once for the union of interest rather
    than once per browser, which is what keeps us inside a free provider's tolerance. If
    this ever serves many simultaneous users it becomes a merged set of boxes, and the
    poller reading it is the only thing that changes.
    """

    aircraft_union: UnionResult[Aircraft] | None = None
    """What the last aircraft cycle merged, kept for reporting rather than for rendering.

    Same job as :attr:`vessel_union` one layer over: ADR 010's provider-attributable count
    and its name-the-missing-provider rule are both derived from this, so ``/api/layers``
    reports what actually came back. One cycle only, replaced by the next.
    """

    aircraft_providers: dict[str, ProviderTally] = field(default_factory=dict)
    """Running per-provider counts for the aircraft union, across every cycle so far.

    One poller serves the whole union, so its own failure counters never move when a single
    provider drops out. These are what tell a provider that has failed since start-up from
    one that failed the last cycle, and they carry the drop counts the adapter measured.
    """

    military_union: UnionResult[Aircraft] | None = None
    """What the last military cycle merged, so its drop count reaches ``/api/layers``.

    One provider rather than three, because ``/v2/mil`` is a single worldwide sweep and
    ADR 010's union is about coverage the military endpoint does not have. It goes through the
    same merge anyway so it gets the same reporting: 81 of the 391 records in the recorded
    ``/v2/mil`` capture carry no position and are dropped, which is the highest drop rate of
    any layer here, and before this it reached the log and stopped there.
    """

    military_providers: dict[str, ProviderTally] = field(default_factory=dict)
    """Running counts for the military sweep, kept apart from :attr:`aircraft_providers`.

    Its own dict because both layers poll adsb.lol, so one dict would add the military
    sweep's drops to the union's and neither number would mean anything.
    """

    aisstream: AisStreamClient | None = None
    transit_client: GtfsRtClient | None = None
    """The GTFS-Realtime client, held so ``/api/capabilities`` can read the registry it loaded.

    Optional for the same reason the stream is: a state built for a test that makes no
    upstream call has no need of one.
    """

    """The global vessel subscription, or ``None`` when no aisstream.io key is configured.

    A supervised WebSocket rather than a poller, so the lifespan starts and stops it
    directly. Absent it, the vessel layer runs on the keyless providers and reports
    aisstream unavailable, exactly like any other missing key.
    """

    vessel_union: UnionResult[Vessel] | None = None
    """What the last vessel cycle merged, kept for reporting rather than for rendering.

    ADR 010 asks for a provider-attributable count and for a degraded layer to name which
    provider is missing. Both are derived from this, so ``/api/layers`` reports what
    actually came back instead of a summary somebody has to remember to update.

    One cycle only. It is replaced by the next one, which is why the cumulative counts live
    in :attr:`vessel_providers` instead.
    """

    vessel_providers: dict[str, ProviderTally] = field(default_factory=dict)
    transit_sweep: "SweepResult | None" = None
    """What the last GTFS-Realtime pass did, kept for reporting rather than for rendering.

    Same job as :attr:`vessel_union` one layer over. A sweep's interesting numbers are how
    many feeds answered, how many said "not modified" and how many could not be read, and none
    of those survive in the store: the store holds vehicles. ``/api/layers`` reports them off
    this, so "258 of 258 polled, zero failures" is measured rather than asserted.

    ``unchanged`` is the one worth naming here. A host answering **304** has confirmed its
    held records still stand, which is not the same as a feed returning nothing, and a reader
    that collapsed the two would see a healthy conditional request as an empty feed.
    """

    transit_refusals: Counter[str] = field(default_factory=Counter)
    """How many records the transit adapter refused since start-up, keyed on the reason.

    **A reason is not a provider, and this used to be a ``dict[str, ProviderTally]`` that
    pretended otherwise.** Feeding reasons through the provider shape put them on
    ``/api/layers`` as rows with ``records: 0`` and ``exclusive: 0``, because
    ``ProviderCoverage`` answers "how many records did only this provider see" and a reason has
    no records and no exclusivity. The layer rail then faithfully rendered "report older than 5
    minutes only: 0", which is not a sentence about anything. A plain count keyed on the reason
    is the whole of what this is.

    Not one tally per feed either: 258 feeds would make 258 rows of which almost all read zero.
    The interesting question is *why* records were refused, because a staleness problem and a
    null-island problem have different fixes.
    """

    transit_tally: ProviderTally = field(
        default_factory=lambda: ProviderTally(provider=GTFSRT_SOURCE)
    )
    """The transit adapter's own running counts, one provider, counted per sweep.

    Separate from :attr:`transit_refusals` because they answer different questions and sharing
    one dict is what let feed counts leak into poll fields: ``empty_polls`` once read 175
    against 83 polls, which cannot both be true of one provider and was in fact 175 feeds
    skipped inside a host floor out of a 258-feed registry. **A poll here is one sweep**, so
    ``polls`` counts passes rather than feeds, and the per-pass feed detail lives on
    :attr:`transit_sweep` where it describes feeds and says so.
    """

    """Running per-provider counts for the vessel union, across every cycle so far.

    The union has one poller for three providers, so the poller's own failure counters never
    move when a single provider drops out. Without these, an AISHub answering an empty 200
    every cycle for a week is indistinguishable from one that did it once, which is the
    counting half of plan phase 2 acceptance 8.
    """

    def __post_init__(self) -> None:
        """Build the state's own clients, which is the social pair and nothing else.

        The gazetteer is deliberately reached through :meth:`city_search` rather than bound
        here. ``city_index`` is *replaced whole* by each weekly refresh, so passing
        ``self.city_index.search`` would hand the resolver a bound method of the empty index
        this state starts with, and it would keep answering out of that dead object for the life
        of the process: every derived location would fail to resolve and the Mastodon half of
        the layer would go quiet with nothing logged. That is the same trap
        :meth:`search_service` is built per call to avoid.
        """
        self.social = SocialClients(
            commons_client=CommonsClient(self.http),
            mastodon_client=MastodonClient(
                self.http, resolve=exact_city_resolver(self.city_search)
            ),
        )

    def city_search(self, query: str) -> tuple[City, ...]:
        """The gazetteer as it stands now, looked up at call time.

        A one-line delegate rather than handing out ``city_index.search`` directly, because the
        index is replaced whole by each refresh and a bound method of the old one keeps
        answering out of it. Anything that outlives a request holds this instead.
        """
        return self.city_index.search(query)

    def search_service(self) -> SearchService:
        """One query resolver over whatever this deployment currently has wired.

        Built per call rather than held, because the city index is replaced whole by each
        weekly refresh and a held service would keep answering out of the index it was born
        with. Construction is five attribute assignments over objects that already exist, so
        there is nothing to cache: everything with real state behind it, the stores and the
        geocoder's cache and its one-per-second floor, lives for the process and is passed in
        by reference.

        Both aircraft stores go in. The military sweep is a separate store of the same
        contract, so a military aircraft inside the viewport is in both, and the search
        de-duplicates on the ICAO address rather than offering it twice.
        """
        return SearchService(
            aircraft=(self.aircraft, self.military),
            vessels=(self.vessels,),
            satellites=(self.satellites,),
            cities=self.city_index,
            places=self.nominatim,
        )


@dataclass(frozen=True, slots=True)
class CreditedOperator:
    """One data owner inside a grouped credit, with the terms that bind that owner alone.

    Exists because a licence family is not always one set of terms. 41 of the transit feeds
    sit under "operator terms", which is 41 **different** terms pages: a single grouped row
    with one ``url`` would link one operator's terms and misattribute the other 40. Carrying
    the pairs structurally lets one row satisfy 41 obligations, which a comma-joined string
    and a single link cannot.
    """

    name: str
    """The operator as the licence requires it to be named."""

    url: str
    """Where this operator's own terms are published. Empty when the group's licence covers it."""


@dataclass(frozen=True, slots=True)
class Attribution:
    """A licence credit that the UI must display for a data source.

    Served to the frontend rather than hardcoded there, so adding a source cannot
    accidentally ship without its attribution. Several of these licences make
    attribution a condition of use.

    **A row is compliant, not a field.** ``text`` is the headline sentence and it names the
    licence, but it is not on its own enough for every licence here and no wording could be:
    Etalab 2.0 requires the date of the last update, which is resolved per request, and the 41
    operators under bespoke terms each need their own link. A client discharges these licences
    by rendering the row: ``text``, ``url``, ``operators`` and ``as_of`` together. ``operators``
    and ``as_of`` are empty on the ordinary one-source rows, where ``text`` and ``url`` are the
    whole obligation.
    """

    source: str
    text: str
    url: str
    licence: str
    operators: tuple[CreditedOperator, ...] = ()
    """The data owners this one row credits, where it credits more than one.

    Empty on a single-source row. Populated on a grouped row so the menu can name every owner
    and link the terms that bind each of them, rather than naming them in a sentence the
    frontend would have to parse to render.
    """

    requires: str | None = None
    """The capability row that must be available before this credit is served, if any.

    **A credit is a statement in the present tense and four of them were false.** ADS-B
    Exchange, airplanes.live, aisstream.io and AISHub are all gated: the same
    ``/api/capabilities`` payload reported them ``available: false``, none appeared in any
    provider tally, and their credits still said we were using them. The sharpest was ADS-B
    Exchange, whose credit asserted "Unfiltered aircraft data from ADS-B Exchange" beside its
    own licence field reading that redistribution to a browser is prohibited. A provenance
    panel confessing to a breach we are not committing is worse than a missing credit.

    Deleting them is not the fix, because the reason they exist is that a source must not be
    able to ship uncredited, and that property has to survive. So the credit stays and is
    served only while the thing it credits can serve, keyed on the capability row that already
    computes exactly that. A gated source is named by its capability row instead, which states
    the position accurately.

    ``None`` on a credit for a source with nothing standing in its way, which is most of them.
    """

    layer: str | None = None
    """Which layer this credit is owed for, where that has to be known.

    **Not decoration: without it a date meant for one layer lands on another.** Licence names
    are not unique across sources. adsb.lol, Nominatim and 46 of the transit feeds are all
    "ODbL 1.0", so resolving a per-request date by licence alone stamped the aircraft feed's
    credit and the geocoder's credit with a French bus's last observation. Measured live
    2026-08-24: 10 rows carried a date and only 8 of them should have.

    ``None`` on a credit that needs no per-layer resolution, which is every one that carries no
    date.
    """

    as_of: datetime | None = None
    """When the credited information was last updated, where a licence requires the date.

    **Etalab 2.0 requires it and 101 transit feeds are under Etalab.** The French text asks for
    "sa source (a minima le nom du Concédant) **et la date de la dernière mise à jour de
    l'Information réutilisée**", and Bizkaia's CTB says the same in its own terms. A static
    credit list cannot satisfy that, which is why this is a field rather than baked into
    ``text``: it is resolved per request from the freshest record actually held, so it
    describes the data on screen rather than when the registry was compiled.

    ``None`` on every row whose licence asks for no date, and on a grouped row holding nothing,
    where there is no information being reused and so nothing to date.
    """


def aircraft_provider_gate(settings: Settings, provider: AdsbProvider) -> str | None:
    """Why one ADS-B provider is not contributing today, or ``None`` when nothing stops it.

    One implementation, called from two places that would otherwise drift: the union wiring
    decides whether to poll a provider, and ``/api/capabilities`` reports whether it is
    configured. Those have to give the same answer, or the layer rail says a provider is
    available while the poller has quietly left it out.

    Read off the provider row rather than compared against module constants by identity. The
    identity version was fail-open: a new row carrying its own ``gate_reason`` fell through to
    ``return None``, so a Cloudflare-blocked provider reported itself available on
    ``/api/capabilities`` and joined the poll. Here a reason stands unless the row names a
    setting that clears it, which is the direction that fails safe.

    The reason text lives on the provider row in ``sources/adsb.py``, next to the live
    verification that produced it. ``access_setting`` is a name rather than a callable so the
    row stays plain data; a test asserts every name on every row resolves.
    """
    if provider.gate_reason is None:
        return None
    if provider.access_setting is None:
        return provider.gate_reason
    return None if getattr(settings, provider.access_setting) else provider.gate_reason


def get_state(request: Request) -> AppState:
    """The application state attached at startup, as a FastAPI dependency."""
    state: AppState = request.app.state.tracker
    return state


def get_settings_dep(request: Request) -> Settings:
    """Settings read off the application state, as a FastAPI dependency."""
    return get_state(request).settings


StateDep = Annotated[AppState, Depends(get_state)]
SettingsDep = Annotated[Settings, Depends(get_settings_dep)]
