"""adsbdb aircraft registry lookup: demand-driven, cached, one call per key per session.

This is not a poller. It is keyed on a Mode S hex or a registration and called when a card
needs an owner, so the cache is the point of the module rather than an optimisation bolted
onto it. Verified live 2026-08-19 against ``GET /v0/aircraft/A835AF``.

**Why the cache carries a miss as well as a hit.** About 19% of genuine aircraft on a live
adsb.lol sweep are simply not in adsbdb: of the first 20 hexes in
``tests/fixtures/adsb_point_live.json``, 13 answered 200 and 7 answered 404, and three of
those 404s were real aircraft with real registrations (``0201a0``/CN-RHF, ``4080e9``/G-TNED,
``4080e0``/G-TTNW). A 404 is normal operation, not a fault. Caching only the hits means the
19% is re-fetched on every card open, which is the obvious way to get the shared egress IP
blocked. So a miss is cached as ``None`` and a *failure* is not cached at all: see
:meth:`AdsbdbLookup.aircraft`.

**The rate limit is not published, it is read off the provider's own source.**
``src/db_redis/ratelimit.rs`` on ``main`` sets ``LOWER_LIMIT`` 512 and ``UPPER_LIMIT`` 1024
against a 60-second window, per IP. At 512 requests in a minute adsbdb starts refusing with
a 60-second penalty; at 1024 the penalty becomes 300 seconds. No response carries any
``X-RateLimit-*`` header and a 200 carries no ``Retry-After``, so remaining budget cannot be
discovered from the wire and has to be counted here. :data:`MAX_REQUESTS_PER_MINUTE` is our
own half-of-the-lower-limit budget, a constant with no constructor argument and no setting
that can raise it.

**Licence: there is none.** No LICENSE terms for the data, no terms page. The aircraft data
is credited to PlaneBase (``planebase.biz``), a commercial database, with no redistribution
grant given. ``url_photo`` is a hot-link into airport-data.com, and AGENTS.md forbids
hot-linking media, so :attr:`AircraftRegistration.photo_url` must be proxied and cached
before a browser ever sees it. The scheme check in :func:`_photo_url` is the adapter's half
of that: the proxy still owes a host allowlist, because a URL from an upstream reaching an
outbound fetcher unchecked is server-side request forgery.

**The callsign endpoint is deliberately absent from this module.** ``/v0/callsign/{cs}`` and
the combined ``/v0/aircraft/{hex}?callsign={cs}`` form both return flight-route data which
the provider's README says "may not be copied, published, or incorporated into other
databases without the explicit permission of David J Taylor, Edinburgh". Serving an
origin/destination pair to a browser is publishing it and storing it in our SQLite file is
incorporating it. Same class of blocker as ADS-B Exchange in AGENTS.md. Not implemented, and
it should not be added without that written permission.

Other traps this module handles, all verified on 2026-08-19:

- **``mode_s`` comes back uppercase whatever case you send.** adsb.lol emits lowercase and
  :attr:`tracker.contracts.aircraft.Aircraft.icao24` is lowercase, so the address is folded
  down here. Folding the other way would make the registry key miss every feed record.
- **One route serves both hex and registration.** ``/v0/aircraft/N628TS`` and
  ``/v0/aircraft/A835AF`` return byte-identical bodies, so a successful answer is also
  cached under both of its own identifiers.
- **404 is the only failure mode and it is indistinguishable from bad input.** A real unknown
  hex and the garbage input ``ZZ`` both return ``404 {"response":"unknown aircraft"}``. A 404
  whose body is *not* that string is treated as a contract violation rather than a cached
  miss, because a moved or withdrawn endpoint 404ing every request would otherwise fill the
  cache with day-long "this aircraft does not exist" answers and look like poor coverage.
- **There is no operator field.** The plan asks this lookup for "owner, operator, type and
  photo". It gives one string, ``registered_owner``, and nothing that separates a beneficial
  owner from an operator. ``registered_owner_operator_flag_code`` is a flag-*image* code
  (``"EWG"`` for a Eurowings A320, ``"G650"`` for a private Gulfstream), not an ICAO operator
  code, so it is not carried at all.
- **The record has no date of its own**, so :attr:`AircraftRegistration.retrieved_at` is when
  we fetched it and nothing else. It is not a registry extract date.
- **This cache holds personal data, so it has an eviction path and never touches disk.**
  ``registered_owner`` is a named individual on a great many N-numbers. ADR 008 makes a
  removal a product feature and the TTL here is a day, so a removal with no way into this
  cache would report success while the deleted name kept being served.
  :meth:`AdsbdbLookup.forget` is that way in. It is also the one cache in ``sources/`` that
  was deliberately left out of :class:`~tracker.cache.DiskCache`; the reasoning is on
  :class:`AdsbdbLookup` and a test asserts that no owner name reaches the cache file.
- **Two identifier widths used to be wider here than on the aircraft contract**, 20 against
  12 for a registration and 8 against 4 for a type designator, so a registry answer that was
  legal on its own contract cost the whole airframe its enrichment when the merge revalidated
  it. The widths now agree and the adapter drops the offending value on its own: see
  :data:`REGISTRATION_MAX_CHARS` and :data:`TYPE_DESIGNATOR_MAX_CHARS`.
"""

