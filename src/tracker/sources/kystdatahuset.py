"""Kystdatahuset AIS vessel adapter, the Norwegian Coastal Administration's live feed.

The second keyless vessel provider and the reason the layer stopped being Finland-only.
Fintraffic covers the Baltic and the Gulf of Finland; this covers the Norwegian coast, the
North Sea, the Norwegian Sea and the Barents, and one unfiltered call returned **3,542
features against Fintraffic's 630**. Keyless, no registration, published under the
Norwegian Licence for Open Government Data 1.0, which the provider names in its own OpenAPI
document. Verified live on 2026-08-23.

A union member under ADR 010, not a failover and not a replacement. It merges with
Fintraffic on MMSI, the freshest fix supplies the record, nothing is averaged, and a cycle
where it drops out costs the layer Norwegian coverage rather than the layer itself.

``robots.txt`` on the host is ``User-agent: *`` with an empty ``Disallow:``, so every path
is permitted and there is nothing for ``cloudscraper`` to work around. The descriptive
User-Agent this project mandates is answered normally: no 403, no CDN filter, no browser
header set needed. Checked 2026-08-23.

Everything below was measured against the live host on 2026-08-23, not read off
documentation. Five traps here produce wrong output rather than an error, so each is named
at the constant or the branch that handles it and each has its own test.

**1. The geometry is a LineString and the current position is the LAST coordinate.** The
track runs oldest first. Proved two ways rather than assumed. Taking the last segment as the
direction of travel and comparing it against the vessel's own reported course over ground
gave a median error of **0.6 degrees** across 585 moving vessels, inside 20 degrees on
97.9% of them; reversing it gave a median error of **179.4 degrees** and landed inside 20
degrees on 0.2%. Independently, across 638 vessels that reported again 163 seconds later,
the old track's last coordinate lay nearer the new track than its first coordinate on 88.7%
of them and sat a median of **0 metres** from it, meaning the newest end of one report is
literally a point on the next. Taking the first coordinate would place 754 of 3,477 vessels
more than a kilometre from where they are, 376 of them more than five kilometres, and one
38.9 kilometres out. Nothing errors and the layer looks fine. See :func:`_position`.

**2. ``ship_name`` carries a match confidence in the form ``[NN%]``.** 15 of 3,542 records,
percentages 41 to 95, space-padded before the bracket: ``'THEA MATHILDE  [59%]'``,
``'BUOY TJ3       [41%]'``. The provider is telling us it matched that name to that MMSI
rather than receiving it, so the suffix is stripped out of the domain value by
:func:`_vessel_name` and never reaches a card. **The strip is specific to the ``[NN%]``
form and must stay that way**: the same body carried ``'DOLPHIN01 [UNCREWED]'``, where the
bracket is part of the vessel's name, so anything that removes a trailing bracket removes
real text.

**3. ``draught`` is an int on some records and a float on others in the same response.**
2,192 ints against 1,350 floats out of 3,542. This is the ``eo:cloud_cover`` trap in
``AGENTS.md`` again: a ``strict=True`` float field rejects every int and loses 62% of the
feed, and a strict int field loses the other 38%. The wire layer is deliberately permissive
so it takes both, which is the whole reason :class:`~tracker.contracts.base.WireModel` is
not strict, and :func:`test_int_and_float_draughts_both_survive` asserts it. The provider's
own schema declares ``draught``, ``length``, ``breadth``, ``maneuvre`` and ``true_heading``
as floats while the wire sends ints for four of the five, so the same mixing applies to all
of them and none is typed strictly here.

**4. A LineString with zero coordinates is a real record.** 77 of 3,542 arrived as
``"coordinates": []`` with complete properties, including NOBLE INTEGRATOR with a valid IMO.
A vessel with no position is not on the globe, so it is dropped and counted rather than
being given a position from anywhere.

**5. ``cog`` carries the heading sentinel, not just its own.** 542 records read 360.0, which
is the documented course-unavailable value, and 3 read **511.0**, which is the *heading*
sentinel appearing in the course field. A ``0 <= x < 360`` check applied without mapping
sentinels first rejects 545 real vessels and reads as thin coverage.
:func:`~tracker.contracts.vessel.ais_bearing` already handles both, because it tests
at-or-above the sentinel and then the range.

**The same MMSI arrives twice in one response.** 19 MMSIs, 38 features, each pair carrying a
different internal ``id`` and a different ``date_time_utc``, and in several cases the older
of the two has an empty ``ship_name``. They are the same ship reported twice by the
provider's own query rather than two ships, so the freshest is kept and the superseded
report is discarded, per ADR 010. That is a dedupe and not a drop: nothing was refused, so
it is logged and does not join the provider's drop total.

**There is no envelope timestamp.** Unlike Fintraffic's ``dataUpdatedTime`` this response
carries nothing but ``type`` and ``features``, so ``observed_at`` is our own receive clock,
floored at the record's own fix. The recency merge is unaffected either way, because
``services/union.py`` resolves conflicts on ``observed_at - position_age_s``, which recovers
the fix exactly.

**Query window and cadence.** Called bare the endpoint returns every ship that reported in
the last ten minutes, which the provider documents and the capture confirms: oldest record
598 seconds old, median 45, none in the future and none stale enough to be a ghost. So there
is no Fintraffic-style 24-hour default to defend against and no ``from`` parameter to send.
The provider publishes no rate cap, sends no ``Cache-Control`` and sends no ``ETag``, so
:data:`MIN_INTERVAL_SECONDS` is set from the data instead: positions are wiped after 20
minutes, the companion ``vessels-by-type`` endpoint aggregates by the minute, and the body
is 3.7MB, so a call more often than once a minute spends a government open-data host's
bandwidth on bytes that have barely changed.
"""

