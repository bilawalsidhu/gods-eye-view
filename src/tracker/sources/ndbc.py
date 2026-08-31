"""Ocean observing stations and their live readings, from NOAA's National Data Buoy Center.

Keyless, global, and public domain. Two documents, fetched on different cadences and joined
on the station id:

- ``latest_obs.txt``, a fixed-column text file, one row per station, 22 whitespace-separated
  columns with two comment lines of header. 106,148 bytes and **890 rows** on 2026-08-24.
  This is what moves.
- ``activestations.xml``, the station register: id, position, name, owner, programme and the
  station's type. 272,320 bytes and **1,351 stations**. This barely moves, and a station's
  name and owner are not worth a request an hour.

**Why this feed and not NOAA's ship reports.** ``docs/status.md`` records the near miss that
made this module's identity rule non-negotiable: NOAA's Voluntary Observing Ship feed is
keyless and global and carries **nine distinct identifiers across 9,211 observations**, eight
buoy numbers and the literal string ``SHIP``. Merged on identity per ADR 010 the whole feed
becomes nine records. Measured against this feed on 2026-08-24: **890 rows, 890 distinct
station ids, zero duplicates**. That is a real identity and it is why the layer exists.

**The station id join is case-sensitive upstream and matching it that way loses 62% of the
feed.** Of the 890 ids in ``latest_obs.txt``, only **340 appear verbatim in
``activestations.xml``**; case-folded, all **890** do. The observation file upper-cases
(``AGXC1``) while the register lower-cases (``agxc1``), and nothing in either document says
so. A naive exact join therefore succeeds, returns something, and silently leaves 550
stations with no name, no owner and no type, which reads as a provider with patchy metadata
rather than as our bug. :data:`_station_key` folds both sides.

**Two direction columns in one row, two conventions, neither declared.** ``WDIR`` (wind) counts
**1 to 360 with 360 meaning north**: 624 readings on 2026-08-24 ranged 10.0 to 360.0 with
thirteen at exactly 360 and **not one at zero**. ``MWD`` (waves) counts **0 to 359**: 182
readings ranged 0.0 to 357.0 with one at exactly zero and **none at 360**. This project
already has a rule that exactly 360.0 is a not-available sentinel, taken from Digitraffic's
``cog``, and applying it here would throw away thirteen real north-wind readings. So ``WDIR``
maps 360 to 0.0 and ``MWD`` is passed through. See :func:`_wind_direction` and
:func:`_wave_direction`.

**Two columns are not metric and both are converted here.** ``VIS`` is nautical miles and
``TIDE`` is feet. Feet in a feed is the trap this project's geospatial rules name by name, and
the conversion belongs in the adapter and nowhere downstream.

**The provider states its rate discipline in words rather than in a number.**
``ndbc.noaa.gov/rt_data_access.shtml``, read 2026-08-24: "We ask that you limit your
retrievals to a minimal level. Most stations report hourly and most of the data is available
by 25 minutes after the hour." The observation file also serves ``Cache-Control: max-age=600``,
so it is regenerated at most every ten minutes however often we ask. Both documents serve
``ETag`` and ``Last-Modified`` and a conditional GET returns a real **HTTP 304 with zero
bytes**, verified live, so most polls cost nothing at all.
"""

import logging
from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final, get_args
from xml.etree import ElementTree

import httpx

from tracker.cache import DiskCache
from tracker.cache import key as cache_key
from tracker.contracts.base import ContractViolationError
from tracker.contracts.buoy import BuoyObservation, StationType
from tracker.contracts.geo import Point
from tracker.sources.base import (
    RATE_LIMIT_STATUS_CODES,
    ParsedRecords,
    RateLimitedError,
    describe_exception,
    retry_after_seconds,
)

_log = logging.getLogger(__name__)

SOURCE_NAME: Final = "ndbc"
"""Layer name in health output and logs."""

CACHE_NAMESPACE: Final = "ndbc"
"""Prefix for every key this adapter writes to the shared disk cache."""

LATEST_OBS_URL: Final = "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt"
"""Every reporting station's most recent transmission, one row each.

Verified 2026-08-24: HTTP 200, 106,148 bytes, ``text/plain; charset=ISO-8859-1``, 890 rows.
"""

STATIONS_URL: Final = "https://www.ndbc.noaa.gov/activestations.xml"
"""The station register: name, owner, programme and type per station.

Verified 2026-08-24: HTTP 200, 272,320 bytes, ``text/xml``, 1,351 stations.
"""