import json
import logging
import re
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from typing import Final
from urllib.parse import quote

import httpx
from pydantic import Field, TypeAdapter

from tracker.contracts.aircraft import Aircraft
from tracker.contracts.base import (
    ContractViolationError,
    StrictModel,
    UtcDatetime,
    WireModel,
    validate_payload,
)
from tracker.sources.base import (
    RATE_LIMIT_STATUS_CODES,
    RateLimitedError,
    SourceError,
    retry_after_seconds,
)

_log = logging.getLogger(__name__)

SOURCE_NAME: Final = "adsbdb"
"""Per-record provider name, per ADR 010. Never a per-layer field."""

BASE_URL: Final = "https://api.adsbdb.com"
"""Documented base is ``https://api.adsbdb.com/v[semver.major]``, so ``/v0`` tracks the 0.x
line. ``GET /v0/online`` reported ``api_version 0.6.5`` on 2026-08-19: the URL major version
and the software version are different numbers and the URL one moves far more slowly."""

AIRCRAFT_PATH_TEMPLATE: Final = "/v0/aircraft/{key}"

UNKNOWN_AIRCRAFT_RESPONSE: Final = "unknown aircraft"
"""Exact ``response`` string in a 404 body. The callsign endpoint says ``unknown callsign``
instead, so this doubles as a guard against having called the wrong route."""

ATTRIBUTION: Final = (
    "Aircraft registry data via adsbdb, sourced from PlaneBase. Photos via airport-data.com."
)
"""Shown on any card carrying a value from this source. There is no licence granting
redistribution, so attribution is the floor rather than the whole obligation."""

PROVIDER_LOWER_LIMIT_PER_MINUTE: Final = 512
"""adsbdb's own ``LOWER_LIMIT``: at this many requests in 60 seconds it starts refusing."""

PROVIDER_UPPER_LIMIT_PER_MINUTE: Final = 1024
"""adsbdb's own ``UPPER_LIMIT``: exceeding it extends the block from 60 to 300 seconds."""

MAX_REQUESTS_PER_MINUTE: Final = PROVIDER_LOWER_LIMIT_PER_MINUTE // 2
"""Our budget, half the provider's floor, held as a constant on purpose.

A demand-driven lookup has no poll interval to slow down, so this is where the cadence floor
lives. Nothing in the constructor and nothing in configuration can raise it, because the
failure it prevents is one enrichment pass over a full globe firing several hundred lookups
in a second and earning a five-minute block for the whole egress IP.
"""

RATE_WINDOW_SECONDS: Final = 60.0
"""The window adsbdb counts in, per its own ``ONE_MINUTE_AS_SEC``."""

DEFAULT_CACHE_TTL_SECONDS: Final = 86_400.0
"""One day. Ownership changes happen on registry timescales, not on globe timescales."""

ICAO_ADDRESS_HEX_DIGITS: Final = 6
"""An ICAO 24-bit address is exactly six hex digits."""

OWNER_MAX_CHARS: Final = 120
"""Matches :attr:`tracker.contracts.aircraft.Aircraft.owner`, so an unusually long name
cannot map here and then fail when the enrichment writes it onto the aircraft."""

