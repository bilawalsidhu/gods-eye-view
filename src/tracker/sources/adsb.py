"""ADS-B aircraft feed adapter.

Talks to any provider serving the readsb ``/v2`` schema, which means adsb.lol, adsb.fi
and ADSBexchange share this one adapter and are swappable by base URL alone. That is the
whole reason for the shape of this module: adsb.lol publishes no contractual rate limit
and plans to introduce keys, so being able to change provider without touching a parser
is worth more than any cleverness here.

Every provider quirk is confined to this file. Downstream code sees only
:class:`~tracker.contracts.aircraft.Aircraft`.
"""

import json
import logging
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final, Literal

import httpx
from pydantic import AliasChoices, Field, TypeAdapter

from tracker.cache import DiskCache
from tracker.cache import key as cache_key
from tracker.contracts.aircraft import Aircraft, EmergencyState
from tracker.contracts.base import ContractViolationError, WireModel, validate_payload
from tracker.contracts.geo import (
    FEET_PER_MINUTE_TO_METRES_PER_SECOND,
    FEET_TO_METRES,
    KNOTS_TO_METRES_PER_SECOND,
    BoundingBox,
    Point,
)
from tracker.services.classify import classified
from tracker.sources.base import (
    RATE_LIMIT_STATUS_CODES,
    ParsedRecords,
    RateLimitedError,
    SourceError,
    describe_exception,
    retry_after_seconds,
)

_log = logging.getLogger(__name__)

CACHE_NAMESPACE: Final = "adsb"
"""Prefix for every key this adapter writes, so the whole source can be cleared at once."""

HELD_OFF_STATUS: Final = 429
"""Status carried on an :class:`AdsbCoolingDownError`, where no response was received.

429 rather than the 420 adsb.lol actually sends, because this exception is our own refusal
and not a provider's answer. The provider's real status is in the log line written when the
cooldown was recorded.
"""


def _utc_now() -> datetime:
    """Wall clock, injectable so a cooldown boundary is asserted rather than slept through."""
    return datetime.now(UTC)


DB_FLAG_MILITARY: Final = 1
"""``dbFlags`` bit 1. Confirmed against a live /v2/mil response where all 391 records carried it."""

DB_FLAG_INTERESTING: Final = 2
DB_FLAG_PRIVACY_ICAO: Final = 4
"""``dbFlags`` bit 4. A privacy ICAO address: deliberately unresolvable to an owner."""

DB_FLAG_LADD: Final = 8
"""``dbFlags`` bit 8. The owner is on the FAA's Limiting Aircraft Data Displayed programme.

**This is the source for the LADD attribute, and it is a real one.** readsb documents the
bitfield as ``military = dbFlags & 1; interesting = dbFlags & 2; PIA = dbFlags & 4;
LADD = dbFlags & 8`` (``wiedehopf/readsb`` ``README-json.md``), and adsb.lol publishes
``/v2/ladd`` on top of it, summarised in its own OpenAPI document as "Aircrafts on LADD
(Limiting Aircraft Data Displayed)" with a link to the FAA's programme page. Verified live
on 2026-08-20: ``/v2/ladd`` answered HTTP 200 with 249 aircraft, 248 at ``dbFlags`` 8 and
one at 10 (LADD plus interesting), every one of them carrying a registration. A 250nm
viewport on New York the same day carried 26 LADD aircraft out of 539, so the bit arrives
on ordinary position queries and not only on the dedicated endpoint. 16 of the 18 real
Gulfstream G650s in ``tests/fixtures/adsb_type_glf6_live.json`` carry it.

Two things it is not. It is not the FAA's own list: the FAA publishes ``IndustryLADD``
monthly through the NAS Aeronautical Data Exchange portal to Service Consumers who have
signed its terms, which is not a route open to us, so this flag is the provider's
assertion sourced from that list rather than a fact we read at source. And it is not a
suppression instruction. Per ADR 009 nothing here reads it as one: the aircraft resolves
and renders like any other and the flag is an attribute on the record.
"""

NAUTICAL_MILE_M: Final = 1852.0