PROVIDER: Final = "NOAA National Data Buoy Center"
"""Who publishes the feed. Not the station owner: 105 owners are republished through it."""

LICENCE: Final = "US Government public domain"
"""What the records travel under.

The National Weather Service states it plainly at ``weather.gov/disclaimer``, read
2026-08-24: "The information on National Weather Service (NWS) Web pages are in the public
domain, unless specifically noted otherwise, and may be used without charge for any lawful
purpose". Three conditions come with it and only one bears on this project: do not present
the data as official government material after modifying it. We do not modify readings, we
convert two of them into the units this project uses everywhere, and the card names NOAA as
the source. The NWS name and identifier are trademarks, which is why the attribution names
the centre in plain text and reproduces no logo.
"""

ATTRIBUTION: Final = "Data from NOAA National Data Buoy Center"
"""The credit shown on the globe. Plain text, no NWS visual identifier, per the trademark
condition in :data:`LICENCE`."""

COVERAGE_REASON: Final = (
    "890 stations, 310 of them moored buoys. Mostly US waters; 23 around the UK and Ireland."
)
"""What the layer says about itself, measured on 2026-08-24 rather than claimed.

Three facts a viewer needs before judging an empty patch of ocean. The station count is what
answers; the buoy count is the honest split, because 542 of the 890 are fixed coastal
stations and one is an uncrewed surface vehicle; and the geography is lopsided, 835 of 890
west of 30W, because this is a United States programme that also republishes partner data.
The UK figure is named because it is the part a British viewer will look for: UK Met Office
lightships at Sevenstones, Sandettie, Greenwich and the Channel, plus North Sea platform
weather stations.
"""

MIN_INTERVAL_SECONDS: Final = 900.0
"""The cadence floor, ours rather than the provider's, because the provider states no number.

NDBC asks in words that retrievals be limited "to a minimal level" and says most stations
report hourly with data available by 25 minutes past. The file itself carries
``Cache-Control: max-age=600``, so anything faster than ten minutes cannot return new data.
Fifteen minutes is four conditional requests an hour against an hourly feed, and a poll
inside the window opens no socket at all.
"""

STATIONS_MIN_INTERVAL_SECONDS: Final = 86_400.0
"""How often the station register may be re-read. Once a day.

Stations do not get renamed or re-owned on a timescale that matters, and the register is 2.6x
the size of the observations. A conditional request costs nothing when it 304s, but asking at
all costs the provider something, and this is the number that keeps that near zero.
"""

MAX_REPORT_AGE_SECONDS: Final = 14_400.0
"""How old a reading may be before it is dropped rather than drawn. Four hours.

**This bound is looser than the transit layer's 300 seconds and that is deliberate, because
it is answering a different question.** A bus report five minutes old puts a vehicle on the
wrong street, which a viewer can check against the map. A moored station does not move: an
hour-old sea temperature is an hour-old sea temperature at a place we still know exactly, and
the card carries the age rather than implying the reading is current.

So the bound exists to stop a station that has **stopped** reporting being drawn as live, and
it has to sit above the feed's own natural spread or it would refuse working stations. Measured
across all 890 rows on 2026-08-24:

====== ================
bound  kept of the set
====== ================
3600s            67.0%
5400s            90.7%
7200s            93.6%
10800s           99.2%
**14400s**   **100.0%**
====== ================

Newest row 21 minutes old, median 46 minutes, p90 89 minutes, oldest **3 hours 9 minutes**.
There is no cliff to cut at because hourly reporting has no cliff; anything under 3.2 hours
refuses live stations. Four hours is four missed reports, which is a station that has gone
quiet rather than one that is between transmissions.

**State the sum, per this project's own rule.** With the store holding for two cadence floors
(1,800s), the worst a card can show is 14,400 + 1,800 = **16,200 seconds, four and a half
hours**. That is a large number and it is stated rather than buried: it is the cost of an
hourly feed, and the age on the record is what makes it visible instead of silent.
"""

MAX_CLOCK_SKEW_SECONDS: Final = 300.0
"""How far ahead of our clock a reading may be before it is dropped.

Zero rows were ahead of our clock on 2026-08-24. This is here so a station or a mirror running
fast produces a counted drop rather than a negative age reaching the contract's ``ge=0.0`` and
raising.
"""

MISSING: Final = "MM"
"""What the source writes where it has no value. Never an empty column, never a null."""

HEADER_LINES: Final = 2
"""Two comment lines before the data: the column names, then the units. Both start with ``#``."""

