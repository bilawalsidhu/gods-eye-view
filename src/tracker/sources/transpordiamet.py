"""Estonian Transpordiamet AIS vessel adapter, the third keyless member of the vessel union.

The Estonian Transport Administration publishes live AIS as an **ArcGIS FeatureServer**,
queryable with no credential of any kind. Verified live on 2026-08-23: 627 vessels in the
eastern Baltic and the Gulf of Finland, lon 19.68 to 29.41, lat 56.98 to 60.71.

**It earns its place on 230 ships and one edge of sea.** Measured against the other two
keyless members in the same minute on 2026-08-23: 397 of its 627 were already in Fintraffic,
**zero** were in Kystdatahuset, and **230 were in neither**. It also reaches slightly further
south than Fintraffic, lat 56.98 against 57.67, which is the Latvian and Lithuanian coast.
Under ADR 010 that is exactly the case for a union member rather than a failover.

**Finding it at all took going through a web map.** The authority's public viewer is an ArcGIS
Experience Builder app, so there is no documented API to read: the data sits in the portal's
service directory and the endpoint has to be enumerated. `/arcgis/rest/services?f=json` lists
the folders, and the AIS layer is not in the maritime folder anybody would look in
(``Nutimeri``) but in ``Hosted``, as ``AIS_vessels_feature_view``. The folder that *is* named
for vessel traffic, ``Laevaliikluse_tiheduskaardid``, holds 52 ``ImageServer`` entries of
yearly **density rasters** by vessel type, which are aggregate counts per cell and not vessels
at all. Anyone sweeping this host quickly would find the rasters, conclude "density only" and
move on. Recorded because the same mistake is available on every ArcGIS-hosted authority.

``robots.txt`` on the host is HTTP 404, so there are no directives to honour. The descriptive
User-Agent this project mandates is answered normally, and the portal's
``authInfo.isTokenBasedSecurity: true`` describes its admin endpoints rather than this one:
the query answers keylessly and was verified with no header of any kind.

Four traps here produce wrong output rather than an error, so each is named at the constant or
the branch that handles it and each has its own test.

**1. The default spatial reference is EPSG:3301, not WGS84, and it is metres.** A query without
``outSR`` returns ``{"x": 466890.13, "y": 6529584.57}``, which is the Estonian Coordinate
System of 1997 in metres. Those are not degrees and a longitude of 466,890 fails this project's
contract, so **every vessel would be dropped** and the layer would read as an empty sea rather
than as a projection mistake. :data:`REQUIRED_PARAMS` sends ``outSR=4326`` on every request and
:func:`_position` refuses anything the server did not return in 4326, so a server-side default
change cannot silently reproject the fleet.

**2. ``sys_timestamp`` is a constant and it is not a time.** Every one of 627 records carried
``-2209161600000``, which is 1 January 1900. The real observation time is ``timestamp``, a
13-digit millisecond epoch. This is Digitraffic's "four names, three units, one API" trap in a
new place: reading the field whose name contains ``timestamp`` and looks like a system clock
dates the whole feed to 1900, and every vessel then loses every recency contest in the union.
Nothing here reads it, and it is deliberately absent from :class:`_AttributesWire` so nothing
can.

**3. An ArcGIS error arrives as HTTP 200 with an ``error`` key.** A bad field name answered
``{"error":{"code":500,"message":"Field name 'NOT_A_COLUMN' does not exist."}}`` with a 200, so
``raise_for_status`` passes and a client reaching for ``features`` gets a ``KeyError`` or reads
it as "no ships here". Same shape as the MediaWiki action API trap already in ``AGENTS.md``.
:func:`parse_features` checks for ``error`` before anything else.

**4. ``mmsi`` is a string and ``draught`` is metres.** The MMSI arrives as a nine-character
string on all 627 records, which happens to be what this project's merge key wants, so nothing
is padded. ``draught`` is a float in **metres**, 0 to 16.3 measured, unlike Digitraffic's
decimetres on ``/api/ais/v1/vessels``. Two endpoints of two authorities, one word, two units.

**``eta`` is a real timestamp here, not the packed AIS integer**, which is the one place this
feed carries more than the domain can hold. See :func:`_eta`.

**Paging is mandatory even though today it is not.** ``maxRecordCount`` is 1,000 and the count
was 627, so one page covers it now. The server sets ``exceededTransferLimit: true`` when there
is more, verified by asking for 500 of 627, and honours ``resultOffset``, verified at offset
600. A feed that grows past a thousand on a busy day would silently truncate without this.
"""

