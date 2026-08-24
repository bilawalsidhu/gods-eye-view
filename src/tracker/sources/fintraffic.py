"""Fintraffic Digitraffic AIS vessel adapter.

The keyless primary vessel provider, and the one that has to work with no credentials at
all. CC BY 4.0 with commercial use explicitly permitted, which is why it leads the union
under ADR 010 rather than aisstream.io or AISHub.

Two endpoints on the same API version feed one :class:`~tracker.contracts.vessel.Vessel`,
and they are deliberately handled by two separate wire models with no shared timestamp
parser:

- ``/api/ais/v1/locations`` is a GeoJSON FeatureCollection of positions.
- ``/api/ais/v1/vessels`` is a bare JSON array of static and voyage data.

They join on MMSI and the join is not total: 1,058 positions against 950 static records in
one pair of live calls on 2026-08-19. A vessel with a position and no static record renders
with the static fields empty; a static record with no position is not on the globe at all.

Everything below was measured against the live host on 2026-08-19, not read off
documentation. Five traps here produce wrong output rather than an error, so each one is
named at the constant or the branch that handles it and each has its own test.

**1. ``properties.timestamp`` on ``/locations`` is not a time.** It is the AIS
second-of-minute, 0 to 63, where 60 means not available, 61 manual, 62 dead reckoning and
63 inoperative. Parsing it as an epoch dates every ship to 1970. The field is called
``second_of_minute`` on the wire model here so nothing downstream can reach for it by
mistake, and the real observation time is ``timestampExternal``, a 13-digit millisecond
epoch.

**2. ``timestamp`` means the opposite thing on ``/vessels``**, where it *is* a 13-digit
millisecond epoch. Same field name, same API version, opposite semantics, confirmed by the
provider's own documentation. It is called ``updated_at_ms`` on that wire model. This is the
``/v2/mil`` versus ``/v2/point`` problem again, so the two endpoints share no timestamp
code path.

**3. The default response is 24 hours of history, not a live snapshot.** The provider's
OpenAPI document says ``from`` defaults to 24 hours in the past, and the oldest record in a
bare call was 23 hours 42 minutes stale. Omitting ``from`` renders a day of ghost ships that
look like a working layer, so :data:`DEFAULT_WINDOW_SECONDS` is always sent.

**4. ``bbox`` is silently ignored.** ``?bbox=17,57,32,66`` returned the entire 1,059-feature
set. No ``bbox`` parameter exists in the OpenAPI document and unknown parameters are dropped
rather than rejected with a 400. The real spatial filter is ``radius`` in kilometres with
``latitude`` and ``longitude``, so a viewport query goes through
:attr:`~tracker.contracts.geo.BoundingBox.centre` and
:meth:`~tracker.contracts.geo.BoundingBox.enclosing_radius_m`, and the box filter is applied
again locally rather than trusted to the provider.

**5. gzip is mandatory.** Without ``Accept-Encoding: gzip`` the host answers HTTP 406 with
the body "Use of gzip compression is required with Accept-Encoding: gzip header." The header
is set per request here rather than relied on from the shared client's defaults.

``dataUpdatedTime`` is per query rather than a sweep clock: a filtered call returned a value
a full day older than the unfiltered one. So it is used only as "when this response was
built" and never as the age of the data, and a record whose own fix is newer than it carries
an age of zero rather than a negative one.

Attribution is a licence condition and the string is exact: see :data:`ATTRIBUTION`.
"""

import logging
import math
from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final

import httpx
from pydantic import Field, RootModel, TypeAdapter, ValidationError

from tracker.contracts.base import ContractViolationError, WireModel, validate_payload
from tracker.contracts.geo import BoundingBox, Point
from tracker.contracts.vessel import (
    AIS_COG_NOT_AVAILABLE,
    AIS_DRAUGHT_NOT_AVAILABLE,
    AIS_HEADING_NOT_AVAILABLE,
    AIS_IMO_NOT_AVAILABLE,
    AIS_NAV_STATUS_CODES,
    AIS_SHIP_TYPE_NOT_AVAILABLE,
    CALL_SIGN_MAX_CHARS,
    DESTINATION_MAX_CHARS,
    IMO_MAX,
    IMO_MIN,
    NAME_MAX_CHARS,
    SHIP_TYPE_MAX,
    SHIP_TYPE_MIN,
    MmsiCategory,
    NavigationalStatus,
    Vessel,
    VesselEta,
    ais_bearing,
    mmsi_category,
    rate_of_turn_from_ais,
    speed_over_ground_mps,
)
from tracker.sources.base import (
    RATE_LIMIT_STATUS_CODES,
    ParsedRecords,
    RateLimitedError,
    SourceError,
    describe_exception,
    retry_after_seconds,
)

_log = logging.getLogger(__name__)