REGISTRATION_MAX_CHARS: Final = 12
"""Matches :attr:`tracker.contracts.aircraft.Aircraft.registration`, and the same 12 that
:data:`LOOKUP_KEY_PATTERN` already allows a lookup key.

This field used to take 20. Nothing real is lost by narrowing it: the longest tail number in
service is about eight characters with its hyphen, and a 13-character value was never going
to reach an aircraft record anyway, because the merge revalidates against the aircraft
contract. What the 20 bought was the failure being discovered one layer too late, where the
whole airframe lost its enrichment over one field.
"""

TYPE_DESIGNATOR_MAX_CHARS: Final = 4
"""Matches :attr:`tracker.contracts.aircraft.Aircraft.type_designator`.

An ICAO Doc 8643 designator is two to four characters by the standard, so this is the width
the thing itself has and not a guess. This field used to take 8. A longer value is a
data-quality signal about the registry rather than a designator, and it is dropped and
logged here rather than carried to the merge to fail there.
"""

LOOKUP_KEY_PATTERN: Final = re.compile(r"^[A-Z0-9][A-Z0-9-]{1,11}$")
"""What a Mode S hex or a registration can look like: 2 to 12 characters, alphanumeric plus
the hyphen that Canadian (``C-FPFW``) and Australian (``VH-ABC``) marks carry."""

_HEX_DIGITS: Final = frozenset("0123456789abcdef")
_RATE_WINDOW: Final = timedelta(seconds=RATE_WINDOW_SECONDS)


def _now() -> datetime:
    return datetime.now(UTC)


class AdsbdbBudgetExhaustedError(RateLimitedError):
    """Our own per-minute budget is spent, so no request was made.

    A :class:`~tracker.sources.base.RateLimitedError` subclass because every caller that
    wants to back off already branches on that type, and 429 is the code adsbdb would send
    if we let it get that far. The distinct class and the message exist so a log line reads
    as "we stopped ourselves" rather than sending a debugger looking for an HTTP response
    that never happened.
    """

    def __init__(self, *, retry_after: float) -> None:
        self.status_code = int(HTTPStatus.TOO_MANY_REQUESTS)
        self.retry_after_seconds = max(retry_after, 1.0)
        SourceError.__init__(
            self,
            SOURCE_NAME,
            f"self-imposed budget of {MAX_REQUESTS_PER_MINUTE} requests per "
            f"{RATE_WINDOW_SECONDS:.0f}s is spent; no request made, retry in "
            f"{self.retry_after_seconds:.0f}s",
        )


class AdsbdbAircraftWire(WireModel):
    """One aircraft record exactly as ``/v0/aircraft/{key}`` sends it.

    ``type`` is aliased to ``model_name`` because it is the marketing name (``"G650 ER"``)
    and not a designator, which is ``icao_type`` (``"G650"``). Mixing the two up is how a
    business-jet classification keyed on the ICAO designator silently matches nothing.

    ``registered_owner_operator_flag_code`` is present upstream and deliberately not
    modelled: it selects a flag image, not an operator.
    """

    mode_s: str
    registration: str | None = None
    icao_type: str | None = None
    manufacturer: str | None = None
    model_name: str | None = Field(default=None, alias="type")
    registered_owner: str | None = None
    registered_owner_country_iso_name: str | None = None
    registered_owner_country_name: str | None = None
    url_photo: str | None = None
    url_photo_thumbnail: str | None = None


class _AdsbdbResponseWire(WireModel):
    aircraft: AdsbdbAircraftWire


class AdsbdbEnvelopeWire(WireModel):
    """The ``response`` wrapper every adsbdb endpoint puts round its payload.

    On a 404 ``response`` is a bare string rather than an object, which fails validation
    here. That is intentional: the 404 is handled by status code before this model is
    reached, so a *200* carrying a string means the endpoint changed shape and should be a
    loud contract violation.
    """

    response: _AdsbdbResponseWire


_ENVELOPE_ADAPTER: Final = TypeAdapter(AdsbdbEnvelopeWire)


