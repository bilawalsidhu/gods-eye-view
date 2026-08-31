"""Great Lakes / St Lawrence Seaway AIS adapter. The first vessel provider outside Europe.

The Vessel Information System behind the public traffic map at
``vis.greatlakes-seaway.com``, run jointly by the St Lawrence Seaway Management Corporation
(Canada) and the Saint Lawrence Seaway Development Corporation (United States). It is a
**GraphQL** endpoint, not REST, and it answers with no credential of any kind.

**This is the source that puts ships on a second continent.** Verified live on 2026-08-23:
1,664 vessels inside a ten-minute window across lon -92.10 to -51.83 and lat 41.42 to 51.61,
which is the Great Lakes, the St Lawrence, the Gulf of St Lawrence and the approaches. MMSI
MIDs are 316 (Canada, 810 vessels), 338/366/367/368/369 (United States, about 756) and a tail
of ocean-going flags including 538 Marshall Islands, 636 Liberia and 311 Bahamas. Before this,
every ship on the globe was in northern Europe.

**Keyless, proved rather than assumed.** ``robots.txt`` on both the API host and the map host
is ``User-agent: *`` with an empty ``Disallow:``. A cold POST carrying only a User-Agent and a
content type, with no cookie, no referer, no session and no authorization header, returned the
full 7,118-record body. The public map's own JavaScript bundle names this endpoint, this
operation and this argument, and the word "anonymous" appears in it nineteen times: the
anonymous read path is the provider's own design rather than something worked around. The same
schema exposes ``currentUser``, ``roles`` and ``directoryUsers``, which is what an internal
operations tool looks like from outside, so **this adapter queries the AIS fields and nothing
else**. Nothing here reads a user, a pilot assignment or an agent.

Six traps, all measured on the live body. Each produces wrong output rather than an error.

**1. ``age`` is not an age. It is an absolute ISO 8601 timestamp**, and the field name is
actively misleading: ``"age": "2026-08-23T10:41:51Z"``. Anything treating it as a duration in
seconds gets a string, and anything treating it as elapsed time gets 2026 as a number of
seconds, which is half an hour. It is the only time field on the record and it is the fix time.

**2. The response is a sixty-day roster, not a live snapshot, and this is the big one.** Of
7,118 records, the median report was **2.4 days old**, the 90th percentile 33.6 days and the
oldest **60 days**. 4,100 of 7,118 were older than 24 hours. Rendering the body as served
draws four thousand ghost ships parked where they were up to two months ago, which is the
Digitraffic 24-hour-default trap an order of magnitude worse. The server cannot help: its own
``ageOrLastUpdatedDays`` filter is in **whole days**, so the cut has to be local. See
:data:`FRESHNESS_WINDOW_SECONDS`.

**3. ``sessionFilterOverrides`` is required, has about seventy non-null boolean fields and no
defaults, and every one of them silently narrows the answer.** Omit the argument and the query
fails; supply it with any single vessel-type, fleet, navigational-status or transponder-class
flag false and that entire class of vessel disappears with no error and no count. The filter is
therefore built here from named groups, every inclusion flag true, and only the genuinely
narrowing flags false. See :data:`_FILTER`.

**4. A GraphQL error arrives as HTTP 200 with an ``errors`` array.** A misspelled field
answered 200 with ``{"errors":[{"message":"Cannot query field 'name' on type
'AisInformationType'"}]}``, so ``raise_for_status`` passes and a client reaching for ``data``
gets ``None``. Same class as the MediaWiki action API and the ArcGIS traps already recorded.

**5. ``latitude == 91`` and ``longitude == 181`` are the AIS position-not-available sentinel**,
14 of 7,118 records, and 91 is a legal float that a naive range check on latitude would pass.
Those records are dropped and counted; they are not placed at the North Pole.

**6. ``accuracyType: MALFUNCTION`` does NOT mean a bad position, and dropping on it would throw
away four fifths of the live feed.** It reads MALFUNCTION on 6,103 of 7,118 records overall and
on 1,351 of the 1,664 inside the freshness window. Measured: the bounding box of the fresh
MALFUNCTION records is lon -92.10 to -52.40, against -92.07 to -52.34 for HIGH and -91.14 to
-51.83 for LOW. Same water, same spread, so the flag is not describing a broken fix. It is
carried nowhere and acted on nowhere.

**Two fields are called ``id`` and only one is an MMSI.** ``aisInformation.id`` is the
nine-digit MMSI. The outer ``VesselType.id`` was ``null`` on every one of 7,118 records, so a
reader taking the obvious outer one gets nothing. The vessel's name and dimensions, however,
are only on the outer object, so both levels have to be read.

**What this feed does not carry**: no call sign, no rate of turn, no ETA and no draught. They
are absent from the schema rather than empty, confirmed by introspecting
``AisInformationType`` and ``VesselType``, so the domain fields stay empty rather than being
derived from something else.

**The host serves an incomplete TLS chain, and it works in curl and fails in Python.** That
cost real time, so it is written down. All three of the provider's hostnames present the leaf
certificate alone and omit the Sectigo intermediate that signs it, which ``openssl`` reports as
``verify error:num=21: unable to verify the first certificate``. Browsers and curl paper over it
by fetching the missing intermediate from the ``authorityInfoAccess`` URL in the leaf; Python's
``ssl`` module does no such fetch, so httpx fails with ``CERTIFICATE_VERIFY_FAILED: unable to
get local issuer certificate`` against a host a shell command had just read fine. Measured live
2026-08-23. :func:`ssl_context` supplies the intermediate so the chain completes. See that
function for why this is not a weakening of verification.
"""

