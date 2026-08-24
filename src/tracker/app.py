"""Application factory and lifespan.

A factory rather than a module-level ``app`` object, because tests need to build an
application with an injected HTTP client and no background tasks. The lifespan is where
every long-lived resource is created and, more importantly, torn down: one HTTP client,
the poller group, and the hub's broadcast loop.

Pollers start here, which means they run once per process. Under multiple uvicorn workers
each worker would run its own lifespan and duplicate every upstream request. Until a
cross-process lock exists, this app runs with a single worker, and
``start_background_tasks=False`` is how tests and any future poller-less web tier opt out.
"""

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator, Mapping
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from functools import partial
from typing import TYPE_CHECKING, Final

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from tracker.api import (
    routes_entities,
    routes_media,
    routes_meta,
    routes_removals,
    routes_social,
    routes_ws,
)
from tracker.api.state import AppState, Attribution, CreditedOperator, aircraft_provider_gate
from tracker.cache import DiskCache
from tracker.cache import key as cache_key
from tracker.config import Settings, get_settings
from tracker.contracts.geo import BoundingBox
from tracker.contracts.vessel import Vessel
from tracker.services import search, spine
from tracker.services.enrich import Enricher
from tracker.services.gazetteer import CityIndex
from tracker.services.hub import Hub
from tracker.services.poller import Poller, PollerGroup
from tracker.services.store import EntityStore
from tracker.services.suppression import RemovalService, SuppressionStore
from tracker.services.union import (
    ProviderResult,
    UnionResult,
    count_drops,
    merge_providers,
    record_cycle,
)
from tracker.sources import (
    adsb,
    adsbdb,
    aishub,
    aisstream,
    celestrak,
    faa_registry,
    fintraffic,
    geonames,
    gtfsrt,
    kystdatahuset,
    nominatim,
    seaway,
    sec,
    transpordiamet,
)
from tracker.sources.adsb import AdsbClient
from tracker.sources.base import ParsedRecords, SourceError, describe_exception
from tracker.sources.celestrak import CelestrakClient
from tracker.sources.faa_registry import FaaRegistry
from tracker.sources.geonames import GeonamesDump
from tracker.sources.gtfsrt import merge_key
from tracker.sources.nominatim import NominatimClient

if TYPE_CHECKING:
    from tracker.contracts.aircraft import Aircraft
    from tracker.contracts.city import City
    from tracker.contracts.satellite import Satellite
    from tracker.contracts.transit import TransitVehicle

_log = logging.getLogger(__name__)

AIRCRAFT_LAYER: Final = "aircraft"
"""The layer name the aircraft union serves, used as its poller layer and its error source.

The per-provider cadence floors that used to sit here now live beside the providers they
belong to, in ``sources/adsb.py``, because ADR 010 makes cadence a per-provider question
rather than a per-layer one: adsb.lol tolerates five seconds, airplanes.live states one
request a second, and a metered ADS-B Exchange key tolerates neither and is demand-driven.
``adsb.UNION_MIN_INTERVAL_SECONDS`` is the floor for one cycle, taken from the strictest
provider that actually gets swept.
"""

ADSB_MIL_MIN_INTERVAL_SECONDS = 30.0
"""Hard floor for the worldwide military endpoint, four times the viewport floor.

``/v2/mil`` returns every military aircraft on the planet in one response (391 records,
168KB when measured on 2026-08-19) and adsb.lol throttled it with HTTP 420 on the first
live run of this app. It is a far more expensive call than a viewport query and gets a
correspondingly slower cadence. Military aircraft positions do not become stale in
thirty seconds in any way a user would notice.
"""

VESSEL_UNION_MIN_INTERVAL_SECONDS = max(
    fintraffic.MIN_INTERVAL_SECONDS,
    kystdatahuset.MIN_INTERVAL_SECONDS,
    transpordiamet.MIN_INTERVAL_SECONDS,
    seaway.MIN_INTERVAL_SECONDS,
    aishub.MIN_INTERVAL_SECONDS,
)
"""Hard floor for one vessel cycle, taken from the strictest provider in the union.

One cycle calls every provider, so the floor is the slowest of theirs rather than an
average of them. Fintraffic caches for sixty seconds, AISHub answers an over-frequent
call with an empty body, and Kystdatahuset serves the last ten minutes of positions in one
3.7MB body with no ``ETag``, so every one of them is sixty, and a faster cycle would make
AISHub refuse its own call and the layer read degraded when nothing is wrong. The two added on
2026-08-23 land on the same number for the same reason: neither the Estonian ArcGIS service nor
the Seaway GraphQL endpoint publishes a cap, and both turn their data over in minutes.

It also settles the rate-limit question. A provider that throttles us drops out of the
union for that cycle (ADR 010 names rate limiting as one of those cases) rather than
raising into the poller, and retrying at this floor stays inside both providers' published
caps, so nothing is hammered.
"""

VESSEL_LAYER: Final = "vessels"
TRANSIT_LAYER: Final = "transit"
"""The layer name the vessel union serves, used as its poller layer and its error source."""

NO_ELEMENTS_DETAIL: Final = "no element set cached, so nothing to publish"
"""Why a satellite cycle fails rather than publishing an empty world.

Served on ``/api/health`` as the feed's last error, so a blank satellite layer says why it
is blank instead of reading healthy with a count of zero.
"""

CITY_REFRESH_TASK_NAME: Final = "cities/geonames"

OWNERSHIP_LAYER: Final = "ownership"
OFFICERS_LAYER: Final = "ownership/officers"


OWNERSHIP_REFRESH_TASK_NAME: Final = "ownership/faa-sec"

SEC_INDEX_CACHE_KEY: Final = cache_key("sec", "company-index")
SEC_INDEX_TTL_SECONDS: Final = 7.0 * 24.0 * 60.0 * 60.0
"""A week. The SEC index gains a company at a time and loses one at a time; nothing about a
listed-company name list needs a daily fetch, and 796KB on disk costs nothing."""
"""Name of the weekly city refresh task, for a readable traceback and asyncio debug output.

**A task rather than a ``Poller``, deliberately.** A poller belongs to a feed that publishes
a new picture on a cadence, and it registers a layer with the hub so deltas reach a browser.
Cities do not move: the dump changes about once a week, the whole layer is one file, and the
refresh writes an index rather than a time-to-live store. Wiring it as a poller would need a
``LayerName`` for a layer with no delta channel and a store that expires London, and both
would be wrong in the same direction.
"""

GZIP_MINIMUM_BYTES: Final = 1024
"""Responses smaller than this are sent uncompressed.

A kilobyte, so the small JSON bodies the socket and the health checks return do not pay a
compression pass to save a few hundred bytes.
"""

CITY_RETRY_SECONDS: Final = 300.0
"""How long the city refresh waits after an attempt that indexed nothing.

Five minutes, matching ``Poller``'s own ``MAX_BACKOFF_SECONDS``, because a hand-rolled loop
should not be laxer than the one every polled feed uses. It costs the provider one
conditional request: with no copy on disk there is nothing for the adapter's weekly floor to
measure, and with a copy on disk that will not open the retry never reaches the network at
all. The weekly floor still governs every successful pass.
"""

TTL_MISSED_POLLS = 3.0
"""How many missed polls a vessel or satellite survives before the store drops it.

The aircraft time to live is tuned to a feed that publishes every few seconds. Vessels are
polled every minute and element sets every six hours, so the same ninety seconds would
retire every ship and every satellite between two polls.
"""


def _transit_attributions() -> tuple[Attribution, ...]:
    """Credits for the 258 transit feeds, grouped by licence, mandates kept verbatim.

    **Grouped by licence rather than one row per operator, because that is what the licences
    themselves care about.** 183 distinct credits across six licences would be 183 rows in a
    menu whose whole purpose was to stop a panel covering the globe, and the grouping is not a
    space-saving compromise: three of the six licences want different things said, so a list
    that ignored that would be longer *and* wrong.

    - **ODbL 1.0, 46 feeds.** Requires a notice "reasonably calculated" to make a viewer aware
      both that the content came from the database and that it is available under that licence,
      so naming the operator alone fails it. Each feed's own ``credit`` already carries the
      licence in parentheses, which is why listing those satisfies it.
    - **CC-BY 4.0, 35 feeds.** Creator, copyright notice, licence notice, disclaimer and a URI,
      satisfiable in any reasonable manner. No wording mandated, but the licence link is not
      optional, so the group carries it.
    - **CC0 1.0, 31 feeds.** The affirmer waives attribution outright, so these are courtesy
      rather than obligation and are the only ones a grouping could drop. They are kept, because
      a credit nobody is owed still tells a viewer where the data came from.
    - **Etalab 2.0, 101 feeds, and this group is not yet fully compliant.** The licence requires
      "la date de la dernière mise à jour de l'Information réutilisée", the date of last update,
      not merely the producer's name. A static credit list carries no date. For a live feed the
      natural reading is the observation time, which every record already holds, so the fix is
      a per-record date on the card rather than a longer string here. Recorded as a blocker in
      ``docs/status.md``: this layer must not be publicly displayed until it is met.
    - **Two verbatim mandates get their own rows and a grouping must never touch them.** King
      County Metro requires its sentence "prominently displayed" unless otherwise agreed in
      writing, and the City of Hamilton reserves the right to require removal. Both come
      straight off ``TransitFeed.attribution``.

    Measured 2026-08-23 by reading all 41 bespoke operator terms pages, which also excluded four
    feeds gated behind an agreement no URL pattern advertised.
    """
    by_licence: dict[str, dict[str, str]] = {}
    mandated: list[Attribution] = []
    for feed in gtfsrt.FEEDS:
        if feed.attribution:
            mandated.append(
                Attribution(
                    source=feed.provider,
                    text=feed.attribution,
                    url=feed.licence_url,
                    licence=feed.licence,
                    layer=TRANSIT_LAYER,
                )
            )
            continue
        # Keyed on the operator so one operator with several feeds is credited once, and
        # carrying that operator's own terms URL rather than the group's. The two differ for
        # the 41 operators under "operator terms", which is 38 distinct terms pages: a group
        # with one link would credit one of them and misattribute the rest.
        owners = by_licence.setdefault(feed.licence, {})
        owners.setdefault(feed.provider, feed.licence_url)
    grouped = tuple(
        Attribution(
            source=f"Transit feeds under {licence}",
            text=_group_notice(licence, len(owners)),
            url=_group_licence_url(licence, owners),
            licence=licence,
            operators=tuple(
                CreditedOperator(name=name, url=owners[name]) for name in sorted(owners)
            ),
            layer=TRANSIT_LAYER,
        )
        for licence, owners in sorted(by_licence.items())
    )
    # Verbatim first: one of the two requires prominence and a grouped row must not precede it.
    return tuple(mandated) + grouped