SOURCE_NAME: Final = "digitraffic"
"""Per-record provider name, per ADR 010. Never a per-layer field.

A merged store that cannot say which network saw a given ship is unauditable, so this rides
on the record rather than on the layer. It names coverage and not corroboration: under R1 in
``docs/pending-decisions.md`` a provider union is one origin, because several AIS aggregators
carrying one vessel are repeating one transponder broadcast and one receiver commonly feeds
more than one network. Reverse R1 and this string starts counting towards a corroboration
score; nothing in this module changes either way.
"""

ATTRIBUTION: Final = "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY"
"""The exact attribution string the CC BY 4.0 terms require. Reproduced verbatim."""

LICENCE: Final = "CC BY 4.0"
ATTRIBUTION_URL: Final = "https://www.digitraffic.fi/en/terms-of-service/"

BASE_URL: Final = "https://meri.digitraffic.fi"
"""The only server declared in the provider's own OpenAPI document.

The historic unversioned path is gone: ``/api/v1/locations`` answers HTTP 404, and so does
``/api/ais/v1/locations/latest``.
"""

LOCATIONS_PATH: Final = "/api/ais/v1/locations"
VESSELS_PATH: Final = "/api/ais/v1/vessels"

MIN_INTERVAL_SECONDS: Final = 60.0
"""Cadence floor, in code and not in configuration, per ADR 010.

Three separate facts land on the same number. The provider allows 60 requests a minute per
IP and answers 429 above it. It caches most responses for one minute, and
``cache-control: max-age=60`` was observed on both endpoints. Its own instructions say there
is no gain in calling more often because the response will not change. So anything faster
than this spends someone else's bandwidth to receive identical bytes.
"""

DEFAULT_WINDOW_SECONDS: Final = 600.0
"""How far back ``from`` reaches on the positions call. Ten minutes.

Not the cadence. A window equal to the poll interval would drop every vessel that did not
report inside the last minute, and AIS Class A transmits every 3 minutes at anchor while
Class B goes to 3 minutes at low speed. Ten minutes keeps moored ships on the globe and
still cuts the provider's 24-hour default down to something live.
"""

DIGITRAFFIC_USER_HEADER: Final = "Digitraffic-User"
"""Client identification header the provider asks every API user to send."""

REQUIRED_HEADERS: Final = {"Accept-Encoding": "gzip"}
"""Trap 5. Sent per request because the host answers HTTP 406 without it.

Set here rather than left to the shared ``httpx.AsyncClient`` in ``app.py``: that client
passes its own ``headers=`` dict, so what it sends is httpx's default plus whatever it was
given, and this layer must not depend on either staying as it is.
"""

GZIP_REQUIRED_STATUS: Final = 406
NOT_MODIFIED_STATUS: Final = 304

METRES_PER_KM: Final = 1000.0
DECIMETRES_PER_METRE: Final = 10.0
"""Trap: ``draught`` is decimetres on this endpoint and metres on ``/api/port-call/v1``."""

MMSI_MAX: Final = 999_999_999
"""An MMSI is nine digits, so anything above this is not one."""

GEOJSON_MIN_COORDINATES: Final = 2
"""A GeoJSON position needs longitude and latitude. A third element is altitude, which
AIS does not report, so it is ignored rather than read."""

MILLISECOND_EPOCH_FLOOR: Final = 1e11
"""Below this a value is not a millisecond epoch, so it is refused rather than converted.

Both fields this module reads through :func:`_from_ms_epoch` are verified 13-digit
millisecond epochs on the live host, and 1e11 milliseconds is 1973, so no real value comes
anywhere near the floor. The reason it is here at all is that the same API sends the same
instant in seconds under a different name: ``AGENTS.md`` records ``time`` on the MQTT
``location`` topic as a 10-digit epoch in seconds, ``timestamp`` on MQTT ``metadata`` as
milliseconds, and calls it four names, three units, one API.

Unlike ``adsb.py``'s :data:`~tracker.sources.adsb.MILLISECOND_EPOCH_FLOOR`, this one does
**not** switch units on magnitude. Two readsb providers genuinely send both units through
one parser, so choosing there is right; here a 10-digit value on a REST endpoint documented
as milliseconds is junk, and reading it as seconds would invent a plausible 2026 timestamp
out of it. It is dropped and counted instead.
"""

MAX_FIX_TIME_AHEAD_SECONDS: Final = 60.0
"""How far ahead of our own clock a fix may be dated before it is refused.

``timestampExternal`` was trusted unbounded, so a value of 1893456000000 dated a record to
1 January 2030, gave it ``position_age_s`` of zero and let it beat every other provider's
genuinely fresh report in the union until 2030. That is the accidental provider precedence
ADR 010 forbids, arriving through a bad timestamp instead of through a preference order.

The bound is against our own clock rather than the response's ``dataUpdatedTime``, because
that field is per query and was measured a full day behind its own contents, so it cannot
carry a tight bound. A minute covers clock skew between us and the provider and nothing
else: this is a live feed and a fix cannot legitimately be taken in our future.
"""

_MAX_CACHED_RESPONSES: Final = 8
"""Conditional-request cache size. One entry per distinct query, and there are two in
normal use: the static call and the current viewport. Cleared rather than evicted when a
moving viewport overflows it, because a stale entry costs a full body and nothing else.
"""