import logging
import ssl
from collections import Counter
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Final

import httpx
from pydantic import Field, TypeAdapter, ValidationError

from tracker.cache import DiskCache
from tracker.cache import key as cache_key
from tracker.contracts.base import WireModel, validate_payload
from tracker.contracts.geo import Point
from tracker.contracts.vessel import (
    AIS_COG_NOT_AVAILABLE,
    AIS_HEADING_NOT_AVAILABLE,
    AIS_IMO_NOT_AVAILABLE,
    AIS_NAV_STATUS_CODES,
    AIS_SHIP_TYPE_NOT_AVAILABLE,
    BEAM_MAX_M,
    DESTINATION_MAX_CHARS,
    IMO_MAX,
    IMO_MIN,
    LENGTH_MAX_M,
    NAME_MAX_CHARS,
    SHIP_TYPE_MAX,
    SHIP_TYPE_MIN,
    MmsiCategory,
    NavigationalStatus,
    Vessel,
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

SOURCE_NAME: Final = "seaway"
"""Per-record provider name, per ADR 010.

The Seaway rather than either corporation that runs it, because the system is jointly operated
by the Canadian and United States authorities and crediting one would be wrong half the time.
"""

CACHE_NAMESPACE: Final = SOURCE_NAME
"""Prefix for every key this module writes to the shared :class:`~tracker.cache.DiskCache`."""

ATTRIBUTION: Final = (
    "Vessel data from the Great Lakes St. Lawrence Seaway Vessel Information System"
)
"""The credit shown wherever these positions are displayed.

Courtesy rather than a licence condition, because no licence is stated. Given for the same
reason CelesTrak's is: naming who the data came from is how a card stays honest about
provenance.
"""

LICENCE: Final = "Not stated by the provider; credit is courtesy"
"""Verified absent rather than assumed, 2026-08-23.

No terms page was found on the API host or the map host, ``robots.txt`` on both permits
everything, and the GraphQL response carries no licence field. **This is a licence question to
settle before anything here is redistributed commercially**, and it is the same open state the
CelesTrak, adsbdb and Transpordiamet rows already carry. Both operating corporations are public
bodies, which points at open terms and is not a grant.
"""

ATTRIBUTION_URL: Final = "https://greatlakes-seaway.com"

BASE_URL: Final = "https://vis.seaway.ca"
GRAPHQL_PATH: Final = "/graphql"
"""The one endpoint this adapter calls, verified live 2026-08-23 returning HTTP 200 and 7,118
vessels to an anonymous POST. Found by reading the public map's own JavaScript bundle, because
the provider publishes a map and no API reference."""

MIN_INTERVAL_SECONDS: Final = 60.0
"""Cadence floor, in code and not in configuration, per ADR 010.

No rate cap is published, on the response headers, in ``robots.txt`` or on any terms page, so
this is read off the data. The freshest report in the body was 119 seconds old and the
ten-minute window held 1,664 vessels against 1,537 at five minutes, so the feed turns over on
the order of minutes and a faster poll buys almost nothing. A minute also matches every other
vessel provider here, which keeps the union's floor one number.
"""

FRESHNESS_WINDOW_SECONDS: Final = 600.0
"""How old a report may be before it is refused. Trap 2, and the single most important constant
in this module.

Ten minutes, chosen to match what the other two keyless vessel providers already do:
Kystdatahuset serves the last ten minutes by the provider's own design and Fintraffic is
queried with a ten-minute ``from``. So the whole layer carries one definition of "now" rather
than one per source.

Measured on the live body at each candidate window: 300s gave 1,537 vessels, 600s gave 1,664,
900s gave 1,681 and 3600s gave 1,734. So widening past ten minutes buys about one per cent more
ships and drags in a tail whose median is 2.4 days. Ten minutes is where the curve flattens.

**A refused record is counted as a drop rather than filtered silently.** A stale report mapped
cleanly and was not junk, so counting it looks harsh: the reason it is counted anyway is that
``/api/layers`` would otherwise show this provider serving 7,118 records while the globe drew
1,664, and nobody reading that could tell whether the other 5,454 were lost or never wanted.
"""

MMSI_MAX: Final = 999_999_999
"""An MMSI is nine digits, so anything above this is not one."""

LATITUDE_NOT_AVAILABLE: Final = 91.0
LONGITUDE_NOT_AVAILABLE: Final = 181.0
"""Trap 5. The AIS position-not-available sentinels, 14 of 7,118 live records.

Both are legal floats and 91 is only just outside a latitude's range, so they are named and
tested for rather than left to a bounds check.
"""

MAX_FIX_TIME_AHEAD_SECONDS: Final = 60.0
"""How far ahead of our own clock a fix may be dated before it is refused.

Same guard and same reason as every other vessel adapter here: a future-dated fix wins every
merge until the clock catches up, which is the accidental provider precedence ADR 010 forbids.
No live record needed it; the body carried zero future-dated reports.
"""

RATE_LIMIT_HELD_OFF_STATUS: Final = 429
"""Status reported on a request this client refused locally, because a cooldown is running."""

EMPTY_WORLD_DETAIL: Final = (
    "the vessel query returned no vessel inside the freshness window: counted as a failed "
    "poll, never as an empty sea. The existing vessels stay in the store"
)
"""Why an empty answer is a failure rather than a quiet zero.

1,664 vessels inside the window when measured. Zero means either the feed broke or every
report went stale at once, and both are failures rather than an empty Great Lakes.
"""

# ---------------------------------------------------------------- the required filter
#
# Trap 3. Every name below is a non-null Boolean on FilterInputType with no default, read off
# the live schema by introspection on 2026-08-23. Omitting the argument fails the query;
# setting any inclusion flag false silently removes that class of vessel with no error and no
# count, which is the worst possible failure mode for a coverage feed.

_VESSEL_TYPE_FLAGS: Final = (
    "vesselTypeUnspecified",
    "vesselTypeCargo",
    "vesselTypeTanker",
    "vesselTypePassengerOnly",
    "vesselTypeCargoAndPassenger",
    "vesselTypeTankBarge",
    "vesselTypeCargoBarge",
    "vesselTypeUnderTow",
    "vesselTypeDredge",
    "vesselTypeScow",
    "vesselTypeBarge",
    "vesselTypeTug",
    "vesselTypeNavalMilitary",
    "vesselTypeGovernment",
    "vesselTypeOther",
    "vesselTypePleasureCraft",
    "vesselTypeSeawayVessels",
    "vesselTypeCoastGuard",
    "vesselTypeBulkCarrier",
    "vesselTypeSelfUnloader",
    "vesselTypeHeavyLift",
    "vesselTypeRollOnRollOff",
)
"""Ship classes. ``vesselTypeUnspecified`` is in deliberately: 138 records carried AIS ship
type 0 and dropping them would lose real ships over a missing attribute."""

_VESSEL_FLEET_FLAGS: Final = ("vesselFleetInland", "vesselFleetOcean", "vesselFleetUnspecified")

_NAVIGATION_STATUS_FLAGS: Final = tuple(f"vesselNavigationStatus{code}" for code in range(16))
"""All sixteen AIS navigational statuses, 15 (undefined) included. It was set on 5,544 of
7,118 records, so excluding it would remove most of the feed."""

_DISPLAY_FLAGS: Final = (
    "isVesselDisplayedAtDestination",
    "isVesselDisplayedAtDock",
    "isVesselDisplayedAtPort",
    "isVesselDisplayedAtTurningLocation",
    "isVesselDisplayedWhenDelayed",
    "isVesselDisplayedWhenInTransit",
    "isVesselDisplayedWhenStopped",
)
"""Where a vessel may be and still be returned. All true: a ship at a dock is still a ship."""

_TRANSPONDER_FLAGS: Final = ("transponderClassA", "transponderClassB")

_NARROWING_FLAGS: Final = (
    "withTransitOnly",
    "withTransitHistory",
    "agentOwnerOnly",
    "pilotOnBoard",
    "pilotSlbUp",
    "pilotBohUp",
    "pilotBohDown",
    "pilotSnlUp",
    "pilotSnlDown",
    "pilotIroUp",
    "pilotIroDown",
    "pilotCvcUp",
    "pilotCvcDown",
    "pilotC15Up",
    "pilotLieUp",
    "pilotLonDown",
    "pilotC16Down",
    "pilotL07Down",
    "pilotMtlDown",
    "pilotSlrDown",
)
"""The only flags set false, because each restricts the answer to a subset rather than
including a class.

``withTransitOnly`` would return only vessels in a booked Seaway transit, ``agentOwnerOnly``
only those belonging to the caller, and every ``pilot*`` flag only those with a particular
pilot boarding assignment. Those last seventeen are also the operational half of an internal
tool, and this adapter has no business filtering on who is piloting a ship.
"""

_FILTER: Final[dict[str, bool]] = {
    **dict.fromkeys(_VESSEL_TYPE_FLAGS, True),
    **dict.fromkeys(_VESSEL_FLEET_FLAGS, True),
    **dict.fromkeys(_NAVIGATION_STATUS_FLAGS, True),
    **dict.fromkeys(_DISPLAY_FLAGS, True),
    **dict.fromkeys(_TRANSPONDER_FLAGS, True),
    **dict.fromkeys(_NARROWING_FLAGS, False),
}
"""The complete argument. 50 flags true and 20 false, which is what returned all 7,118."""

QUERY: Final = """query getAllVessels($filter: FilterInputType!) {
  aisOnlyVessels(sessionFilterOverrides: $filter) {
    name
    overallLength
    extremeBeam
    aisInformation {
      id
      latitude
      longitude
      cog
      heading
      speed
      navigationStatus
      vesselType
      destination
      age
      imoNumber
    }
  }
}"""
"""The one operation this adapter sends.

Deliberately narrow. The schema also exposes users, roles, pilot assignments, camera feeds and
transit plans, and none of that is any of our business: this asks for positions and the
attributes that describe a ship. ``accuracyType`` is not requested either, because trap 6 says
it must not be acted on and a field nobody may act on is a field not worth carrying.
"""

INTERMEDIATE_CERTIFICATE: Final = Path(__file__).with_name("seaway_intermediate.pem")
"""The intermediate certificate this provider's servers fail to send.

``Sectigo Public Server Authentication CA DV R36``, SHA-256 fingerprint
``8C:54:C3:34:B6:6B:A4:E4:26:77:2A:F4:A3:F9:13:6C:19:A1:AE:C7:29:FD:B2:8C:53:5C:07:A5:A4:EF:22:E0``,
valid until 21 March 2036. Fetched on 2026-08-23 from the ``authorityInfoAccess`` URL inside
the provider's own leaf certificate, which is the same place a browser would fetch it from.

Committed rather than downloaded at runtime, because a network fetch inside TLS setup is a
failure mode worse than the one it fixes, and because a pinned file is reviewable. It is a
public CA intermediate, freely redistributable, and it expires in 2036: when the provider fixes
its chain this file becomes dead weight and can go.
"""


def ssl_context() -> ssl.SSLContext:
    """A TLS context that can complete this provider's chain.

    **This does not weaken verification, and the reason is the whole point.** The intermediate
    loaded here is itself signed by ``Sectigo Public Server Authentication Root R46``, which is
    already in ``certifi``, so it was already trusted transitively: nothing becomes trusted that
    was not trusted before. All that changes is that the link the server omits is now available
    locally, so the chain can be built and then fully verified. Hostname checking and expiry
    checking are untouched, and ``vis.seaway.ca`` is a real ``subjectAltName`` on the leaf
    alongside ``vis.greatlakes-seaway.com`` and ``siv.grandslacs-voiemaritime.com``.

    Verified 2026-08-23: ``openssl verify`` against the trusted bundle with this intermediate
    passed as ``-untrusted`` returned ``OK``, and httpx with this context returned HTTP 200
    where httpx with its default context raised ``CERTIFICATE_VERIFY_FAILED``.

    **What was deliberately not done.** ``verify=False`` would have been one character and is
    not on the table: it turns off certificate validation for the whole client, and a live
    position feed read over an unverified connection is worse than no feed. Reaching for the
    operating system's trust store instead would work on this laptop and might not in CI, which
    trades a clear failure for an environment-dependent one.
    """
    # httpx's own default rather than ssl.create_default_context(), so this starts from
    # exactly the trust baseline every other client in this app uses and adds one link to it.
    # It also means no new dependency: reaching for certifi directly would import a package
    # this project does not declare and only has because httpx pulls it in.
    context = httpx.create_ssl_context()
    context.load_verify_locations(cafile=str(INTERMEDIATE_CERTIFICATE))
    return context


_DROP_NO_AIS: Final = "record carried no AIS information"
_DROP_POSITION_UNAVAILABLE: Final = "position is the AIS not-available sentinel"
_DROP_NO_POSITION: Final = "record carried no latitude or longitude"
_DROP_MMSI_RANGE: Final = "MMSI is not nine digits"
_DROP_NO_FIX_TIME: Final = "no age field, so the fix has no time"
_DROP_UNREADABLE_FIX_TIME: Final = "age is not a readable timestamp"
_DROP_FUTURE_FIX_TIME: Final = "age is dated ahead of our own clock"
_DROP_STALE: Final = "report is older than the freshness window"
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


class _AisInformationWire(WireModel):
    """The AIS half of one record.

    ``id`` is the MMSI. ``age`` is an ISO 8601 instant despite the name, which is trap 1, and it
    is typed as a ``datetime`` here so pydantic reads it as one and nothing downstream can
    subtract it from anything.
    """

    id: int | None = None
    latitude: float | None = None
    longitude: float | None = None
    cog: float | None = None
    heading: float | None = None
    speed: float | None = None
    navigation_status: int | None = Field(default=None, alias="navigationStatus")
    vessel_type: int | None = Field(default=None, alias="vesselType")
    destination: str | None = None
    age: datetime | None = None
    imo_number: int | None = Field(default=None, alias="imoNumber")


class _VesselWire(WireModel):
    """One vessel. The name and the dimensions are here; the position is one level down.

    ``id`` on this object is **not** modelled. It was ``null`` on every one of 7,118 live
    records and it is not the MMSI, so leaving it out means nothing can reach for the wrong
    one of the two fields called ``id``.
    """

    name: str | None = None
    overall_length: float | None = Field(default=None, alias="overallLength")
    extreme_beam: float | None = Field(default=None, alias="extremeBeam")
    ais_information: _AisInformationWire | None = Field(default=None, alias="aisInformation")


class _GraphQLErrorWire(WireModel):
    """One entry in the ``errors`` array a GraphQL 200 can carry. Trap 4."""

    message: str | None = None


class _DataWire(WireModel):
    """The ``data`` object. ``aisOnlyVessels`` is left raw and validated per record."""

    ais_only_vessels: tuple[object, ...] | None = Field(default=None, alias="aisOnlyVessels")


class _ResponseWire(WireModel):
    """The GraphQL envelope.

    Neither field is required, because a successful body carries ``data`` and no ``errors``
    while a failed one carries ``errors`` and a null ``data``, and trap 4 says both arrive with
    HTTP 200. :func:`parse_vessels` decides which it got.
    """

    data: _DataWire | None = None
    errors: tuple[_GraphQLErrorWire, ...] | None = None


_RESPONSE_ADAPTER: Final = TypeAdapter(_ResponseWire)
_VESSEL_ADAPTER: Final = TypeAdapter(_VesselWire)


# ---------------------------------------------------------------- field mapping


def _identity(ais: _AisInformationWire) -> str:
    """The vessel's MMSI as a nine-digit string, or a drop naming why.

    ``aisInformation.id`` and never the outer ``VesselType.id``, which is null throughout.

    Zero-padded before classification, so a short value gets an honest ITU reason rather than
    being called malformed. The live body carried eleven that are not nine digits, including
    417, 835, 9111507 and 33855412, and one on the ``111`` search-and-rescue aircraft prefix.
    """
    if ais.id is None or not 0 <= ais.id <= MMSI_MAX:
        raise _UnmappableRecordError(_DROP_MMSI_RANGE)
    mmsi = f"{ais.id:09d}"
    category = mmsi_category(mmsi)
    if category is not MmsiCategory.SHIP_STATION:
        msg = f"MMSI is a {category.value}, not a ship station"
        raise _UnmappableRecordError(msg)
    return mmsi


def _position(ais: _AisInformationWire) -> Point:
    """The vessel's position, refusing the AIS not-available sentinel.

    Trap 5. ``latitude == 91`` with ``longitude == 181`` is the standard AIS "no position"
    encoding, 14 of 7,118 live records. 91 is barely outside a latitude's legal range, so it is
    named and refused explicitly rather than left to a bounds check that a future contract
    change could widen.

    Raises:
        _UnmappableRecordError: the record carries no position, or the sentinel.
    """
    if ais.latitude is None or ais.longitude is None:
        raise _UnmappableRecordError(_DROP_NO_POSITION)
    if ais.latitude == LATITUDE_NOT_AVAILABLE or ais.longitude == LONGITUDE_NOT_AVAILABLE:
        raise _UnmappableRecordError(_DROP_POSITION_UNAVAILABLE)
    return Point(lon=ais.longitude, lat=ais.latitude)


def _fix_time(ais: _AisInformationWire, *, now: datetime) -> datetime:
    """When the position was fixed, from ``age``, which is an instant and not a duration.

    Trap 1 and trap 2 both land here. The field is read as a timestamp, and then bounded on
    both sides: a report from our future is refused because it would win every merge until the
    clock caught up, and a report older than :data:`FRESHNESS_WINDOW_SECONDS` is refused
    because the body is a sixty-day roster and rendering it draws ghost ships.

    Raises:
        _UnmappableRecordError: no fix time, one dated ahead of our clock, or one older than
            the freshness window.
    """
    if ais.age is None:
        raise _UnmappableRecordError(_DROP_NO_FIX_TIME)
    fixed_at = ais.age if ais.age.tzinfo is not None else ais.age.replace(tzinfo=UTC)
    fixed_at = fixed_at.astimezone(UTC)
    ahead = (fixed_at - now).total_seconds()
    if ahead > MAX_FIX_TIME_AHEAD_SECONDS:
        raise _UnmappableRecordError(_DROP_FUTURE_FIX_TIME)
    if -ahead > FRESHNESS_WINDOW_SECONDS:
        raise _UnmappableRecordError(_DROP_STALE)
    return fixed_at


def _clean_text(raw: str | None, limit: int) -> str | None:
    """Strip a text field and map an empty string to ``None``.

    ``destination`` was blank on 5,943 of 7,118 records overall and on 1,058 of the fresh ones,
    so this is the common case rather than an edge.
    """
    if raw is None:
        return None
    return raw.strip()[:limit] or None


def _imo(value: int | None) -> int | None:
    """The IMO number, or ``None`` for either spelling of not-available.

    **This feed says "no IMO" two ways**: ``null`` on 5,437 records and ``0`` on 790. A check
    for only one of them lets the other reach a seven-digit field and drop the whole ship.
    """
    if value is None or value == AIS_IMO_NOT_AVAILABLE or not IMO_MIN <= value <= IMO_MAX:
        return None
    return value


def _ship_type(value: int | None) -> int | None:
    """The AIS ship and cargo type, or ``None`` for the not-available sentinel. 0 on 138."""
    if (
        value is None
        or value == AIS_SHIP_TYPE_NOT_AVAILABLE
        or not SHIP_TYPE_MIN <= value <= SHIP_TYPE_MAX
    ):
        return None
    return value


def _dimension(value: float | None, limit: float) -> float | None:
    """A length or beam in metres, or ``None`` when the feed carries none.

    Metres, and on the outer object rather than the AIS one. Present on 1,570 of 7,118 records
    with a maximum of 369 m overall length and 54 m beam, which is a large container ship and a
    plausible bound. A value past the field's own limit empties one optional field rather than
    dropping a real ship.
    """
    if value is None or value <= 0.0 or value > limit:
        return None
    return float(value)


def _nav_status(code: int | None) -> NavigationalStatus | None:
    """Map the AIS navigational status, leaving the undefined and reserved codes empty.

    15, undefined, on 5,544 of 7,118 records and 1,097 of the fresh ones, which is most of the
    feed. It correlates with a stale report rather than with a broken one.
    """
    return None if code is None else AIS_NAV_STATUS_CODES.get(code)


def _to_vessel(vessel: _VesselWire, *, now: datetime, source: str) -> Vessel:
    """Map one record into the domain contract.

    ``observed_at`` is the later of our receive clock and the record's own fix, so
    ``observed_at - position_age_s`` recovers the fix exactly and the age can never be
    negative. Our clock because the response carries no build time of its own.

    Raises:
        _UnmappableRecordError: the record cannot be identified, located or dated, or is
            outside the freshness window.
        ValidationError: the mapped values do not satisfy the vessel contract.
    """
    ais = vessel.ais_information
    if ais is None:
        raise _UnmappableRecordError(_DROP_NO_AIS)
    mmsi = _identity(ais)
    fixed_at = _fix_time(ais, now=now)
    observed_at = max(now, fixed_at)
    return Vessel(
        mmsi=mmsi,
        name=_clean_text(vessel.name, NAME_MAX_CHARS),
        # No call sign in the schema at all, confirmed by introspection rather than assumed
        # from an empty value. Same for the rate of turn, the ETA and the draught below.
        call_sign=None,
        imo=_imo(ais.imo_number),
        ship_type=_ship_type(ais.vessel_type),
        point=_position(ais),
        course_over_ground_deg=ais_bearing(ais.cog, AIS_COG_NOT_AVAILABLE),
        speed_over_ground_mps=speed_over_ground_mps(ais.speed),
        true_heading_deg=ais_bearing(ais.heading, AIS_HEADING_NOT_AVAILABLE),
        rate_of_turn_deg_per_min=None,
        navigational_status=_nav_status(ais.navigation_status),
        draught_m=None,
        length_m=_dimension(vessel.overall_length, LENGTH_MAX_M),
        beam_m=_dimension(vessel.extreme_beam, BEAM_MAX_M),
        destination=_clean_text(ais.destination, DESTINATION_MAX_CHARS),
        eta=None,
        observed_at=observed_at,
        position_age_s=(observed_at - fixed_at).total_seconds(),
        source=source,
    )


def parse_vessels(
    payload: bytes | str,
    *,
    source: str = SOURCE_NAME,
    now: datetime | None = None,
) -> ParsedRecords[Vessel]:
    """Parse the GraphQL response into vessels inside the freshness window.

    Args:
        payload: The raw response body.
        source: Provider name, recorded on every record per ADR 010.
        now: Our own clock. Supplies ``observed_at`` and both ends of the freshness bound.
            Defaults to the wall clock; a test passes one so the window is exercised without
            waiting sixty days.

    Returns:
        The vessels that are identifiable, located, dated and fresh, plus everything refused,
        counted by reason. The stale count is the interesting one: it is normally several times
        the kept count, and ``/api/layers`` serving it is what stops this provider looking like
        it contributes 7,118 ships.

    Raises:
        SourceError: the body is a GraphQL error, or carries neither data nor errors. Trap 4:
            that arrives with HTTP 200, so it is raised from the parse rather than the status.
        ContractViolationError: the body is not this endpoint's shape at all. Loud on purpose,
            because a shape change that parsed to zero vessels would read as a healthy but
            empty layer.
    """
    wire = validate_payload(_RESPONSE_ADAPTER, payload, source=source)
    if wire.errors:
        messages = "; ".join(e.message or "(no message)" for e in wire.errors[:3])
        raise SourceError(source, f"HTTP 200 carrying GraphQL errors: {messages}")
    if wire.data is None or wire.data.ais_only_vessels is None:
        msg = "response carried neither aisOnlyVessels nor errors"
        raise SourceError(source, msg)

    clock_now = now if now is not None else _utc_now()
    vessels: list[Vessel] = []
    dropped: Counter[str] = Counter()
    for raw in wire.data.ais_only_vessels:
        try:
            record = _VESSEL_ADAPTER.validate_python(raw)
        except ValidationError as exc:
            dropped[_DROP_WIRE_SHAPE] += 1
            _log.debug("dropping unreadable record: %s", exc)
            continue
        try:
            vessels.append(_to_vessel(record, now=clock_now, source=source))
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
    return ParsedRecords(records=tuple(vessels), drops=dropped)


# ---------------------------------------------------------------- client


class SeawayClient:
    """Fetches vessels from the Seaway Vessel Information System. Keyless, and a POST.

    The only adapter here that talks GraphQL, so it is the only one that sends a body rather
    than a query string, and the only one whose "did it work" question is answered by the body
    rather than the status code.

    Holds one piece of state, a throttling cooldown, on disk for the reason
    ``kystdatahuset.py`` sets out: a union member's exception never reaches the poller, because
    ``app._provider_result`` turns any failure into a provider that dropped out of the cycle, so
    a provider's own backoff figure has to be honoured where the response arrived. On disk
    because in-memory rate state does not survive a restart and a restart loop is
    indistinguishable from hammering.

    The cadence floor is not persisted separately: the vessel poller already persists its own
    next-allowed-poll time through the same cache at the same 60 seconds.
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
        """Every vessel inside the freshness window, plus everything refused.

        One request. The body is the whole roster and there is no spatial argument on the
        schema, so a viewport query would be filtered locally and there is nothing to gain by
        asking twice.

        Raises:
            RateLimitedError: the provider is inside a backoff it asked for, or just asked.
            SourceError: a GraphQL error inside an HTTP 200, or no vessel inside the window at
                all. See :data:`EMPTY_WORLD_DETAIL`.
        """
        parsed = parse_vessels(await self._post(), source=SOURCE_NAME, now=self._clock())
        if not parsed.records:
            raise SourceError(SOURCE_NAME, EMPTY_WORLD_DETAIL)
        return parsed

    def request_body(self) -> dict[str, Any]:
        """The GraphQL request, built once here so a test can assert what we send.

        Exposed because trap 3 is invisible from the outside: a filter missing one flag returns
        a smaller answer with no error, so the thing worth asserting is the request rather than
        the response.
        """
        return {
            "operationName": "getAllVessels",
            "query": QUERY,
            "variables": {"filter": dict(_FILTER)},
        }

    async def _post(self) -> bytes:
        """One POST, refusing to send it while a backoff the provider asked for is running.

        Raises:
            RateLimitedError: a cooldown is in force, or this response started one.
        """
        remaining = self._cooldown_remaining()
        if remaining > 0.0:
            raise RateLimitedError(SOURCE_NAME, RATE_LIMIT_HELD_OFF_STATUS, remaining)

        response = await self._client.post(
            f"{self._base_url}{GRAPHQL_PATH}", json=self.request_body()
        )
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