BESPOKE_TERMS_LICENCE: Final = "operator terms"
"""The registry's catch-all, and the one "licence" that is not a licence family.

44 feeds and 41 operators sit under it, across 38 different terms pages. Everything else in
the registry is a named public licence with one canonical text.
"""


def _group_licence_url(licence: str, owners: Mapping[str, str]) -> str:
    """The one URL that describes a whole group's licence, or empty when there is no such thing.

    A named licence family has one canonical text, so the group links it. The registry stores
    a few variants of the same text (``creativecommons.org/licenses/by/4.0/`` beside its
    ``/legalcode`` and ``/deed.ja`` forms, and Etalab's HTML page beside its PDF), and the
    shortest is the canonical deed in every case: a human-readable page rather than a legal
    annex or a download. **This link is not optional under CC-BY 4.0**, which requires a
    licence notice and a URI, so an empty group URL there would be a compliance failure rather
    than a cosmetic gap.

    :data:`BESPOKE_TERMS_LICENCE` is the exception and it is excluded by name rather than by
    counting URLs, because the heuristic and the fact are different things: those 41 operators
    have 38 unrelated terms pages, so no single URL describes the group and picking one would
    state the wrong terms for forty of them. Empty there, and the per-operator URLs on
    :attr:`~tracker.api.state.Attribution.operators` are what a viewer follows instead.
    """
    if licence == BESPOKE_TERMS_LICENCE:
        return ""
    urls = sorted({url for url in owners.values() if url}, key=len)
    return urls[0] if urls else ""


def _group_notice(licence: str, operators: int) -> str:
    """The headline sentence for one licence group, naming the licence and how many owners.

    **Short, and the operators are not in it.** It used to name all of them in prose, which
    made the Etalab sentence **2,024 characters** of comma-separated producers. That is what
    :attr:`~tracker.api.state.Attribution.operators` exists for: the owners are structured
    data, so a menu can list them and link the terms binding each one instead of a client
    having to parse a paragraph.

    **A row is compliant, not a field, and the shortening is what forced that to be said
    plainly.** Naming every producer in ``text`` was never enough on its own anyway: Etalab
    also requires the date of the last update, which is per request and cannot live in a string
    built at import time. So there was no length at which ``text`` alone discharged Etalab, and
    pretending otherwise was the more dangerous version. A client satisfies these licences by
    rendering the row: this sentence, the licence URL, the operators, and ``as_of``.

    The wording is still per licence, because the licences ask for different things:

    - **ODbL 1.0** wants a notice reasonably calculated to convey both that the content came
      from the source *and* that it is available under that licence, so the licence is named
      here rather than left to a neighbouring field. Section 4.3's safe-harbour text is offered
      rather than mandated, so this follows its shape without quoting it.
    - **CC0 1.0** asks for nothing at all, the affirmer having waived attribution, so its
      sentence says so rather than implying a condition that does not exist.
    """
    owners = f"{operators} transit operator" + ("s" if operators != 1 else "")
    if licence == "ODbL 1.0":
        return (
            f"Contains information from {owners}, made available under the "
            f"Open Database License (ODbL) 1.0"
        )
    if licence == "CC0 1.0":
        return f"Transit vehicle positions from {owners}, dedicated to the public domain"
    if licence == BESPOKE_TERMS_LICENCE:
        # "under operator terms" reads as a licence name and is not one. Each of these
        # operators publishes its own terms, which is why the row carries no group URL.
        return f"Transit vehicle positions from {owners}, each under its own published terms"
    return f"Transit vehicle positions from {owners} under {licence}"


ATTRIBUTIONS: tuple[Attribution, ...] = (
    Attribution(
        source="faa-registry",
        text=faa_registry.ATTRIBUTION,
        url="https://registry.faa.gov/aircraftinquiry/",
        # Public domain, so the credit is courtesy in law and not in practice: an owner name
        # on a card is a statement about a named party, and the register it came from is the
        # only thing that makes it checkable.
        licence="US government work, no copyright",
    ),
    Attribution(
        source="sec-edgar",
        text=sec.ATTRIBUTION,
        url="https://www.sec.gov/search-filings",
        # EDGAR is a work of the US government and carries no copyright, so the credit is
        # courtesy rather than a condition. It is here because a card naming an officer of a
        # company should say where that came from, and "a filing" is the whole reason the
        # claim may be asserted at all.
        licence="US government work, no copyright",
    ),
    Attribution(
        source="adsb.lol",
        text="Aircraft data from adsb.lol",
        url="https://adsb.lol",
        licence="ODbL 1.0",
    ),
    Attribution(
        source="adsb.fi",
        text="Aircraft failover data from adsb.fi",
        url="https://adsb.fi",
        licence="Non-commercial use",
    ),
    Attribution(
        source="airplanes.live",
        text="Unfiltered aircraft data from airplanes.live",
        url="https://airplanes.live",
        licence="Access granted on request; no published redistribution grant",
        requires="aircraft/airplanes.live",
    ),
    Attribution(
        source="adsbexchange",
        text="Unfiltered aircraft data from ADS-B Exchange",
        url="https://www.adsbexchange.com",
        licence=(
            "Paid RapidAPI key; redistribution prohibited without written permission, "
            "which serving positions to a browser would require"
        ),
        requires="aircraft/adsbexchange",
    ),
    Attribution(
        source=adsbdb.SOURCE_NAME,
        text=adsbdb.ATTRIBUTION,
        url="https://www.adsbdb.com",
        licence="None stated by the provider; no redistribution grant given",
    ),
    Attribution(
        source="Fintraffic",
        # Verbatim from the provider's terms page, which specifies the wording. Shortening
        # it would drop the licence name the licence itself asks us to carry.
        text="Source: Fintraffic / digitraffic.fi, license CC 4.0 BY",
        url=fintraffic.ATTRIBUTION_URL,
        licence=fintraffic.LICENCE,
    ),
    Attribution(
        source="Kystdatahuset",
        # NLOD 1.0 makes naming the source a condition, and the provider names the licence
        # itself in its own OpenAPI document, so both travel together.
        text=kystdatahuset.ATTRIBUTION,
        url=kystdatahuset.ATTRIBUTION_URL,
        licence=kystdatahuset.LICENCE,
    ),
    Attribution(
        source="Transpordiamet",
        # No licence is stated on the service: copyrightText is empty and there is no terms
        # page. The credit is courtesy, and saying so is the honest version.
        text=transpordiamet.ATTRIBUTION,
        url=transpordiamet.ATTRIBUTION_URL,
        licence=transpordiamet.LICENCE,
    ),
    Attribution(
        source="Seaway VIS",
        # Same position: no terms page on either host and no licence field in the response.
        text=seaway.ATTRIBUTION,
        url=seaway.ATTRIBUTION_URL,
        licence=seaway.LICENCE,
    ),
    Attribution(
        source="aisstream.io",
        text="Global vessel positions from aisstream.io",
        url="https://aisstream.io",
        licence="Provider terms, redistribution not granted; check before commercial use",
        requires="vessels/aisstream",
    ),
    Attribution(
        source="AISHub",
        text="Vessel data from the AISHub contributor network",
        url="https://www.aishub.net",
        licence="Contributor terms, redistribution not granted",
        requires="vessels/aishub",
    ),
    Attribution(
        source="CelesTrak",
        text="Orbital element sets from CelesTrak",
        url="https://celestrak.org",
        licence="Not stated by the provider; credit is courtesy",
    ),
    Attribution(
        source=geonames.SOURCE_NAME,
        # Fixed by the licence rather than by us: CC BY 4.0 makes the credit a condition, and
        # it wants a link to the source and a link to the licence. `url` carries the source
        # link and the licence text carries the licence link, because the credit contract has
        # one URL field and both links have to reach the panel somehow.
        text="City data from GeoNames, CC BY 4.0",
        url="https://www.geonames.org/",
        licence="CC BY 4.0, https://creativecommons.org/licenses/by/4.0/",
    ),
    Attribution(
        source=nominatim.SOURCE_NAME,
        # The provider's own string, carried in the `licence` field of every record it
        # returns. Rendering a hand-written line instead would drift from what the data
        # actually says, which is why the adapter pins this as a constant.
        text=nominatim.ATTRIBUTION,
        url="https://osm.org/copyright",
        licence="ODbL 1.0",
    ),
    Attribution(
        source="NASA GIBS",
        text="Imagery courtesy of NASA EOSDIS GIBS",
        url="https://gibs.earthdata.nasa.gov",
        licence="Public domain, attribution requested",
    ),
    # Unpacked rather than concatenated, so this stays one tuple literal. The transit credits
    # are computed because there are 258 feeds behind six licences: see the builder for why
    # they are grouped by licence rather than listed one per operator.
    *_transit_attributions(),
)
"""Credits the UI must display. Served from the API so a new source cannot ship without one."""