EMPTY_WORLD_DETAIL: Final = (
    "the unfiltered positions query returned no renderable vessel: counted as a failed "
    "poll, never as an empty sea. The existing vessels stay in the store"
)
"""Why an empty answer to an *unfiltered* query is a failure rather than a quiet zero.

The bare call is the whole Baltic inside a ten-minute window, 1,058 features when it was
measured. Zero means something broke upstream, exactly as CelesTrak refuses an empty element
array on the grounds that the sky did not empty. Reported as a provider failure, so the
layer degrades and names Fintraffic instead of sitting healthy with a count of zero and
expiring every ship 180 seconds later.

Scoped to the unfiltered query on purpose. A radius or box query over quiet water is allowed
to see nothing, which is the same distinction AISHub's bounded queries need.
"""

STATIC_FETCH_FAILED_DETAIL: Final = (
    "the static endpoint failed, so positions render with the last static data we hold"
)
"""Why a static-leg failure is survivable.

Positions and static data are two endpoints, and only one of them is load-bearing. A vessel
with a position and no metadata renders with the static fields empty, which is the normal
case for 108 of 1,058 live positions. Aborting the cycle because a name was unavailable made
the only keyless vessel provider contribute nothing.
"""

_DROP_NO_PROPERTIES: Final = "feature carried no properties"
_DROP_NO_COORDINATES: Final = "feature carried no usable coordinates"
_DROP_MMSI_MISMATCH: Final = "MMSI disagrees between feature and properties"
_DROP_MMSI_RANGE: Final = "MMSI is not nine digits"
_DROP_NO_FIX_TIME: Final = "no timestampExternal, so the fix has no time"
_DROP_UNUSABLE_FIX_TIME: Final = "timestampExternal is not a usable millisecond epoch"
_DROP_FUTURE_FIX_TIME: Final = "timestampExternal is dated ahead of our own clock"
_DROP_WIRE_SHAPE: Final = "record does not match the shape this endpoint sends"
_DROP_CONTRACT: Final = "failed the vessel contract"
"""Drop reasons. Constants so a test can assert one and the log can count them by name."""


def _utc_now() -> datetime:
    return datetime.now(UTC)


class _UnmappableRecordError(ValueError):
    """One record cannot become a :class:`Vessel`, with a short reason for the counter.

    A :class:`ValueError` so the parse loop catches it alongside the contract's own
    validation failures, and every drop is counted rather than silently swallowed.
    """

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


# ---------------------------------------------------------------- wire models


class _GeometryWire(WireModel):
    """A GeoJSON point geometry. ``coordinates`` is ``[longitude, latitude]``.

    That already matches this project's rule, so nothing is swapped here. Confirmed by the
    live body independently of the documentation: longitudes ran 17.0 to 32.5 and latitudes
    57.5 to 65.9, and a latitude of 32 in the Baltic is impossible.
    """

    coordinates: tuple[float, ...] = ()


class _LocationPropertiesWire(WireModel):
    """The ``properties`` object on one ``/api/ais/v1/locations`` feature.

    ``second_of_minute`` is the field the wire calls ``timestamp``, renamed here on purpose:
    it is the AIS second-of-minute, 0 to 63, and trap 1 in the module docstring is what
    happens when something treats it as a time. Nothing in this module reads it.
    """

    mmsi: int | None = None
    sog: float | None = None
    cog: float | None = None
    heading: int | None = None
    rot: int | None = None
    nav_stat: int | None = Field(default=None, alias="navStat")
    second_of_minute: int | None = Field(default=None, alias="timestamp")
    reported_at_ms: int | None = Field(default=None, alias="timestampExternal")


class _LocationFeatureWire(WireModel):
    """One vessel position. ``mmsi`` appears both here and inside ``properties``."""

    mmsi: int
    geometry: _GeometryWire | None = None
    properties: _LocationPropertiesWire | None = None


class _LocationsWire(WireModel):
    """The FeatureCollection envelope.

    Both fields are required, which is the loud-failure guard. A payload whose shape has
    changed would otherwise parse cleanly to zero vessels, the poller would record a
    healthy feed with a count of zero, and the layer would empty with nothing anywhere
    saying why. That exact silent zero has already happened once on the aircraft feed.

    ``features`` is deliberately left unvalidated here and each element is validated on its
    own by :data:`_FEATURE_ADAPTER`. Typing it as a tuple of feature models validates the
    whole array in one pass, so one fractional ``rot`` in one of 110 records rejected the
    entire body and, with no AISHub username and no aisstream key, emptied the vessel layer
    one TTL later. A record that will not map is dropped and counted, which is the house
    rule, and ``aishub.py`` and ``celestrak.py`` were already doing it this way.
    """

    data_updated_time: datetime = Field(alias="dataUpdatedTime")
    features: tuple[object, ...]