MAX_RADIUS_NM: Final = 250
"""Provider-enforced ceiling on a radius query. Larger values are rejected outright."""

VIEWPORT_PATH_TEMPLATE: Final = "/v2/lat/{lat:.4f}/lon/{lon:.4f}/dist/{radius}"
"""Radius-query path, chosen because every provider we use accepts this exact shape.

The obvious alternative, adsb.lol's ``/v2/point/{lat}/{lon}/{radius}``, is adsb.lol only:
adsb.fi answers it with HTTP 400. Since failover replays the same path against the
secondary provider, a provider-specific path silently disables failover for that call.
That is exactly what happened here, and only ``/v2/mil`` survived because it happens to be
path-identical across both. Verified 2026-08-19: both providers return 200 for this shape.
"""

MILLISECOND_EPOCH_FLOOR: Final = 1e11
"""At or above this, the envelope's ``now`` is milliseconds; below it, seconds.

readsb providers do not agree on the unit of their own batch timestamp. Verified against
the two captures taken on 2026-08-19: adsb.lol sent ``now: 1787165611001`` and mirrored it
in ``ctime``, both milliseconds; adsb.fi sent ``now: 1787170658.001`` alongside a
fractional ``ptime`` of 0.067, both seconds. Dividing adsb.fi's value by a thousand dated
its entire batch to 1970-01-21, so every adsb.fi aircraft reached the domain 56 years
stale, and the recency merge in :mod:`tracker.services.union` could never let it win a
shared aircraft. That is provider precedence arriving by accident, which is the one thing
ADR 010 says the merge must not do.

The boundary is unambiguous by orders of magnitude rather than by luck: 1e11 milliseconds
is 1973 and 1e11 seconds is the year 5138, so no epoch a feed could plausibly send falls
near it.
"""

ICAO_ADDRESS_HEX_DIGITS: Final = 6
"""An ICAO 24-bit address is exactly six hex digits."""
_HEX_DIGITS: Final = frozenset("0123456789abcdef")


# ---------------------------------------------------------------- the union's providers
#
# ADR 010 makes the aircraft layer the union of its providers rather than whichever one
# answered. The table below is that provider set as data, so adding one is a row and a base
# URL rather than a code change. Each floor is a constant here and never in configuration,
# per ADR 003: a floor in an environment variable is one careless override away from a ban,
# and at least one provider in this project bans permanently.

ADSB_LOL_MIN_INTERVAL_SECONDS: Final = 5.0
"""adsb.lol's floor. It aggregates roughly every five seconds, so a faster sweep returns
the identical body and spends someone else's bandwidth for nothing."""

AIRPLANESLIVE_MIN_INTERVAL_SECONDS: Final = 1.0
"""airplanes.live's floor, stated by the provider: "The ADSB One API is rate limited to 1
request per second" (``airplanes-live/api-archive`` README). Read 2026-08-20."""

ADSBEXCHANGE_MIN_INTERVAL_SECONDS: Final = 260.0
"""ADS-B Exchange's floor, and the reason it cannot be swept at all.

Its only published plan is the Community API at 10 USD a month for **10,000 requests a
month** (developer hub, read 2026-08-20). A thirty-day month divided by that quota is one
call every 259.2 seconds, rounded up here. Put differently, the five-second cadence
adsb.lol tolerates would spend the whole month's quota in fourteen hours. So this provider
is demand-driven rather than polled, and the floor exists to make an accidental sweep
obviously wrong rather than quietly expensive.
"""


