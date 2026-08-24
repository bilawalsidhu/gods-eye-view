"""Nominatim forward geocoding: the only path in this project where a search query leaves us.

Demand-driven, cached per unique query, and hard-capped at one request per second. It is not
a poller and it must never become one. Verified live 2026-08-19 against
``GET /search?q=London&format=jsonv2&limit=5&addressdetails=1&extratags=1`` (HTTP 200, three
results) and ``q=10+Downing+Street,+London`` (HTTP 200, one result). Both recordings are in
``tests/fixtures/nominatim_search_*_live.json``.

**The cap is the provider's own words and it is an absolute maximum, not a target.** From
https://operations.osmfoundation.org/policies/nominatim/ retrieved 2026-08-19: "No heavy uses
(an absolute maximum of 1 request per second)", "Results must be cached on your side. Clients
sending repeatedly the same query may be classified as faulty and blocked", and, under
unacceptable use, "Systematic queries. This includes reverse queries in a grid, searching for
complete lists of postcodes, towns etc." That is why the city list comes from the GeoNames
dump and never from here, why :data:`MIN_INTERVAL_SECONDS` is a constant with no setting that
can raise it, and why a query answered from cache never reaches the network again.

**Which is also why the cache goes to disk.** "Results must be cached on your side" is a
condition of use, and a cache that empties on every restart does not meet it: the same query
was re-sent after every stop and start, which is the pattern the provider names as faulty. With
a :class:`~tracker.cache.DiskCache` passed in, answers persist with no expiry and the cooldown
the provider asked for on a 429 or a block page persists with them. The one-per-second slot is
deliberately **not** persisted: a process restart takes longer than a second, so it would buy
nothing and cost a disk write on every keystroke that reached the network.

**The gate refuses rather than sleeps.** A search box fires on keystrokes. Sleeping a second
inside a request would queue every subsequent keystroke behind it and the browser would show a
frozen typeahead; refusing costs that one keystroke its remote results and nothing else. The
refusal is a :class:`~tracker.sources.base.RateLimitedError` subclass, so callers that already
branch on throttling need no new case.

Traps this module handles, every one measured on the recorded responses:

- **``lat`` and ``lon`` are strings.** ``"51.5074456"``, not ``51.5074456``. Our domain models
  are ``strict=True`` and reject a string for a float, so the conversion happens here. The wire
  model declares them as ``str`` on purpose: if the provider ever switches to numbers, the
  record is dropped and counted rather than silently coerced.
- **``boundingbox`` is four strings in latitude-first order, ``[south, north, west, east]``.**
  Proved on the recorded Greater London result: ``["51.2867601", "51.6918741", "-0.5103751",
  "0.3340155"]``. That is a different order from our own ``BoundingBox``, from the OSM notes
  API's ``bbox={w},{s},{e},{n}``, from Overpass's ``(south, west, north, east)`` and from
  aisstream's ``[latitude, longitude]``. Five conventions, one project. Written down here
  because nothing reads the field: search flies the camera to a point at a fixed altitude, so
  the extent has no consumer and is not carried into the domain. Anyone who adds one starts
  from this order.
- **``format=jsonv2`` returns ``category`` and ``addresstype``, and there is no ``class``
  key.** The older ``format=json`` uses ``class`` instead. The format string is pinned in
  :data:`RESPONSE_FORMAT`, same discipline as CelesTrak's ``FORMAT``. Neither field is
  carried: nothing ranks or renders on them.
- **``limit`` is a ceiling, not a count.** ``limit=5`` for "London" returned three results,
  because Nominatim collapses duplicates. Nothing here asserts a length.
- **The top hit for "London" is named "Greater London".** It is a boundary relation whose
  ``lat``/``lon`` are a representative point for the polygon rather than a city centre. This is
  why the city layer answers "London" from GeoNames and this module is only ever consulted when
  the local index has nothing.
- **``addresstype`` is not a place type.** On the Downing Street result it reads ``office``,
  with ``place_rank`` 30. A geocoder answer is not necessarily a settlement, so nothing here
  pretends a :class:`Place` is a city. ``place_rank`` is not carried either, and carrying it
  behind a ``le=30`` bound would have dropped a whole live result the day the provider went
  past its own documented ceiling, for a field with no reader.
- **``importance`` orders results inside one response and means nothing across two.** Carried
  for ranking within a response and never compared between queries.
- **The response carries no date at all.** :attr:`Place.retrieved_at` is our fetch time. It is
  not a fact about the place and must never be shown as one.

Licence: ODbL, and the API hands us the exact credit string per record in ``licence``, so the
record carries its own attribution into the domain rather than relying on a hand-written
constant. :data:`ATTRIBUTION` is the string the provider actually returned, for the layer-level
credit the frontend renders.

**No contact email, no requests.** The usage policy requires a User-Agent identifying the
application, and the shared client builds one from ``Settings.contact_email``. The wiring
constructs this client only when ``Settings.osm_services_available`` is true; with it false the
search service reports the places group unavailable with a reason, exactly like a missing key.
"""

