"""One query in, everything we hold out: aircraft, vessels, satellites, cities and places.

The search box is the only navigation this globe has, so it resolves every identity in the
system rather than making somebody pick a layer first. A live callsign, an MMSI, "ISS",
"Rotterdam" and "10 Downing Street" all go in the same field, and results come back grouped by
type with the groups ordered by how well their best hit matched.

**There is no secondary index and there is no cache of live entities.** Every mover query is a
linear scan over the stores' own snapshots, which is the only design here that cannot go stale:
a store is the single copy of the truth, ``snapshot()`` is what the API and the WebSocket
already serve, and a callsign index maintained alongside it would need invalidation on every
upsert and every expiry. The store publishes changes through
:meth:`~tracker.services.store.EntityStore.take_changes`, and that is *drained* by the hub, so
an index here could not subscribe to it without starving the WebSocket of deltas. Measured on
2026-08-20 against stores holding 8,400 aircraft, 3,000 vessels and 60 element sets: a
callsign, an MMSI and "ISS" resolve in 2.1 to 3.0 ms each, and 19.6 to 23.4 ms with coverage
instrumentation on, against the 300 ms this phase is judged against. The scan is asserted at
that scale by a test that logs what it measured.

**A city hit never leaves the process, and that is the point.**
:class:`~tracker.services.gazetteer.CityIndex` holds no HTTP client and takes no URL, so the
common case costs no network at all and cannot be made to. Nominatim is consulted only when
every local group came back empty, because its own usage policy calls systematic querying
unacceptable use and caps us at an absolute maximum of one request per second. See
``sources/nominatim.py`` for the provider's exact words and the throttle that honours them.
City ranking is not reimplemented here either: the index already puts an exact name above a
longer prefix and then orders by population, which is the same order this service ranks by, so
it is asked for exactly the number of rows the group will show.

**Adding a group is a few lines and not a registration API.** A group is one constructor
argument, one entry in :data:`GROUP_ORDER` and one function that yields
:class:`_Scored` candidates. Phase 6 adds organisations and profiles that way. There is no
plugin registry, no base class and no dispatch table, because two known future callers do not
justify one and the explicit version is shorter than the machinery would be.

**Ranking rules, all asserted by tests.**

- An exact identifier beats an exact name, which beats a prefix, which beats a substring. A
  substring only counts from :data:`MIN_SUBSTRING_CHARS` characters, so a one-letter query does
  not match half the ocean.
- Cities tie-break on population, which is what makes "London" mean the English one: the
  GeoNames rows are 8,961,989 for London GB against 422,324 for London CA, a factor of 21, so
  no special case is needed anywhere.
- Movers tie-break on freshness, so where two records score the same the one whose position was
  fixed more recently comes first.
- One entity appears once. The aircraft and military stores overlap by design (``/v2/mil`` is a
  worldwide sweep and ``/v2/point`` is a radius), so a military aircraft inside the viewport is
  in both, and de-duplication on the entity's own identity is what stops it being offered twice.

**A group is never silently empty.** Where a group could not be consulted at all it comes back
carrying the reason, the same rule ``/api/capabilities`` follows for a missing key. That covers
the places group with no contact email or a geocoder that failed, and the cities group before
the weekly gazetteer has landed. An empty group with no reason means the search genuinely found
nothing.

**An empty gazetteer does not become a geocoder query.** The fall-through to Nominatim is
guarded on the local index holding something, because "every local group came back empty" is
not evidence a query needs a geocoder when there was nothing local to search.
"""

import logging
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Literal

import httpx
from pydantic import Field

from tracker.contracts.base import ContractViolationError, StrictModel
from tracker.contracts.geo import Point
from tracker.services.gazetteer import CityIndex, fold
from tracker.sources.base import SourceError, describe_exception
from tracker.sources.nominatim import NominatimClient, Place, normalise_query

if TYPE_CHECKING:
    from tracker.contracts.aircraft import Aircraft
    from tracker.contracts.city import City
    from tracker.contracts.satellite import Satellite
    from tracker.contracts.vessel import Vessel
    from tracker.services.store import EntityStore

_log = logging.getLogger(__name__)

type SearchGroupName = Literal["aircraft", "vessels", "satellites", "cities", "places"]

GROUP_ORDER: Final = ("aircraft", "vessels", "satellites", "cities", "places")
"""Tie-break order when two groups' best hits score the same, so output is deterministic.

Movers first because a query that matches a live entity is almost always about that entity,
and places last because it is the only group that costs a network call.
"""