@dataclass(frozen=True, slots=True)
class AdsbProvider:
    """One ADS-B network the aircraft union may draw on, and what stands in its way.

    Held as data because ADR 010 asks for coverage that is additive rather than exclusive,
    and because the providers are not interchangeable: the two that matter commercially are
    the ones that do not filter aircraft on the FAA blocking programmes, and both of those
    are unreachable today. A table makes that visible instead of leaving it as an absence.

    ``swept`` false means demand-driven: called for a specific hex, type or viewport when it
    is worth asking, never on a fixed cycle. That is the real work in ADR 010 rather than a
    second base URL, and it is why a metered key cannot simply join the poll.

    ``gate_reason`` is why the provider is not contributing today, or ``None`` when nothing
    stands in the way. It is served on ``/api/capabilities`` exactly like a missing key, and
    a row that carries one is gated unless ``access_setting`` names a credential that clears
    it. That default is deliberate: the earlier version compared the row against two module
    constants by identity, so a new blocked row reported itself available and was admitted to
    the poll, and a new row with its own host silently inherited adsb.lol's base URL and
    adsb.lol's name. Both are now read off the row.

    The two ``*_setting`` fields name attributes on :class:`~tracker.config.Settings` rather
    than holding URLs, because the base URL of the one provider we can reach is already
    configurable and a second copy here would be the one that drifts. A test asserts every
    name on every row resolves.
    """

    name: str
    min_interval_seconds: float
    unfiltered: bool
    swept: bool
    base_url_setting: str | None = None
    """Settings attribute holding this provider's base URL. ``None`` means we hold no host
    for it, so it cannot be polled at all: that is the honest state for a provider whose
    access has never been bought."""

    failover_setting: str | None = None
    """Settings attribute holding a within-provider failover host, if it has one."""

    access_setting: str | None = None
    """Settings property that clears :attr:`gate_reason` when true. ``None`` means nothing in
    configuration can clear it, which is the case for a licence or an access grant."""

    gate_reason: str | None = None


ADSB_LOL: Final = AdsbProvider(
    name="adsb.lol",
    min_interval_seconds=ADSB_LOL_MIN_INTERVAL_SECONDS,
    # It filters. adsb.lol serves /v2/ladd and /v2/pia, which is how we know it holds the
    # flags, but ADR 010's unfiltered-coverage argument rests on the two providers below.
    unfiltered=False,
    swept=True,
    base_url_setting="adsb_base_url",
    failover_setting="adsb_failover_base_url",
)
"""The keyless default and, today, the only live member of the union."""

ADSBEXCHANGE: Final = AdsbProvider(
    name="adsbexchange",
    min_interval_seconds=ADSBEXCHANGE_MIN_INTERVAL_SECONDS,
    unfiltered=True,
    swept=False,
    # No base URL and no access setting, so nothing in configuration can admit it. That is
    # the point: the blocker is a redistribution licence rather than a credential, and an
    # environment variable must not be able to switch a licence warning off.
    # Short on purpose. This string renders on a card over the globe, and the long version
    # ran to five lines there. It also no longer names a key: keyed sources are out of scope
    # since 2026-08-20, so telling a viewer to get one argues against our own constraint. The
    # HTTP 401, the redistribution terms and the two routes through are in
    # docs/data-sources.md, which is where a paragraph belongs.
    gate_reason="Paid key, and its terms prohibit redistribution to a browser.",
)
"""Unfiltered, metered and licence-blocked. Configured, unavailable, and saying so."""

AIRPLANES_LIVE: Final = AdsbProvider(
    name="airplanes.live",
    min_interval_seconds=AIRPLANESLIVE_MIN_INTERVAL_SECONDS,
    unfiltered=True,
    swept=True,
    base_url_setting="airplaneslive_base_url",
    access_setting="airplaneslive_available",
    gate_reason=(
        "Access not granted. api.airplanes.live answered HTTP 403 on 2026-08-20 with "
        "'Please contact us at contact@airplanes.live. Your email MUST include any links, "
        "a description of the project, and any information you deem appropriate.' Nobody "
        "has sent that email."
    ),
)
"""Unfiltered and keyless, and refusing us until an access email is answered."""

UNION_PROVIDERS: Final = (ADSB_LOL, ADSBEXCHANGE, AIRPLANES_LIVE)
"""Every provider ADR 010 names for the aircraft layer, reachable or not.

adsb.fi is deliberately absent. It is the within-provider failover inside
:class:`AdsbClient` and not a union member, per R3 in ``docs/pending-decisions.md``: it is
licensed for non-commercial use, and in the union that licence would attach to records
served to a browser on every cycle rather than only during an outage. That also keeps it out
of the per-record provider list and out of the provider-attributable count, which is the
honest position given R1.

adsb.one is not here either. It answered HTTP 403 from Cloudflare on 2026-08-20 and there is
nothing to configure, so it is a candidate rather than a row.
"""