class _StaticWire(WireModel):
    """One record from ``/api/ais/v1/vessels``, which is a bare array with no envelope.

    ``updated_at_ms`` is the field the wire calls ``timestamp`` and here it genuinely is a
    13-digit millisecond epoch, the opposite of the identically named field on
    ``/locations``. Trap 2.
    """

    mmsi: int
    name: str | None = None
    call_sign: str | None = Field(default=None, alias="callSign")
    destination: str | None = None
    imo: int | None = None
    draught_dm: int | None = Field(default=None, alias="draught")
    eta_packed: int | None = Field(default=None, alias="eta")
    ship_type: int | None = Field(default=None, alias="shipType")
    reference_point_a: int | None = Field(default=None, alias="referencePointA")
    reference_point_b: int | None = Field(default=None, alias="referencePointB")
    reference_point_c: int | None = Field(default=None, alias="referencePointC")
    reference_point_d: int | None = Field(default=None, alias="referencePointD")
    updated_at_ms: int | None = Field(default=None, alias="timestamp")


class _StaticListWire(RootModel[tuple[object, ...]]):
    """The bare array ``/api/ais/v1/vessels`` returns, wrapped so it can be validated.

    Elements stay raw for the same reason as :class:`_LocationsWire`: one junk ``draught``
    in one of 93 records must not lose the other 92.
    """


_LOCATIONS_ADAPTER: Final = TypeAdapter(_LocationsWire)
_STATIC_ADAPTER: Final = TypeAdapter(_StaticListWire)
_FEATURE_ADAPTER: Final = TypeAdapter(_LocationFeatureWire)
_STATIC_RECORD_ADAPTER: Final = TypeAdapter(_StaticWire)


# ---------------------------------------------------------------- static data


@dataclass(frozen=True, slots=True)
class VesselStatic:
    """Cleaned static and voyage data for one vessel, keyed on MMSI by :func:`parse_static`.

    An adapter intermediate rather than a domain contract: a :class:`Vessel` needs a
    position and a static record has none, so a record that never joins to a position never
    becomes an entity. Units and sentinels are already resolved here, so the join step does
    no conversion.

    Every field defaults to empty, which is what the 108-of-1,058 positions with no static
    record get.
    """

    updated_at: datetime | None = None
    name: str | None = None
    call_sign: str | None = None
    imo: int | None = None
    ship_type: int | None = None
    draught_m: float | None = None
    length_m: float | None = None
    beam_m: float | None = None
    destination: str | None = None
    eta: VesselEta | None = None


_NO_STATIC: Final = VesselStatic()
"""What a position with no static record joins to. Renders, with the static fields empty."""

_TIME_FLOOR: Final = datetime.min.replace(tzinfo=UTC)
"""Sort floor for a static record that carried no usable timestamp: treated as the oldest."""


def _from_ms_epoch(millis: int) -> datetime | None:
    """Convert a 13-digit millisecond epoch to UTC, or ``None`` if it is not one.

    Args:
        millis: The wire value. ``timestampExternal`` on a position, ``timestamp`` on a
            static record.

    Returns:
        The instant in UTC, or ``None`` when the value is not a millisecond epoch at all
        (see :data:`MILLISECOND_EPOCH_FLOOR`) or when the platform cannot represent it. A
        nonsense value must not escape as an ``OverflowError``: the caller counts a dropped
        record and carries on, where an unhandled overflow would kill the whole poll.
    """
    if millis < MILLISECOND_EPOCH_FLOOR:
        return None
    try:
        return datetime.fromtimestamp(millis / 1000.0, tz=UTC)
    except (OverflowError, OSError, ValueError):
        return None


def _as_utc(value: datetime) -> datetime:
    """Attach UTC to a naive timestamp, or normalise an aware one.

    Digitraffic sends ``dataUpdatedTime`` with a ``Z`` suffix, so this is belt and braces
    rather than the CelesTrak case. It stays because a naive datetime reaching a domain
    contract is a validation error, and the fix belongs in the adapter.
    """
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _clean_text(raw: str | None, limit: int) -> str | None:
    """Strip a text field and map the feed's empty string to ``None``.

    The feed sends ``""`` rather than ``null`` for missing text: ``callSign`` on 5 of 950
    live records and ``destination`` on 91. Truncation to the field's own cap is deliberate
    and matches the aircraft adapter: losing the tail of a name is better than dropping a
    real ship over a display field.
    """
    if raw is None:
        return None
    return raw.strip()[:limit] or None


def _dimension(near: int | None, far: int | None) -> float | None:
    """Sum two AIS antenna reference points into a length or a beam, in metres.

    A plus B is the overall length, C plus D the overall beam. Zero on both means the
    transponder was never told the ship's dimensions, which is not a zero-metre ship.
    """
    total = (near or 0) + (far or 0)
    return float(total) if total > 0 else None