EXPECTED_COLUMNS: Final = 22
"""Columns per row. Asserted per row, so a provider changing shape counts drops rather than
silently reading the wrong field."""

FULL_CIRCLE_DEGREES: Final = 360.0
"""360 in the wind column means north. See the module docstring: it is **not** a sentinel here,
which is the opposite of what it means on the AIS feeds this project already reads."""

NAUTICAL_MILE_M: Final = 1852.0
"""Metres in a nautical mile, exactly, by international definition. ``VIS`` is in these."""

FOOT_M: Final = 0.3048

# ---------------------------------------------------------------- plausibility bounds
#
# Every reading below is refused outside these, dropped and counted rather than clamped. NDBC
# publishes `MM` for a missing value, but a station with a failing sensor reports a *number*, and
# a wave height of 99 metres or an air temperature of 999 would otherwise be drawn as weather.
#
# Chosen against the physical record with headroom rather than against what the buoys happen to
# have sent, so a genuine extreme is kept and only the impossible is dropped. Each names what it
# is holding out.

MIN_LATITUDE_DEG: Final = -90.0
MAX_LATITUDE_DEG: Final = 90.0
MIN_LONGITUDE_DEG: Final = -180.0
MAX_LONGITUDE_DEG: Final = 180.0
"""The world. A station outside it is a parse error rather than a buoy in an unusual place."""

MAX_WIND_SPEED_MS: Final = 120.0
"""Faster than any surface wind ever recorded. The 1996 Barrow Island gust was 113 m/s."""

MAX_WAVE_HEIGHT_M: Final = 35.0
"""Above the 19.0m buoy record and the 29.1m measured by RRS Discovery, so a real freak stands."""

MAX_WAVE_PERIOD_S: Final = 40.0
"""Swell periods run to about 25s. Past 40 the reading is an artefact, not a longer wave."""

MIN_PRESSURE_HPA: Final = 800.0
MAX_PRESSURE_HPA: Final = 1100.0
"""Sea-level pressure has never been recorded outside 870 to 1084 hPa."""

MAX_PRESSURE_TENDENCY_HPA: Final = 50.0
"""Three-hourly change, signed. A 50 hPa swing in three hours is already beyond any storm."""

MIN_TEMPERATURE_C: Final = -90.0
MAX_TEMPERATURE_C: Final = 60.0
"""Air, sea and dew point share these. Wider than any marine reading, and it is the same
`_bounded` call three times over, so one pair rather than three keeps them from drifting apart."""

MAX_VISIBILITY_M: Final = 100_000.0
"""NDBC reports visibility in nautical miles and caps its own scale well below this."""

MAX_TIDE_M: Final = 20.0
"""Signed about the datum. The Bay of Fundy runs to about 16m, which is the world's largest."""
"""Metres in a foot, exactly, by international definition. ``TIDE`` is in these."""

MAX_BODY_BYTES: Final = 8_000_000
"""Refuse a response larger than this before parsing it.

The two documents are 106KB and 272KB. This is roughly thirty times the larger of them, and it
is the bound that makes parsing the station register with the standard library's XML parser a
decision rather than an oversight: an entity-expansion attack needs a body to arrive in, and
this one is capped and comes from a fixed NOAA path over TLS.
"""

DROP_SHORT_ROW: Final = "row did not carry 22 columns"
DROP_NO_POSITION: Final = "position would not parse"
DROP_NULL_ISLAND: Final = "positioned at 0,0"
DROP_NO_TIMESTAMP: Final = "timestamp would not parse"
DROP_STALE: Final = "reading older than 4 hours"
DROP_FUTURE: Final = "reading timestamped in the future"
DROP_NO_MEASUREMENTS: Final = "reported no measurements at all"
DROP_UNMAPPABLE: Final = "will not map to the contract"
DROP_DUPLICATE_STATION: Final = "station id repeated inside one file"
REFUSED_READING: Final = "single reading outside its physical bound"
"""Drop reasons in the adapter's own words, served per layer on ``/api/layers``.

:data:`REFUSED_READING` is the odd one out and is counted rather than dropped: it refuses one
measurement and keeps the station, because a broken thermometer is not a broken buoy. It is
still on this list so the number reaches somebody instead of being defaulted away in silence.
"""

_STATION_TYPES: Final = frozenset(get_args(StationType.__value__))
"""The seven type words the contract accepts, taken from the contract rather than retyped."""