def _fix_time(observed_at: datetime, position_age_s: float) -> datetime:
    """When a report's position was actually fixed.

    ``observed_at`` is when the provider built the response and the position inside it can be
    seconds or hours older, so this is what recency has to be judged on. Resolving on response
    time would let a slow provider's stale fix win, which is provider precedence wearing a
    recency costume.
    """
    return observed_at - timedelta(seconds=position_age_s)


def _aircraft_fix_time(aircraft: "Aircraft") -> datetime:
    """Fix time for the aircraft stores, so a failover cannot walk an aircraft backwards."""
    return _fix_time(aircraft.observed_at, aircraft.position_age_s)


def _vessel_fix_time(vessel: Vessel) -> datetime:
    """Fix time for the vessel union and its store, per ADR 010."""
    return _fix_time(vessel.observed_at, vessel.position_age_s)


def _vessel_interval(settings: Settings) -> float:
    """The cadence one vessel cycle actually runs at.

    One poller calls every provider, so the cycle is the slowest configured cadence, floored
    at the strictest provider's own floor. ADR 010 asks for cadence per provider and phase 3
    makes that expressible; today both knobs move the same cycle, and the store's time to live
    is derived from this so it can never be shorter than the gap between two polls.
    """
    return max(
        settings.fintraffic_poll_seconds,
        settings.kystdatahuset_poll_seconds,
        settings.transpordiamet_poll_seconds,
        settings.seaway_poll_seconds,
        settings.aishub_poll_seconds,
        VESSEL_UNION_MIN_INTERVAL_SECONDS,
    )


def build_state(settings: Settings, http: httpx.AsyncClient) -> AppState:
    """Construct application state without starting anything.

    Separate from the lifespan so tests can build state, drive a poller by hand and
    inspect the stores, with no background tasks and no sleeping.

    One :class:`~tracker.cache.DiskCache` is built here and handed to everything that holds a
    rate guard or a response cache, because the point of it is that there is one file rather
    than one per source. It opens no file until something writes, so a state built for a test
    that makes no upstream call still touches no disk.
    """
    cache = DiskCache(settings.cache_dir)
    # One instance each, held so the removal sweeps the cache the product actually serves
    # from. A second copy would let a removal report success while the first went on serving
    # the name, which is the failure AGENTS.md records against the adsbdb owner cache.
    owner_lookup = adsbdb.AdsbdbLookup(http)
    media = routes_media.MediaStore(http, cache, settings.cache_dir / routes_media.MEDIA_DIRECTORY)
    suppression = SuppressionStore(cache, settings.cache_dir)
    # **The aircraft store outlives one poll cycle by design, because the layer is now a
    # global sweep rather than a viewport query.** One cell is fetched per cycle and alternate
    # cycles go to the camera, so a cell far from the camera comes round once every
    # 2 x cells x interval. At the default five-second interval that is 250 seconds across
    # twenty-five productive cells, and the ninety-second default would have expired every
    # aircraft outside the current view before its cell was swept again: the globe would have
    # shown the camera's own cell and nothing else, which is the bug this change exists to fix.
    #
    # Derived rather than typed, so changing the grid step or the interval moves it without
    # anyone remembering to. Stated as the sum AGENTS.md asks for: this feed carries no
    # acceptance window of its own, so the worst age on screen is the store's alone, and it is
    # about eight minutes for somewhere nobody is looking. That is the cost of global coverage
    # from one keyless provider at a five-second floor, and the rail says so rather than
    # implying every aircraft is five seconds old.
    aircraft_ttl_seconds = max(
        settings.entity_ttl_seconds,
        2 * adsb.PRODUCTIVE_CELL_ESTIMATE * settings.adsb_poll_seconds * 2.0,
    )
    aircraft: EntityStore[Aircraft] = EntityStore(
        ttl_seconds=aircraft_ttl_seconds, fix_time=_aircraft_fix_time
    )
    military: EntityStore[Aircraft] = EntityStore(
        ttl_seconds=settings.entity_ttl_seconds, fix_time=_aircraft_fix_time
    )
    vessels: EntityStore[Vessel] = EntityStore(
        # The time to live is derived from the cycle the poller actually runs, not from one
        # provider's knob. Two settings drive one cycle, so reading only the Fintraffic one
        # gave a 180-second time to live on a 300-second cycle: every ship expired between
        # two polls and the layer blinked empty.
        ttl_seconds=max(settings.entity_ttl_seconds, _vessel_interval(settings) * TTL_MISSED_POLLS),
        fix_time=_vessel_fix_time,
    )
    transit: EntityStore[TransitVehicle] = EntityStore(
        # A sweep legitimately skips a host inside its floor and legitimately gets a 304 from
        # a host whose feed has not changed, so a vehicle can go several cadences without a
        # fresh report while still being exactly where the feed last said. The time to live
        # therefore has to cover the slowest floor in the registry rather than the cadence:
        # passio3.com is 350s, and expiring on the cadence would blink 23 feeds' worth of
        # vehicles off the globe between two polls.
        # **Two cycles of the slowest floor that governs a real feed, and this figure has now
        # been measured wrong twice.**
        #
        # It began as the slowest declared host floor times `TTL_MISSED_POLLS`, 1,050 seconds.
        # That was too generous because the store expires on *insertion* while the adapter
        # accepts an already-old report, so the two add rather than one bounding the other.
        # Measured on a warm store of 15,065 vehicles: median position age 359s, p90 891s,
        # **8,437 older than five minutes**, worst 1,814s. A road vehicle thirty minutes stale
        # is miles from where it is drawn, which is the error the clustering agent refused to
        # make by extrapolating, held silently instead of openly.
        #
        # Cutting it to two cycles halved the tail. Then two things moved underneath it. The
        # adapter's acceptance bound came down from 900 to 300 seconds on its own measurement,
        # which made this the dominant term. And `passio3.com`, the 350-second floor this was
        # derived from, turns out to govern **no feed at all**: all 23 of its feeds were
        # dropped for having no licence recorded. So the figure was derived from a host the
        # registry does not use.
        #
        # Derived from the feeds that exist instead, which is self-correcting: the slowest
        # floor actually governing a feed is 120 seconds, so this is 240. Worst case on screen
        # is now 300 + 240 = 540 seconds against 1,950 originally. Two cycles rather than one
        # because a host whose sweep fails waits its whole floor before the next attempt, so
        # one cycle would blink its vehicles off the globe on a single transient failure.
        #
        # It also cannot go below the largest governing floor without our own rate discipline
        # manufacturing stale drops, which is the coupling asserted in `sources/gtfsrt.py`.
        #
        # One thing this deliberately does not try to fix: `FeedEntity.id` is trip-scoped on
        # 23.7% of records and on all of Entur, so a bus finishing a trip reappears under a new
        # key and the finished one lingers here until it expires. A shorter time to live buys
        # fewer dead trips, which is why the count is a count of recent reports rather than a
        # fleet size, and the product says so rather than implying otherwise.
        ttl_seconds=max(
            settings.entity_ttl_seconds,
            max((feed.min_interval_seconds for feed in gtfsrt.FEEDS), default=30.0) * 2.0,
        ),
        fix_time=gtfsrt.fix_time,
    )
    # No fix_time on the satellite store: a record is an element set rather than an
    # observation, so there is no report time to compare and last write wins.
    satellites: EntityStore[Satellite] = EntityStore(
        ttl_seconds=settings.celestrak_poll_seconds * TTL_MISSED_POLLS
    )
    pollers = PollerGroup()
    hub = Hub(
        broadcast_interval_seconds=settings.broadcast_interval_seconds,
        health_provider=pollers.health,
    )
    hub.register_layer("aircraft", aircraft)
    hub.register_layer("military", military)
    hub.register_layer(VESSEL_LAYER, vessels)
    hub.register_layer(TRANSIT_LAYER, transit)
    # The satellite store looks like a third copy of the element cache and is not: it is the
    # delta channel for it. `/api/satellites/elements` is the initial load a tab does once,
    # and this is how a refreshed element set or a decayed object reaches that tab without a
    # page reload (`frontend/src/main.ts` feeds `batch.satellites` to the propagation worker).
    # Deleting the registration would leave every open browser propagating whatever it read
    # at load time, for as long as it stayed open.
    hub.register_layer("satellites", satellites)

    state = AppState(
        settings=settings,
        http=http,
        hub=hub,
        pollers=pollers,
        aircraft=aircraft,
        military=military,
        vessels=vessels,
        satellites=satellites,
        transit=transit,
        celestrak=CelestrakClient(http, cache=cache),
        registry=_build_registry(owner_lookup),
        # No city index here and no download either. build_state opens no sockets, and the
        # gazetteer is filled by the refresh job the lifespan starts, so an app built for a
        # test has an empty index rather than a 3.3MB fetch in its constructor.
        geonames=GeonamesDump(http, cache_dir=settings.geonames_cache_dir),
        # Same rule as the gazetteer: no download in a constructor. The register is 73MB and
        # the refresh job the lifespan starts is what fills it, so an app built for a test has
        # no index rather than a 70MB fetch before its first request.
        faa=FaaRegistry(cache_dir=settings.cache_dir),
        sec=sec.SecClient(http, contact_email=settings.contact_email),
        cache=cache,
        suppression=suppression,
        # Replaced below, once ``AppState.__post_init__`` has built the social clients. See
        # the assignment after this call for why it cannot be done here.
        removals=RemovalService(suppression, (media, owner_lookup)),
        nominatim=_build_geocoder(settings, http, cache),
        attribution=ATTRIBUTIONS,
    )
    # **The social derived page is swept too, and it has to be this instance.** It holds a
    # Mastodon author handle and a Commons licence author, so it is real personal data and it
    # is the cache a removal is most likely to miss. It cannot go in the constructor above
    # because ``AppState`` builds it in ``__post_init__``, which has not run yet, and a
    # ``SocialClients`` made here would be a second object: the removal would sweep a page
    # nobody reads and report a cache it never reached, which is worse than not claiming it.
    state.removals = RemovalService(suppression, (media, owner_lookup, state.social))
    _register_aircraft_pollers(state)
    _register_vessel_poller(state)
    _register_satellite_poller(state)
    _register_transit_poller(state)
    return state