def _static_from_wire(wire: _StaticWire) -> VesselStatic:
    """Clean one static record: units resolved, sentinels mapped, empty strings dropped."""
    imo = wire.imo
    if imo is None or imo == AIS_IMO_NOT_AVAILABLE or not IMO_MIN <= imo <= IMO_MAX:
        # 0 means not available on 322 of 950 live records, a third of the feed, and the
        # same body carried 912974400, which is not an IMO number either.
        imo = None
    ship_type = wire.ship_type
    if (
        ship_type is None
        or ship_type == AIS_SHIP_TYPE_NOT_AVAILABLE
        or not SHIP_TYPE_MIN <= ship_type <= SHIP_TYPE_MAX
    ):
        ship_type = None
    draught_dm = wire.draught_dm
    if draught_dm is None or draught_dm == AIS_DRAUGHT_NOT_AVAILABLE or draught_dm < 0:
        draught_dm = None
    return VesselStatic(
        updated_at=None if wire.updated_at_ms is None else _from_ms_epoch(wire.updated_at_ms),
        name=_clean_text(wire.name, NAME_MAX_CHARS),
        call_sign=_clean_text(wire.call_sign, CALL_SIGN_MAX_CHARS),
        imo=imo,
        ship_type=ship_type,
        draught_m=None if draught_dm is None else draught_dm / DECIMETRES_PER_METRE,
        length_m=_dimension(wire.reference_point_a, wire.reference_point_b),
        beam_m=_dimension(wire.reference_point_c, wire.reference_point_d),
        destination=_clean_text(wire.destination, DESTINATION_MAX_CHARS),
        eta=None if wire.eta_packed is None else VesselEta.from_ais_packed(wire.eta_packed),
    )


def parse_static(payload: bytes | str, *, source: str = SOURCE_NAME) -> dict[str, VesselStatic]:
    """Parse ``/api/ais/v1/vessels`` into static data keyed on a nine-digit MMSI.

    Args:
        payload: The raw response body. A bare JSON array, with no envelope and no
            ``dataUpdatedTime``, unlike ``/api/ais/v1/locations`` on the same API version.
        source: Provider name, used in the error when the payload will not validate.

    Returns:
        One entry per MMSI, freshest first. Where the endpoint returns more than one record
        for a vessel inside its query window, the newest by ``timestamp`` wins, which is the
        one place trap 2 has teeth: read that field as a second-of-minute and the wrong
        record supplies the name.

        No ITU category check happens here. A static record that never joins to a position
        never becomes an entity, and positions carrying a placeholder or non-vessel MMSI are
        dropped by :func:`parse_locations`, so filtering twice would only duplicate the rule.

    Raises:
        ContractViolationError: The payload is not the array this endpoint returns. Only the
            array itself is validated here; a record inside it that will not read is dropped
            and counted, because one junk ``draught`` must not lose the other 92 names.

    A refused static record is not a refused vessel, so this count stays in the log rather
    than joining the provider's drop total on ``/api/layers``. The ship still renders; it
    renders with its name and voyage fields empty, which is the same outcome as the 108
    positions in the capture that have no static record at all.
    """
    raw_records = validate_payload(_STATIC_ADAPTER, payload, source=source).root
    statics: dict[str, VesselStatic] = {}
    dropped: Counter[str] = Counter()
    for raw in raw_records:
        try:
            record = _STATIC_RECORD_ADAPTER.validate_python(raw)
        except ValidationError as exc:
            dropped[_DROP_WIRE_SHAPE] += 1
            _log.debug("dropping unreadable static record: %s", exc)
            continue
        if not 0 <= record.mmsi <= MMSI_MAX:
            dropped[_DROP_MMSI_RANGE] += 1
            continue
        mmsi = f"{record.mmsi:09d}"
        candidate = _static_from_wire(record)
        existing = statics.get(mmsi)
        if existing is None or (candidate.updated_at or _TIME_FLOOR) > (
            existing.updated_at or _TIME_FLOOR
        ):
            statics[mmsi] = candidate
    if dropped:
        _log.info(
            "%s: %d static records dropped (%s)", source, sum(dropped.values()), dict(dropped)
        )
    return statics


# ---------------------------------------------------------------- positions


def _identity(feature: _LocationFeatureWire, props: _LocationPropertiesWire) -> str:
    """The vessel's MMSI as a nine-digit string, or a drop naming why.

    The MMSI arrives twice, at feature level and inside ``properties``, identical on all
    1,058 live records. They are compared rather than one being picked, because the merge
    key under ADR 010 is the whole identity of the record and two disagreeing copies of it
    is not an identity we can stand behind.

    The ITU category check is what stops the two MMSI classes that break the merge key: the
    999999999 placeholder, which is a real value on this feed and would merge every ship
    using it into one record, and the ``111`` search-and-rescue aircraft prefix, which put
    two helicopters doing 36 knots in the live vessel body.
    """
    if props.mmsi is not None and props.mmsi != feature.mmsi:
        raise _UnmappableRecordError(_DROP_MMSI_MISMATCH)
    if not 0 <= feature.mmsi <= MMSI_MAX:
        raise _UnmappableRecordError(_DROP_MMSI_RANGE)
    mmsi = f"{feature.mmsi:09d}"
    category = mmsi_category(mmsi)
    if category is not MmsiCategory.SHIP_STATION:
        msg = f"MMSI is a {category.value}, not a ship station"
        raise _UnmappableRecordError(msg)
    return mmsi