class AircraftRegistration(StrictModel):
    """What adsbdb knows about one airframe, mapped into the domain.

    Strict, frozen and safe to hand to the enrichment service. ``icao24`` is lowercase so it
    joins straight onto :attr:`tracker.contracts.aircraft.Aircraft.icao24`.
    """

    icao24: str = Field(
        pattern=r"^[0-9a-f]{6}$",
        description="ICAO 24-bit address, lowercase. adsbdb sends it uppercase; the feeds "
        "send it lowercase, and the feeds win because they are the merge key.",
    )
    registration: str | None = Field(
        default=None,
        max_length=REGISTRATION_MAX_CHARS,
        description="Tail number with its country prefix present, e.g. N628TS. Unlike the "
        "FAA, CCARCS and CASA bulk registries, adsbdb does not strip the prefix. Same "
        "width as the aircraft contract on purpose: a longer value is dropped in the "
        "adapter so it costs one field rather than the airframe's whole enrichment.",
    )
    icao_type: str | None = Field(
        default=None,
        max_length=TYPE_DESIGNATOR_MAX_CHARS,
        description="ICAO type designator, e.g. G650. This is the only source in the "
        "aviation group that supplies one for a US airframe: FAA ACFTREF.MODEL is "
        "'767-322', not 'B763'. Four characters, the width Doc 8643 gives a designator "
        "and the width the aircraft contract takes.",
    )
    model_name: str | None = Field(
        default=None,
        max_length=80,
        description="Marketing name, e.g. 'G650 ER'. Display only, never a match key.",
    )
    manufacturer: str | None = Field(default=None, max_length=80)
    owner: str | None = Field(
        default=None,
        max_length=OWNER_MAX_CHARS,
        description="adsbdb's registered_owner. One string covering owner and operator "
        "together; nothing in the payload separates a beneficial owner from an operator, "
        "so no operator field is claimed.",
    )
    owner_country: str | None = Field(default=None, max_length=80)
    owner_country_iso: str | None = Field(default=None, max_length=2)
    photo_url: str | None = Field(
        default=None,
        max_length=500,
        description="Third-party photograph, https only. Must be proxied and cached before "
        "a browser sees it, and the proxy owes a host allowlist of its own.",
    )
    photo_thumbnail_url: str | None = Field(default=None, max_length=500)
    retrieved_at: UtcDatetime = Field(
        description="When we fetched this record. adsbdb carries no date of its own, so "
        "this is not a registry extract date and must not be shown as one."
    )
    source: str = Field(default=SOURCE_NAME, min_length=1, max_length=40)


@dataclass(frozen=True, slots=True)
class _CachedLookup:
    """One answered lookup, hit or miss.

    ``registration is None`` means adsbdb answered 404: the registry does not hold this
    airframe. A *failed* lookup is never stored, so "we asked and got nothing" and "we could
    not ask" stay distinguishable.
    """

    fetched_at: datetime
    registration: AircraftRegistration | None


def _cached_identities(key: str, entry: _CachedLookup) -> frozenset[str]:
    """Every lookup key one cached answer can be reached by.

    The key it was stored under plus, on a hit, the record's own address and registration,
    folded the way :func:`normalise_lookup_key` folds them. This is the inverse of
    :meth:`AdsbdbLookup._remember` and the two have to stay that way: a removal that misses
    an alias leaves the owner's name reachable by another route.
    """
    record = entry.registration
    if record is None:
        return frozenset({key})
    aliases = (record.icao24, record.registration)
    return frozenset({key, *(alias.strip().upper() for alias in aliases if alias)})


def _text(raw: str | None, limit: int) -> str | None:
    """Strip, clip to ``limit``, and turn a blank into ``None``."""
    if raw is None:
        return None
    value = raw.strip()[:limit]
    return value or None


def _photo_url(raw: str | None) -> str | None:
    """Keep an https photo URL, drop anything else.

    Nothing in the payload is trusted to reach an outbound fetcher. A non-https value is
    dropped and logged rather than passed on: the media proxy is the thing that would make
    the request, and handing it ``file://`` or a link-local address is server-side request
    forgery. This is the cheap half of the defence; the proxy still owes a host allowlist.
    """
    value = _text(raw, 500)
    if value is None:
        return None
    if not value.startswith("https://"):
        _log.info("dropping non-https photo URL from %s", SOURCE_NAME)
        return None
    return value