def _build_geocoder(
    settings: Settings, http: httpx.AsyncClient, cache: DiskCache
) -> NominatimClient | None:
    """The Nominatim client, or ``None`` when no contact email is configured.

    The gate is read here rather than inside the adapter, so an unconfigured deployment does
    not hold a client it must not call. Nominatim's usage policy requires contact details in
    the User-Agent, and calling it anonymously is how a shared egress IP gets blocked for
    everybody behind it. With ``None`` the search reports the places group unavailable with
    the reason, exactly like a missing key on any other layer.

    Cities are unaffected: the gazetteer is local and keyless, so a deployment with no contact
    email still resolves London.
    """
    if not settings.osm_services_available:
        _log.info("%s: %s", nominatim.SOURCE_NAME, search.PLACES_UNAVAILABLE_REASON)
        return None
    return NominatimClient(http, cache=cache)


async def refresh_cities(state: AppState) -> int:
    """One city refresh attempt. Returns how many cities are indexed afterwards.

    Never raises, which is the same contract ``Poller.run_once`` has and for the same reason:
    this runs in a supervised loop that must survive any upstream fault. A failed refresh
    leaves the index it already had, because a week-old gazetteer beats an empty one and
    cities do not move.

    At most one conditional request a week reaches the network, and the floor is enforced
    inside the adapter against the mtime of the copy on disk, so calling this more often is
    cheap rather than rude. The reading that permits the fetch at all is R4 in
    ``docs/pending-decisions.md`` and it is unratified; the URL and the reasoning live
    together in ``sources/geonames.py``.
    """
    tally = state.city_tally
    tally.polls += 1
    try:
        parsed = await state.geonames.cities()
    except Exception as exc:  # noqa: BLE001 - a supervised job must survive any upstream fault
        tally.failures += 1
        _log.warning(
            "%s: city refresh failed, keeping the %d cities already indexed: %s",
            geonames.SOURCE_NAME,
            len(state.cities),
            describe_exception(exc),
        )
        return len(state.cities)

    tally.drops += parsed.dropped
    # The provider's own confirmation time, off the mtime of the copy on disk, rather than
    # the moment this ran. Inside the week a refresh serves the cached dump without asking
    # GeoNames anything, and stamping that as a success would tell /api/layers the provider
    # answered when nothing was sent. A 304 restamps the file, so a confirmed-unchanged dump
    # does move this forward.
    tally.last_success_at = state.geonames.refreshed_at
    indexed = index_cities(state, parsed.records)
    _log.info("%s: indexed %d cities", geonames.SOURCE_NAME, indexed)
    return indexed


def index_cities(state: AppState, cities: tuple["City", ...]) -> int:
    """Put these cities behind the gazetteer, replacing whatever was there.

    Both containers are replaced whole and in one direction, index first. Nothing here
    mutates a live container, so a search running concurrently sees the old gazetteer or the
    new one and never a half-built one.

    The list is sorted once here rather than per request: population descending, with the
    GeoNames id as a total tie-break so two identical requests return identical bodies. That
    ordering is what makes a capped read useful, because the first page is then the cities a
    world view labels rather than an arbitrary slice.
    """
    state.city_index = CityIndex(cities)
    state.cities = tuple(sorted(cities, key=lambda city: (-city.population, city.geonames_id)))
    return len(state.cities)


async def refresh_ownership(state: AppState) -> int:
    """One ownership refresh: the FAA register, the SEC company index, then the join.

    Returns how many aircraft carry a join afterwards. Never raises, the same contract
    :func:`refresh_cities` has and for the same reason: this runs in a supervised loop that
    has to survive any upstream fault, and a failed refresh leaves whatever was already
    indexed. An hours-old register beats none, because aircraft ownership does not change
    between breakfast and lunch.

    Neither half normally opens a socket. The FAA adapter refreshes at most once a day
    against the mtime of the copy on disk, and the company index is cached for a week, so a
    pass inside either window is two disk reads.

    **The company index is cached and the filings are not, and that asymmetry is the point.**
    A company is not a natural person. ``sources/sec.py`` caches nothing precisely because
    everything it fetches about a person is about a person; 796KB of listed-company names is
    not, so it goes on disk where a restart can reuse it.
    """
    try:
        # The register first, and unconditionally. It needs no contact address: its gate is a
        # bot filter on the FAA's CDN, not a declared-client requirement, and gating it on the
        # SEC's condition is what used to leave every aircraft with no owner at all.
        registry = await state.faa.load()
    except Exception as exc:  # noqa: BLE001 - a supervised job must survive any upstream fault
        state.ownership_error = describe_exception(exc)
        _log.warning("register refresh failed: %s", state.ownership_error)
        return state.ownership.joined if state.ownership else 0

    if not state.settings.filings_available:
        # The register is loaded and the cards can show a registered owner. Only the join to a
        # filing entity is off, because the company index is an SEC fetch and the SEC refuses an
        # undeclared client. Checked before the request, not after: sending one would spend a
        # refusal to learn what configuration already says.
        # Not an error on this layer: the register loaded and the owners are on the cards.
        # The filings being off is reported by its own capability row, from configuration,
        # which is where a condition that configuration decides belongs.
        state.ownership_error = state.faa.last_error
        state.ownership = None
        return 0

    try:
        index = await _company_index(state)
    except Exception as exc:  # noqa: BLE001 - a supervised job must survive any upstream fault
        state.ownership_error = describe_exception(exc)
        _log.warning("company index refresh failed: %s", state.ownership_error)
        return state.ownership.joined if state.ownership else 0

    state.ownership_error = state.faa.last_error
    state.company_index = index
    extract = registry.extract_date
    if extract is None:
        # No extract date means nothing to date a join to, and ADR 006 drops an undated
        # entry rather than stamping it with the time of the run. So the register is held
        # and nothing is joined from it.
        state.ownership_error = "register carries no extract date"
        return 0

    state.ownership = spine.summarise(
        _registrants(state, registry),
        index=index,
        as_of=extract.date(),
        source=faa_registry.SOURCE_NAME,
        origin_key=f"{faa_registry.SOURCE_NAME}-{extract.date().isoformat()}",
    )
    _log.info(
        "ownership: %d aircraft asserted, %d possible, across %d companies",
        state.ownership.asserted,
        state.ownership.possible,
        len(state.ownership.organisation_ids),
    )
    return state.ownership.joined


def _registrants(
    state: AppState, registry: faa_registry.FaaRegistryIndex
) -> Iterator[tuple[str, spine.RegistrantKind]]:
    """The registrant of every aircraft currently in view, name and kind.

    Driven from the aircraft store rather than from the whole register on purpose. 316,110
    registrations is the register; a few hundred are airborne, and the join a card needs is
    for the ones on the globe. Walking the register instead would spend a second of CPU to
    answer a question nobody asked.
    """
    for aircraft in state.aircraft.snapshot() + state.military.snapshot():
        registration = registry.registration(aircraft.icao24)
        if registration is None:
            continue
        yield registration.owner_name, spine.registrant_kind(str(registration.owner_type))