import logging
from collections import Counter
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Final

import httpx
from pydantic import Field, TypeAdapter, ValidationError

from tracker.cache import DiskCache
from tracker.cache import key as cache_key
from tracker.contracts.base import WireModel, validate_payload
from tracker.contracts.geo import Point
from tracker.contracts.vessel import (
    AIS_COG_NOT_AVAILABLE,
    AIS_DRAUGHT_NOT_AVAILABLE,
    AIS_HEADING_NOT_AVAILABLE,
    AIS_NAV_STATUS_CODES,
    AIS_SHIP_TYPE_NOT_AVAILABLE,
    BEAM_MAX_M,
    CALL_SIGN_MAX_CHARS,
    DESTINATION_MAX_CHARS,
    DRAUGHT_MAX_M,
    IMO_MAX,
    IMO_MIN,
    LENGTH_MAX_M,
    NAME_MAX_CHARS,
    SHIP_TYPE_MAX,
    SHIP_TYPE_MIN,
    MmsiCategory,
    NavigationalStatus,
    Vessel,
    VesselEta,
    ais_bearing,
    mmsi_category,
    speed_over_ground_mps,
)
from tracker.sources.base import (
    RATE_LIMIT_STATUS_CODES,
    ParsedRecords,
    RateLimitedError,
    SourceError,
    retry_after_seconds,
)

_log = logging.getLogger(__name__)

SOURCE_NAME: Final = "transpordiamet"
"""Per-record provider name, per ADR 010. The authority, not the software behind it.

``transpordiamet`` rather than ``nutimeri`` or ``arcgis``: Nutimeri is the authority's chart
viewer and the AIS layer is not in it, and ArcGIS is the server product several unrelated
authorities happen to run. Naming the authority is what makes the licence and the attribution
on a card mean something.
"""

CACHE_NAMESPACE: Final = SOURCE_NAME
"""Prefix for every key this module writes to the shared :class:`~tracker.cache.DiskCache`."""

ATTRIBUTION: Final = "Vessel data from Transpordiamet (Estonian Transport Administration)"
"""The credit shown wherever these positions are displayed.

**No licence is stated anywhere on the service, and that is recorded rather than glossed.** The
FeatureServer's ``copyrightText`` is an empty string, the host serves no terms page for the
service directory and ``robots.txt`` is a 404. So this credit is courtesy rather than a licence
condition, and it is given for the same reason CelesTrak gets one: naming who the data came
from is how a card stays honest about provenance. See :data:`LICENCE`.
"""

LICENCE: Final = "Not stated by the provider; credit is courtesy"
"""Verified absent rather than assumed, 2026-08-23.

``copyrightText`` on the FeatureServer is empty, there is no terms link in the service
directory, and no licence appears on the viewer. Estonia is an EU member state and the Open
Data Directive points at open terms for public-sector data, but a directive is not a grant on
this endpoint and this project does not infer licences. **This is a licence question to settle
before anything here is redistributed commercially**, and it is the same open state the
CelesTrak and adsbdb rows already carry.
"""

ATTRIBUTION_URL: Final = "https://transpordiamet.ee"

BASE_URL: Final = "https://gis.transpordiamet.ee"
QUERY_PATH: Final = "/arcgis/rest/services/Hosted/AIS_vessels_feature_view/FeatureServer/0/query"
"""The one endpoint this adapter calls, verified live 2026-08-23 returning HTTP 200 and 627
vessels. Enumerated out of the portal's service directory rather than read off documentation,
because the authority publishes a web map and no API reference."""