def _identifier(raw: str | None, limit: int, *, field: str) -> str | None:
    """Keep an identifier that fits, drop one that does not, and never clip one.

    The other text fields here are clipped by :func:`_text`, and a clipped owner name is
    still recognisably the same company. A clipped registration or type designator is a
    different aircraft, so an over-long value is dropped and logged instead.

    Dropping it here rather than at the merge is the whole point. The merge revalidates
    against the aircraft contract, so an over-long value raises there and the enrichment
    service counts the *record* as unmappable: the airframe keeps its position and loses its
    owner, its country and its class over one bad field. One field dropped and counted is
    this project's own rule, applied at the width the field actually has.
    """
    if raw is None:
        return None
    value = raw.strip()
    if not value:
        return None
    if len(value) > limit:
        _log.info("dropping over-long %s from %s: over %d characters", field, SOURCE_NAME, limit)
        return None
    return value


def _to_domain(wire: AdsbdbAircraftWire, *, retrieved_at: datetime) -> AircraftRegistration:
    """Map the wire record to the domain contract.

    Raises:
        ContractViolationError: ``mode_s`` is not a six-digit hex address, which means the
            join key is unusable and the record cannot be attached to anything.
    """
    icao24 = wire.mode_s.strip().lower()
    if len(icao24) != ICAO_ADDRESS_HEX_DIGITS or not _HEX_DIGITS.issuperset(icao24):
        raise ContractViolationError(SOURCE_NAME, f"unusable mode_s {wire.mode_s!r}")

    return AircraftRegistration(
        icao24=icao24,
        registration=_identifier(wire.registration, REGISTRATION_MAX_CHARS, field="registration"),
        icao_type=_identifier(wire.icao_type, TYPE_DESIGNATOR_MAX_CHARS, field="icao_type"),
        model_name=_text(wire.model_name, 80),
        manufacturer=_text(wire.manufacturer, 80),
        owner=_text(wire.registered_owner, OWNER_MAX_CHARS),
        owner_country=_text(wire.registered_owner_country_name, 80),
        owner_country_iso=_text(wire.registered_owner_country_iso_name, 2),
        photo_url=_photo_url(wire.url_photo),
        photo_thumbnail_url=_photo_url(wire.url_photo_thumbnail),
        retrieved_at=retrieved_at,
    )


def parse_aircraft(payload: bytes | str, *, retrieved_at: datetime) -> AircraftRegistration:
    """Parse a 200 body from ``/v0/aircraft/{key}`` into the domain contract.

    Args:
        payload: Raw response body.
        retrieved_at: When the response arrived, timezone-aware.

    Returns:
        The mapped registry record.

    Raises:
        ContractViolationError: The envelope is not an aircraft object, or the Mode S
            address in it is unusable.
    """
    envelope = validate_payload(_ENVELOPE_ADAPTER, payload, source=SOURCE_NAME)
    return _to_domain(envelope.response.aircraft, retrieved_at=retrieved_at)


def apply_to_aircraft(aircraft: Aircraft, registration: AircraftRegistration) -> Aircraft:
    """Write this registry record's facts onto a live aircraft, and nothing else.

    The merge half of the phase 3 join: :class:`~tracker.services.enrich.Enricher` calls
    this, then reverts any attribute the feed had already supplied and keeps the
    disagreement as a conflict. So this maps generously and the service arbitrates, which
    is why nothing here checks whether a field is already set.

    Four fields and no more. ``owner`` and ``registered_country`` are what the registry is
    for. ``registration`` and ``type_designator`` are mapped because a feed record often
    carries neither: the ``/v2/mil`` capture has ``r`` on 59 of 65 records, and an aircraft
    with no designator classifies as ``UNKNOWN`` until a register supplies one. Both are also
    where this registry disagrees with the feed most often, which the service records rather
    than resolves.

    **The type designator is the trap.** adsbdb's ``icao_type`` is not always an ICAO Doc
    8643 designator. On the real record in ``tests/fixtures/adsbdb_ab374c_live.json`` the
    feed says ``GLF6``, which is Doc 8643's designator for the Gulfstream G650, and adsbdb
    says ``G650``, which is not a designator at all. Taking the registry's word for it would
    move that airframe out of
    :data:`~tracker.services.classify.BUSINESS_JET_TYPE_DESIGNATORS` and declassify a real
    business jet. Feed-wins in the enrichment service is what stops that, and a test asserts
    the class survives the join.

    No operator is written, because adsbdb has none: one ``registered_owner`` string covers
    owner and operator together and nothing in the payload separates them. No photo either.
    ``photo_url`` is a hot-link into airport-data.com and AGENTS.md forbids hot-linking
    media, so it stays on :class:`AircraftRegistration` for a proxy to fetch and never rides
    onto a record that is served to a browser.

    **Nothing this adapter produces can fail here on width any more, and the round trip
    stays anyway.** :class:`AircraftRegistration` used to allow a 20-character registration
    and an 8-character type against the aircraft contract's 12 and 4, so a registry answer
    that was legal on its own contract raised here and the enrichment service counted the
    whole record unmappable: the airframe kept its position and lost its owner, its country
    and its class over one field. The two contracts now agree on width and
    :func:`_identifier` drops an over-long value where it arrives, so one bad field costs one
    field. The revalidation below is kept because ``model_copy`` on its own puts an
    unvalidated value onto a record that is served to a browser, and because phase 5 adds
    three more registries mapping into this same shape.

    Raises:
        pydantic.ValidationError: The registry sent something the aircraft contract will not
            take, and the enrichment service counts it as unmappable and keeps the feed's
            record. The round trip through the wire format is what this project already
            guarantees for every contract (it is why computed fields are banned,
            ``contracts/aircraft.py:160``).
    """
    proposed = aircraft.model_copy(
        update={
            "owner": registration.owner,
            "registered_country": registration.owner_country,
            "registration": registration.registration,
            "type_designator": registration.icao_type,
        }
    )
    return Aircraft.model_validate_json(proposed.model_dump_json())