async def _company_index(state: AppState) -> spine.CompanyIndex:
    """The SEC company index, from disk if it is fresh and from the SEC if it is not."""
    held = state.cache.get(SEC_INDEX_CACHE_KEY, ttl_seconds=SEC_INDEX_TTL_SECONDS)
    if held is not None:
        return spine.CompanyIndex.build(sec.parse_company_index(held.value))
    payload = await state.sec.company_index_payload()
    state.cache.set(SEC_INDEX_CACHE_KEY, payload.decode("utf-8"))
    return spine.CompanyIndex.build(sec.parse_company_index(payload))


async def _refresh_ownership_forever(state: AppState) -> None:
    """Refresh ownership now, then on the configured interval for the life of the process.

    Runs immediately so the join fills in a moment after start-up rather than at the first
    interval, and not in the poller group for the same reason the city refresh is not: a
    daily bulk download is not a feed and has no delta channel a static file could use.
    """
    while True:
        await refresh_ownership(state)
        await asyncio.sleep(state.settings.ownership_refresh_seconds)


async def _refresh_cities_forever(state: AppState) -> None:
    """Refresh the gazetteer now, then once a week for as long as the process lives.

    The first pass runs immediately, so start-up is not blocked on a 3.3MB download and the
    city layer fills in a moment later. Every later pass is a conditional request that
    normally answers HTTP 304 and costs the provider nothing.

    The weekly sleep is the adapter's own floor, not a number of its own, so the wake-up and
    the refusal to fetch can never disagree about what "weekly" means. An attempt that leaves
    nothing indexed waits :data:`CITY_RETRY_SECONDS` instead, because a network blip at boot
    with no copy on disk would otherwise leave the gazetteer empty for seven days: no search
    resolves a city, the label layer draws nothing, and every city query falls through to
    Nominatim.
    """
    while True:
        indexed = await refresh_cities(state)
        await asyncio.sleep(geonames.MIN_REFRESH_INTERVAL_S if indexed else CITY_RETRY_SECONDS)


def _build_registry(
    lookup: adsbdb.AdsbdbLookup,
) -> Enricher["Aircraft", adsbdb.AircraftRegistration]:
    """The aircraft-to-owner join: adsbdb behind the generic enrichment service.

    Built once per process because the lookup underneath owns the cache, the TTL and the
    request budget, and "no repeat call for the same hex in a session" only means something
    if one instance survives the session. The lookup arrives from outside rather than being
    made here, because a removal under ADR 008 has to sweep it and a second instance would let
    the removal report success while the first one carried on serving the name.

    Nothing polls through this. It is called from the card path for one aircraft at a time,
    because adsbdb's own limiter allows 512 requests a minute per IP and a live aircraft
    layer is thousands of records a cycle. A registry failure degrades the card to feed-only
    data and never to an error state, which is the enrichment service's own guarantee.
    """
    return Enricher(
        registry=adsbdb.SOURCE_NAME,
        lookup=lookup.aircraft,
        merge=adsbdb.apply_to_aircraft,
        key=_aircraft_key,
    )


def _aircraft_key(aircraft: "Aircraft") -> str:
    """The merge identity for an aircraft: its ICAO 24-bit address, per ADR 010.

    The transponder's own stable identity, never a generated or positional key, or an
    aircraft duplicates itself every time it moves. A privacy ICAO address is still a
    stable identity for as long as it is broadcast, which is why an anonymous aircraft
    merges here like any other and is correlated to a registration in phase 11 instead.
    """
    return aircraft.icao24


def _aircraft_union_members(state: AppState) -> tuple[tuple[adsb.AdsbProvider, AdsbClient], ...]:
    """The providers this deployment can actually poll, with a client each.

    ADR 010's union, filtered to what is reachable. A provider that cannot be reached is
    left out entirely rather than added and failed every cycle, because a permanent
    degraded banner tells a viewer nothing: ``/api/capabilities`` carries its reason
    instead, the same way an unconfigured AISHub does on the vessel layer.

    **This is where the single-member reality lands, and it is the honest position.** Of the
    providers ADR 010 names, adsb.lol is keyless and answers. ADS-B Exchange is demand-driven
    rather than swept and has no key. airplanes.live answers HTTP 403 until an access email
    is answered. adsb.one is Cloudflare-blocked and is not even a row. adsb.fi is the
    failover inside the adsb.lol client and not a member, per R3 in
    ``docs/pending-decisions.md``. So the union has one member, which makes it a correct
    implementation with an access blocker in front of it rather than a failure. The
    consequence to state out loud is that ADR 010's unfiltered coverage is zero today.

    Where that zero is reported matters, and an earlier version of this docstring got it
    wrong. ``/api/layers`` carries a row per provider that was **polled**, so a provider left
    out here has no row and no number there: a row reading ``records: 0, error: null`` is
    ADR 010's reporting-but-empty state, which is a different sentence from "never asked", and
    folding one into the other would be the more misleading of the two. The reason a provider
    was left out is served on ``/api/capabilities`` instead, per provider, with the live
    verification that produced it.
    """
    settings = state.settings
    members: list[tuple[adsb.AdsbProvider, AdsbClient]] = []
    for provider in adsb.SWEPT_PROVIDERS:
        reason = aircraft_provider_gate(settings, provider)
        if reason is not None:
            _log.info("%s left out of the aircraft union: %s", provider.name, reason)
            continue
        members.append((provider, _aircraft_client(state, provider)))
    return tuple(members)


def _aircraft_client(state: AppState, provider: adsb.AdsbProvider) -> AdsbClient:
    """One readsb ``/v2`` client per union member, configured entirely off the row.

    Every provider here serves the identical schema, so this is a base URL and a name rather
    than a parser, which is the fact that made ADR 010 cheap in the first place. Both now come
    off the provider row. They used to come from an ``is`` comparison against one module
    constant, which meant a new row was handed adsb.lol's host and adsb.lol's name: the union
    then polled adsb.lol twice a cycle against the floor that exists to stop exactly that,
    ``/api/layers`` reported two providers where one origin answered twice, and every
    aircraft looked seen-by-both so the provider-attributable count collapsed to zero.

    Only adsb.lol carries a failover, and only to adsb.fi. Under R3 adsb.fi is a
    within-provider fallback rather than a union member, so its non-commercial licence
    attaches to records served during an outage window instead of on every cycle.
    """
    settings = state.settings
    if provider.base_url_setting is None:
        # Reached only by wiring a provider we hold no host for into the poll. Loud here
        # rather than a request to whatever host happened to be the default.
        msg = f"{provider.name} has no base URL setting and cannot be polled"
        raise ValueError(msg)
    failover = (
        None
        if provider.failover_setting is None
        else str(getattr(settings, provider.failover_setting))
    )
    return AdsbClient(
        state.http,
        base_url=str(getattr(settings, provider.base_url_setting)),
        failover_base_url=failover,
        source_name=provider.name,
        cache=state.cache,
    )


def _register_aircraft_pollers(state: AppState) -> None:
    """Attach the aircraft union to the state's poller group, and the military sweep with it.

    Two pollers, two stores. This one replaces nothing outside its own results and relies on
    the store's time to live to retire aircraft that leave the view; the military sweep is one
    function down.

    The aircraft layer is a union of providers merged on the ICAO 24-bit address, per
    ADR 010, built exactly like the vessel union below: providers polled concurrently, the
    freshest fix supplying the record, nothing averaged, every record naming every provider
    that saw it, and a provider that fails dropping out of that cycle rather than failing the
    layer.
    """
    settings = state.settings
    members = _aircraft_union_members(state)
    counted_drops: dict[str, int] = {}

    sweep = adsb.GlobalSweep()

    async def fetch(client: AdsbClient) -> tuple["Aircraft", ...]:
        """One provider's contribution: alternating the viewport and one cell of the globe.

        **The aircraft layer used to query the viewport and nothing else, so it was never
        global.** Measured on 2026-08-24 before this changed: 954 aircraft in 4 of 648
        ten-degree cells, longitude -6.8 to 6.5, which is Britain, France and Benelux. Every
        aircraft coverage figure this project had published described one browser window.

        One request per cycle, because that is what adsb.lol's five-second floor allows, and
        **every one of them is a grid cell**. Alternate cycles ask for the grid cell nearest the
        camera rather than a bounding box around it, so the local refresh and the global
        rotation are the same request instead of competing for the budget. An earlier version
        alternated the viewport box with a grid cell and spent half the rate on requests that
        could never advance coverage.

        `GlobalSweep` skips cells that came back empty, so the rotation converges on the places
        with traffic rather than sweeping ocean at the same rate as western Europe.

        The consequence a viewer must be told, and the rail says it: an aircraft outside the
        current view can be minutes old. That is the trade Alexander Fanthome asked for on
        2026-08-24, in his words "you can poll some things slower, but also you must increase
        coverage (the whole globe)".
        """
        box = state.viewport
        centre = None if box is None else (box.centre.lat, box.centre.lon)
        lat, lon = sweep.next_cell(near=centre)
        found = await client.aircraft_near(lat=lat, lon=lon, radius_nm=adsb.SWEEP_RADIUS_NM)
        sweep.record((lat, lon), len(found))
        return found

    def count_client_drops(name: str, client: AdsbClient) -> None:
        """Add the records this provider's parser refused since the last cycle.

        The client counts cumulatively, so this adds the difference rather than the total,
        which is how the aisstream drain already works. Discarding it is what made "dropped
        and counted" mean "dropped and logged" on the vessel layer.
        """
        seen = counted_drops.get(name, 0)
        count_drops(state.aircraft_providers, name, client.dropped - seen)
        counted_drops[name] = client.dropped

    async def poll_aircraft() -> int:
        # Concurrently, per ADR 010: a union polled in series takes as long as its slowest
        # provider and makes the freshest fix a function of poll order.
        results = list(
            await asyncio.gather(
                *(
                    _provider_result(provider.name, partial(fetch, client))
                    for provider, client in members
                )
            )
        )
        for provider, client in members:
            count_client_drops(provider.name, client)
        union = merge_providers(
            results,
            key=_aircraft_key,
            reported_at=_aircraft_fix_time,
            served_by=_served_by,
        )
        state.aircraft_union = union
        record_cycle(state.aircraft_providers, union)
        # upsert_many, never replace_all: each provider covers its own receivers, and
        # replacing would delete every aircraft only a missing provider could see.
        #
        # Iterated rather than fed from union.keyed(), because keyed() carries the winning
        # value alone and ADR 010 wants the providers that saw the aircraft on the record
        # itself. The store is the boundary that list has to cross.
        state.aircraft.upsert_many(
            (record.key, record.value.model_copy(update={"providers": record.providers}))
            for record in union.records
        )
        if not union.reporting:
            raise SourceError(AIRCRAFT_LAYER, union.degraded_reason or "no provider answered")
        if union.degraded:
            _log.warning("aircraft layer degraded: %s", union.degraded_reason)
        return len(union.records)

    state.pollers.add(
        Poller(
            name="aircraft/union",
            layer=AIRCRAFT_LAYER,
            poll=poll_aircraft,
            interval_seconds=settings.adsb_poll_seconds,
            min_interval_seconds=adsb.UNION_MIN_INTERVAL_SECONDS,
            cache=state.cache,
        )
    )
    _register_military_poller(state)


