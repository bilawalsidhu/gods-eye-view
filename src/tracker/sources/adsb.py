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
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from typing import Final, Literal

import httpx
from pydantic import AliasChoices, Field, TypeAdapter

from tracker.contracts.aircraft import Aircraft, AircraftClass, EmergencyState
from tracker.contracts.base import ContractViolationError, WireModel, validate_payload
from tracker.contracts.geo import (
    FEET_PER_MINUTE_TO_METRES_PER_SECOND,
    FEET_TO_METRES,
    KNOTS_TO_METRES_PER_SECOND,
    BoundingBox,
    Point,
)
from tracker.sources.base import (
    RATE_LIMIT_STATUS_CODES,
    RateLimitedError,
    SourceError,
    retry_after_seconds,
)

_log = logging.getLogger(__name__)

DB_FLAG_MILITARY: Final = 1
"""``dbFlags`` bit 1. Confirmed against a live /v2/mil response where all 391 records carried it."""

DB_FLAG_INTERESTING: Final = 2
DB_FLAG_PRIVACY_ICAO: Final = 4
"""``dbFlags`` bit 4. A privacy ICAO address: deliberately unresolvable to an owner."""

DB_FLAG_LADD: Final = 8

_ROTORCRAFT_CATEGORY: Final = "A7"

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


def _classify(
    wire: AdsbAircraftWire,
    *,
    is_military: bool,
    uses_privacy_address: bool,
) -> AircraftClass:
    """Assign a display class from what the feed actually tells us.

    Deliberately conservative. Business-jet detection by type designator arrives in
    phase 3 with the registry lookup that gives it meaning; until then an aircraft is
    only classified when the feed itself is the authority.
    """
    if is_military:
        return AircraftClass.MILITARY
    if uses_privacy_address:
        return AircraftClass.ANONYMOUS
    if wire.category == _ROTORCRAFT_CATEGORY:
        return AircraftClass.HELICOPTER
    return AircraftClass.UNKNOWN


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

    return Aircraft(
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
        aircraft_class=_classify(wire, is_military=is_military, uses_privacy_address=uses_privacy),
        is_military=is_military,
        uses_privacy_address=uses_privacy,
        observed_at=observed_at,
        position_age_s=max(0.0, float(wire.seen_pos or 0.0)),
        messages_received=max(0, wire.messages or 0),
        source=source,
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


def parse_response(payload: bytes | str, *, source: str) -> tuple[Aircraft, ...]:
    """Parse a readsb ``/v2`` response into domain aircraft.

    Raises :class:`ContractViolationError` when the envelope itself is unrecognisable, because
    that means the provider changed shape and we want a loud failure. Individual records
    that cannot be mapped are skipped and counted, because one aircraft with a corrupt
    field must not blank the entire globe.
    """
    _require_known_envelope(payload, source=source)
    wire = validate_payload(_RESPONSE_ADAPTER, payload, source=source)
    observed_at = _envelope_time(wire.now, source=source)

    aircraft: list[Aircraft] = []
    skipped = 0
    for record in wire.ac:
        try:
            mapped = _to_domain(record, observed_at=observed_at, source=source)
        except (ValueError, TypeError) as exc:
            skipped += 1
            _log.debug("skipping malformed aircraft %s: %s", record.hex, exc)
            continue
        if mapped is None:
            skipped += 1
        else:
            aircraft.append(mapped)

    if skipped:
        _log.info("%s: kept %d aircraft, skipped %d", source, len(aircraft), skipped)
    return tuple(aircraft)


class AdsbClient:
    """Fetches aircraft from a readsb ``/v2`` provider, with failover.

    Holds no state beyond its configuration and the shared HTTP client, so it is safe to
    construct per request or keep for the process lifetime.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        base_url: str,
        failover_base_url: str | None = None,
        source_name: str = "adsb.lol",
        failover_source_name: str = "adsb.fi",
    ) -> None:
        self._client = client
        self._base_url = base_url.rstrip("/")
        self._failover_base_url = failover_base_url.rstrip("/") if failover_base_url else None
        self._source_name = source_name
        self._failover_source_name = failover_source_name

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

    async def by_type(self, type_designator: str) -> tuple[Aircraft, ...]:
        """Every aircraft of one ICAO type designator, worldwide."""
        return await self._get(f"/v2/type/{type_designator.strip().upper()}")

    async def _get(self, path: str) -> tuple[Aircraft, ...]:
        """Fetch and parse, falling back to the secondary provider on failure.

        Failover covers transport errors, rate limiting, 5xx responses and contract
        violations, because a provider that has started serving a different shape is as
        unavailable to us as one refusing connections.
        """
        try:
            return await self._fetch_from(self._base_url, path, self._source_name)
        except (httpx.HTTPError, ContractViolationError, SourceError) as primary_error:
            if self._failover_base_url is None:
                raise
            _log.warning(
                "%s failed for %s (%s); trying %s",
                self._source_name,
                path,
                primary_error,
                self._failover_source_name,
            )
            return await self._fetch_from(self._failover_base_url, path, self._failover_source_name)

    async def _fetch_from(self, base_url: str, path: str, source: str) -> tuple[Aircraft, ...]:
        response = await self._client.get(f"{base_url}{path}")
        if response.status_code in RATE_LIMIT_STATUS_CODES:
            raise RateLimitedError(source, response.status_code, retry_after_seconds(response))
        response.raise_for_status()
        return parse_response(response.content, source=source)


def merge_by_identity(*batches: Iterable[Aircraft]) -> tuple[Aircraft, ...]:
    """Merge overlapping aircraft batches, keeping the freshest record per address.

    Needed because the viewport query and the military query overlap: a military
    aircraft inside the current view arrives twice, and rendering both would draw two
    icons fighting over the same pixel. Freshest wins, measured by position age.
    """
    best: dict[str, Aircraft] = {}
    for batch in batches:
        for aircraft in batch:
            existing = best.get(aircraft.icao24)
            if existing is None or aircraft.position_age_s < existing.position_age_s:
                best[aircraft.icao24] = aircraft
    return tuple(best.values())


def only_in_box(aircraft: Sequence[Aircraft], box: BoundingBox) -> tuple[Aircraft, ...]:
    """Filter aircraft to those inside a bounding box, antimeridian included."""
    return tuple(a for a in aircraft if box.contains(a.point))