MIN_INTERVAL_SECONDS: Final = 60.0
"""Cadence floor, in code and not in configuration, per ADR 010.

The provider publishes no rate cap, so this is read off the data. Report ages measured 84
seconds at the freshest, a median of 148 and a maximum of 1,878, so the feed itself does not
turn over faster than about a minute and a quicker poll buys nothing. A minute also matches
every other vessel provider here, which keeps the union's floor one number.
"""

MMSI_DIGITS: Final = 9
"""An MMSI is nine digits. Named because this feed sends it as a string, so the check is a
length rather than a numeric range and a bare 9 in the comparison reads as a magic number."""

MAX_RECORDS_PER_PAGE: Final = 1000
"""``maxRecordCount`` as the service declares it. Asked for explicitly rather than relying on
the server's default, so a lowered default cannot silently halve a page."""

MAX_PAGES: Final = 20
"""Backstop on the paging loop, so a server that always sets ``exceededTransferLimit`` cannot
spin. Twenty pages is 20,000 vessels against a measured 627: far above any real answer and far
below a runaway."""

WGS84_WKID: Final = 4326
"""The only spatial reference this adapter accepts back. Trap 1.

Requested on every call and checked on every response. The service's own default is 3301,
Estonian grid metres, so a missing or changed ``outSR`` must fail loudly here rather than
quietly handing 466,890 to a longitude field.
"""

ESTONIAN_GRID_WKID: Final = 3301
"""The service's default, recorded so the wrong answer has a name in a log line."""

REQUIRED_PARAMS: Final = {
    "where": "1=1",
    "outFields": "*",
    "returnGeometry": "true",
    "outSR": str(WGS84_WKID),
    "f": "json",
}
"""Every request sends all of these. ``outSR`` is trap 1 and ``where`` is not optional:
ArcGIS requires a predicate and answers an error to a query without one."""

MAX_FIX_TIME_AHEAD_SECONDS: Final = 60.0
"""How far ahead of our own clock a fix may be dated before it is refused.

Same guard and same reason as the other two vessel adapters. A fix dated in our future wins
every merge until the clock catches up, which is the accidental provider precedence ADR 010
forbids arriving through a bad timestamp rather than a preference order.
"""

MILLISECOND_EPOCH_FLOOR: Final = 1e11
"""Below this a value is not a millisecond epoch, so it is refused rather than converted.

1e11 milliseconds is 1973. ``sys_timestamp``'s constant -2209161600000 is below it and so is
every plausible seconds-epoch value, which is the point: this feed already contains one field
that looks like a time and is not, so a value that fails the magnitude test is dropped rather
than reinterpreted.
"""

RATE_LIMIT_HELD_OFF_STATUS: Final = 429
"""Status reported on a request this client refused locally, because a cooldown is running.

No response arrived, so there is no real status code to carry. 429 is the one the provider
would have sent.
"""

EMPTY_WORLD_DETAIL: Final = (
    "the vessel query returned no renderable vessel: counted as a failed poll, never as an "
    "empty sea. The existing vessels stay in the store"
)
"""Why an empty answer is a failure rather than a quiet zero.

627 vessels when measured, covering the whole Gulf of Finland. Zero means something broke
upstream, the same call the other vessel adapters and ``celestrak.py`` make.
"""

_DROP_NO_GEOMETRY: Final = "feature carried no usable geometry"
_DROP_MMSI_SHAPE: Final = "MMSI is not nine digits"
_DROP_NO_FIX_TIME: Final = "no timestamp, so the fix has no time"
_DROP_UNUSABLE_FIX_TIME: Final = "timestamp is not a usable millisecond epoch"
_DROP_FUTURE_FIX_TIME: Final = "timestamp is dated ahead of our own clock"
_DROP_WIRE_SHAPE: Final = "record does not match the shape this endpoint sends"
_DROP_CONTRACT: Final = "failed the vessel contract"
"""Drop reasons. Constants so a test can assert one and the log can count them by name."""


def _utc_now() -> datetime:
    return datetime.now(UTC)