def _register_military_poller(state: AppState) -> None:
    """Attach the worldwide military sweep, on its own client and its own tally.

    One provider, not a union: ``/v2/mil`` is a single worldwide call and with adsb.lol the
    only reachable member a union here would be ceremony around it. It goes through the same
    merge anyway, because that is where the per-provider reporting lives, and this layer needs
    it more than any other: 81 of the 391 records in the recorded capture carry no position
    and are dropped as heard-but-not-located, which before this reached the parser's log line
    and stopped there while ``/api/layers`` served no military row at all.

    Its own client, so the sweep's cadence and its failover are independent of the union's.
    Same provider, same failover, different endpoint and a floor four times slower.
    """
    settings = state.settings
    client = _aircraft_client(state, adsb.ADSB_LOL)
    drained = 0

    def finish(result: ProviderResult["Aircraft"]) -> UnionResult["Aircraft"]:
        """Record one cycle, whichever way it went, and hand back the merge."""
        nonlocal drained
        union = merge_providers(
            (result,),
            key=_aircraft_key,
            reported_at=_aircraft_fix_time,
            served_by=_served_by,
        )
        state.military_union = union
        record_cycle(state.military_providers, union)
        count_drops(state.military_providers, adsb.ADSB_LOL.name, client.dropped - drained)
        drained = client.dropped
        return union

    async def poll_military() -> int:
        # The failure is recorded and then re-raised rather than swallowed into a provider
        # result: this layer is one provider, so a failure is the layer failing, and the
        # poller needs the original exception to honour a RateLimitedError's own backoff.
        try:
            found = await client.military()
        except Exception as exc:
            finish(ProviderResult.from_error(adsb.ADSB_LOL.name, exc))
            raise
        # replace_all because /v2/mil returns a complete worldwide picture each call, so
        # anything absent has genuinely gone off the feed.
        union = finish(ProviderResult(provider=adsb.ADSB_LOL.name, records=found))
        state.military.replace_all(union.keyed())
        return len(union.records)

    state.pollers.add(
        Poller(
            name="adsb.lol/mil",
            layer="military",
            poll=poll_military,
            interval_seconds=max(settings.adsb_poll_seconds * 4, ADSB_MIL_MIN_INTERVAL_SECONDS),
            min_interval_seconds=ADSB_MIL_MIN_INTERVAL_SECONDS,
            cache=state.cache,
        )
    )


def _served_by(record: "Aircraft | Vessel") -> str:
    """Which host's bytes this record actually is, for the union's attribution list.

    The adapter's own ``source``, not the union member we polled, because an adapter can
    fail over inside one member row: ``AdsbClient`` polls adsb.lol and falls back to
    adsb.fi under the member name adsb.lol. Without this the merge credits the polled
    member, and since adsb.lol is ODbL 1.0 and adsb.fi is non-commercial, the card states
    the wrong licence over the data on screen. Measured live 2026-08-23: two of 1,040
    aircraft served ``source: adsb.fi`` beside ``providers: ["adsb.lol"]``.
    """
    return record.source


def _vessel_key(vessel: Vessel) -> str:
    """The merge identity for a vessel: its MMSI, per ADR 010.

    The source's own stable identity, never a generated or positional key, or a ship
    duplicates itself every time it moves.
    """
    return vessel.mmsi


async def _provider_result[T](
    provider: str, fetch: Callable[[], Awaitable[tuple[T, ...]]]
) -> ProviderResult[T]:
    """Run one provider's fetch, turning any failure into a provider that dropped out.

    ADR 010: a provider that errors, rate-limits or loses its key leaves the union for that
    cycle and the layer reports itself degraded with which provider is missing. It does not
    fail the layer, so the exception is recorded here rather than raised into the poller.

    Generic because aircraft and vessels merge through the same function and there is nothing
    layer-specific here. One implementation, so the aircraft union cannot quietly acquire
    different failure semantics from the vessel union.
    """
    try:
        return ProviderResult(provider=provider, records=await fetch())
    except Exception as exc:  # noqa: BLE001 - one provider must never fail the whole layer
        _log.warning("%s dropped out of the union: %s", provider, describe_exception(exc))
        return ProviderResult.from_error(provider, exc)


def _counted(
    state: AppState,
    provider: str,
    fetch: Callable[[], Awaitable[ParsedRecords[Vessel]]],
) -> Callable[[], Awaitable[tuple[Vessel, ...]]]:
    """Add one provider's refused records to its running total, then hand on the rest.

    Every polled provider returns its drop count with its records, so this is the one place
    the count is added and no provider needs its own wrapper. Discarding it is what made
    "dropped and counted" mean "dropped and logged": on 2026-08-20 the Fintraffic log read
    "kept 658 vessels, dropped 3" while ``/api/layers`` served ``drops: 0`` for that cycle.
    """

    async def fetch_and_count() -> tuple[Vessel, ...]:
        parsed = await fetch()
        count_drops(state.vessel_providers, provider, parsed.dropped)
        return parsed.records

    return fetch_and_count


def _connect_stream(
    settings: Settings, on_vessel: Callable[[Vessel], None]
) -> aisstream.AisStreamClient | None:
    """Build the aisstream.io subscription, or ``None`` when no key is configured.

    Constructed here and started by the lifespan, so ``build_state`` opens no sockets and a
    test can inspect the wiring with no network. No key is a configured-but-unavailable
    provider rather than an error: the layer runs on the keyless providers and
    ``/api/capabilities`` reports the reason.
    """
    if not settings.aisstream_available:
        _log.info("aisstream.io: %s", aisstream.UNAVAILABLE_REASON)
        return None
    box = BoundingBox(
        west=settings.aisstream_bbox_west,
        south=settings.aisstream_bbox_south,
        east=settings.aisstream_bbox_east,
        north=settings.aisstream_bbox_north,
    )
    return aisstream.AisStreamClient(
        api_key=settings.aisstream_api_key,
        boxes=(box,),
        on_vessel=on_vessel,
        reconnect_delay_seconds=settings.aisstream_reconnect_seconds,
    )