import logging
import re
from collections import Counter
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Final

import httpx
from pydantic import TypeAdapter, ValidationError

from tracker.cache import DiskCache
from tracker.cache import key as cache_key
from tracker.contracts.base import WireModel, validate_payload
from tracker.contracts.geo import Point
from tracker.contracts.vessel import (
    AIS_COG_NOT_AVAILABLE,
    AIS_DRAUGHT_NOT_AVAILABLE,
    AIS_HEADING_NOT_AVAILABLE,
    AIS_IMO_NOT_AVAILABLE,
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

SOURCE_NAME: Final = "kystdatahuset"
"""Per-record provider name, per ADR 010. Never a per-layer field.

Same reasoning as ``fintraffic.SOURCE_NAME``: a merged store that cannot say which network
saw a given ship is unauditable, so this rides on the record. It names coverage and not
corroboration. Under R1 in ``docs/pending-decisions.md`` a provider union is one origin,
because two AIS aggregators carrying one vessel are repeating one transponder broadcast, and
a Norwegian receiver on the Skagerrak feeds both this and Fintraffic often enough that the
overlap is not two independent sightings.
"""

CACHE_NAMESPACE: Final = SOURCE_NAME
"""Prefix for every key this module writes to the shared :class:`~tracker.cache.DiskCache`."""

ATTRIBUTION: Final = "Vessel data from Kystverket (Norwegian Coastal Administration)"
"""The credit NLOD makes mandatory, in the wording ``docs/data-sources.md`` already prescribes.

NLOD requires the contributor to be acknowledged and prescribes no wording, so the string is
ours. It is deliberately the same one recorded for the raw Kystverket AIS TCP stream, because
that is one authority under one licence and two different credits for it would read as two
sources on a card.
"""

LICENCE: Final = "NLOD 1.0"
"""Norwegian Licence for Open Government Data, version 1.0.

**The version is what this endpoint's own document says, and it disagrees with the rest of
the repo.** ``info.license`` in the live OpenAPI document reads "Norwegian Licence for Open
Government Data (NLOD) 1.0" and points at ``data.norge.no/nlod/en/1.0``, verified 2026-08-23.
``docs/data-sources.md`` had recorded NLOD **2.0** for both this API and the Kystverket TCP
stream, on the reasoning that it is one authority under one licence.

The version this names is the one the provider stated for the API we actually call, because
stating a grant the provider did not state for this endpoint is the wrong way round to be
wrong. Nothing practical turns on it: both versions were read on 2026-08-23 and both grant
the right to copy, use and distribute provided the contributor is acknowledged, so the
obligation :data:`ATTRIBUTION` discharges is identical either way. Unlike AISHub and
aisstream.io there is no licence blocker on serving these positions to a browser under
either version. The discrepancy is recorded in ``docs/data-sources.md`` rather than resolved
here, because which of Kystverket's two statements governs is theirs to settle.
"""

ATTRIBUTION_URL: Final = "https://data.norge.no/nlod/en/1.0"
"""The licence the API document points at. Verified to resolve, 2026-08-23."""

BASE_URL: Final = "https://kystdatahuset.no"
REALTIME_PATH: Final = "/ws/api/ais/realtime/geojson"
"""The one endpoint this adapter calls, verified live 2026-08-23 returning HTTP 200 and
3,542 features in 3.7MB. Declared in the provider's OpenAPI document as needing no security
scheme, and it answers with no credential of any kind."""

MIN_INTERVAL_SECONDS: Final = 60.0
"""Cadence floor, in code and not in configuration, per ADR 010.

The provider publishes no rate cap, so this is read off the feed rather than off a terms
page. Three measured facts land on the same number. Its own OpenAPI description says
positions are wiped after 20 minutes and that a bare call returns the last 10 minutes. Its
companion ``/api/ais/realtime/vessels-by-type`` endpoint counts "active vessels during the
last minute", so a minute is the provider's own aggregation unit. And the body is 3.7MB
uncompressed with no ``ETag`` and no ``Cache-Control`` to make a repeat call cheap, so
anything faster spends a government open-data host's bandwidth to receive nearly identical
bytes.
"""

GEOJSON_MIN_COORDINATES: Final = 2
"""A GeoJSON position needs longitude and latitude. A third element would be altitude, which
AIS does not report, so it is ignored rather than read."""

MMSI_MAX: Final = 999_999_999
"""An MMSI is nine digits, so anything above this is not one."""

RATE_LIMIT_HELD_OFF_STATUS: Final = 429
"""Status reported on a request this client refused locally, because a cooldown is running.

No response arrived, so there is no real status code to carry. 429 is the one the provider
would have sent, and it keeps the error identical to a caller whether the throttle was
enforced by them or by us.
"""

MAX_FIX_TIME_AHEAD_SECONDS: Final = 60.0
"""How far ahead of our own clock a fix may be dated before it is refused.

Same guard and same reason as ``fintraffic.MAX_FIX_TIME_AHEAD_SECONDS``. A fix dated in our
future does not merely enter the recency merge, it wins every one of them until the clock
catches up, which is the accidental provider precedence ADR 010 forbids arriving through a
bad timestamp instead of through a preference order. A minute covers clock skew and nothing
else. No live record needed it: the capture held zero future-dated fixes.
"""

_CONFIDENCE_SUFFIX: Final = re.compile(r"\s*\[\d{1,3}%\]\s*$")
"""Trap 2. Anchored, and it matches a percentage and nothing else.

``\\d{1,3}%`` rather than anything in brackets, because ``'DOLPHIN01 [UNCREWED]'`` is a real
name in the same body and a looser pattern would delete part of it. Anchored to the end
because the suffix is always trailing and a bracket mid-name is somebody's name.
"""

EMPTY_WORLD_DETAIL: Final = (
    "the realtime query returned no renderable vessel: counted as a failed poll, never as "
    "an empty sea. The existing vessels stay in the store"
)
"""Why an empty answer is a failure rather than a quiet zero.

The call is unfiltered and covers the whole Norwegian coast inside a ten-minute window,
3,542 features when it was measured. Zero means something broke upstream, the same call
``fintraffic.EMPTY_WORLD_DETAIL`` and ``celestrak.py`` both make. Reported as a provider
failure, so the layer degrades and names Kystdatahuset instead of sitting healthy with a
count of zero and expiring every Norwegian ship one time-to-live later.
"""

_DROP_NO_COORDINATES: Final = "feature carried no usable coordinates"
_DROP_MMSI_RANGE: Final = "MMSI is not nine digits"
_DROP_NO_FIX_TIME: Final = "no date_time_utc, so the fix has no time"
_DROP_FUTURE_FIX_TIME: Final = "date_time_utc is dated ahead of our own clock"
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
    """The LineString geometry. Every coordinate is ``[longitude, latitude]``.

    That already matches this project's rule, so nothing is swapped here, and it was
    confirmed against the live body independently of the documentation: longitudes ran
    -0.11 to 38.38 and latitudes 55.78 to 79.73 across 106,020 coordinates, and a latitude
    of 79 is Svalbard while a longitude of 79 is Kazakhstan.

    ``coordinates`` defaults to empty rather than being required, because trap 4 is a real
    record with an empty array and it has to reach the parser to be counted.
    """

    coordinates: tuple[tuple[float, ...], ...] = ()


class _PropertiesWire(WireModel):
    """The ``properties`` object on one realtime feature.

    Every field the endpoint sends is either modelled here or named below, so nothing is
    lost to ``extra="ignore"`` without a decision having been taken about it.

    Deliberately not modelled, because the domain has nowhere to put them and inventing a
    field is not this adapter's job: ``id`` is the provider's internal row identifier and
    changes between reports of the same ship, so it is never an identity; ``maneuvre`` is
    the AIS special-manoeuvre indicator, 0 on 3,522 of 3,542; and ``ais_class`` is A, B or,
    on exactly one record, ``Z``, which was the SAR aircraft that trap 4 and the MMSI check
    both refuse anyway.

    Types are the loose ones on purpose. Trap 3: the provider declares ``draught``,
    ``length``, ``breadth`` and ``true_heading`` as floats and sends ints for most of them,
    so a strict annotation here would drop most of the feed.
    """

    mmsi: int | None = None
    ship_name: str | None = None
    callsign: str | None = None
    imo: int | None = None
    ship_type: int | None = None
    destination: str | None = None
    cog: float | None = None
    speed: float | None = None
    true_heading: float | None = None
    status: int | None = None
    draught: float | None = None
    length: float | None = None
    breadth: float | None = None
    date_time_utc: datetime | None = None


class _FeatureWire(WireModel):
    """One vessel. ``mmsi`` lives inside ``properties`` only, unlike Fintraffic's feed."""

    geometry: _GeometryWire | None = None
    properties: _PropertiesWire | None = None


class _CollectionWire(WireModel):
    """The FeatureCollection envelope.

    Both fields are required, which is the loud-failure guard. A payload whose shape has
    changed would otherwise parse cleanly to zero vessels, the poller would record a healthy
    feed with a count of zero, and the layer would empty with nothing anywhere saying why.
    That exact silent zero has already happened once on the aircraft feed.

    ``features`` is left unvalidated here and each element is validated on its own by
    :data:`_FEATURE_ADAPTER`, for the reason ``fintraffic._LocationsWire`` documents: typing
    it as a tuple of feature models validates the whole array in one pass, so one junk
    record in 3,542 would reject the entire body and empty the layer.
    """

    type: str
    features: tuple[object, ...]


_COLLECTION_ADAPTER: Final = TypeAdapter(_CollectionWire)
_FEATURE_ADAPTER: Final = TypeAdapter(_FeatureWire)


# ---------------------------------------------------------------- field mapping


def _identity(props: _PropertiesWire) -> str:
    """The vessel's MMSI as a nine-digit string, or a drop naming why.

    Zero-padded before classification rather than after, which is what makes the reason
    honest for the three short values on the live feed. 2320212 pads to ``002320212``, whose
    ``00`` prefix and MID 232 make it a UK coast station, and 310 and 4747 pad to values
    whose embedded MID is 000, which the ITU has never allocated. Refusing them on length
    alone would count a coast station as malformed.

    The ITU category check is what stops the MMSI classes that break the merge key. On this
    feed that is MMSI 111257514, "SAR AIRCRAFT CHC SAR", callsign LNOQR, which is a
    helicopter in the vessel body exactly as Fintraffic's LIFEGUARD 003 and 004 were.
    """
    if props.mmsi is None or not 0 <= props.mmsi <= MMSI_MAX:
        raise _UnmappableRecordError(_DROP_MMSI_RANGE)
    mmsi = f"{props.mmsi:09d}"
    category = mmsi_category(mmsi)
    if category is not MmsiCategory.SHIP_STATION:
        msg = f"MMSI is a {category.value}, not a ship station"
        raise _UnmappableRecordError(msg)
    return mmsi


def _position(geometry: _GeometryWire | None) -> Point:
    """Read the vessel's current position off the **last** coordinate of the LineString.

    Trap 1, and the whole module docstring's first entry. The track runs oldest first, so
    the last coordinate is where the ship is now and the first is where it was up to forty
    minutes ago. Measured: taking the first would put 754 of 3,477 vessels over a kilometre
    from their real position and one 38.9 kilometres out, with nothing erroring.

    Raises:
        _UnmappableRecordError: the geometry is absent, the coordinate array is empty (77 of
            3,542 live records, trap 4), or the last coordinate is not a position.
    """
    if geometry is None or not geometry.coordinates:
        raise _UnmappableRecordError(_DROP_NO_COORDINATES)
    latest = geometry.coordinates[-1]
    if len(latest) < GEOJSON_MIN_COORDINATES:
        raise _UnmappableRecordError(_DROP_NO_COORDINATES)
    return Point(lon=latest[0], lat=latest[1])


def _fix_time(props: _PropertiesWire, *, now: datetime) -> datetime:
    """When the position was fixed, from ``date_time_utc``, with UTC attached.

    The field is naive on every record and is UTC by its own name, which is the CelesTrak
    ``EPOCH`` case: attach the zone in the adapter, because a naive datetime reaching a
    domain contract is a validation error. Some records carry microseconds
    (``2026-08-23T09:43:37.022473``) and some do not, which pydantic reads either way.

    A record with no fix time is dropped rather than dated to now, because recency is what
    resolves a conflict between providers under ADR 010 and a record that cannot say when it
    was taken would win every merge it entered.

    Raises:
        _UnmappableRecordError: the record carries no fix time, or one dated ahead of our
            clock past :data:`MAX_FIX_TIME_AHEAD_SECONDS`.
    """
    raw = props.date_time_utc
    if raw is None:
        raise _UnmappableRecordError(_DROP_NO_FIX_TIME)
    fixed_at = raw.replace(tzinfo=UTC) if raw.tzinfo is None else raw.astimezone(UTC)
    if (fixed_at - now).total_seconds() > MAX_FIX_TIME_AHEAD_SECONDS:
        raise _UnmappableRecordError(_DROP_FUTURE_FIX_TIME)
    return fixed_at


def _vessel_name(raw: str | None) -> str | None:
    """The vessel's name with any ``[NN%]`` match confidence stripped off.

    Trap 2. The provider appends its own match confidence to a name it matched rather than
    received, on 15 of 3,542 records at 41% to 95%, space-padded before the bracket. A card
    showing ``'BUOY TJ3       [41%]'`` would be displaying an internal score as part of a
    ship's name, so the suffix comes off here.

    **What the number said is not carried anywhere, and that is a decision nobody has
    ratified.** :class:`~tracker.contracts.vessel.Vessel` has no field for the confidence of
    a display attribute, so a 41% name and a 95% name are indistinguishable downstream and
    both read as observed. Under ADR 011 a value produced by a join is labelled derived, and
    this is one. It is recorded as an open question rather than closed by inventing a field
    here, because the fix is a contract change and a card change together.

    The strip is anchored to the ``[NN%]`` form only. ``'DOLPHIN01 [UNCREWED]'`` is in the
    same body with the bracket as part of the name.
    """
    if raw is None:
        return None
    return _CONFIDENCE_SUFFIX.sub("", raw).strip()[:NAME_MAX_CHARS] or None


def _clean_text(raw: str | None, limit: int) -> str | None:
    """Strip a text field and map the feed's empty string to ``None``.

    The feed sends ``""`` rather than ``null`` for missing text: ``ship_name`` on 13 of
    3,542 records, ``callsign`` on 84 and ``destination`` on 809, which is nearly a quarter
    of the feed. Truncation to the field's own cap is deliberate and matches the other
    adapters: losing the tail of a destination is better than dropping a real ship over a
    display field.
    """
    if raw is None:
        return None
    return raw.strip()[:limit] or None


def _imo(value: int | None) -> int | None:
    """The IMO number, or ``None`` for the sentinel and for anything outside seven digits.

    0 on 1,845 of 3,542 live records, over half the feed.
    """
    if value is None or value == AIS_IMO_NOT_AVAILABLE or not IMO_MIN <= value <= IMO_MAX:
        return None
    return value


def _ship_type(value: int | None) -> int | None:
    """The AIS ship and cargo type, or ``None`` for the not-available sentinel."""
    if (
        value is None
        or value == AIS_SHIP_TYPE_NOT_AVAILABLE
        or not SHIP_TYPE_MIN <= value <= SHIP_TYPE_MAX
    ):
        return None
    return value


def _dimension(value: float | None, limit: float) -> float | None:
    """A length, beam or draught in metres, or ``None`` when the feed carries none.

    **Metres on this endpoint, and that is not a safe assumption to carry across.**
    Digitraffic sends ``draught`` in decimetres on ``/api/ais/v1/vessels`` and in metres on
    ``/api/port-call/v1/vessel-details``, one word and two units on one host. Here the range
    settles it: draughts run 0.5 to 25.5 with 25.5 as the top value on 4 records, and 25.5 m
    is exactly the AIS saturation point meaning "25.5 m or greater". Read as decimetres the
    whole fleet would draw 2.55 m at most.

    0 means not available on all three, which is
    :data:`~tracker.contracts.vessel.AIS_DRAUGHT_NOT_AVAILABLE` for a draught and the same
    number for the other two: ``draught`` on 1,435 records, ``length`` on 126 and
    ``breadth`` on 147. A value above the field's own bound is refused rather than clamped,
    so a junk dimension empties one optional field instead of dropping a real ship.
    """
    if value is None or value <= float(AIS_DRAUGHT_NOT_AVAILABLE) or value > limit:
        return None
    return float(value)


def _nav_status(code: int | None) -> NavigationalStatus | None:
    """Map the AIS navigational status code, leaving the undefined and reserved ones empty.

    15, undefined, on 81 of 3,542 live records, plus 9, 10 and 13 reserved on 16 more. All
    four are absent from :data:`~tracker.contracts.vessel.AIS_NAV_STATUS_CODES`, so
    ``dict.get`` is the whole mapping and no second sentinel check is needed.
    """
    return None if code is None else AIS_NAV_STATUS_CODES.get(code)


def _to_vessel(feature: _FeatureWire, *, now: datetime, source: str) -> Vessel:
    """Map one realtime feature into the domain contract.

    ``observed_at`` is the later of our receive clock and this record's own fix, so
    ``observed_at - position_age_s`` recovers the fix exactly and the age can never be
    negative. Our clock rather than a response field because this endpoint sends no envelope
    timestamp at all, unlike Fintraffic's ``dataUpdatedTime``. The fix itself is bounded
    against ``now`` in :func:`_fix_time`, which is what stops a future-dated report winning
    every merge it enters.

    Raises:
        _UnmappableRecordError: the record cannot be identified, located or dated.
        ValidationError: the mapped values do not satisfy the vessel contract.
    """
    if feature.properties is None:
        raise _UnmappableRecordError(_DROP_WIRE_SHAPE)
    props = feature.properties
    mmsi = _identity(props)
    fixed_at = _fix_time(props, now=now)
    observed_at = max(now, fixed_at)
    return Vessel(
        mmsi=mmsi,
        name=_vessel_name(props.ship_name),
        call_sign=_clean_text(props.callsign, CALL_SIGN_MAX_CHARS),
        imo=_imo(props.imo),
        ship_type=_ship_type(props.ship_type),
        point=_position(feature.geometry),
        course_over_ground_deg=ais_bearing(props.cog, AIS_COG_NOT_AVAILABLE),
        speed_over_ground_mps=speed_over_ground_mps(props.speed),
        true_heading_deg=ais_bearing(props.true_heading, AIS_HEADING_NOT_AVAILABLE),
        # No rate of turn and no ETA on this endpoint. Left empty rather than derived: a
        # turn rate computed from two coordinates of the track is our arithmetic and not
        # something a receiver reported, and an ETA has no field on the wire at all.
        rate_of_turn_deg_per_min=None,
        navigational_status=_nav_status(props.status),
        draught_m=_dimension(props.draught, DRAUGHT_MAX_M),
        length_m=_dimension(props.length, LENGTH_MAX_M),
        beam_m=_dimension(props.breadth, BEAM_MAX_M),
        destination=_clean_text(props.destination, DESTINATION_MAX_CHARS),
        eta=None,
        observed_at=observed_at,
        position_age_s=(observed_at - fixed_at).total_seconds(),
        source=source,
    )


def parse_realtime(
    payload: bytes | str,
    *,
    source: str = SOURCE_NAME,
    now: datetime | None = None,
) -> ParsedRecords[Vessel]:
    """Parse the realtime GeoJSON body into vessels, one per MMSI.

    Args:
        payload: The raw FeatureCollection body.
        source: Provider name, recorded on every record per ADR 010.
        now: Our own clock. Supplies ``observed_at`` and bounds how far ahead a fix may be
            dated. Defaults to the wall clock; a test passes one so both are exercised
            without waiting.

    Returns:
        One vessel per usable feature, plus the records that could not be read, identified,
        located or dated, counted by reason and never partially accepted. The count is
        returned rather than only logged because ``/api/layers`` serves it.

        Where the same MMSI arrives twice, and 19 of them did, the freshest fix wins and the
        superseded report is discarded. That is the ADR 010 recency rule applied inside one
        provider, and it is a dedupe rather than a drop: nothing was refused, so it stays out
        of the drop total and is logged instead.

    Raises:
        ContractViolationError: The envelope is not the FeatureCollection this endpoint
            returns. Loud on purpose: a shape change that parsed to zero vessels would read
            as a healthy but empty layer.
    """
    wire = validate_payload(_COLLECTION_ADAPTER, payload, source=source)
    clock_now = now if now is not None else _utc_now()

    freshest: dict[str, Vessel] = {}
    superseded = 0
    dropped: Counter[str] = Counter()
    for raw_feature in wire.features:
        try:
            feature = _FEATURE_ADAPTER.validate_python(raw_feature)
        except ValidationError as exc:
            dropped[_DROP_WIRE_SHAPE] += 1
            _log.debug("dropping unreadable feature: %s", exc)
            continue
        try:
            vessel = _to_vessel(feature, now=clock_now, source=source)
        except _UnmappableRecordError as exc:
            dropped[exc.reason] += 1
            continue
        except ValidationError as exc:
            dropped[_DROP_CONTRACT] += 1
            _log.debug("dropping vessel: %s", exc)
            continue
        held = freshest.get(vessel.mmsi)
        if held is not None:
            superseded += 1
            if vessel.position_age_s >= held.position_age_s:
                continue
        freshest[vessel.mmsi] = vessel

    if superseded:
        _log.info(
            "%s: %d duplicate MMSI reports superseded by a fresher fix from the same provider",
            source,
            superseded,
        )
    if dropped:
        _log.info(
            "%s: kept %d vessels, dropped %d (%s)",
            source,
            len(freshest),
            sum(dropped.values()),
            dict(dropped),
        )
    return ParsedRecords(records=tuple(freshest.values()), drops=dropped)


# ---------------------------------------------------------------- client


class KystdatahusetClient:
    """Fetches vessels from Kystdatahuset. Keyless, and there is nothing to proxy.

    **The one piece of state it holds is a throttling cooldown, and it is on disk.** The
    provider publishes no rate cap, but a union member's exception never reaches the poller:
    ``app._provider_result`` turns any failure into a provider that dropped out of the cycle,
    so a :class:`~tracker.sources.base.RateLimitedError` raised here is recorded as a
    degraded layer and the poller then polls again on its ordinary cadence. That is exactly
    the bug ``AGENTS.md`` records against ``AdsbClient``: adsb.lol asked for 120 seconds of
    quiet, the failover absorbed the throttle, and the next cycle called it 65 seconds into
    its own window. So the figure is honoured here, where the response arrived, and checked
    before the next request rather than after it.

    On disk because in-memory rate state does not survive a restart and a restart loop is
    indistinguishable from hammering as far as a provider is concerned. Without a
    :class:`~tracker.cache.DiskCache` it degrades to the in-memory behaviour, which is what
    every guard here did before ``cache.py`` existed.

    **The cadence floor is deliberately not persisted separately**, for the reason
    ``AishubClient`` gives: the vessel poller already persists its own next-allowed-poll
    time through the same cache, at 60 seconds from this provider's figure, so a second
    identical floor inside the client would add nothing and would let a second of clock
    jitter make the layer read degraded when nothing is wrong.

    **There is no conditional-request cache either**, unlike ``FintrafficClient``. This host
    sends no ``ETag`` and no ``Last-Modified``, so there is no validator to send back and a
    conditional GET would simply be a GET.
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
        """Every vessel that reported in the provider's last ten minutes, plus its drops.

        There is no spatial filter to send. The endpoint takes ``timeStamp`` and
        ``aisShipType`` and nothing else, so a viewport query would be filtered locally, and
        the whole body is one 3.7MB call covering the entire Norwegian coast.

        Raises:
            RateLimitedError: the provider is inside a backoff it asked for, or has just
                asked for one.
            SourceError: the query produced no renderable vessel. See
                :data:`EMPTY_WORLD_DETAIL`.
        """
        parsed = parse_realtime(
            await self._get(REALTIME_PATH), source=SOURCE_NAME, now=self._clock()
        )
        if not parsed.records:
            raise SourceError(SOURCE_NAME, EMPTY_WORLD_DETAIL)
        return parsed

    async def _get(self, path: str) -> bytes:
        """One GET, refusing to send it while a backoff the provider asked for is running.

        Raises:
            RateLimitedError: a cooldown is in force, or this response started one.
        """
        remaining = self._cooldown_remaining()
        if remaining > 0.0:
            raise RateLimitedError(SOURCE_NAME, RATE_LIMIT_HELD_OFF_STATUS, remaining)

        response = await self._client.get(f"{self._base_url}{path}")
        if response.status_code in RATE_LIMIT_STATUS_CODES:
            # Recorded before the raise, so the figure survives whatever the caller does
            # with the exception. The union swallows it into a degraded provider row.
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
        """Record the provider's own backoff, never shortening one already in force.

        The ``max`` makes that a property of the arithmetic rather than a branch somebody has
        to remember, matching ``AdsbClient._hold_off``. Guessing short is how an address gets
        blocked, so the longer figure always wins.
        """
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