def _position(geometry: _GeometryWire | None) -> Point:
    """Read ``[longitude, latitude]`` off the geometry. No swap: the feed already agrees."""
    if geometry is None or len(geometry.coordinates) < GEOJSON_MIN_COORDINATES:
        raise _UnmappableRecordError(_DROP_NO_COORDINATES)
    return Point(lon=geometry.coordinates[0], lat=geometry.coordinates[1])


def _fix_time(props: _LocationPropertiesWire, *, now: datetime) -> datetime:
    """When the position was actually fixed, from ``timestampExternal`` and nothing else.

    A record with no fix time is dropped rather than dated to now. Recency is what resolves
    a conflict between providers under ADR 010, so a record that cannot say when it was
    taken would win every merge it entered.

    A fix dated in our own future is dropped for the same reason and it is the sharper case,
    because it does not just enter the merge, it wins every one of them until the clock
    catches up. See :data:`MAX_FIX_TIME_AHEAD_SECONDS`.

    Raises:
        _UnmappableRecordError: the record carries no fix time, or one that is not a
            millisecond epoch, or one dated ahead of our clock.
    """
    if props.reported_at_ms is None:
        raise _UnmappableRecordError(_DROP_NO_FIX_TIME)
    fixed_at = _from_ms_epoch(props.reported_at_ms)
    if fixed_at is None:
        raise _UnmappableRecordError(_DROP_UNUSABLE_FIX_TIME)
    if (fixed_at - now).total_seconds() > MAX_FIX_TIME_AHEAD_SECONDS:
        raise _UnmappableRecordError(_DROP_FUTURE_FIX_TIME)
    return fixed_at


def _nav_status(code: int | None) -> NavigationalStatus | None:
    """Map the AIS navigational status code, leaving the undefined and reserved ones empty."""
    return None if code is None else AIS_NAV_STATUS_CODES.get(code)


def _to_vessel(
    feature: _LocationFeatureWire,
    statics: Mapping[str, VesselStatic],
    *,
    response_time: datetime,
    now: datetime,
    source: str,
) -> Vessel:
    """Map one position feature, joined to its static record, into the domain contract.

    ``observed_at`` is the later of the response's own ``dataUpdatedTime`` and this record's
    fix, so ``observed_at - position_age_s`` recovers the fix exactly and can never be
    negative. That matters because ``dataUpdatedTime`` is per query rather than a sweep
    clock: a filtered call returned a value a day older than the unfiltered one, and a
    response that claims to predate its own contents cannot be allowed to zero every age
    and hand this provider an accidental win in the recency merge. The fix itself is bounded
    against ``now`` in :func:`_fix_time`, which is what stops the same accidental win
    arriving through a future ``timestampExternal`` instead.

    Raises:
        _UnmappableRecordError: The record cannot be identified, located or dated.
        ValidationError: The mapped values do not satisfy the vessel contract.
    """
    if feature.properties is None:
        raise _UnmappableRecordError(_DROP_NO_PROPERTIES)
    props = feature.properties
    mmsi = _identity(feature, props)
    fixed_at = _fix_time(props, now=now)
    observed_at = max(response_time, fixed_at)
    static = statics.get(mmsi, _NO_STATIC)
    return Vessel(
        mmsi=mmsi,
        name=static.name,
        call_sign=static.call_sign,
        imo=static.imo,
        ship_type=static.ship_type,
        point=_position(feature.geometry),
        course_over_ground_deg=ais_bearing(props.cog, AIS_COG_NOT_AVAILABLE),
        speed_over_ground_mps=speed_over_ground_mps(props.sog),
        true_heading_deg=ais_bearing(props.heading, AIS_HEADING_NOT_AVAILABLE),
        rate_of_turn_deg_per_min=(None if props.rot is None else rate_of_turn_from_ais(props.rot)),
        navigational_status=_nav_status(props.nav_stat),
        draught_m=static.draught_m,
        length_m=static.length_m,
        beam_m=static.beam_m,
        destination=static.destination,
        eta=static.eta,
        observed_at=observed_at,
        position_age_s=(observed_at - fixed_at).total_seconds(),
        source=source,
    )