def _keyless_vessel_fetches(
    state: AppState,
) -> list[tuple[str, Callable[[], Awaitable[tuple[Vessel, ...]]]]]:
    """Build the vessel union's keyless members, in the order they were added to the project.

    Extracted from :func:`_register_vessel_poller` so that adding a fifth authority is a few
    lines here rather than more length on a function that already wires a socket, a drain and a
    poller. Every one of these needs no credential at all, so none is gated and none can be
    left out by configuration: they are the vessel layer.

    What each one is for, because "four AIS feeds" hides the only thing that matters about
    them, which is where they put ships:

    - **Fintraffic** (Finland): the Gulf of Finland, the Gulf of Bothnia and the Archipelago
      Sea. About 650 vessels.
    - **Kystdatahuset** (Norway): the Norwegian coast, the North Sea, the Norwegian Sea and the
      Barents, out to Svalbard. Between 1,200 and 3,400 depending on the hour, because the
      provider's own output swings by a factor of two and a half.
    - **Transpordiamet** (Estonia): the eastern Baltic and south to the Latvian coast. About
      620, of which roughly 230 are ships neither of the two above can see.
    - **Seaway** (Canada and the United States): the Great Lakes, the St Lawrence and the Gulf
      of St Lawrence. About 1,650 inside its freshness window, and the only member outside
      Europe.

    The national sweep that produced exactly this list, and no more, is recorded in
    ``docs/data-sources.md``: twenty-nine authorities across Europe, the Americas, Asia,
    Africa and Oceania were called on 2026-08-23 and these four are all that answered
    keylessly with live per-vessel positions.
    """
    settings = state.settings
    clients = (
        fintraffic.FintrafficClient(
            state.http,
            base_url=settings.fintraffic_base_url,
            digitraffic_user=settings.digitraffic_user or settings.user_agent,
            window_seconds=settings.fintraffic_window_seconds,
        ),
        kystdatahuset.KystdatahusetClient(
            state.http, base_url=settings.kystdatahuset_base_url, cache=state.cache
        ),
        transpordiamet.TranspordiametClient(
            state.http, base_url=settings.transpordiamet_base_url, cache=state.cache
        ),
        seaway.SeawayClient(state.http, base_url=settings.seaway_base_url, cache=state.cache),
    )
    return [(client.name, _counted(state, client.name, client.all_vessels)) for client in clients]


def _register_vessel_poller(state: AppState) -> None:
    """Attach the vessel union to the state's poller group.

    One poller, up to six providers, per ADR 010: the layer is the union of what its
    providers return rather than whichever one answered. They merge on MMSI, the freshest
    fix supplies the record, nothing is averaged, and a provider that fails drops out of
    that cycle instead of failing the layer.

    Four of the six are keyless and all four are always in: Fintraffic for the Gulf of
    Finland, Kystdatahuset for the Norwegian coast, Transpordiamet for the eastern Baltic and
    the Seaway for the Great Lakes and the St Lawrence. That is the whole vessel layer today,
    because AISHub needs a physical receiver accepted and aisstream.io needs a key. The
    national sweep behind that list is in ``docs/data-sources.md``: twenty-nine authorities
    were called on 2026-08-23 and those four are all that answered keylessly with live
    per-vessel positions.

    aisstream.io is a persistent subscription rather than a polled endpoint, so it keeps its
    newest report per MMSI in a buffer that each cycle drains. That is what keeps one merge
    point and therefore one record per ship, which is the phantom-fleet bug ADR 010 names.

    A provider with no credential is left out of the union entirely rather than added and
    failed every cycle, so an unconfigured AISHub does not make the layer read degraded
    forever. It reports itself unavailable from ``/api/capabilities`` instead.

    Recency deciding a conflict outright, with the superseded report dropped, is R2 in
    ``docs/pending-decisions.md`` and is unratified. It lives in ``services/union.py``; this
    function only feeds it the fix time.
    """
    settings = state.settings
    fetches = _keyless_vessel_fetches(state)

    worldwide = aishub.AishubClient(state.http, username=settings.aishub_username)

    async def aishub_vessels() -> ParsedRecords[Vessel]:
        return await worldwide.vessels(interval_minutes=settings.aishub_interval_minutes)

    if worldwide.available:
        fetches.append((worldwide.name, _counted(state, worldwide.name, aishub_vessels)))

    streamed: dict[str, Vessel] = {}

    def receive(vessel: Vessel) -> None:
        """Hold the newest report per MMSI until the next cycle drains it."""
        streamed[vessel.mmsi] = vessel

    stream = _connect_stream(settings, receive)
    state.aisstream = stream

    counted_stream_drops = 0

    def drain(client: aisstream.AisStreamClient) -> ProviderResult[Vessel]:
        """This provider's contribution for one cycle, drained from the socket's buffer.

        A connected socket that carried nothing is an empty answer, not a failure: thin
        traffic in the subscribed box is a legitimate result. A disconnected socket with an
        empty buffer is a provider that dropped out, named so the layer reads degraded.

        The stream counts its drops cumulatively rather than per response, because it has no
        responses. So this adds the difference since the last drain, which leaves the served
        total matching the client's own and stops one cycle's drops being counted twice.
        """
        nonlocal counted_stream_drops
        records = tuple(streamed.values())
        streamed.clear()
        count_drops(
            state.vessel_providers,
            aisstream.SOURCE_NAME,
            client.stats.dropped - counted_stream_drops,
        )
        counted_stream_drops = client.stats.dropped
        if records or client.connected:
            return ProviderResult(provider=aisstream.SOURCE_NAME, records=records)
        return ProviderResult(
            provider=aisstream.SOURCE_NAME,
            error=client.last_error or "not connected",
        )

    async def poll_vessels() -> int:
        results = list(await asyncio.gather(*(_provider_result(name, f) for name, f in fetches)))
        if stream is not None:
            results.append(drain(stream))
        union = merge_providers(
            results, key=_vessel_key, reported_at=_vessel_fix_time, served_by=_served_by
        )
        state.vessel_union = union
        record_cycle(state.vessel_providers, union)
        # upsert_many, never replace_all: each provider covers its own patch of sea, and
        # replacing would delete every ship only a missing provider could see.
        #
        # Iterated rather than fed straight from union.keyed(), because keyed() carries the
        # winning value alone and ADR 010 wants the list of providers that saw the ship on
        # the record itself. The store is the boundary the list has to cross: after this
        # line the merge result is gone and only the served Vessel remains.
        state.vessels.upsert_many(
            (record.key, record.value.model_copy(update={"providers": record.providers}))
            for record in union.records
        )
        if not union.reporting:
            # Every provider dropped out. The store keeps what it has, but the feed has to
            # read unhealthy rather than healthy-and-empty: that is the same lie AISHub's
            # empty HTTP 200 tells, one level up.
            detail = union.degraded_reason or "no provider answered"
            raise SourceError(VESSEL_LAYER, detail)
        if union.degraded:
            _log.warning("vessel layer degraded: %s", union.degraded_reason)
        return len(union.records)

    state.pollers.add(
        Poller(
            name="vessels/union",
            layer=VESSEL_LAYER,
            poll=poll_vessels,
            interval_seconds=_vessel_interval(settings),
            min_interval_seconds=VESSEL_UNION_MIN_INTERVAL_SECONDS,
            cache=state.cache,
        )
    )


def _register_transit_poller(state: AppState) -> None:
    """Attach the GTFS-Realtime sweep: buses and trains from 258 keyless licensed feeds.

    **``upsert_many``, never ``replace_all``, and the reason is the conditional request.** A
    sweep legitimately skips a host that is inside its own floor, and legitimately receives
    **HTTP 304 with a zero-byte body** from a host whose feed has not changed. Both mean "the
    records you hold still stand". Replacing the store from one sweep's records would delete
    every vehicle on every skipped and every unchanged host, which is most of the registry on
    most passes, and the layer would flicker. Expiry is the store's own time to live, which
    is what removes a vehicle that has genuinely stopped reporting.

    ``SweepResult`` separates ``unchanged`` from ``polled`` for exactly that reason, so this
    reads the distinction rather than collapsing it.

    **The cadence is not the floor.** ``settings.transit_poll_seconds`` starts a pass; the
    client refuses a host inside its own window, so a fast host is polled every 30 seconds
    while ``www.data.gouv.fr`` waits 120 and ``passio3.com`` waits 350. That is why the floor
    is per host: 99 of the 258 feeds sit on one public-sector host, and a per-feed floor would
    take 3.3 requests a second off it.

    **A pass that read nothing is not a failure.** 261 of 265 feeds that carried no vehicles
    in one sweep had a header timestamp under five minutes old: they were alive and had no
    buses running. Measured across **seven sweeps spanning a full day** on 2026-08-23 and
    2026-08-24, the shipping registry ran **3,629 vehicles at 00:48 UTC and 9,668 at 16:50, a
    factor of 2.7**. An earlier reading over four sweeps put it at 23% and was wrong because
    all four fell inside one European working day. So an empty feed is thin service rather
    than a broken one, and only a pass where no feed could be read at all is a failed poll.
    """
    settings = state.settings
    client = gtfsrt.GtfsRtClient(state.http, cache=state.cache)
    state.transit_client = client

    async def poll_transit() -> int:
        sweep = await client.sweep()
        state.transit_sweep = sweep
        # A pass is one poll of one adapter, so the tally counts passes. The per-feed detail
        # stays on the sweep, where the fields are named for feeds: putting "175 feeds skipped"
        # into a provider's `empty_polls` is what made it read 175 against 83 polls.
        tally = state.transit_tally
        tally.polls += 1
        tally.drops += sum(sweep.drops.values())
        state.transit_refusals.update(sweep.drops)
        state.transit.upsert_many((merge_key(v), v) for v in sweep.records)
        if sweep.polled == 0 and sweep.unchanged == 0:
            # Nothing was read and nothing was confirmed unchanged, so the store is serving
            # records no feed stood behind this pass. Skipped-inside-a-floor is not this
            # case: that is the rate discipline working and it leaves polled at zero only
            # when every host is held, which a failure would also produce, so the failures
            # dict is what tells them apart.
            tally.failures += 1
            detail = "; ".join(f"{feed}: {why}" for feed, why in sweep.failures.items())
            raise SourceError(TRANSIT_LAYER, detail or "no feed answered")
        if not sweep.records:
            # Read or confirmed something and still produced no vehicle. Legitimate at four in
            # the morning on a registry that is mostly daytime bus services, so it is a poll
            # that saw nothing rather than a failure, which is the distinction ADR 010 draws.
            tally.empty_polls += 1
        tally.last_success_at = datetime.now(UTC)
        if sweep.failures:
            _log.warning("transit layer degraded: %d feeds failed", sweep.failed)
        return len(sweep.records)

    state.pollers.add(
        Poller(
            name="transit/gtfsrt",
            layer=TRANSIT_LAYER,
            poll=poll_transit,
            interval_seconds=settings.transit_poll_seconds,
            min_interval_seconds=gtfsrt.DEFAULT_MIN_INTERVAL_SECONDS,
            cache=state.cache,
        )
    )