SWEPT_PROVIDERS: Final = tuple(provider for provider in UNION_PROVIDERS if provider.swept)
"""Providers the union may poll on a cycle. A demand-driven provider is never in here."""

UNION_MIN_INTERVAL_SECONDS: Final = max(
    provider.min_interval_seconds for provider in SWEPT_PROVIDERS
)
"""Hard floor for one union cycle, taken from the strictest provider that gets swept.

One cycle calls every swept provider, so the floor is the slowest of theirs rather than an
average. Demand-driven providers are excluded on purpose: ADS-B Exchange's 260-second floor
would otherwise slow the whole layer to a crawl to protect a quota nothing is spending.
"""


class AdsbAircraftWire(WireModel):
    """One aircraft record exactly as a readsb ``/v2`` endpoint sends it.

    Permissive on purpose. ``/v2/mil`` returns eight fields ``/v2/point`` does not
    (``dbFlags``, ``calc_track``, ``lastPosition``, ``gpsOkBefore``, ``gpsOkLat``,
    ``gpsOkLon``, ``rr_lat``, ``rr_lon``), so a strict model here would reject every
    military aircraft. Unknown fields are ignored rather than forbidden.
    """

    hex: str
    type: str | None = None
    flight: str | None = None
    r: str | None = None
    t: str | None = None

    lat: float | None = None
    lon: float | None = None

    alt_baro: float | int | Literal["ground"] | None = None
    alt_geom: float | int | None = None

    gs: float | int | None = None
    track: float | int | None = None
    true_heading: float | int | None = None
    mag_heading: float | int | None = None
    dir: float | int | None = None

    baro_rate: float | int | None = None
    geom_rate: float | int | None = None

    squawk: str | None = None
    emergency: str | None = None
    category: str | None = None

    db_flags: int | None = Field(default=None, alias="dbFlags")
    seen_pos: float | int | None = None
    messages: int | None = None


AIRCRAFT_LIST_KEYS: Final = ("ac", "aircraft")
"""Every key a supported provider uses for the aircraft list.

adsb.lol and ADSBExchange send ``ac``; adsb.fi sends ``aircraft``. This difference is not
documented anywhere and is invisible in testing against a single provider, because an
unrecognised key simply yields an empty list. That is exactly what happened here: failover
to adsb.fi "succeeded", returned zero aircraft, and reported the feed healthy while the
layer sat empty. A silent zero is worse than an error, so
:func:`_require_known_envelope` now rejects a payload carrying none of these.
"""


class AdsbResponseWire(WireModel):
    """The envelope around a readsb ``/v2`` aircraft list.

    ``now`` is the authoritative timestamp for the whole batch, since individual records
    carry only an age in seconds relative to it. Its unit varies by provider, milliseconds
    on adsb.lol and seconds on adsb.fi, so :data:`MILLISECOND_EPOCH_FLOOR` decides which
    it is rather than the field's type.

    Field names vary between providers, so the aliases carry the differences rather than
    the parser: adsb.lol uses ``ac`` and ``total``, adsb.fi uses ``aircraft`` and
    ``resultCount``.
    """

    ac: tuple[AdsbAircraftWire, ...] = Field(
        default=(), validation_alias=AliasChoices(*AIRCRAFT_LIST_KEYS)
    )
    now: float | int | None = None
    msg: str | None = None
    total: int | None = Field(default=None, validation_alias=AliasChoices("total", "resultCount"))


_RESPONSE_ADAPTER: Final = TypeAdapter(AdsbResponseWire)

_EMERGENCY_BY_WIRE: Final[dict[str, EmergencyState]] = {e.value: e for e in EmergencyState}

_EMERGENCY_SQUAWKS: Final = frozenset({"7500", "7600", "7700"})