DEFAULT_LIMIT: Final = 8
"""Hits per group. A grouped typeahead showing five groups already fills a panel."""

IDENTIFIER_EXACT_SCORE: Final = 1.0
"""An exact hex, callsign, registration, MMSI, IMO or catalogue number. Nothing beats it."""

NAME_EXACT_SCORE: Final = 0.9
"""An exact name. Below an identifier because names are not unique: 1,307 city names in the
GeoNames extract appear more than once, with nine Victorias."""

PREFIX_FACTOR: Final = 0.6
"""Applied to the exact score when the query is a prefix of the value."""

SUBSTRING_FACTOR: Final = 0.3
"""Applied to the exact score when the query appears inside the value. Names only."""

MIN_SUBSTRING_CHARS: Final = 3
"""Shortest query that may match mid-value.

Two purposes, and the second is the one that matters. It keeps a two-letter query from
matching most of a vessel store, and it bounds the work the scan does: without it the query
"a" scores a hit for nearly every record in every store, and the ranking then has to build
and sort tens of thousands of candidates inside the 300 ms budget.
"""

INDEX_MATCH_SCORE: Final = 0.25
"""Floor for a record an index returned whose name we cannot see matching the query.

The gazetteer indexes each city under its name *and* GeoNames' own ASCII transliteration, and
the two are not the same fold: ``Köln`` folds to ``koln`` while its ASCII column is ``Koeln``,
so the query "koeln" legitimately returns a row whose name matches nothing. Nominatim is worse:
"10 downing street" is not a prefix of anything in its own answer. Scoring either zero would
silently discard the index's own result, which reads as missing coverage rather than as a bug
here, so the score is floored instead.
"""

MIN_REMOTE_QUERY_CHARS: Final = 3
"""Shortest query allowed to reach Nominatim.

The provider names systematic querying as unacceptable use and a typeahead is systematic by
nature. One and two-character queries are answered locally or not at all.
"""

PLACES_UNAVAILABLE_REASON: Final = (
    "Nominatim needs contact details in the User-Agent; set TRACKER_CONTACT_EMAIL"
)
"""Why the places group is off when no Nominatim client was wired.

There is exactly one reason to leave it out, so the reason lives here rather than being passed
in and worded differently by each caller. ``Settings.osm_services_available`` is the gate, and
the wiring reads it: with no contact email the client is not built and this group reports
itself unavailable instead of calling the provider anonymously.
"""

SHORT_QUERY_REASON: Final = f"query is shorter than {MIN_REMOTE_QUERY_CHARS} characters"
"""Why the places group is empty on a very short query with no local hit."""

CITIES_UNLOADED_REASON: Final = "the local city gazetteer holds nothing yet"
"""Why the cities group could not be consulted at all.

The gazetteer is a weekly file, so between start-up and the first successful download there
is no index to search, and a failed download leaves none for as long as the retry takes. The
search box has to say so: without this the response is indistinguishable from "no city called
that", and the fall-through would send every city query to Nominatim, which is the systematic
querying its usage policy names as unacceptable use.
"""

MAX_REASON_CHARS: Final = 300
"""Ceiling on an ``unavailable_reason``, and the reason a degraded group is not a 500.

An httpx ``HTTPStatusError`` renders the whole request URL, so the percent-encoded query is
inside the string: a 79-character query, or a 14-character Cyrillic one, pushed the reason
past this and the contract failure escaped as an HTTP 500 from a route whose whole job was to
report the geocoder being down. Clipped at the point of construction, never validated away.
"""


class SearchHit(StrictModel):
    """One thing the query resolved to, ready to render in a grouped typeahead."""

    group: SearchGroupName
    entity_id: str = Field(
        min_length=1,
        max_length=64,
        description="The identity the rest of the system knows this by: an ICAO 24-bit "
        "address, an MMSI, a NORAD catalogue number, a GeoNames id, or an OSM type and id. "
        "What the frontend uses to open the card, so it is the store's key and never a "
        "generated one.",
    )
    label: str = Field(min_length=1, max_length=200, description="What to show, one line.")
    detail: str | None = Field(
        default=None,
        max_length=500,
        description="Second line: the identifiers or the country and population that tell two "
        "same-named results apart.",
    )
    point: Point | None = Field(
        default=None,
        description="Where to fly the camera. None for a satellite, whose position is "
        "propagated in the browser from its element set and is not a field on the record.",
    )
    score: float = Field(
        ge=0.0,
        le=1.0,
        description="Match quality, 1.0 for an exact identifier. Ordering inside a group is "
        "the order of the tuple, not this number alone: equal scores are already broken by "
        "population for cities and by freshness for movers.",
    )