def is_unknown_aircraft(payload: bytes | str) -> bool:
    """Whether a 404 body is adsbdb saying it does not hold this airframe.

    Exists so a 404 from a moved or withdrawn endpoint is not cached as a genuine miss. That
    failure mode would be silent for a day per key and would read as poor registry coverage
    rather than as a broken URL.
    """
    try:
        raw = json.loads(payload)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return False
    return isinstance(raw, dict) and raw.get("response") == UNKNOWN_AIRCRAFT_RESPONSE


def normalise_lookup_key(raw: str) -> str:
    """Fold a hex or registration to the form adsbdb answers on, and reject junk.

    adsbdb is case-insensitive on input and always uppercase on output, so upper-casing here
    means a lowercase feed hex and an uppercase registry hex share one cache entry instead of
    costing two requests.

    Args:
        raw: A Mode S hex or a registration.

    Returns:
        The stripped, upper-cased key.

    Raises:
        ValueError: The key cannot be either identifier. Callers passing an
            :class:`~tracker.contracts.aircraft.Aircraft` address are safe by construction,
            because that field is already contract-validated to six hex digits. A ``r``
            field straight off a feed is not, and is untrusted text going into a URL path.
    """
    key = raw.strip().upper()
    if not LOOKUP_KEY_PATTERN.match(key):
        msg = f"{raw!r} is neither a Mode S address nor a registration"
        raise ValueError(msg)
    return key