def _clean_hex(raw: str) -> tuple[str, bool]:
    """Normalise a readsb hex identifier.

    readsb prefixes an address with ``~`` when it is not a real ICAO allocation, which
    happens for TIS-B ground vehicles and ADS-R relays. Returns the bare lowercase hex
    plus whether the prefix was present, because that distinction matters for trust and
    the caller should not have to know about the sigil.
    """
    stripped = raw.strip().lower()
    non_icao = stripped.startswith("~")
    return (stripped.removeprefix("~"), non_icao)


def _resolve_track(wire: AdsbAircraftWire) -> float | None:
    """Pick the best available heading and normalise it into ``[0, 360)``.

    Only about half of live records carry ``track``, so the fallback chain is not an edge
    case: without it, half the aircraft on screen point north regardless of where they
    are going. ``dir`` is last because it is the bearing from the receiver to the
    aircraft, not the aircraft's own heading, and is only better than nothing.
    """
    for candidate in (wire.track, wire.true_heading, wire.mag_heading, wire.dir):
        if candidate is not None:
            return float(candidate) % 360.0
    return None


def _to_domain(wire: AdsbAircraftWire, *, observed_at: datetime, source: str) -> Aircraft | None:
    """Map one wire record to the domain contract, or ``None`` if it is unusable.

    A record without a position is dropped rather than defaulted. Roughly every feed
    carries transponders that have been heard but not located, and putting them at
    (0, 0) would draw a permanent cluster of phantom aircraft in the Gulf of Guinea.
    """
    if wire.lat is None or wire.lon is None:
        return None

    icao24, non_icao = _clean_hex(wire.hex)
    if len(icao24) != ICAO_ADDRESS_HEX_DIGITS or not _HEX_DIGITS.issuperset(icao24):
        _log.debug("dropping record with unusable address %r", wire.hex)
        return None

    on_ground = wire.alt_baro == "ground"
    baro_m = (
        None
        if on_ground or wire.alt_baro is None or isinstance(wire.alt_baro, str)
        else float(wire.alt_baro) * FEET_TO_METRES
    )
    geom_m = None if wire.alt_geom is None else float(wire.alt_geom) * FEET_TO_METRES

    flags = wire.db_flags or 0
    is_military = bool(flags & DB_FLAG_MILITARY)
    uses_privacy = bool(flags & DB_FLAG_PRIVACY_ICAO)
    on_ladd = bool(flags & DB_FLAG_LADD)

    vertical_source = wire.baro_rate if wire.baro_rate is not None else wire.geom_rate
    vertical_mps = (
        None
        if vertical_source is None
        else float(vertical_source) * FEET_PER_MINUTE_TO_METRES_PER_SECOND
    )

    callsign = wire.flight.strip() if wire.flight else None
    squawk = wire.squawk.strip() if wire.squawk else None
    emergency = _EMERGENCY_BY_WIRE.get(wire.emergency or "none", EmergencyState.NONE)
    if emergency is EmergencyState.NONE and squawk in _EMERGENCY_SQUAWKS:
        emergency = EmergencyState.GENERAL

    return classified(
        Aircraft(
            icao24=icao24,
            non_icao_address=non_icao,
            message_source=(wire.type or "unknown")[:20],
            callsign=callsign or None,
            registration=(wire.r.strip() or None) if wire.r else None,
            type_designator=(wire.t.strip() or None) if wire.t else None,
            point=Point(
                lon=float(wire.lon),
                lat=float(wire.lat),
                altitude_m=0.0 if on_ground else (geom_m if geom_m is not None else baro_m),
            ),
            on_ground=on_ground,
            barometric_altitude_m=baro_m,
            geometric_altitude_m=geom_m,
            ground_speed_mps=(
                None if wire.gs is None else max(0.0, float(wire.gs) * KNOTS_TO_METRES_PER_SECOND)
            ),
            track_deg=_resolve_track(wire),
            vertical_rate_mps=vertical_mps,
            squawk=squawk,
            emergency=emergency,
            category=wire.category or None,
            is_military=is_military,
            uses_privacy_address=uses_privacy,
            on_ladd=on_ladd,
            observed_at=observed_at,
            position_age_s=max(0.0, float(wire.seen_pos or 0.0)),
            messages_received=max(0, wire.messages or 0),
            source=source,
        )
    )