class SearchGroup(StrictModel):
    """The hits of one type, best first.

    ``unavailable_reason`` is what stops a degraded group reading as an empty world. Set when
    the group could not be consulted at all; ``None`` with no hits means it was consulted and
    matched nothing.
    """

    name: SearchGroupName
    hits: tuple[SearchHit, ...] = ()
    unavailable_reason: str | None = Field(default=None, max_length=MAX_REASON_CHARS)


class SearchResponse(StrictModel):
    """Everything one query resolved to, groups ordered by their best hit."""

    query: str = Field(max_length=200, description="The query as asked, whitespace trimmed.")
    groups: tuple[SearchGroup, ...] = ()


@dataclass(frozen=True, slots=True)
class _Scored:
    """One candidate hit with the two numbers that order it.

    ``tiebreak`` is compared only between candidates of equal ``score``, and each group decides
    what it means: population for a city, importance for a place, and negative position age for
    a mover so the freshest report wins.
    """

    score: float
    tiebreak: float
    hit: SearchHit


def _identifier_score(query: str, value: str | None) -> float:
    """Score a query against an identifier: exact, then prefix, and never a substring.

    A substring of an identifier is noise. "992" appears inside a great many MMSIs and inside
    no MMSI that anybody meant.
    """
    if not value:
        return 0.0
    folded = value.casefold()
    if folded == query:
        return IDENTIFIER_EXACT_SCORE
    if folded.startswith(query):
        return IDENTIFIER_EXACT_SCORE * PREFIX_FACTOR
    return 0.0


def _name_score(query: str, value: str | None) -> float:
    """Score a query against a name: exact, then prefix, then substring."""
    if not value:
        return 0.0
    folded = value.casefold()
    if folded == query:
        return NAME_EXACT_SCORE
    if folded.startswith(query):
        return NAME_EXACT_SCORE * PREFIX_FACTOR
    if len(query) >= MIN_SUBSTRING_CHARS and query in folded:
        return NAME_EXACT_SCORE * SUBSTRING_FACTOR
    return 0.0


def _joined(*parts: str | None) -> str | None:
    """Join the parts that exist into one detail line, or ``None`` when none do."""
    kept = [part for part in parts if part]
    return " · ".join(kept) if kept else None


def _best(candidates: Iterable[_Scored], limit: int) -> tuple[SearchHit, ...]:
    """Rank, de-duplicate on entity identity, and cut to ``limit``.

    De-duplication happens here rather than in each group because every group can produce the
    same entity twice: the aircraft and military stores overlap, and a city can match on both
    its name and an alternate spelling.
    """
    seen: set[str] = set()
    hits: list[SearchHit] = []
    for candidate in sorted(candidates, key=lambda item: (-item.score, -item.tiebreak)):
        if candidate.hit.entity_id in seen:
            continue
        seen.add(candidate.hit.entity_id)
        hits.append(candidate.hit)
        if len(hits) >= limit:
            break
    return tuple(hits)


def _aircraft_candidates(
    stores: "Sequence[EntityStore[Aircraft]]", query: str
) -> Iterable[_Scored]:
    """Match a query against every live aircraft by hex, callsign and registration.

    The callsign is scored as an identifier rather than a name: "RAM801F" is a flight number,
    and a mid-string match on it means nothing.
    """
    for store in stores:
        for aircraft in store.snapshot():
            score = max(
                _identifier_score(query, aircraft.icao24),
                _identifier_score(query, aircraft.callsign),
                _identifier_score(query, aircraft.registration),
            )
            if score <= 0.0:
                continue
            yield _Scored(
                score=score,
                tiebreak=-aircraft.position_age_s,
                hit=SearchHit(
                    group="aircraft",
                    entity_id=aircraft.icao24,
                    label=aircraft.label,
                    detail=_joined(
                        aircraft.registration,
                        aircraft.type_designator,
                        aircraft.icao24.upper(),
                    ),
                    point=aircraft.point,
                    score=score,
                ),
            )