class AdsbdbLookup:
    """Cached, demand-driven registry lookups.

    Holds the cache and the request budget, so one instance must live for the process rather
    than being built per request. That is also what makes the "no repeat call for the same
    hex in a session" guarantee mean anything.

    **This cache stays in memory, and that is a decision rather than an omission.** Every
    other rate guard in ``sources/`` was moved onto :class:`~tracker.cache.DiskCache` on
    2026-08-20 so a restart could not look like hammering. This one was deliberately left
    out. Three reasons, in the order they mattered:

    - **It holds personal data.** ``registered_owner`` is a named individual on a great many
      N-numbers, which is the whole reason :meth:`forget` exists. A restart clearing it is the
      correct behaviour for a cache of named people, not a cost to be engineered away.
    - **Persisting it would put personal data in a file that a removal has to reach.** ADR 008
      makes removal immediate, with no queue and no human step. A disk copy means the removal
      is only as good as its eviction path, and the aliases make that path subtle: one answer
      is written under the requested key, the record's own address and its registration, so a
      removal that cleared one key would leave the name reachable by the other two and report
      success while doing it. That is worse than a slow removal, because it looks like it
      worked. Not holding the file is the version of that with nothing to get wrong.
    - **A restart's refill is paced elsewhere, so it does not need to be avoided here.**
      Corrected 2026-08-24, when :class:`tracker.services.ingest.RegistryIngest` was added: it
      used to say "nothing polls adsbdb, so a restart produces no burst", and something does
      now. A restart empties this cache and the background ingest refills it, so a restart
      **does** replay traffic. What makes that safe is not the cache: it is the ingest's pace,
      64 requests a minute, a quarter of :data:`MAX_REQUESTS_PER_MINUTE` and an eighth of the
      provider's own lower limit, plus a backoff that is on disk precisely because a restart
      loop is indistinguishable from hammering. So the burst this bullet used to rule out is
      now bounded by a number in ``services/ingest.py`` rather than by there being no caller,
      and persisting the answers would buy a smaller refill at the cost of holding named people
      in a file the removal has to reach through three alias keys. The first two reasons above
      are what keep this in memory; this one no longer argues either way.

    ``tests/sources/test_adsbdb.py`` asserts the consequence rather than the intent: after a
    real lookup, an owner's name appears nowhere in the cache file. If someone later wires
    this onto the disk cache, that test fails and the removal path has to arrive with it.

    Not thread-safe, and neither is anything else in this package: one event loop owns it.
    Concurrent first-time lookups of the *same* key will both issue a request, because there
    is no in-flight de-duplication.
    """

    # ponytail: no in-flight coalescing. Two cards opened on one aircraft inside the same
    # round trip cost two requests instead of one. Add a per-key asyncio.Future map if the
    # request count ever gets near MAX_REQUESTS_PER_MINUTE; the cache handles every other case.

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        base_url: str = BASE_URL,
        clock: Callable[[], datetime] = _now,
    ) -> None:
        self._client = client
        self._base_url = base_url.rstrip("/")
        # A constant, not a setting. It had a constructor argument and a floor clamp guarding
        # it, and nothing in the product ever passed one, so the floor only ever protected
        # against the argument's own existence. The clock below is what a test needs to reach
        # the expiry branch; the TTL never needed to move.
        self._ttl = timedelta(seconds=DEFAULT_CACHE_TTL_SECONDS)
        self._clock = clock
        self._cache: dict[str, _CachedLookup] = {}
        self._requests: deque[datetime] = deque()

    async def aircraft(self, key: str) -> AircraftRegistration | None:
        """Look up one airframe by Mode S hex or registration.

        Answered from cache when there is a live entry, whether that entry is a hit or a
        miss. A successful record is also cached under its own address and registration, so
        the same aircraft asked for the other way round costs nothing.

        Args:
            key: Mode S hex (either case) or a registration with its country prefix.

        Returns:
            The registry record, or ``None`` when adsbdb does not hold this airframe. About
            19% of live aircraft fall in the second case and it is not an error.

        Raises:
            ValueError: ``key`` is neither identifier.
            AdsbdbBudgetExhaustedError: Our own per-minute budget is spent. Nothing was
                requested and nothing was cached, so the caller may retry later.
            RateLimitedError: adsbdb asked us to back off.
            ContractViolationError: A 200 that is not an aircraft envelope, or a 404 that is
                not adsbdb declining this airframe.
            httpx.HTTPError: Transport failure or a 5xx. Not cached, so the card degrades to
                feed-only data now and a later open tries again.
        """
        normalised = normalise_lookup_key(key)
        now = self._clock()
        entry = self._cache.get(normalised)
        if entry is not None and now - entry.fetched_at < self._ttl:
            return entry.registration

        found = await self._fetch(normalised)
        self._remember(normalised, _CachedLookup(fetched_at=now, registration=found))
        return found

    def holds(self, key: str) -> bool:
        """Whether :meth:`aircraft` would answer this key without opening a socket.

        True for a live hit **and** for a live miss, because a cached "adsbdb does not hold
        that airframe" is an answer and re-asking for it is exactly the 19% of the layer that
        would otherwise be re-fetched on every pass. False for an expired entry and for an
        entry that was never made.

        **This exists for the background ingest and not as an optimisation.**
        :class:`tracker.services.ingest.RegistryIngest` walks the layer 64 records a minute
        against a store of thirteen thousand, so it has to be able to skip what is already
        held: without that it would spend every batch re-reading the same cached answers and
        never reach the rest of the globe.

        Junk in gets ``False`` rather than an exception, because a caller asking whether
        something is cached has nothing useful to do with a raise and the honest answer to
        "do you hold this nonsense" is no. :meth:`aircraft` still refuses it loudly.
        """
        try:
            normalised = normalise_lookup_key(key)
        except ValueError:
            return False
        entry = self._cache.get(normalised)
        return entry is not None and self._clock() - entry.fetched_at < self._ttl

    @property
    def name(self) -> str:
        """What a removal calls this cache when reporting what it reached."""
        return f"{SOURCE_NAME} owner cache"

    def forget_all(self) -> int:
        """Empty the cache, and say how many entries went.

        The blunt companion to :meth:`forget`, and a removal under ADR 008 needs it rather than
        the precise version. ``forget`` takes an airframe key; a removal holds a person, and
        turning one into the other means comparing owner names, which means the removal path
        holding the name it is removing. So it sweeps. The cost is re-fetching owners that were
        nothing to do with the request, which is cheap and correct, against a cache that keeps
        serving a name somebody asked us to delete, which is neither.
        """
        gone = len(self._cache)
        self._cache.clear()
        return gone

    def forget(self, key: str) -> int:
        """Drop every cached answer for one airframe, whatever key it was stored under.

        **The removal hook ADR 008 needs, and it is not an optimisation.** A registered owner
        is a named individual on a great many N-numbers, so this cache holds personal data,
        and :data:`DEFAULT_CACHE_TTL_SECONDS` is a day. A removal that deleted a profile and
        could not reach this cache would report success while the deleted name kept being
        served for the rest of the day, which is worse than a slow removal.

        **The alias entries are the trap.** :meth:`_remember` writes one answer under the
        requested key, under the record's own address and under its registration, so clearing
        one key leaves the name reachable by the other two. This sweeps on identity instead:
        an entry goes if any key it can be reached by is wanted, and every key of everything
        dropped widens the sweep, so a stale entry left under a previous registration goes
        with the current one.

        **No suppression register here.** Phase 6 owns that, and it is what stops the next
        card open fetching the name again. This empties the cache and claims nothing more.

        Args:
            key: Mode S hex or registration, either case.

        Returns:
            How many cache entries were dropped. Zero means nothing was held for it.

        Raises:
            ValueError: ``key`` is neither identifier. A removal aimed at junk is loud rather
                than a silent success.
        """
        wanted = {normalise_lookup_key(key)}
        dropped = 0
        while doomed := [
            cached
            for cached, entry in self._cache.items()
            if not wanted.isdisjoint(_cached_identities(cached, entry))
        ]:
            for cached in doomed:
                wanted |= _cached_identities(cached, self._cache.pop(cached))
            dropped += len(doomed)
        _log.info("%s: forgot %d cached entries", SOURCE_NAME, dropped)
        return dropped

    def _remember(self, key: str, entry: _CachedLookup) -> None:
        """Cache the answer under the requested key and, on a hit, its own identifiers."""
        self._cache[key] = entry
        record = entry.registration
        if record is None:
            return
        for alias in (record.icao24, record.registration):
            if alias:
                self._cache[alias.strip().upper()] = entry

    async def _fetch(self, key: str) -> AircraftRegistration | None:
        self._reserve_request_slot()
        path = AIRCRAFT_PATH_TEMPLATE.format(key=quote(key, safe=""))
        response = await self._client.get(f"{self._base_url}{path}")

        if response.status_code in RATE_LIMIT_STATUS_CODES:
            raise RateLimitedError(SOURCE_NAME, response.status_code, retry_after_seconds(response))
        if response.status_code == HTTPStatus.NOT_FOUND:
            if not is_unknown_aircraft(response.content):
                raise ContractViolationError(
                    SOURCE_NAME,
                    f"HTTP 404 from {path} is not an unknown-aircraft answer; "
                    f"the endpoint has probably moved",
                )
            _log.debug("%s does not hold %s", SOURCE_NAME, key)
            return None

        response.raise_for_status()
        return parse_aircraft(response.content, retrieved_at=self._clock())

    def _reserve_request_slot(self) -> None:
        """Spend one request from the budget, or refuse before touching the network."""
        now = self._clock()
        cutoff = now - _RATE_WINDOW
        while self._requests and self._requests[0] <= cutoff:
            self._requests.popleft()
        if len(self._requests) >= MAX_REQUESTS_PER_MINUTE:
            raise AdsbdbBudgetExhaustedError(retry_after=RATE_WINDOW_SECONDS)
        self._requests.append(now)