def _require_known_envelope(payload: bytes | str, *, source: str) -> None:
    """Reject a payload that carries none of the known aircraft-list keys.

    Without this, a provider whose envelope we do not recognise parses cleanly to zero
    aircraft. The poller then records a healthy feed with an entity count of zero, the
    layer empties, and nothing anywhere says why. Raising instead turns that into a
    contract violation, which the client treats as provider failure and fails over.

    An empty list under a *known* key is left alone: a viewport with no aircraft in it is
    a legitimate answer.
    """
    try:
        raw = json.loads(payload)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ContractViolationError(source, f"payload is not JSON: {exc}") from exc
    if not isinstance(raw, dict):
        raise ContractViolationError(source, f"expected a JSON object, got {type(raw).__name__}")
    if not any(key in raw for key in AIRCRAFT_LIST_KEYS):
        raise ContractViolationError(
            source,
            f"envelope has no aircraft list; expected one of {list(AIRCRAFT_LIST_KEYS)}, "
            f"got keys {sorted(raw)[:8]}",
        )


def _envelope_time(now: float | int | None, *, source: str) -> datetime:
    """Convert the envelope's epoch to a UTC datetime, in whichever unit it arrived.

    The unit is per provider, not per schema, so it is decided here rather than assumed:
    see :data:`MILLISECOND_EPOCH_FLOOR` for the two captures that settled it.

    A nonsense value has to become a :class:`ContractViolationError` rather than an
    ``OverflowError`` from the platform's time functions. Callers catch contract
    violations to trigger provider failover; an ``OverflowError`` escapes that handling
    and kills the poll instead of moving to the secondary provider.
    """
    if now is None:
        return datetime.now(UTC)
    seconds = now / 1000.0 if now >= MILLISECOND_EPOCH_FLOOR else float(now)
    try:
        return datetime.fromtimestamp(seconds, tz=UTC)
    except (OverflowError, OSError, ValueError) as exc:
        raise ContractViolationError(source, f"unusable envelope timestamp {now!r}") from exc


DROP_NO_POSITION: Final = "heard but not located"
DROP_UNUSABLE_ADDRESS: Final = "unusable ICAO address"
DROP_UNMAPPABLE: Final = "will not map to the contract"
"""Drop reasons, the adapter's own words, served per provider on ``/api/layers``."""


def parse_records(payload: bytes | str, *, source: str) -> ParsedRecords[Aircraft]:
    """Parse a readsb ``/v2`` response into domain aircraft, with the refusals counted.

    Raises :class:`ContractViolationError` when the envelope itself is unrecognisable, because
    that means the provider changed shape and we want a loud failure. Individual records
    that cannot be mapped are dropped and counted by reason, because one aircraft with a
    corrupt field must not blank the entire globe and because a count only kept in the log
    is a count nobody can read. The union wiring adds these to the provider's running total.
    """
    _require_known_envelope(payload, source=source)
    wire = validate_payload(_RESPONSE_ADAPTER, payload, source=source)
    observed_at = _envelope_time(wire.now, source=source)

    aircraft: list[Aircraft] = []
    drops: Counter[str] = Counter()
    for record in wire.ac:
        try:
            mapped = _to_domain(record, observed_at=observed_at, source=source)
        except (ValueError, TypeError) as exc:
            drops[DROP_UNMAPPABLE] += 1
            _log.debug("skipping malformed aircraft %s: %s", record.hex, exc)
            continue
        if mapped is None:
            drops[_drop_reason(record)] += 1
        else:
            aircraft.append(mapped)

    if drops:
        _log.info(
            "%s: kept %d aircraft, dropped %d %s",
            source,
            len(aircraft),
            sum(drops.values()),
            dict(drops),
        )
    return ParsedRecords(records=tuple(aircraft), drops=drops)


def _drop_reason(wire: AdsbAircraftWire) -> str:
    """Which of :func:`_to_domain`'s two refusals this record hit."""
    if wire.lat is None or wire.lon is None:
        return DROP_NO_POSITION
    return DROP_UNUSABLE_ADDRESS