def _vessel_candidates(stores: "Sequence[EntityStore[Vessel]]", query: str) -> Iterable[_Scored]:
    """Match a query against every live vessel by name, MMSI and IMO number."""
    for store in stores:
        for vessel in store.snapshot():
            imo = str(vessel.imo) if vessel.imo is not None else None
            score = max(
                _name_score(query, vessel.name),
                _identifier_score(query, vessel.mmsi),
                _identifier_score(query, imo),
                _identifier_score(query, vessel.call_sign),
            )
            if score <= 0.0:
                continue
            yield _Scored(
                score=score,
                tiebreak=-vessel.position_age_s,
                hit=SearchHit(
                    group="vessels",
                    entity_id=vessel.mmsi,
                    label=vessel.label,
                    detail=_joined(
                        f"MMSI {vessel.mmsi}",
                        f"IMO {imo}" if imo else None,
                        vessel.call_sign,
                    ),
                    point=vessel.point,
                    score=score,
                ),
            )


def _satellite_candidates(
    stores: "Sequence[EntityStore[Satellite]]", query: str
) -> Iterable[_Scored]:
    """Match a query against every element set by object name, catalogue number and designator.

    The hit carries no position. A satellite's position is propagated in the browser from the
    element set, so there is nothing on the record to fly to and inventing one server-side
    would be a second source of truth for the same thing.
    """
    for store in stores:
        for satellite in store.snapshot():
            catalogue = str(satellite.norad_cat_id)
            score = max(
                _name_score(query, satellite.object_name),
                _identifier_score(query, catalogue),
                _identifier_score(query, satellite.object_id),
            )
            if score <= 0.0:
                continue
            yield _Scored(
                score=score,
                tiebreak=0.0,
                hit=SearchHit(
                    group="satellites",
                    entity_id=catalogue,
                    label=satellite.object_name or f"NORAD {catalogue}",
                    detail=_joined(f"NORAD {catalogue}", satellite.object_id),
                    score=score,
                ),
            )


def _city_candidates(rows: "Sequence[City]", query: str) -> Iterable[_Scored]:
    """Score the gazetteer's candidates, floored so its own answers cannot be discarded.

    Scored through :func:`~tracker.services.gazetteer.fold`, the index's own key function,
    rather than a plain case-fold. Anything else re-ranks the index's answers against a
    different notion of equality: "zurich" is an exact match on "Zürich" under the fold and a
    non-match without it, so a worse prefix hit would climb above it.
    """
    key = fold(query)
    for city in rows:
        score = max(
            _name_score(key, fold(city.name)),
            _name_score(key, fold(city.ascii_name)),
            INDEX_MATCH_SCORE,
        )
        yield _Scored(
            score=score,
            tiebreak=float(city.population),
            hit=SearchHit(
                group="cities",
                entity_id=str(city.geonames_id),
                label=city.name,
                detail=f"{city.country_code} · population {city.population:,}",
                point=city.point,
                score=score,
            ),
        )


def _place_candidates(places: Sequence[Place], query: str) -> Iterable[_Scored]:
    """Score geocoder answers, keeping the provider's own ordering as the tie-break.

    Nothing is discarded on a zero name score. The geocoder matched the query however it
    matched it, and "10 Downing Street" is not a prefix of anything in its own result.
    """
    for place in places:
        score = max(_name_score(query, place.name), INDEX_MATCH_SCORE)
        yield _Scored(
            score=score,
            tiebreak=place.importance or 0.0,
            hit=SearchHit(
                group="places",
                entity_id=place.osm_key,
                label=place.name,
                detail=place.display_name,
                point=place.point,
                score=score,
            ),
        )


def _degraded(name: SearchGroupName, reason: str) -> SearchGroup:
    """A group carrying why it has no hits, clipped to what the contract accepts.

    Every dynamic reason goes through here. The one that overflowed was an httpx status error,
    which renders the whole request URL and so carries the percent-encoded query inside it, and
    the contract failure turned a degraded group into an HTTP 500.
    """
    return SearchGroup(name=name, unavailable_reason=reason[:MAX_REASON_CHARS])


def _rank_groups(groups: Iterable[SearchGroup]) -> tuple[SearchGroup, ...]:
    """Order groups by their best hit, ties broken by :data:`GROUP_ORDER`."""

    def key(group: SearchGroup) -> tuple[float, int]:
        best = -group.hits[0].score if group.hits else 0.0
        return (best, GROUP_ORDER.index(group.name))

    return tuple(sorted(groups, key=key))