import logging
from collections import Counter
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any, Final

import httpx
from pydantic import Field, TypeAdapter, ValidationError

from tracker.cache import DiskCache
from tracker.cache import key as cache_key
from tracker.contracts.base import ContractViolationError, StrictModel, UtcDatetime, WireModel
from tracker.contracts.geo import Point
from tracker.sources.base import (
    DEFAULT_RATE_LIMIT_BACKOFF_SECONDS,
    RATE_LIMIT_STATUS_CODES,
    ParsedRecords,
    RateLimitedError,
    SourceError,
    retry_after_seconds,
)

_log = logging.getLogger(__name__)

SOURCE_NAME: Final = "nominatim"
"""Per-record provider name, the same field every other adapter here fills."""

BASE_URL: Final = "https://nominatim.openstreetmap.org"
"""The OSMF-run instance. A self-hosted or commercial instance is a constructor argument."""

SEARCH_PATH: Final = "/search"

RESPONSE_FORMAT: Final = "jsonv2"
"""Pinned explicitly. ``format=json`` sends ``class`` where this sends ``category``, so the
two are not interchangeable and the default is not documented as stable."""

SEARCH_LIMIT: Final = 5
"""Results asked for per query. A ceiling: "London" returned three at ``limit=5``."""

MIN_INTERVAL_SECONDS: Final = 1.0
"""The provider's own absolute maximum of one request per second.

A constant, not a setting, and there is no constructor argument for it. A demand-driven
lookup has no poll interval to slow down, so this is where the cadence floor lives, and the
failure it prevents is a typeahead firing a request per keystroke and getting the shared
egress IP classified as faulty.
"""

MAX_CACHED_QUERIES: Final = 4096
"""How many distinct queries are remembered before the oldest is evicted.

Caching is a condition of use here rather than an optimisation, so the cache is unbounded in
time and bounded only in size. At roughly 1 KB per answer this is a few megabytes.
"""

ATTRIBUTION: Final = "Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright"
"""The credit string, verbatim from the ``licence`` field of every recorded record.

Every :class:`Place` carries its own copy, because ODbL attribution travels with the data. This
constant exists for the layer-level credit the frontend renders.
"""


def _now() -> datetime:
    return datetime.now(UTC)


OUR_FLOOR_REASON: Final = (
    f"self-imposed floor of one request per {MIN_INTERVAL_SECONDS:.0f}s not yet elapsed"
)
"""Why a call was refused before it was sent: our own cadence gate."""

PROVIDER_COOLDOWN_REASON: Final = "still inside the backoff the provider asked for"
"""Why a call was refused before it was sent: the provider's own figure, being honoured."""

BLOCK_STATUS_CODES: Final = frozenset({httpx.codes.FORBIDDEN})
"""Statuses that mean "stopped serving you", not "broke this once".

Nominatim answers a blocked client with a 403 block page rather than a 429, so it carries no
``Retry-After`` and nothing about it looks like a rate limit. A 500 is deliberately not in
here: ``sources/base.py`` already makes the point that a 500 is worth retrying promptly and a
throttle is not, and treating the two the same would silence the geocoder for two minutes over
one bad response.
"""