class _UnmappableRecordError(ValueError):
    """One record cannot become a :class:`Vessel`, with a short reason for the counter."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


# ---------------------------------------------------------------- wire models


class _GeometryWire(WireModel):
    """An ArcGIS point geometry. ``x`` is longitude and ``y`` is latitude **in 4326 only**.

    Named ``x`` and ``y`` rather than lon and lat because that is what the server calls them
    and because in the service's own default reference they genuinely are eastings and
    northings in metres. The rename happens in :func:`_position`, after the spatial reference
    has been checked, so the names stop being ambiguous at exactly the point the units are
    known.
    """

    x: float | None = None
    y: float | None = None


class _SpatialReferenceWire(WireModel):
    """The reference the server actually answered in. Trap 1's guard.

    ``latestWkid`` is what modern ArcGIS sets and ``wkid`` is the older spelling; both are read
    because a server may send either and agreeing on 4326 is the whole check.
    """

    wkid: int | None = None
    latest_wkid: int | None = Field(default=None, alias="latestWkid")

    @property
    def code(self) -> int | None:
        """The reference code, preferring the modern field."""
        return self.latest_wkid if self.latest_wkid is not None else self.wkid


class _AttributesWire(WireModel):
    """One vessel's attributes.

    ``sys_timestamp`` is **deliberately not modelled**. It is a constant -2209161600000 on
    every record, which is 1 January 1900, and trap 2 is what happens when something reads it
    as the observation time. Leaving it out of this model means nothing downstream can reach
    for it by mistake, which is the same call ``fintraffic.py`` makes by renaming Digitraffic's
    ``timestamp`` to ``second_of_minute``.

    ``flag`` is also absent: it is a three-letter country string the provider derives rather
    than something AIS broadcasts, and the domain has nowhere to put it. The MID inside the
    MMSI carries the same fact and carries it from the source.
    """

    mmsi: str | None = None
    name: str | None = None
    callsign: str | None = None
    imo: str | None = None
    destination: str | None = None
    type_and_cargo: int | None = None
    nav_status: int | None = None
    sog: float | None = None
    cog: float | None = None
    true_heading: float | None = None
    length: float | None = None
    width: float | None = None
    draught: float | None = None
    eta: int | None = None
    timestamp: int | None = None


class _FeatureWire(WireModel):
    """One vessel: its attributes and its point."""

    attributes: _AttributesWire | None = None
    geometry: _GeometryWire | None = None


class _ErrorWire(WireModel):
    """The ``error`` object ArcGIS returns inside an HTTP 200 body. Trap 3."""

    code: int | None = None
    message: str | None = None


class _ResponseWire(WireModel):
    """The query response envelope.

    ``features`` is not required, because an error response carries an ``error`` key and no
    ``features`` at all, and trap 3 says that arrives with a 200. So the envelope has to be
    readable in both shapes and :func:`parse_features` decides which one it got.

    Each feature is left unvalidated here and validated on its own by
    :data:`_FEATURE_ADAPTER`, for the reason the other vessel adapters document: validating
    the whole array in one pass lets one junk record reject the entire body and empty the
    layer.
    """

    features: tuple[object, ...] | None = None
    error: _ErrorWire | None = None
    spatial_reference: _SpatialReferenceWire | None = Field(default=None, alias="spatialReference")
    exceeded_transfer_limit: bool = Field(default=False, alias="exceededTransferLimit")


_RESPONSE_ADAPTER: Final = TypeAdapter(_ResponseWire)
_FEATURE_ADAPTER: Final = TypeAdapter(_FeatureWire)


# ---------------------------------------------------------------- field mapping


def _identity(attributes: _AttributesWire) -> str:
    """The vessel's MMSI, or a drop naming why.

    The MMSI arrives as a nine-character string on all 627 live records, so unlike every other
    adapter here there is nothing to zero-pad: the value is taken as sent and refused if it is
    not nine digits. Padding a shorter one would invent an identity, and the merge key under
    ADR 010 is the vessel's own.

    The ITU category check is the same rule the rest of the layer uses, and it is not
    theoretical on a Baltic feed: Fintraffic's own body carries the 999999999 placeholder and
    two search-and-rescue helicopters on the ``111`` prefix.
    """
    raw = (attributes.mmsi or "").strip()
    if len(raw) != MMSI_DIGITS or not raw.isdigit():
        raise _UnmappableRecordError(_DROP_MMSI_SHAPE)
    category = mmsi_category(raw)
    if category is not MmsiCategory.SHIP_STATION:
        msg = f"MMSI is a {category.value}, not a ship station"
        raise _UnmappableRecordError(msg)
    return raw


def _position(geometry: _GeometryWire | None, reference: int | None) -> Point:
    """Read longitude and latitude off an ArcGIS point, in WGS84 and nothing else.

    Trap 1, and the reason this takes the spatial reference as an argument rather than trusting
    the request. A query without ``outSR`` answers in EPSG:3301, Estonian grid metres, where
    the same berth reads ``x: 466890.13, y: 6529584.57``. Handed to this project's contract
    that fails validation on every record, so the layer would report an empty sea rather than a
    projection mistake, and a reader would look for a dead feed rather than a wrong parameter.

    Refusing an unexpected reference rather than reprojecting is deliberate. This project's
    rule is that Cesium owns all projection and the domain is WGS84 throughout, so an adapter
    that quietly reprojected would be the only place in the tree doing coordinate maths, and
    getting it subtly wrong returns a valid answer about the wrong place.

    Raises:
        _UnmappableRecordError: the geometry is absent or incomplete, or the server answered in
            a reference this adapter will not read.
    """
    if reference != WGS84_WKID:
        msg = f"response is in EPSG:{reference}, not EPSG:{WGS84_WKID}; refusing to reproject"
        raise _UnmappableRecordError(msg)
    if geometry is None or geometry.x is None or geometry.y is None:
        raise _UnmappableRecordError(_DROP_NO_GEOMETRY)
    return Point(lon=geometry.x, lat=geometry.y)


def _from_ms_epoch(millis: int) -> datetime | None:
    """Convert a 13-digit millisecond epoch to UTC, or ``None`` if it is not one.

    The magnitude floor is what keeps trap 2 from becoming a silent 1900: ``sys_timestamp``'s
    constant is far below it. A platform that cannot represent the value returns ``None`` as
    well, because a nonsense figure must not escape as an ``OverflowError`` and kill the poll.
    """
    if millis < MILLISECOND_EPOCH_FLOOR:
        return None
    try:
        return datetime.fromtimestamp(millis / 1000.0, tz=UTC)
    except (OverflowError, OSError, ValueError):
        return None


def _fix_time(attributes: _AttributesWire, *, now: datetime) -> datetime:
    """When the position was fixed, from ``timestamp`` and nothing else.

    Trap 2 lives here by omission: ``sys_timestamp`` is not on the wire model, so the only
    field this can read is the real one.

    Raises:
        _UnmappableRecordError: no fix time, one that is not a millisecond epoch, or one dated
            ahead of our clock.
    """
    if attributes.timestamp is None:
        raise _UnmappableRecordError(_DROP_NO_FIX_TIME)
    fixed_at = _from_ms_epoch(attributes.timestamp)
    if fixed_at is None:
        raise _UnmappableRecordError(_DROP_UNUSABLE_FIX_TIME)
    if (fixed_at - now).total_seconds() > MAX_FIX_TIME_AHEAD_SECONDS:
        raise _UnmappableRecordError(_DROP_FUTURE_FIX_TIME)
    return fixed_at


def _eta(millis: int | None) -> VesselEta | None:
    """Decode this feed's ETA, which is a real timestamp rather than the packed AIS field.

    **The one place this provider carries more than the domain can hold.** Every other AIS
    source here sends the 20-bit packed ETA, which has month, day, hour and minute and no year
    at all, so :class:`~tracker.contracts.vessel.VesselEta` has no year field and its docstring
    says why. This feed sends a millisecond epoch, which does have one.

    The year is therefore dropped, deliberately and with the loss stated here rather than
    hidden. Two reasons. The alternative is a year on Estonian ETAs and no year on every other
    provider's, which is a contract that means different things per source, and a card cannot
    show a field that is sometimes there. And an ETA is a crew-typed intention that is
    routinely stale: the live body carried one dated three months in the past, so the year adds
    less than it looks like it does.

    Returns:
        The ETA's month, day, hour and minute in UTC, or ``None`` when the field is absent or
        is not a usable epoch. ``null`` is a real value on this feed.
    """
    if millis is None:
        return None
    when = _from_ms_epoch(millis)
    if when is None:
        return None
    return VesselEta(month=when.month, day=when.day, hour=when.hour, minute=when.minute)


def _clean_text(raw: str | None, limit: int) -> str | None:
    """Strip a text field and map an empty string to ``None``.

    The feed sends ``""`` rather than ``null`` for missing text on some fields and a real
    ``null`` on others: ``name`` empty on 6 of 627, ``destination`` on 147, ``imo`` absent or
    empty on 219. Both forms have to mean the same thing or a quarter of the feed fails the
    contract the day the provider changes its mind.
    """
    if raw is None:
        return None
    return raw.strip()[:limit] or None


def _imo(raw: str | None) -> int | None:
    """The IMO number, or ``None`` for the sentinel, an empty string and anything junk.

    A **string** on this feed where every other provider sends an int, so it is parsed rather
    than range-checked first. Absent, empty or ``"0"`` on 219 of 627 live records.
    """
    text = (raw or "").strip()
    if not text.isdigit():
        return None
    value = int(text)
    return value if IMO_MIN <= value <= IMO_MAX else None


def _ship_type(value: int | None) -> int | None:
    """The AIS ship and cargo type, or ``None`` for the not-available sentinel.

    Called ``type_and_cargo`` here and ``shipType`` on Digitraffic. 0 on 14 of 627.
    """
    if (
        value is None
        or value == AIS_SHIP_TYPE_NOT_AVAILABLE
        or not SHIP_TYPE_MIN <= value <= SHIP_TYPE_MAX
    ):
        return None
    return value


def _dimension(value: float | None, limit: float) -> float | None:
    """A length, beam or draught in metres, or ``None`` when the feed carries none.

    **Metres on this feed**, and that is measured rather than assumed: draughts run 0 to 16.3,
    which is a laden bulk carrier. Digitraffic sends the same word in decimetres on
    ``/api/ais/v1/vessels``, so read that way the deepest ship in the Gulf of Finland would
    draw 1.63 m.

    0 means not available: ``draught`` on 29 of 627, ``length`` on 19, ``width`` on 20. A value
    past the field's own bound empties one optional field rather than dropping a real ship.
    """
    if value is None or value <= float(AIS_DRAUGHT_NOT_AVAILABLE) or value > limit:
        return None
    return float(value)


def _nav_status(code: int | None) -> NavigationalStatus | None:
    """Map the AIS navigational status code, leaving the undefined and reserved ones empty."""
    return None if code is None else AIS_NAV_STATUS_CODES.get(code)


def _to_vessel(
    feature: _FeatureWire, *, reference: int | None, now: datetime, source: str
) -> Vessel:
    """Map one feature into the domain contract.

    ``observed_at`` is the later of our receive clock and this record's own fix, so
    ``observed_at - position_age_s`` recovers the fix exactly and the age can never be
    negative. Our clock because the response carries no build time of its own, the same call
    ``kystdatahuset.py`` makes.

    Raises:
        _UnmappableRecordError: the record cannot be identified, located or dated.
        ValidationError: the mapped values do not satisfy the vessel contract.
    """
    if feature.attributes is None:
        raise _UnmappableRecordError(_DROP_WIRE_SHAPE)
    attributes = feature.attributes
    mmsi = _identity(attributes)
    fixed_at = _fix_time(attributes, now=now)
    observed_at = max(now, fixed_at)
    return Vessel(
        mmsi=mmsi,
        name=_clean_text(attributes.name, NAME_MAX_CHARS),
        call_sign=_clean_text(attributes.callsign, CALL_SIGN_MAX_CHARS),
        imo=_imo(attributes.imo),
        ship_type=_ship_type(attributes.type_and_cargo),
        point=_position(feature.geometry, reference),
        course_over_ground_deg=ais_bearing(attributes.cog, AIS_COG_NOT_AVAILABLE),
        speed_over_ground_mps=speed_over_ground_mps(attributes.sog),
        true_heading_deg=ais_bearing(attributes.true_heading, AIS_HEADING_NOT_AVAILABLE),
        # No rate of turn on this endpoint. Left empty rather than derived from two fixes,
        # which would be our arithmetic and not something a receiver reported.
        rate_of_turn_deg_per_min=None,
        navigational_status=_nav_status(attributes.nav_status),
        draught_m=_dimension(attributes.draught, DRAUGHT_MAX_M),
        length_m=_dimension(attributes.length, LENGTH_MAX_M),
        beam_m=_dimension(attributes.width, BEAM_MAX_M),
        destination=_clean_text(attributes.destination, DESTINATION_MAX_CHARS),
        eta=_eta(attributes.eta),
        observed_at=observed_at,
        position_age_s=(observed_at - fixed_at).total_seconds(),
        source=source,
    )


def parse_features(
    payload: bytes | str,
    *,
    source: str = SOURCE_NAME,
    now: datetime | None = None,
) -> tuple[ParsedRecords[Vessel], bool]:
    """Parse one page of the query response into vessels.

    Args:
        payload: The raw response body.
        source: Provider name, recorded on every record per ADR 010.
        now: Our own clock. Supplies ``observed_at`` and bounds how far ahead a fix may be
            dated. Defaults to the wall clock.

    Returns:
        The vessels and drops for this page, plus whether the server said there is more. The
        flag is returned rather than acted on here so paging stays the client's job and the
        parser stays a pure function of one body.

    Raises:
        SourceError: the body is an ArcGIS error. Trap 3: that arrives with HTTP 200, so it
            has to be raised from the parse rather than caught from the status.
        ContractViolationError: the body is not this endpoint's shape at all. Loud on purpose,
            because a shape change that parsed to zero vessels would read as a healthy but
            empty layer.
    """
    wire = validate_payload(_RESPONSE_ADAPTER, payload, source=source)
    if wire.error is not None:
        # Trap 3. HTTP 200 with the failure in the body, the MediaWiki action API shape.
        detail = f"HTTP 200 carrying an ArcGIS error {wire.error.code}: {wire.error.message}"
        raise SourceError(source, detail)
    if wire.features is None:
        msg = "response carried neither features nor an error"
        raise SourceError(source, msg)

    reference = wire.spatial_reference.code if wire.spatial_reference is not None else None
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
            vessels.append(_to_vessel(feature, reference=reference, now=clock_now, source=source))
        except _UnmappableRecordError as exc:
            dropped[exc.reason] += 1
        except ValidationError as exc:
            dropped[_DROP_CONTRACT] += 1
            _log.debug("dropping vessel: %s", exc)

    if dropped:
        _log.info(
            "%s: kept %d vessels, dropped %d (%s)",
            source,
            len(vessels),
            sum(dropped.values()),
            dict(dropped),
        )
    return ParsedRecords(records=tuple(vessels), drops=dropped), wire.exceeded_transfer_limit


# ---------------------------------------------------------------- client


class TranspordiametClient:
    """Fetches vessels from the Estonian Transpordiamet ArcGIS service. Keyless.

    Holds one piece of state, a throttling cooldown, on disk for the reason
    ``kystdatahuset.py`` sets out at length: a union member's exception never reaches the
    poller, because ``app._provider_result`` turns any failure into a provider that dropped out
    of the cycle, so a provider's own backoff figure has to be honoured where the response
    arrived. On disk because in-memory rate state does not survive a restart and a restart loop
    is indistinguishable from hammering.

    The cadence floor is not persisted separately: the vessel poller already persists its own
    next-allowed-poll time through the same cache at the same 60 seconds, so a second identical
    floor would add nothing and would let a second of clock jitter make the layer read degraded
    when nothing is wrong. Same argument ``AishubClient`` makes.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        base_url: str = BASE_URL,
        cache: DiskCache | None = None,
        clock: Callable[[], datetime] = _utc_now,
    ) -> None:
        self._client = client
        self._base_url = base_url.rstrip("/")
        self._cache = cache
        self._clock = clock
        self._not_before: datetime | None = None

    @property
    def name(self) -> str:
        """Provider name, recorded on every record this client produces."""
        return SOURCE_NAME

    @property
    def min_interval_seconds(self) -> float:
        """The provider's cadence floor. A constant in code, with no way in from settings."""
        return MIN_INTERVAL_SECONDS

    async def all_vessels(self) -> ParsedRecords[Vessel]:
        """Every vessel the service holds, paging until the server says there is no more.

        Args are not exposed for a viewport: the service is one small sea and the whole answer
        is 627 records in 320KB, so there is nothing to filter server-side that would pay for
        the extra request shape.

        **Deduplicated across pages, keeping the freshest fix.** ArcGIS paging is offset-based
        over a dataset that is being written to while we read it, so a vessel whose row moves
        between two requests can arrive on both pages or on neither. Concatenating the pages
        would put the same MMSI in the result twice, and while ``merge_providers`` would
        collapse it later, the count this method returns would already be wrong and
        ``/api/layers`` would report ships that are not on the globe. One record per identity
        is asserted at the layer under ADR 010, so it is enforced here too, by the same recency
        rule the merge uses.

        Raises:
            RateLimitedError: the provider is inside a backoff it asked for, or just asked.
            SourceError: an ArcGIS error inside an HTTP 200, or a query that produced no
                renderable vessel at all. See :data:`EMPTY_WORLD_DETAIL`.
        """
        freshest: dict[str, Vessel] = {}
        drops: Counter[str] = Counter()
        offset = 0
        for _ in range(MAX_PAGES):
            page, more = parse_features(
                await self._get(offset), source=SOURCE_NAME, now=self._clock()
            )
            for vessel in page.records:
                held = freshest.get(vessel.mmsi)
                if held is None or vessel.position_age_s < held.position_age_s:
                    freshest[vessel.mmsi] = vessel
            drops.update(page.drops)
            if not more:
                break
            offset += MAX_RECORDS_PER_PAGE
        else:
            # Fell out of the loop still being told there is more. Serve what we have and say
            # so, rather than either spinning or pretending the answer was complete.
            _log.warning(
                "%s: stopped after %d pages with the server still reporting more; "
                "serving %d vessels",
                SOURCE_NAME,
                MAX_PAGES,
                len(freshest),
            )
        if not freshest:
            raise SourceError(SOURCE_NAME, EMPTY_WORLD_DETAIL)
        return ParsedRecords(records=tuple(freshest.values()), drops=drops)

    async def _get(self, offset: int) -> bytes:
        """One page, refusing to send it while a backoff the provider asked for is running.

        Raises:
            RateLimitedError: a cooldown is in force, or this response started one.
        """
        remaining = self._cooldown_remaining()
        if remaining > 0.0:
            raise RateLimitedError(SOURCE_NAME, RATE_LIMIT_HELD_OFF_STATUS, remaining)

        params = {
            **REQUIRED_PARAMS,
            "resultRecordCount": str(MAX_RECORDS_PER_PAGE),
            "resultOffset": str(offset),
        }
        response = await self._client.get(f"{self._base_url}{QUERY_PATH}", params=params)
        if response.status_code in RATE_LIMIT_STATUS_CODES:
            wait = retry_after_seconds(response)
            self._hold_off(response.status_code, wait)
            raise RateLimitedError(SOURCE_NAME, response.status_code, wait)
        response.raise_for_status()
        return response.content

    def _cooldown_key(self) -> str:
        return cache_key(CACHE_NAMESPACE, "not_before")

    def _cooldown_remaining(self) -> float:
        """Seconds left on the provider's backoff, or zero when it may be called."""
        until = (
            self._cache.get_time(self._cooldown_key())
            if self._cache is not None
            else self._not_before
        )
        if until is None:
            return 0.0
        return max(0.0, (until - self._clock()).total_seconds())

    def _hold_off(self, status_code: int, seconds: float) -> None:
        """Record the provider's own backoff, never shortening one already in force."""
        held = max(seconds, self._cooldown_remaining())
        until = self._clock() + timedelta(seconds=held)
        self._not_before = until
        if self._cache is not None:
            self._cache.set_time(self._cooldown_key(), until)
        _log.warning(
            "%s answered HTTP %d; holding off until %s",
            SOURCE_NAME,
            status_code,
            until.isoformat(),
        )