def _utc_now() -> datetime:
    """Wall clock, injectable everywhere below so staleness is asserted rather than slept."""
    return datetime.now(UTC)


def _station_key(station_id: str) -> str:
    """Fold a station id for joining and keying.

    Case-folded because the two documents disagree: 340 of 890 ids match verbatim and all 890
    match folded. Upper rather than lower because the observation file is the one that moves
    and it upper-cases, so the key a viewer sees on a card is the one the provider prints.
    """
    return station_id.strip().upper()


@dataclass(frozen=True, slots=True)
class Station:
    """One row of the station register, as the register wrote it.

    This is the permissive wire layer for the register. Every field is optional because the
    register is metadata rather than measurement: a station missing a name is still a station,
    and refusing it here would lose the reading attached to it.
    """

    station_id: str
    name: str | None
    owner: str | None
    programme: str | None
    station_type: StationType | None


@dataclass(frozen=True, slots=True)
class RawObservation:
    """One row of the observation file, still as text.

    The permissive wire layer, and it is a dataclass of strings rather than a pydantic model
    because the upstream is a fixed-column text file with no types in it at all. ``MM`` has not
    been resolved yet, units have not been converted, and nothing has been range-checked.
    :func:`_to_domain` is the boundary.
    """

    columns: tuple[str, ...]

    def value(self, index: int) -> str | None:
        """The column at ``index``, or ``None`` where the source wrote its missing marker."""
        raw = self.columns[index]
        return None if raw == MISSING else raw


_STATION = 0
_LAT = 1
_LON = 2
_YEAR = 3
_MONTH = 4
_DAY = 5
_HOUR = 6
_MINUTE = 7
_WDIR = 8
_WSPD = 9
_GST = 10
_WVHT = 11
_DPD = 12
_APD = 13
_MWD = 14
_PRES = 15
_PTDY = 16
_ATMP = 17
_WTMP = 18
_DEWP = 19
_VIS = 20
_TIDE = 21
"""Column offsets, named because ``row[18]`` is water temperature and nothing says so.

The header line is ``#STN LAT LON YYYY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES PTDY
ATMP WTMP DEWP VIS TIDE`` and the units line under it is ``#text deg deg yr mo day hr mn degT
m/s m/s m sec sec degT hPa hPa degC degC degC nmi ft``. Both are read past rather than parsed:
the file has carried these 22 columns in this order for years, and a change of shape is caught
by the per-row column count rather than by trusting a comment.
"""


def parse_stations(payload: bytes) -> dict[str, Station]:
    """Read the station register into a lookup keyed by folded station id.

    Returns an empty mapping rather than raising when the document is unusable, because the
    register is an enrichment: without it every observation still maps, with a name, an owner
    and a type left empty. Raising here would take a working layer down to gain a label.
    """
    if len(payload) > MAX_BODY_BYTES:
        _log.warning(
            "%s: station register was %d bytes, refusing to parse", SOURCE_NAME, len(payload)
        )
        return {}
    try:
        # Bandit flags the standard library XML parser on principle. The body it parses is a
        # fixed NOAA path over TLS, capped at MAX_BODY_BYTES above, and CPython's ElementTree
        # resolves no external entities. The alternative is a dependency for one 272KB file.
        root = ElementTree.fromstring(payload)  # noqa: S314
    except ElementTree.ParseError as exc:
        _log.warning("%s: station register did not parse: %s", SOURCE_NAME, describe_exception(exc))
        return {}

    stations: dict[str, Station] = {}
    for element in root.iter("station"):
        raw_id = element.get("id")
        if not raw_id:
            continue
        raw_type = (element.get("type") or "").strip().lower()
        stations[_station_key(raw_id)] = Station(
            station_id=_station_key(raw_id),
            name=_text(element.get("name")),
            owner=_text(element.get("owner")),
            programme=_text(element.get("pgm")),
            # Narrowed against the contract's own literal set rather than cast. A new word
            # upstream then leaves the field empty instead of failing the strict contract and
            # dropping a station whose reading is perfectly good.
            station_type=raw_type  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]
            if raw_type in _STATION_TYPES
            else None,
        )
    return stations