BLOCK_COOLDOWN_SECONDS: Final = DEFAULT_RATE_LIMIT_BACKOFF_SECONDS
"""How long a block holds this client off.

Nominatim publishes no figure for a block, so this borrows the same generous default used
when a 429 carries no ``Retry-After``. Guessing short is how an IP gets blocked for good.
"""


class NominatimThrottledError(RateLimitedError):
    """A call was refused before anything was sent.

    A :class:`~tracker.sources.base.RateLimitedError` subclass because every caller that backs
    off already branches on that type, and 429 is what Nominatim would eventually answer if we
    let it get that far. The distinct class and the message exist so a log line reads as "we
    stopped ourselves" rather than sending someone looking for a response that never happened.

    ``because`` names which gate refused: our own one-per-second floor, or the cooldown the
    provider itself asked for on a 429 or a block page.
    """

    def __init__(self, *, retry_after: float, because: str = OUR_FLOOR_REASON) -> None:
        self.status_code = 429
        self.retry_after_seconds = max(retry_after, MIN_INTERVAL_SECONDS)
        SourceError.__init__(
            self,
            SOURCE_NAME,
            f"{because}; no request made, retry in {self.retry_after_seconds:.1f}s",
        )


class NominatimPlaceWire(WireModel):
    """One element of the bare JSON list ``/search`` returns.

    Only what something reads. ``name`` and ``importance`` are optional because a permissive
    wire model that loses a whole record over one absent display field is a strict model
    wearing a disguise. ``category``, ``type``, ``addresstype``, ``place_rank`` and
    ``boundingbox`` are all sent and none of them is modelled, because nothing ranks, renders
    or flies on them; the traps they carry are in the module docstring so a later reader does
    not have to measure them again. ``address`` and ``extratags`` are absent entirely unless
    requested, have no fixed key set (the ``ISO3166-2-lvl{n}`` keys are numbered by admin
    level), and are the same answer.
    """

    osm_type: str
    osm_id: int
    lat: str
    lon: str
    display_name: str
    licence: str
    name: str | None = None
    importance: float | None = None


class Place(StrictModel):
    """One geocoded place, mapped into the domain.

    Not a city and not an entity: a Nominatim answer can be a boundary relation, a building or
    a government office. It has no store, no expiry and no live position, so it is a search
    result and the search service is its only consumer.
    """

    osm_type: str = Field(
        min_length=1,
        max_length=20,
        description="relation, way or node. With osm_id it is the stable identity; place_id "
        "is deliberately not carried because the provider documents it as an internal id "
        "that differs between installations and changes on reimport.",
    )
    osm_id: int = Field(ge=1)
    name: str = Field(
        min_length=1,
        max_length=200,
        description="Short label. Falls back to the first element of display_name when the "
        "provider sends no name, which is why it is never empty here.",
    )
    display_name: str = Field(min_length=1, max_length=500)
    point: Point = Field(
        description="Longitude first, ours. The provider sends lat and lon as strings.",
    )
    importance: float | None = Field(
        default=None,
        description="The provider's own ranking figure for this result. Deliberately "
        "unbounded: it is documented as roughly 0 to 1 rather than exactly, and it orders "
        "results inside one response only.",
    )
    licence: str = Field(
        min_length=1,
        max_length=200,
        description="The credit string the provider attached to this record. ODbL "
        "attribution travels with the data, so it rides on the record rather than being "
        "looked up from a table somewhere else.",
    )
    retrieved_at: UtcDatetime = Field(
        description="When we fetched this answer. Nominatim sends no date of its own, so this "
        "is not a fact about the place and must not be rendered as one.",
    )
    source: str = Field(default=SOURCE_NAME, min_length=1, max_length=40)

    # Plain property, not a pydantic computed field, for the reason at contracts/aircraft.py:160.
    @property
    def osm_key(self) -> str:
        """OSM's own identity for this object, e.g. ``relation/175342``."""
        return f"{self.osm_type}/{self.osm_id}"