def parse_locations(
    payload: bytes | str,
    statics: Mapping[str, VesselStatic] | None = None,
    *,
    source: str = SOURCE_NAME,
    now: datetime | None = None,
) -> ParsedRecords[Vessel]:
    """Parse ``/api/ais/v1/locations`` into vessels, joined to static data on MMSI.

    Args:
        payload: The raw FeatureCollection body.
        statics: Static data from :func:`parse_static`, or ``None`` to render positions with
            the static fields empty. A position with no static record is normal rather than
            an error: 108 of 1,058 live positions had none. A static record with no position
            produces nothing, because a vessel with no position is not on the globe.
        source: Provider name, recorded on every record per ADR 010.
        now: Our own clock, the bound a fix time must not be dated past. Defaults to the
            wall clock; a test passes one so the bound is exercised without waiting.

    Returns:
        One vessel per usable feature, plus the records that could not be read, identified,
        located or dated, counted by reason and never partially accepted. The count is
        returned rather than only logged because ``/api/layers`` serves it: a drop total
        that stops at a log line is dropped and logged, not dropped and counted.

    Raises:
        ContractViolationError: The envelope is not the FeatureCollection this endpoint
            returns. Loud on purpose: a shape change that parsed to zero vessels would read
            as a healthy but empty layer.
    """
    wire = validate_payload(_LOCATIONS_ADAPTER, payload, source=source)
    response_time = _as_utc(wire.data_updated_time)
    joined = statics if statics is not None else {}
    clock_now = now if now is not None else _utc_now()

    vessels: list[Vessel] = []
    dropped: Counter[str] = Counter()
    for raw_feature in wire.features:
        try:
            feature = _FEATURE_ADAPTER.validate_python(raw_feature)
        except ValidationError as exc:
            dropped[_DROP_WIRE_SHAPE] += 1
            _log.debug("dropping unreadable feature: %s", exc)
            continue
        try:
            vessels.append(
                _to_vessel(
                    feature,
                    joined,
                    response_time=response_time,
                    now=clock_now,
                    source=source,
                )
            )
        except _UnmappableRecordError as exc:
            dropped[exc.reason] += 1
        except ValidationError as exc:
            dropped[_DROP_CONTRACT] += 1
            _log.debug("dropping vessel %s: %s", feature.mmsi, exc)

    if dropped:
        _log.info(
            "%s: kept %d vessels, dropped %d (%s)",
            source,
            len(vessels),
            sum(dropped.values()),
            dict(dropped),
        )
    return ParsedRecords(records=tuple(vessels), drops=dropped)


# ---------------------------------------------------------------- client


@dataclass(frozen=True, slots=True)
class _CachedResponse:
    """A body kept against its ``ETag`` so the next poll can ask for a 304 instead."""

    etag: str
    body: bytes