def _text(value: str | None) -> str | None:
    """An empty or whitespace attribute means absent, never an empty name."""
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _number(raw: str | None) -> float | None:
    """Parse a column into a float, or ``None`` when it is missing or not a number."""
    if raw is None:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def _bounded(
    raw: str | None,
    *,
    low: float,
    high: float,
    drops: Counter[str],
) -> float | None:
    """A reading, believed only inside its physical bound, with a refusal counted.

    Refuses the reading rather than the station. A station whose barometer reports 4,000 hPa
    still has a real sea temperature next to it, and dropping the row would lose a working
    measurement to punish a broken one. The refusal is counted so the number is visible.
    """
    value = _number(raw)
    if value is None:
        return None
    if not (low <= value <= high):
        drops[REFUSED_READING] += 1
        return None
    return value


def _wind_direction(raw: str | None, drops: Counter[str]) -> float | None:
    """Wind direction, mapping the source's 360 onto this project's 0.

    **Not a sentinel.** The column counts 1 to 360 with 360 meaning north and never writes 0,
    measured across 624 readings on 2026-08-24: thirteen at exactly 360, none at zero, lowest
    10.0. This project's existing rule that 360.0 means not-available comes from Digitraffic's
    ``cog`` and does not apply here; applying it would delete thirteen real readings a cycle.
    """
    value = _number(raw)
    if value is None:
        return None
    if value == FULL_CIRCLE_DEGREES:
        return 0.0
    if not (0.0 <= value < FULL_CIRCLE_DEGREES):
        drops[REFUSED_READING] += 1
        return None
    return value


def _wave_direction(raw: str | None, drops: Counter[str]) -> float | None:
    """Wave direction, passed through, because this column already counts 0 to 359.

    Separate function from :func:`_wind_direction` on purpose. The two columns sit four apart
    in the same row, both are labelled ``degT``, and they disagree about what 360 and 0 mean.
    One shared helper would have to guess which caller it was serving.
    """
    value = _number(raw)
    if value is None:
        return None
    if not (0.0 <= value < FULL_CIRCLE_DEGREES):
        drops[REFUSED_READING] += 1
        return None
    return value


def _observed_at(row: RawObservation) -> datetime | None:
    """Assemble the five integer time columns into a UTC instant, or ``None``.

    The columns are ``YYYY MM DD hh mm`` and the file's own units line calls them ``yr mo day
    hr mn``. There is no epoch anywhere in this feed, so the seconds-versus-milliseconds trap
    that bites the ADS-B and AIS feeds does not exist here. NDBC publishes in UTC, so the zone
    is attached in the adapter exactly as it is for CelesTrak's naive ``EPOCH``.
    """
    try:
        return datetime(
            int(row.columns[_YEAR]),
            int(row.columns[_MONTH]),
            int(row.columns[_DAY]),
            int(row.columns[_HOUR]),
            int(row.columns[_MINUTE]),
            tzinfo=UTC,
        )
    except ValueError:
        return None