def _register_satellite_poller(state: AppState) -> None:
    """Attach the CelesTrak poller, one fetch per configured group per cycle.

    ``replace_all`` because a group is a complete published list: an object CelesTrak has
    dropped has decayed or been withdrawn and must leave the globe. The store is filled from
    the client's deduplicated cache rather than from this cycle's fetch, because groups
    overlap (``stations`` is a subset of ``active``) and the same object arriving twice would
    otherwise be drawn twice.

    The two-hour floor lives in the adapter, so the client serves from cache inside the
    window with no HTTP at all and the poller cadence cannot breach it.
    """
    settings = state.settings

    async def poll_elements() -> int:
        for group in settings.celestrak_groups:
            await state.celestrak.elements(group)
        found = state.celestrak.cached_elements()
        if not found:
            # replace_all with nothing empties the store and tells every browser to remove
            # every satellite, on a poll the feed would otherwise report as healthy. Zero
            # cached element sets means the fetch failed, every record was unmappable, or
            # no group is configured at all: none of those is the sky emptying, which is the
            # same argument the adapter makes when it refuses an empty OMM array.
            raise SourceError(celestrak.SOURCE_NAME, NO_ELEMENTS_DETAIL)
        state.satellites.replace_all((str(s.norad_cat_id), s) for s in found)
        return len(found)

    state.pollers.add(
        Poller(
            name="celestrak/gp",
            layer="satellites",
            poll=poll_elements,
            interval_seconds=settings.celestrak_poll_seconds,
            min_interval_seconds=celestrak.MIN_GROUP_INTERVAL_S,
            cache=state.cache,
        )
    )


def _prime_satellites_from_cache(state: AppState) -> None:
    """Fill the satellite store at startup, from disk where the floor forbids a request.

    Without this the satellite layer is empty on every restart that lands inside the
    six-hour poll window, even with every element set sitting on disk. Measured 2026-08-23:
    a restart four minutes after a successful fetch served 0 satellites from a cache holding
    698.

    Two correct guards combined to produce it and neither was at fault on its own. The
    poller persists its next-allowed-poll time through ``cache.py``, so a restart inside the
    window declines to call ``poll`` at all, which is the rate discipline that keeps us
    inside the two-hour floor. And the store is only ever filled by that poll. So the layer
    reported itself unhealthy with **no error to show**, because nothing had failed.

    Two subtleties, and getting either wrong is worse than the bug. ``cached_elements`` is an
    in-process dedup cache rather than the disk cache, so on a fresh process it is always
    empty and reading it alone fixes nothing. And ``elements`` **fetches on a miss**, so
    priming through it would put one request per configured group inside application startup,
    fourteen by default, and inside every test that builds an app. It did, briefly: the suite
    went from 21 seconds to 27 minutes with fifteen errors.

    ``CelestrakClient.restore`` is the right door. It reads disk into memory and stops, so
    this is synchronous, opens no socket, and cannot fail on an unreachable provider. A cold
    start with nothing on disk primes nothing and the poller populates it a moment later,
    which is correct.
    """
    found = state.celestrak.restore(state.settings.celestrak_groups)
    if not found:
        return
    state.satellites.replace_all((str(s.norad_cat_id), s) for s in found)
    _log.info("primed %d satellites from the element cache", len(found))


def create_app(
    settings: Settings | None = None,
    *,
    start_background_tasks: bool = True,
    http_client: httpx.AsyncClient | None = None,
) -> FastAPI:
    """Build the application.

    ``start_background_tasks=False`` builds a fully working API over empty stores, which
    is what almost every test wants: real routing and real contracts, no network and no
    clock dependence.
    """
    resolved = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        client = http_client or httpx.AsyncClient(
            timeout=httpx.Timeout(resolved.http_timeout_seconds),
            limits=httpx.Limits(
                max_connections=resolved.http_max_connections,
                max_keepalive_connections=resolved.http_max_keepalive,
            ),
            # **No ``Accept`` header, and that is deliberate.** This used to send
            # ``application/json``, which was a claim about every upstream this project talks
            # to and it was false: GTFS-Realtime is protobuf, the Kystverket feed is NMEA
            # text, GeoNames is a zip, the imagery layers are PNG and JPEG and several
            # registries are CSV. Measured 2026-08-24 through the running app: **32 of the
            # transit feeds answered HTTP 406 Not Acceptable** and 12 to 16 feeds failed on
            # every sweep, because a server honouring the header refused to send protobuf to a
            # client that had asked for JSON. httpx sends ``*/*`` when this is absent, which is
            # the truthful thing for a client with no preference, and no adapter here relies on
            # content negotiation for JSON: they all say ``format=json``, ``f=json`` or
            # ``[out:json]`` in the request itself, or POST JSON and get JSON back.
            headers={"User-Agent": resolved.user_agent},
            follow_redirects=True,
            # httpx's own default trust store plus the one intermediate certificate the Seaway
            # hosts fail to send. Set on the shared client because httpx fixes the SSL context
            # per client rather than per request, and it is safe there: the intermediate is
            # already trusted transitively through a root in the default bundle, so no host
            # becomes trusted that was not trusted before. See sources/seaway.ssl_context.
            verify=seaway.ssl_context(),
        )
        state = build_state(resolved, client)
        app.state.tracker = state
        background: list[asyncio.Task[None]] = []

        _prime_satellites_from_cache(state)

        if start_background_tasks:
            state.pollers.start_all()
            if state.aisstream is not None:
                state.aisstream.start()
            state.hub.start()
            # Not in the poller group: a weekly bulk download is not a feed, and a poller
            # would need a layer name and a delta channel that a static file has no use for.
            background.append(
                asyncio.create_task(_refresh_cities_forever(state), name=CITY_REFRESH_TASK_NAME)
            )
            # Also outside the poller group, and for the same reason: a daily 73MB register
            # and a weekly company list are bulk downloads rather than feeds, with no delta
            # channel a static file could use.
            background.append(
                asyncio.create_task(
                    _refresh_ownership_forever(state), name=OWNERSHIP_REFRESH_TASK_NAME
                )
            )
            _log.info("started %d pollers and the broadcast loop", len(state.pollers))

        try:
            yield
        finally:
            if start_background_tasks:
                await state.pollers.stop_all()
                if state.aisstream is not None:
                    await state.aisstream.stop()
                await state.hub.stop()
            for task in background:
                task.cancel()
            for task in background:
                # Awaited rather than left cancelled, so a shutdown cannot race a refresh
                # into writing an index nobody will read, and asyncio never logs the task as
                # destroyed while pending.
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            if http_client is None:
                await client.aclose()

    app = FastAPI(
        title="Tracker",
        version="0.1.0",
        summary="Real public data on an interactive globe",
        description=(
            "Live aircraft, ships, satellites, public cameras and geolocated events, "
            "served from real public feeds. Every response names its source and licence."
        ),
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved.cors_origins),
        allow_credentials=False,
        allow_methods=["GET"],
        allow_headers=["*"],
    )
    # The gazetteer read is 34,072 rows and 10.2MB of JSON, measured against the real dump on
    # 2026-08-20, and the browser asks for all of it on every page load. Gzipped it is 1.57MB,
    # an 85% cut, and the aircraft and vessel snapshots shrink for free. There is no reverse
    # proxy in this deployment (FastAPI serves the built bundle itself), so nothing else was
    # ever going to do it. Level 1 rather than the default 9: it keeps 80% of the saving for a
    # seventh of the CPU, 40ms against 274ms on the city body.
    app.add_middleware(GZipMiddleware, minimum_size=GZIP_MINIMUM_BYTES, compresslevel=1)

    app.include_router(routes_meta.router)
    app.include_router(routes_entities.router)
    # The media proxy ADR 005 requires: post media is fetched and cached by us rather than
    # hot-linked from a provider. It needs state.http, state.cache and settings.cache_dir,
    # all of which already exist, and no new setting and no key.
    app.include_router(routes_media.router)
    # Social posts, ADR 005. The router owns its own full paths, like routes_media.
    app.include_router(routes_social.router)
    # The removal control ADR 008 requires. It refuses with 403 unless the app is bound to
    # loopback, because a removal that anyone on the network can post is not a control.
    app.include_router(routes_removals.router)
    app.include_router(routes_ws.router)
    return app