class FintrafficClient:
    """Fetches vessels from Fintraffic Digitraffic. Keyless, and there is nothing to proxy.

    Holds one piece of state, the conditional-request cache, because ``ETag`` with
    ``If-None-Match`` is the cheap way to poll a feed that caches for a minute: a real
    HTTP 304 with an empty body was verified against the live host.

    **That cache is deliberately not on disk.** Every rate guard in ``sources/`` was moved onto
    :class:`~tracker.cache.DiskCache` on 2026-08-20 and this one was left out, because it saves
    bandwidth rather than requests: with a persisted ``ETag`` a restart sends the same
    conditional GET and gets a 304 back, so the provider is asked exactly as often either way,
    and its cap is 60 requests a minute rather than a byte budget. What does protect it across a
    restart is the vessel poller's own floor, which is persisted. Body plus ``ETag`` is about
    441KB a minute of write churn for nothing.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        base_url: str = BASE_URL,
        digitraffic_user: str = "",
        window_seconds: float = DEFAULT_WINDOW_SECONDS,
        clock: Callable[[], datetime] = _utc_now,
    ) -> None:
        self._client = client
        self._base_url = base_url.rstrip("/")
        # A window shorter than the cadence floor would guarantee gaps: vessels that
        # reported between two polls would fall outside every query window and blink off
        # the globe. Configuration can widen the window and cannot narrow it past that.
        self._window_seconds = max(window_seconds, MIN_INTERVAL_SECONDS)
        self._clock = clock
        self._headers = dict(REQUIRED_HEADERS)
        if digitraffic_user.strip():
            self._headers[DIGITRAFFIC_USER_HEADER] = digitraffic_user.strip()
        else:
            _log.warning(
                "no %s header configured; the provider caps unidentified clients at "
                "60 requests a minute per IP",
                DIGITRAFFIC_USER_HEADER,
            )
        self._cache: dict[str, _CachedResponse] = {}
        # The last static body that parsed. Positions do not need it, so a failed static
        # leg falls back to this rather than to nothing: passing an empty mapping would
        # blank every name for a cycle and put the flap on the card.
        self._last_statics: dict[str, VesselStatic] = {}

    @property
    def name(self) -> str:
        """Provider name, recorded on every record this client produces."""
        return SOURCE_NAME

    @property
    def min_interval_seconds(self) -> float:
        """The provider's cadence floor. A constant in code, with no way in from settings."""
        return MIN_INTERVAL_SECONDS

    @property
    def window_seconds(self) -> float:
        """How far back the positions query reaches, never shorter than the cadence floor."""
        return self._window_seconds

    async def all_vessels(self) -> ParsedRecords[Vessel]:
        """Every vessel the feed has reported inside the query window, plus its drop count.

        The whole body is 1,058 features and 441KB uncompressed, so there is no reason to
        filter spatially unless a viewport asks for it.

        The drop count comes back with the vessels rather than staying in the log, because
        the caller is what puts it on ``/api/layers``.
        """
        return await self._vessels({})

    async def vessels_near(
        self, *, lat: float, lon: float, radius_km: int
    ) -> ParsedRecords[Vessel]:
        """Vessels within ``radius_km`` kilometres of a point, plus the drop count.

        ``radius`` with ``latitude`` and ``longitude`` is the provider's only spatial
        filter, and it is a haversine radius in kilometres. ``bbox`` is accepted and
        silently ignored: it returned all 1,059 features, so nothing here sends one.
        """
        return await self._vessels(
            {
                "latitude": f"{lat:.5f}",
                "longitude": f"{lon:.5f}",
                "radius": str(max(1, radius_km)),
            }
        )

    async def vessels_in_box(self, box: BoundingBox) -> ParsedRecords[Vessel]:
        """Vessels inside a bounding box, plus the drop count.

        The feed understands circles only, so this queries the circumscribed circle and
        filters locally. The local filter is not belt and braces: ``bbox`` is silently
        ignored upstream, so this is the only thing that makes the answer match the box.

        The box filter is not a drop: a vessel outside the box mapped cleanly and was never
        refused, so the count carried here is the parser's alone.
        """
        centre = box.centre
        radius_km = math.ceil(box.enclosing_radius_m() / METRES_PER_KM)
        found = await self.vessels_near(lat=centre.lat, lon=centre.lon, radius_km=radius_km)
        inside = tuple(vessel for vessel in found.records if box.contains(vessel.point))
        return ParsedRecords(records=inside, drops=found.drops)

    def window_start_ms(self) -> int:
        """The ``from`` value for the next positions query, as a millisecond epoch.

        Quantised to the cadence floor so consecutive polls inside the same minute ask the
        identical question. Without that, a moving ``from`` makes every request unique, the
        ``ETag`` never matches, and the provider ships 441KB of the same data it already
        cached. With it, the second poll in a minute is a 304.
        """
        bucket = math.floor(self._clock().timestamp() / MIN_INTERVAL_SECONDS)
        return int((bucket * MIN_INTERVAL_SECONDS - self._window_seconds) * 1000)

    async def _vessels(self, params: dict[str, str]) -> ParsedRecords[Vessel]:
        """Fetch both endpoints and join them on MMSI.

        Sequential rather than concurrent: two requests a minute is nowhere near the
        provider's 60 and the static call is normally a 304. Independent, though. The static
        leg is allowed to fail without taking the positions with it, because that is the
        partial-failure behaviour the module already documents and :func:`parse_locations`
        already accepts.

        Raises:
            SourceError: the unfiltered query produced no renderable vessel. See
                :data:`EMPTY_WORLD_DETAIL`.
        """
        statics = await self._statics()
        query = {**params, "from": str(self.window_start_ms())}
        parsed = parse_locations(
            await self._get(LOCATIONS_PATH, query), statics, source=SOURCE_NAME
        )
        if not params and not parsed.records:
            raise SourceError(SOURCE_NAME, EMPTY_WORLD_DETAIL)
        return parsed

    async def _statics(self) -> dict[str, VesselStatic]:
        """Static and voyage data, or the last set that parsed.

        Every failure on this leg is survivable except a 429, which is not about this leg at
        all: the provider's rate limit binds the positions request that would follow, so
        spending it is worse than losing the names.
        """
        try:
            self._last_statics = parse_static(await self._get(VESSELS_PATH, {}), source=SOURCE_NAME)
        except RateLimitedError:
            raise
        except (ContractViolationError, SourceError, httpx.HTTPError) as exc:
            _log.warning(
                "%s: %s (%s)", SOURCE_NAME, STATIC_FETCH_FAILED_DETAIL, describe_exception(exc)
            )
        return self._last_statics

    async def _get(self, path: str, params: dict[str, str]) -> bytes:
        """One conditional GET, returning the body, cached or fresh.

        Raises:
            RateLimitedError: HTTP 429. The provider states 60 requests a minute per IP.
            SourceError: HTTP 406, which only ever means our own ``Accept-Encoding`` was
                lost, or a 304 with nothing cached to serve it from.
        """
        cache_key = f"{path}?{sorted(params.items())}"
        headers = dict(self._headers)
        cached = self._cache.get(cache_key)
        if cached is not None:
            headers["If-None-Match"] = cached.etag

        response = await self._client.get(f"{self._base_url}{path}", params=params, headers=headers)

        if response.status_code in RATE_LIMIT_STATUS_CODES:
            raise RateLimitedError(SOURCE_NAME, response.status_code, retry_after_seconds(response))
        if response.status_code == GZIP_REQUIRED_STATUS:
            msg = f"HTTP 406 from {path}: {response.text.strip()}"
            raise SourceError(SOURCE_NAME, msg)
        if response.status_code == NOT_MODIFIED_STATUS:
            if cached is None:
                msg = f"HTTP 304 from {path} with no cached body to serve"
                raise SourceError(SOURCE_NAME, msg)
            return cached.body
        response.raise_for_status()

        etag = response.headers.get("etag")
        if etag:
            if len(self._cache) >= _MAX_CACHED_RESPONSES:
                self._cache.clear()
            self._cache[cache_key] = _CachedResponse(etag=etag, body=response.content)
        return response.content