def _to_domain(  # noqa: PLR0911 -- nine refusal reasons, one return each; see the docstring
    row: RawObservation,
    *,
    stations: Mapping[str, Station],
    now: datetime,
    drops: Counter[str],
) -> BuoyObservation | str:
    """Map one row to the contract, or return the reason it was refused.

    Returning the reason rather than ``None`` is what lets the caller count refusals by cause
    instead of reporting one undifferentiated number.

    Over ruff's return-statement limit on purpose, and the limit is measuring the wrong thing
    here: every return is a distinct named refusal in a flat chain of guard clauses, so the count
    is the number of ways a row can be wrong rather than a sign of branching complexity.
    Extracting the chain into a helper would move the returns, not remove them, and would put the
    reason further from the check that produced it.
    """
    if len(row.columns) != EXPECTED_COLUMNS:
        return DROP_SHORT_ROW

    station_id = _station_key(row.columns[_STATION])
    if not station_id:
        return DROP_SHORT_ROW

    lat = _number(row.columns[_LAT])
    lon = _number(row.columns[_LON])
    if (
        lat is None
        or lon is None
        or not (MIN_LATITUDE_DEG <= lat <= MAX_LATITUDE_DEG)
        or not (MIN_LONGITUDE_DEG <= lon <= MAX_LONGITUDE_DEG)
    ):
        return DROP_NO_POSITION
    if lat == 0.0 and lon == 0.0:
        # Same rule as the transit and aircraft layers: a station heard but not located is not
        # a station in the Gulf of Guinea. Zero rows on 2026-08-24, and one platform sits at
        # exactly 0.0 longitude (Tartan "A" AWS, 58.3N), so the test has to be both together.
        return DROP_NULL_ISLAND

    observed_at = _observed_at(row)
    if observed_at is None:
        return DROP_NO_TIMESTAMP
    age_s = (now - observed_at).total_seconds()
    if age_s < -MAX_CLOCK_SKEW_SECONDS:
        return DROP_FUTURE
    if age_s > MAX_REPORT_AGE_SECONDS:
        return DROP_STALE

    station = stations.get(station_id)
    record = BuoyObservation(
        station_id=station_id,
        # The source writes latitude first in fixed columns. Ours is longitude first.
        point=Point(lon=lon, lat=lat),
        observed_at=observed_at,
        observation_age_s=max(age_s, 0.0),
        station_type=station.station_type if station else None,
        name=station.name if station else None,
        owner=station.owner if station else None,
        programme=station.programme if station else None,
        source=PROVIDER,
        licence=LICENCE,
        wind_direction_deg=_wind_direction(row.value(_WDIR), drops),
        wind_speed_ms=_bounded(row.value(_WSPD), low=0.0, high=MAX_WIND_SPEED_MS, drops=drops),
        gust_ms=_bounded(row.value(_GST), low=0.0, high=MAX_WIND_SPEED_MS, drops=drops),
        wave_height_m=_bounded(row.value(_WVHT), low=0.0, high=MAX_WAVE_HEIGHT_M, drops=drops),
        dominant_wave_period_s=_bounded(
            row.value(_DPD), low=0.0, high=MAX_WAVE_PERIOD_S, drops=drops
        ),
        average_wave_period_s=_bounded(
            row.value(_APD), low=0.0, high=MAX_WAVE_PERIOD_S, drops=drops
        ),
        wave_direction_deg=_wave_direction(row.value(_MWD), drops),
        pressure_hpa=_bounded(
            row.value(_PRES), low=MIN_PRESSURE_HPA, high=MAX_PRESSURE_HPA, drops=drops
        ),
        pressure_tendency_hpa=_bounded(
            row.value(_PTDY),
            low=-MAX_PRESSURE_TENDENCY_HPA,
            high=MAX_PRESSURE_TENDENCY_HPA,
            drops=drops,
        ),
        air_temperature_c=_bounded(
            row.value(_ATMP), low=MIN_TEMPERATURE_C, high=MAX_TEMPERATURE_C, drops=drops
        ),
        water_temperature_c=_bounded(
            row.value(_WTMP), low=MIN_TEMPERATURE_C, high=MAX_TEMPERATURE_C, drops=drops
        ),
        dew_point_c=_bounded(
            row.value(_DEWP), low=MIN_TEMPERATURE_C, high=MAX_TEMPERATURE_C, drops=drops
        ),
        # Nautical miles upstream. Bounded before conversion would compare a distance in one
        # unit against a bound in another, so the conversion happens first and the bound is in
        # metres, which is what the contract is in.
        visibility_m=_converted(
            row.value(_VIS), factor=NAUTICAL_MILE_M, low=0.0, high=MAX_VISIBILITY_M, drops=drops
        ),
        # Feet upstream. This is the conversion this project's rules name by name.
        water_level_m=_converted(
            row.value(_TIDE), factor=FOOT_M, low=-MAX_TIDE_M, high=MAX_TIDE_M, drops=drops
        ),
    )
    if record.measurement_count == 0:
        # Not one of the 890 rows on 2026-08-24 carried zero measurements, so a row that does
        # is a fault rather than a quiet station, and a dot on the globe with an empty card is
        # worse than no dot.
        return DROP_NO_MEASUREMENTS
    return record


def _converted(
    raw: str | None,
    *,
    factor: float,
    low: float,
    high: float,
    drops: Counter[str],
) -> float | None:
    """Convert a reading into this project's units, then bound it.

    Order matters and it is the whole reason this is a separate function from :func:`_bounded`:
    bounding first would test a value in nautical miles against a bound in metres, pass
    everything, and then convert the nonsense.
    """
    value = _number(raw)
    if value is None:
        return None
    converted = value * factor
    if not (low <= converted <= high):
        drops[REFUSED_READING] += 1
        return None
    return converted