class SearchService:
    """Resolves one query against every identity in the system.

    Every argument is optional so a partly wired app still answers: a deployment with no
    satellite feed simply has no satellite group, rather than a group that raises.

    Args:
        aircraft: Live aircraft stores. Several, because the aircraft layer and the military
            sweep are separate stores of the same contract and both are searchable.
        vessels: Live vessel stores.
        satellites: Element set stores.
        cities: The in-memory GeoNames index. It cannot make an HTTP request, so a city hit
            never leaving the process is a fact about the type rather than a rule. An index
            holding nothing reports :data:`CITIES_UNLOADED_REASON` and stops the query
            reaching Nominatim.
        places: The Nominatim client, or ``None`` when no contact email is configured. The
            wiring decides, from ``Settings.osm_services_available``; with ``None`` the places
            group reports :data:`PLACES_UNAVAILABLE_REASON` rather than calling anonymously.
    """

    def __init__(
        self,
        *,
        aircraft: "Sequence[EntityStore[Aircraft]]" = (),
        vessels: "Sequence[EntityStore[Vessel]]" = (),
        satellites: "Sequence[EntityStore[Satellite]]" = (),
        cities: CityIndex | None = None,
        places: NominatimClient | None = None,
    ) -> None:
        self._aircraft = aircraft
        self._vessels = vessels
        self._satellites = satellites
        self._cities = cities
        self._places = places

    async def search(self, query: str, *, limit: int = DEFAULT_LIMIT) -> SearchResponse:
        """Resolve one query into grouped, ranked hits.

        Local groups are searched first and Nominatim is consulted only when every one of them
        came back empty, which is what keeps the geocoder off the hot path.

        Args:
            query: Free text: a callsign, a hex, an MMSI, an IMO, a satellite name, a NORAD
                number, a city, or an address.
            limit: Maximum hits per group.

        Returns:
            The groups that matched, best group first. Empty groups are omitted, except a group
            that carries a reason it could not answer at all.
        """
        folded = normalise_query(query)
        trimmed = " ".join(query.split())
        if not folded:
            return SearchResponse(query=trimmed)

        local: dict[SearchGroupName, tuple[SearchHit, ...]] = {
            "aircraft": _best(_aircraft_candidates(self._aircraft, folded), limit),
            "vessels": _best(_vessel_candidates(self._vessels, folded), limit),
            "satellites": _best(_satellite_candidates(self._satellites, folded), limit),
            "cities": _best(self._city_candidates_for(trimmed, limit), limit),
        }
        groups = [SearchGroup(name=name, hits=hits) for name, hits in local.items() if hits]
        if groups:
            return SearchResponse(query=trimmed, groups=_rank_groups(groups))

        if self._gazetteer_is_empty():
            # Nothing local can match while the index holds nothing, so "every local group came
            # back empty" is not evidence that the query needs a geocoder. Answering it with
            # Nominatim would point a typeahead at the provider for every city query for as
            # long as the gazetteer is down, and answering it with a bare empty group would
            # tell the search box the place does not exist.
            return SearchResponse(
                query=trimmed,
                groups=(_degraded("cities", CITIES_UNLOADED_REASON),),
            )

        return SearchResponse(query=trimmed, groups=(await self._places_group(folded, limit),))

    def _gazetteer_is_empty(self) -> bool:
        """Whether a city index is wired and holds nothing.

        Empty is the degraded state, not absent, and the difference matters. ``AppState`` always
        wires an index and fills it when the weekly download lands, so an empty one means the
        download has not landed yet or failed. ``None`` means this service was built without a
        city group at all, which is a deployment choice rather than a fault and leaves the
        geocoder alone to do its own job.
        """
        return self._cities is not None and len(self._cities) == 0

    def _city_candidates_for(self, trimmed: str, limit: int) -> Iterable[_Scored]:
        """Ask the gazetteer for candidates, if one is wired.

        The index gets the query with its case and accents intact, because it owns the fold and
        the ASCII-column matching. It is asked for exactly ``limit`` rows rather than a wider
        candidate set: it already ranks exact matches above longer prefixes and then by
        population, which is the same order this service ranks by, so a wider ask would buy
        nothing and a narrower one could not hide a larger city.
        """
        if self._cities is None:
            return ()
        return _city_candidates(self._cities.search(trimmed, limit=limit), trimmed)

    async def _places_group(self, folded: str, limit: int) -> SearchGroup:
        """The geocoder group, always carrying either hits or the reason it has none."""
        if self._places is None:
            return _degraded("places", PLACES_UNAVAILABLE_REASON)
        if len(folded) < MIN_REMOTE_QUERY_CHARS:
            return _degraded("places", SHORT_QUERY_REASON)
        try:
            places = await self._places.search(folded)
        except (SourceError, ContractViolationError, httpx.HTTPError) as exc:
            reason = describe_exception(exc)
            _log.info("places search unavailable: %s", reason)
            return _degraded("places", reason)
        return SearchGroup(name="places", hits=_best(_place_candidates(places, folded), limit))