_LIST_ADAPTER: Final = TypeAdapter(list[dict[str, Any]])
"""The response is a bare JSON list. Parsed to raw mappings first so one malformed element
costs that element rather than the whole answer."""

_PLACES_ADAPTER: Final = TypeAdapter(tuple[Place, ...])
"""How a cached answer is written to and read back from disk: domain records, not wire ones.

The wire body is not stored. A cached answer is already mapped and already dropped-and-counted,
so re-parsing it on the way back in would mean the drop counts from a previous process
appeared as this one's. It also means a cached record cannot be looser than the contract.
"""

CACHE_NAMESPACE: Final = SOURCE_NAME
"""Prefix for every key this adapter writes, so the whole source can be cleared at once."""


def normalise_query(raw: str) -> str:
    """Fold a query to the form used as both the cache key and the ``q`` parameter.

    Case-folded and whitespace-collapsed, so "London", "london" and " London " are one cached
    query rather than three requests. Nominatim is case-insensitive, so nothing is lost.

    Args:
        raw: The user's query.

    Returns:
        The folded query, empty when the input was only whitespace.
    """
    return " ".join(raw.split()).casefold()


def _coordinate(raw: str, field: str) -> float:
    """Parse one of the provider's string coordinates.

    Raises:
        ContractViolationError: The value is not a number, so the record has no position.
    """
    try:
        return float(raw)
    except ValueError as exc:
        msg = f"{field} {raw!r} is not a number"
        raise ContractViolationError(SOURCE_NAME, msg) from exc


def _to_domain(wire: NominatimPlaceWire, *, retrieved_at: datetime) -> Place:
    """Map one wire record to the domain contract.

    Raises:
        ContractViolationError: A coordinate is unparseable, or the record carries no usable
            display name.
        pydantic.ValidationError: A mapped value is outside the domain contract, for example a
            bounding box whose south edge is north of its north edge.
    """
    name = wire.name or wire.display_name.split(",")[0].strip()
    if not name:
        msg = f"{wire.osm_type}/{wire.osm_id} carries no usable name"
        raise ContractViolationError(SOURCE_NAME, msg)

    return Place(
        osm_type=wire.osm_type,
        osm_id=wire.osm_id,
        name=name,
        display_name=wire.display_name,
        point=Point(
            lon=_coordinate(wire.lon, "lon"),
            lat=_coordinate(wire.lat, "lat"),
        ),
        importance=wire.importance,
        licence=wire.licence,
        retrieved_at=retrieved_at,
    )


def parse_search(payload: bytes | str, *, retrieved_at: datetime) -> ParsedRecords[Place]:
    """Parse a 200 body from ``/search`` into places, counting whatever will not map.

    Args:
        payload: Raw response body.
        retrieved_at: When the response arrived, timezone-aware.

    Returns:
        The places that mapped, and a count of the rest keyed by reason.

    Raises:
        ContractViolationError: The body is not a JSON list of objects, which means the
            endpoint or the ``format`` parameter has changed shape.
    """
    try:
        raw_records = _LIST_ADAPTER.validate_json(payload)
    except ValidationError as exc:
        msg = f"response is not a JSON list of objects ({exc.error_count()} errors)"
        raise ContractViolationError(SOURCE_NAME, msg) from exc

    places: list[Place] = []
    drops: Counter[str] = Counter()
    for raw in raw_records:
        try:
            wire = NominatimPlaceWire.model_validate(raw)
            places.append(_to_domain(wire, retrieved_at=retrieved_at))
        except ContractViolationError as exc:
            drops[exc.detail] += 1
            _log.info("%s dropped a result: %s", SOURCE_NAME, exc.detail)
        except ValidationError as exc:
            reason = f"{exc.error_count()} contract errors"
            drops[reason] += 1
            _log.info("%s dropped a result: %s", SOURCE_NAME, reason)
    return ParsedRecords(records=tuple(places), drops=drops)