def parse_records(
    payload: bytes,
    *,
    stations: Mapping[str, Station] | None = None,
    now: datetime | None = None,
) -> ParsedRecords[BuoyObservation]:
    """Decode the observation file into domain records, with refusals counted by reason.

    Raises :class:`~tracker.contracts.base.ContractViolationError` when the body is not this
    file at all, because that is a provider changing shape rather than one bad row, and it
    arrives on an **HTTP 200**. The test is the header: two comment lines whose first names
    ``#STN``. A CDN error page, an HTML holding page and a truncated body all fail it, and the
    GeoNames rule this project already has says a 200 carrying an error page is worse than a
    503 because it gets cached.
    """
    now = now or _utc_now()
    stations = stations or {}
    if len(payload) > MAX_BODY_BYTES:
        msg = f"observation file was {len(payload)} bytes, refusing to parse"
        raise ContractViolationError(SOURCE_NAME, msg)

    text = payload.decode("latin-1")
    lines = text.splitlines()
    if len(lines) <= HEADER_LINES or not lines[0].lstrip("#").startswith("STN"):
        msg = "body is not the NDBC latest-observations file"
        raise ContractViolationError(SOURCE_NAME, msg)

    records: list[BuoyObservation] = []
    drops: Counter[str] = Counter()
    for line in lines[HEADER_LINES:]:
        if not line.strip():
            continue
        row = RawObservation(columns=tuple(line.split()))
        try:
            mapped = _to_domain(row, stations=stations, now=now, drops=drops)
        except (ValueError, TypeError) as exc:
            drops[DROP_UNMAPPABLE] += 1
            _log.debug("skipping malformed station row: %s", exc)
            continue
        if isinstance(mapped, str):
            drops[mapped] += 1
        else:
            records.append(mapped)

    kept = _deduplicate(records, drops=drops)
    if drops:
        _log.info(
            "%s: kept %d stations, dropped %d %s",
            SOURCE_NAME,
            len(kept),
            sum(drops.values()),
            dict(drops),
        )
    return ParsedRecords(records=kept, drops=drops)


def _deduplicate(
    records: list[BuoyObservation], *, drops: Counter[str]
) -> tuple[BuoyObservation, ...]:
    """Keep one record per station, newest reading wins, and count what that cost.

    Zero duplicates across 890 rows on 2026-08-24, so this should never fire. It is here
    because the identity is the whole reason this feed was chosen over NOAA's ship reports,
    and a claim that strong needs a counter behind it rather than a comment: if NDBC ever
    starts repeating a station id, the number says so instead of one station silently
    replacing another in the store.
    """
    newest: dict[str, BuoyObservation] = {}
    for record in records:
        held = newest.get(record.station_id)
        if held is None:
            newest[record.station_id] = record
            continue
        drops[DROP_DUPLICATE_STATION] += 1
        if record.observed_at > held.observed_at:
            newest[record.station_id] = record
    return tuple(newest.values())


def merge_key(record: BuoyObservation) -> str:
    """The store key for one station.

    The folded station id and nothing else. Unlike the transit layer there is no compound key
    to build, because there is one publisher rather than 258 and station ids are unique across
    the whole register, measured: 890 rows, 890 distinct ids, and 1,936 distinct ids in the
    full station table with no repeats.
    """
    return record.station_id


def fix_time(record: BuoyObservation) -> datetime:
    """When the reading was taken, for the store's never-go-backwards guard."""
    return record.observed_at


class NdbcCoolingDownError(RateLimitedError):
    """Raised instead of calling NDBC inside its own floor or a backoff it asked for.

    Same shape as ``AdsbCoolingDownError`` and ``GtfsRtCoolingDownError``: the cooldown is
    checked before the request rather than after it, so a throttled provider gets silence
    rather than one more call it has to refuse.
    """