def parse_response(payload: bytes | str, *, source: str) -> tuple[Aircraft, ...]:
    """The records from :func:`parse_records`, for a caller that does not report drops.

    One line, kept because most callers of this parser want the aircraft and nothing else.
    Anything wired into the provider union uses :func:`parse_records` instead, so the count
    reaches ``/api/layers`` rather than only the log.
    """
    return parse_records(payload, source=source).records


class AdsbCoolingDownError(RateLimitedError):
    """A provider is inside the backoff it asked for, so nothing was sent.

    A :class:`~tracker.sources.base.RateLimitedError` subclass for the same reason
    :class:`~tracker.sources.nominatim.NominatimThrottledError` is one: the failover already
    catches that type and the poller already honours its figure, so no caller needs a new
    branch. The distinct class and the wording exist so a log line reads as us holding off
    rather than sending someone looking for a response that never happened.
    """

    def __init__(self, source: str, status_code: int, retry_after_seconds: float) -> None:
        super().__init__(source, status_code, retry_after_seconds)
        self.detail = (
            f"still inside the backoff {source} asked for after HTTP {status_code}; no request "
            f"made, {self.retry_after_seconds:.0f}s left"
        )
        SourceError.__init__(self, source, self.detail)


class AdsbClient:
    """Fetches aircraft from a readsb ``/v2`` provider, with failover.

    **Holds one piece of state: how long each provider has asked us to stay away.** It used
    to hold none, and that was a live defect rather than a tidy design. Measured on
    2026-08-20: adsb.lol answered HTTP 420 on ``/v2/mil``, the failover to adsb.fi succeeded,
    the :class:`~tracker.sources.base.RateLimitedError` was swallowed on the way, and the very
    next cycle called adsb.lol again 65 seconds into the 120 seconds it had asked for. The
    poller could not honour a backoff it never saw, because a successful failover is not a
    failed poll. So the figure is honoured here, where the response arrived.

    With a :class:`~tracker.cache.DiskCache` passed in the cooldown also survives a restart,
    and the two clients in this app then share one. That is deliberate: a 420 is per egress
    address, not per endpoint, so adsb.lol throttling the worldwide military sweep should
    quiet the viewport sweep with it.

    Still safe to keep for the process lifetime, and now worth doing.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        base_url: str,
        failover_base_url: str | None = None,
        source_name: str = "adsb.lol",
        failover_source_name: str = "adsb.fi",
        cache: DiskCache | None = None,
        clock: Callable[[], datetime] = _utc_now,
    ) -> None:
        self._client = client
        self._base_url = base_url.rstrip("/")
        self._failover_base_url = failover_base_url.rstrip("/") if failover_base_url else None
        self._source_name = source_name
        self._failover_source_name = failover_source_name
        self._dropped = 0
        self._cache = cache
        self._clock = clock
        self._not_before: dict[str, datetime] = {}

    @property
    def dropped(self) -> int:
        """Records this client's parser has refused since it was built, cumulatively.

        Cumulative rather than per response, so a caller reads the difference since it last
        looked, the way the vessel wiring already drains the aisstream client's own count.
        Per-response would need every public method to return two things, and 80-odd tests
        assert on a plain tuple of aircraft.

        Counted against this client's *primary* provider even when the failover produced the
        response, because a client is one union member and the failover lives inside it. The
        record's own ``source`` says which of the two actually answered.
        """
        return self._dropped

    async def aircraft_near(
        self,
        *,
        lat: float,
        lon: float,
        radius_nm: int,
    ) -> tuple[Aircraft, ...]:
        """All aircraft within ``radius_nm`` nautical miles of a point.

        The provider caps radius at 250 nautical miles and rejects anything larger, so
        callers covering a wider area must tile.
        """
        capped = max(1, min(radius_nm, MAX_RADIUS_NM))
        return await self._get(VIEWPORT_PATH_TEMPLATE.format(lat=lat, lon=lon, radius=capped))

    async def aircraft_in_box(self, box: BoundingBox) -> tuple[Aircraft, ...]:
        """All aircraft within a bounding box.

        The feed only understands circles, so this queries the circumscribed circle and
        filters locally. That over-fetches by up to about 27% at the corners, which is a
        fair trade against issuing several tiled requests per viewport change.
        """
        centre = box.centre
        radius_nm = int(box.enclosing_radius_m() / NAUTICAL_MILE_M) + 1
        found = await self.aircraft_near(lat=centre.lat, lon=centre.lon, radius_nm=radius_nm)
        return tuple(a for a in found if box.contains(a.point))

    async def military(self) -> tuple[Aircraft, ...]:
        """Every military aircraft the provider currently sees, worldwide.

        Coverage is inherently partial. Military aircraft routinely fly with
        transponders off, and the UI says so rather than implying a complete picture.
        """
        return await self._get("/v2/mil")

    async def _get(self, path: str) -> tuple[Aircraft, ...]:
        """Fetch and parse, falling back to the secondary provider on failure.

        Failover covers transport errors, rate limiting, 5xx responses and contract
        violations, because a provider that has started serving a different shape is as
        unavailable to us as one refusing connections. A provider inside its own backoff
        counts as unavailable too, so the sweep uses the other one rather than spending a
        request the provider has already refused.

        When both are cooling, the second one's error propagates and the poller honours the
        figure on it. That is the only path by which a throttle reaches the poller now, and it
        is the right one: while either provider can answer, the layer is not degraded.
        """
        try:
            return await self._fetch_from(self._base_url, path, self._source_name)
        except (httpx.HTTPError, ContractViolationError, SourceError) as primary_error:
            if self._failover_base_url is None:
                raise
            # describe_exception, not the exception: an httpx timeout stringifies to
            # nothing, and this line logged "failed for /v2/... ()" on the live run.
            _log.warning(
                "%s failed for %s (%s); trying %s",
                self._source_name,
                path,
                describe_exception(primary_error),
                self._failover_source_name,
            )
            return await self._fetch_from(self._failover_base_url, path, self._failover_source_name)

    async def _fetch_from(self, base_url: str, path: str, source: str) -> tuple[Aircraft, ...]:
        remaining = self._cooldown_remaining(source)
        if remaining > 0.0:
            raise AdsbCoolingDownError(source, HELD_OFF_STATUS, remaining)

        response = await self._client.get(f"{base_url}{path}")
        if response.status_code in RATE_LIMIT_STATUS_CODES:
            # Recorded before the raise, so the figure survives whatever the caller does with
            # the exception. A successful failover swallows it, and that used to be the end of
            # the provider's own request.
            wait = retry_after_seconds(response)
            self._hold_off(source, response.status_code, wait)
            raise RateLimitedError(source, response.status_code, wait)
        response.raise_for_status()
        parsed = parse_records(response.content, source=source)
        self._dropped += parsed.dropped
        return parsed.records

    def _cooldown_key(self, source: str) -> str:
        return cache_key(CACHE_NAMESPACE, "not_before", source)

    def _cooldown_remaining(self, source: str) -> float:
        """Seconds left on this provider's backoff, or zero when it may be called."""
        until = (
            self._cache.get_time(self._cooldown_key(source))
            if self._cache is not None
            else self._not_before.get(source)
        )
        if until is None:
            return 0.0
        return max(0.0, (until - self._clock()).total_seconds())

    def _hold_off(self, source: str, status_code: int, seconds: float) -> None:
        """Record a provider's own backoff, never shortening one already in force.

        The ``max`` is what makes that a property of the arithmetic rather than a branch
        somebody has to remember. It matters because two clients here share one provider's
        cooldown and can be in flight together: both check the gate, both find it open, both
        send, and the answers land in whatever order the network decides. Without it a reply
        asking for one second could undo a reply asking for three hundred. Guessing short is
        how an address gets blocked, so the longer figure always wins.
        """
        held = max(seconds, self._cooldown_remaining(source))
        until = self._clock() + timedelta(seconds=held)
        self._not_before[source] = until
        if self._cache is not None:
            self._cache.set_time(self._cooldown_key(source), until)
        _log.warning(
            "%s answered HTTP %d; holding off until %s", source, status_code, until.isoformat()
        )