class NominatimClient:
    """Cached, throttled forward geocoding. One instance per process.

    Holds the cache and the one-per-second floor, so it has to live for the process rather
    than being built per request. Building one per search would make both guarantees
    meaningless: the cache the usage policy requires would be empty every time, and the floor
    would never see the previous call.

    An empty answer is cached like any other. A query with no match will not grow one, and
    re-asking it on every keystroke is exactly the pattern the provider calls faulty. A
    *failure* is never cached, so a transient error does not turn into an hour of "no such
    place".

    Not thread-safe, like everything else in this package: one event loop owns it.
    """

    # ponytail: no in-flight coalescing and no LRU ordering, just insertion-order eviction.
    # Two concurrent first-time searches for the same query cost one request and one refusal
    # rather than one request, and a hot query evicted at 4,096 distinct queries is re-fetched
    # once. Both are cheaper than the bookkeeping, and the one-per-second floor is the thing
    # that actually protects the provider.

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        base_url: str = BASE_URL,
        clock: Callable[[], datetime] = _now,
        cache: DiskCache | None = None,
    ) -> None:
        self._client = client
        self._base_url = base_url.rstrip("/")
        self._clock = clock
        self._cache: dict[str, tuple[Place, ...]] = {}
        self._last_request_at: datetime | None = None
        self._not_before: datetime | None = None
        self._disk = cache
        self.drops: Counter[str] = Counter()
        """Records the provider sent that would not map, keyed by reason, since start-up."""

    async def search(self, query: str) -> tuple[Place, ...]:
        """Geocode one query, from cache when we have already asked it.

        Args:
            query: Free text. Folded by :func:`normalise_query`, which is also the cache key,
                so case and stray whitespace never cost a second request.

        Returns:
            Up to :data:`SEARCH_LIMIT` places, best first as the provider ordered them. Empty
            when the provider found nothing, which is cached.

        Raises:
            NominatimThrottledError: The one-per-second floor has not elapsed. Nothing was
                sent and nothing was cached, so the caller may retry.
            RateLimitedError: Nominatim asked us to back off.
            ContractViolationError: The response is not the documented shape.
            httpx.HTTPError: Transport failure or a non-2xx status.
        """
        key = normalise_query(query)
        if not key:
            return ()
        cached = self._recall(key)
        if cached is not None:
            return cached

        self._reserve_request_slot()
        try:
            places = await self._fetch(key)
        except RateLimitedError as exc:
            self._hold_off(exc.retry_after_seconds)
            raise
        except httpx.HTTPStatusError as exc:
            # A provider that has stopped serving us is not a provider to ask again in a
            # second, and its block page carries no Retry-After to read.
            if exc.response.status_code in BLOCK_STATUS_CODES:
                self._hold_off(BLOCK_COOLDOWN_SECONDS)
            raise
        self._remember(key, places)
        return places

    def _reserve_request_slot(self) -> None:
        """Spend the one-per-second slot, or refuse before touching the network.

        Two gates, both checked before anything is sent: the cooldown the provider last asked
        for, and our own cadence floor. Without the first, a 429 carrying ``Retry-After: 120``
        was answered with another request one second later, 120 times inside the window the
        provider asked us to stay out of, while the reason string handed back to the caller
        said we were backing off.
        """
        now = self._clock()
        not_before = self._cooldown_until()
        if not_before is not None and now < not_before:
            raise NominatimThrottledError(
                retry_after=(not_before - now).total_seconds(),
                because=PROVIDER_COOLDOWN_REASON,
            )
        last = self._last_request_at
        if last is not None:
            waited = (now - last).total_seconds()
            if waited < MIN_INTERVAL_SECONDS:
                raise NominatimThrottledError(retry_after=MIN_INTERVAL_SECONDS - waited)
        self._last_request_at = now

    def _cooldown_until(self) -> datetime | None:
        """When the provider's own cooldown lifts, from disk when there is a cache.

        Read through to disk rather than trusted from memory, so a cooldown a previous process
        was asked for is honoured by this one. A 403 block page carries no ``Retry-After`` and
        borrows a two-minute default, and restarting inside those two minutes used to send the
        next keystroke straight at a provider that had just stopped serving us.
        """
        if self._disk is not None:
            return self._disk.get_time(cache_key(CACHE_NAMESPACE, "not_before"))
        return self._not_before

    def _cooldown_remaining(self) -> float:
        """Seconds left on the provider's cooldown, or zero when there is none."""
        until = self._cooldown_until()
        if until is None:
            return 0.0
        return max(0.0, (until - self._clock()).total_seconds())

    def _hold_off(self, seconds: float) -> None:
        """Refuse every call for this long, never shortening a cooldown already in force.

        The ``max`` makes that a property of the arithmetic rather than a branch somebody has
        to remember. Guessing short is how an IP gets blocked for good, so the longer figure
        always wins.
        """
        until = self._clock() + timedelta(seconds=max(seconds, self._cooldown_remaining()))
        self._not_before = until
        if self._disk is not None:
            self._disk.set_time(cache_key(CACHE_NAMESPACE, "not_before"), until)
        _log.warning("%s: holding off until %s", SOURCE_NAME, until.isoformat())

    def _recall(self, key: str) -> tuple[Place, ...] | None:
        """One cached answer, reading disk through into memory on a first miss.

        No time to live. The provider's terms make caching mandatory, and a place does not
        move: an answer from a previous run is the same answer this run would get. An entry
        that will not parse back is dropped rather than kept failing on.
        """
        cached = self._cache.get(key)
        if cached is not None or self._disk is None:
            return cached
        stored = self._disk.get(cache_key(CACHE_NAMESPACE, "q", key))
        if stored is None:
            return None
        try:
            places = _PLACES_ADAPTER.validate_json(stored.value)
        except ValidationError as exc:
            _log.warning(
                "%s: cached answer for %r is unreadable (%s); dropping", SOURCE_NAME, key, exc
            )
            self._disk.delete(cache_key(CACHE_NAMESPACE, "q", key))
            return None
        self._cache[key] = places
        return places

    def _remember(self, key: str, places: tuple[Place, ...]) -> None:
        """Cache one answer, evicting the oldest in-memory entry once the cache is full.

        The disk copy is deliberately unbounded. An answer is about a kilobyte, the terms
        require the cache, and a person typing into a search box on one laptop is not going to
        fill a disk. :data:`MAX_CACHED_QUERIES` bounds the resident copy only, so an evicted
        hot query is served off disk instead of being re-fetched.
        """
        if len(self._cache) >= MAX_CACHED_QUERIES:
            oldest = next(iter(self._cache))
            del self._cache[oldest]
        self._cache[key] = places
        if self._disk is not None:
            self._disk.set(
                cache_key(CACHE_NAMESPACE, "q", key), _PLACES_ADAPTER.dump_json(places).decode()
            )

    async def _fetch(self, query: str) -> tuple[Place, ...]:
        response = await self._client.get(
            f"{self._base_url}{SEARCH_PATH}",
            params={"q": query, "format": RESPONSE_FORMAT, "limit": SEARCH_LIMIT},
        )
        if response.status_code in RATE_LIMIT_STATUS_CODES:
            raise RateLimitedError(SOURCE_NAME, response.status_code, retry_after_seconds(response))
        response.raise_for_status()

        parsed = parse_search(response.content, retrieved_at=self._clock())
        self.drops.update(parsed.drops)
        if parsed.drops and not parsed.records:
            # The provider answered and not one record mapped, which is a shape change rather
            # than "no such place". Raising is what keeps it out of the cache: an empty tuple
            # remembered here would answer that query for the life of the process, long after
            # the provider was fixed, and the only trace would be an INFO log line.
            raise SourceError(
                SOURCE_NAME,
                f"the provider sent {sum(parsed.drops.values())} results and none of them "
                f"mapped: {dict(parsed.drops)}",
            )
        return parsed.records