class NdbcClient:
    """Reads ocean station observations, holding the station register between polls.

    The two documents move on completely different timescales, so they are fetched on
    completely different cadences: readings every fifteen minutes at most, the register once a
    day at most. Both go out as conditional requests and both answer a real 304 with zero
    bytes, verified live on 2026-08-24, so a poll that finds nothing new costs a round trip and
    no body.

    The register is held in memory rather than on disk. It is 1,351 rows of names and owners
    with no personal data in it, and a restart re-reading it once is cheaper than another cache
    with an eviction path to reason about.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        cache: DiskCache | None = None,
        clock: Callable[[], datetime] = _utc_now,
    ) -> None:
        self._client = client
        self._cache = cache
        self._clock = clock
        self._stations: dict[str, Station] = {}
        self._stations_read_at: datetime | None = None
        self._validators: dict[str, tuple[str | None, str | None]] = {}
        self._not_before: datetime | None = None

    @property
    def stations(self) -> Mapping[str, Station]:
        """The station register as last read. Empty until the first successful fetch."""
        return self._stations

    @property
    def not_before(self) -> datetime | None:
        """The earliest this client may call the observation file again."""
        if self._cache is not None:
            return self._cache.get_time(cache_key(CACHE_NAMESPACE, "not_before"))
        return self._not_before

    def _hold_until(self, when: datetime) -> None:
        """Record the next allowed call, in memory and on disk.

        Persisted unconditionally, because a floor can only ever delay us. That is the rule
        this project settled on after adsb.lol answered HTTP 420 on the **first** request of a
        fresh process, having asked the previous one for 120 seconds of quiet.
        """
        self._not_before = when
        if self._cache is not None:
            self._cache.set_time(cache_key(CACHE_NAMESPACE, "not_before"), when)

    def _validator(self, url: str) -> tuple[str | None, str | None]:
        """The ETag and Last-Modified last seen for ``url``, from disk where there is one."""
        if self._cache is not None:
            etag = self._cache.get(cache_key(CACHE_NAMESPACE, "etag", url))
            stamp = self._cache.get(cache_key(CACHE_NAMESPACE, "lastmod", url))
            return (
                etag.value if etag is not None else None,
                stamp.value if stamp is not None else None,
            )
        return self._validators.get(url, (None, None))

    def _remember_validator(self, url: str, response: httpx.Response) -> None:
        """Keep whatever validator the host offered, so the next call can be conditional."""
        etag = response.headers.get("etag")
        last_modified = response.headers.get("last-modified")
        self._validators[url] = (etag, last_modified)
        if self._cache is None:
            return
        if etag:
            self._cache.set(cache_key(CACHE_NAMESPACE, "etag", url), etag)
        if last_modified:
            self._cache.set(cache_key(CACHE_NAMESPACE, "lastmod", url), last_modified)

    async def _conditional_get(self, url: str) -> httpx.Response | None:
        """One conditional GET. ``None`` means the host answered Not Modified.

        A throttling response holds the whole client, not just this URL: 420 and 429 bind the
        egress address rather than the path, which is the lesson from the ADS-B failover that
        absorbed a 420 and called the same provider again 65 seconds into the window it had
        asked for.
        """
        headers: dict[str, str] = {}
        etag, last_modified = self._validator(url)
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified

        response = await self._client.get(url, headers=headers)

        if response.status_code in RATE_LIMIT_STATUS_CODES:
            backoff = retry_after_seconds(response)
            self._hold_until(self._clock() + timedelta(seconds=backoff))
            raise RateLimitedError(SOURCE_NAME, response.status_code, backoff)

        if response.status_code == httpx.codes.NOT_MODIFIED:
            return None

        response.raise_for_status()
        self._remember_validator(url, response)
        return response

    async def refresh_stations(self) -> int:
        """Re-read the station register if it is due, and report how many it holds.

        Never raises. A failed register read leaves the last one in place and the observations
        still map with the metadata fields empty, which is the right degradation: the layer
        loses labels rather than stations. The error is logged rather than swallowed silently.
        """
        read_at = self._stations_read_at
        now = self._clock()
        if read_at is not None and (now - read_at).total_seconds() < STATIONS_MIN_INTERVAL_SECONDS:
            return len(self._stations)
        try:
            response = await self._conditional_get(STATIONS_URL)
        except (httpx.HTTPError, RateLimitedError) as exc:
            _log.warning(
                "%s: station register unavailable, keeping %d held: %s",
                SOURCE_NAME,
                len(self._stations),
                describe_exception(exc),
            )
            return len(self._stations)
        self._stations_read_at = now
        if response is None:
            return len(self._stations)
        parsed = parse_stations(response.content)
        if parsed:
            self._stations = parsed
        return len(self._stations)

    async def fetch(self) -> ParsedRecords[BuoyObservation] | None:
        """Read the observation file, honouring the floor. ``None`` means Not Modified.

        Raises :class:`NdbcCoolingDownError` when called inside the floor, rather than
        returning an empty result. An empty result and "we did not ask" are different facts and
        collapsing them is how a layer reports itself healthy while never calling anybody.
        """
        now = self._clock()
        not_before = self.not_before
        if not_before is not None and now < not_before:
            wait = (not_before - now).total_seconds()
            raise NdbcCoolingDownError(SOURCE_NAME, httpx.codes.TOO_MANY_REQUESTS, wait)

        await self.refresh_stations()
        try:
            response = await self._conditional_get(LATEST_OBS_URL)
        finally:
            self._hold_until(self._clock() + timedelta(seconds=MIN_INTERVAL_SECONDS))
        if response is None:
            return None
        return parse_records(response.content, stations=self._stations, now=self._clock())
