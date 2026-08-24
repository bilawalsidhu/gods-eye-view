"""Public-transport vehicle positions from keyless GTFS-Realtime feeds.

**What "global" actually means here, measured rather than claimed.** On 2026-08-23 the
Mobility Database listed 738 vehicle-position feeds. 553 were keyless and active, and calling
every one of them took 54.9 seconds at 16 concurrent requests. 518 answered HTTP 200, 512
decoded as protocol buffers, 503 carried a feed header timestamp less than an hour old, and
247 had a vehicle in them at 10:21 UTC. Total: **16,535 vehicles, 2.25MB on the wire**. An
earlier estimate in this project of 36,500 vehicles across 300 feeds was counting catalogue
rows rather than calling them, and overstated the fleet by roughly 2.2x.

Coverage is Europe (74% of vehicles), North America (17%), Japan and east Asia (5.5%) and
Oceania (3%). **There is none at all in Latin America, Africa, the Middle East, India or
China**, because no keyless public vehicle-position feed exists for them. See
:data:`COVERAGE_REASON`, which is what the layer says out loud rather than rounding up to the
word "global".

**The registry is committed data, not a runtime fetch**, the same treatment as
``itu_mid_table.csv`` and the GeoNames city dump. :data:`REGISTRY_FILE_NAME` holds the feeds
that survived every rule this project already has, and the file records who published each
one and under what licence, because a record whose licence cannot be determined is dropped.
The funnel from 553 candidates to :data:`EXPECTED_FEED_COUNT`:

- 35 answered but were network failures, 404, 403, 401 or 503.
- 6 answered HTTP 200 with something that was not a feed. See :func:`parse_records`.
- 9 had a feed header timestamp over an hour old: abandoned, not quiet.
- 4 were the same feed listed under two URLs, byte-identical bodies.
- 35 sit on ``bct.tmix.se``, whose ``robots.txt`` is ``Disallow: /``. That is a stated
  directive, so it is honoured and never worked around. It costs British Columbia.
- 9 are New York MTA, whose licence is a Data Feed Agreement you accept. Reachable, and out
  on terms, exactly like ADS-B Exchange.
- 184 record no licence anywhere in the catalogue. Unrecorded is not the same as unlicensed,
  but this project does not show an item whose licence it cannot determine, so they are out
  and counted. It costs Warsaw (970 vehicles), Rome (684) and Bucharest (486).
- 7 point their licence at an acceptance agreement rather than an open licence, which is the
  MTA case again under a different URL. MBTA is one of them.
- 4 more gate the data behind an agreement the URL does not advertise, found only by reading the
  terms: SEPTA and CTtransit both say "in order to download the Trip Planning Data, you are
  required to agree to [the] License Agreement" and put a form in front of it, and Sound Transit
  says "completing the registration required to access the data". Matching "agree" in a licence
  URL does not catch these, so the pages had to be read.

**One feed is here that the catalogue does not list, and it is worth more than the long
tail.** Entur publishes Norway's national feed as three per-operator slices carrying 148
vehicles between them, all three labelled Czechia. Its unfiltered endpoint, with no query
string, returned **1,497 vehicles in one 304,907-byte request** on 2026-08-23, keyless, NLOD
2.0, and ``api.entur.io/robots.txt`` is HTTP 404 so there is no directive to honour. The three
slices are replaced by the one endpoint. Before adding an aggregator host to the registry,
check whether it serves an unfiltered endpoint: on Entur it was worth 8% of the whole layer.

**The catalogue's country column is wrong often enough to be untrustworthy.** The largest feed
in the set, OVapi at 2,098 vehicles, is labelled ``AT`` and its vehicles are in the
Netherlands. Every country in the registry was checked against the median of its own feed's
measured positions, and six were corrected: OVapi to NL, three Entur slices to NO, Dunkerque
from BE to FR, and blanks filled for Venice, Cleveland, Rzeszow, Reunion and Nimes.

**The generated protobuf classes are the permissive wire layer.** They ignore unknown fields
by construction, which is exactly what the contract discipline asks for, and
:class:`~tracker.contracts.transit.TransitVehicle` is the strict layer behind them. The
library is used rather than a hand-rolled wire parser for a measured reason: a hand-rolled
one written for the research behind this module got ``TripDescriptor`` wrong, because it
numbers its fields ``1 trip_id, 2 start_time, 3 start_date, 4 schedule_relationship,
5 route_id, 6 direction_id`` rather than in declaration order. That version reported 3,476
vehicles instead of 16,535. It threw rather than returning wrong values, which was luck: a
guess between two same-typed fields would have been silent.
"""

import asyncio
import csv
import logging
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Final
from urllib.parse import urlsplit

import httpx

# protobuf 6.x ships .pyi files but no py.typed marker, so mypy wants the separate
# types-protobuf stub package for this one import. gtfs_realtime_pb2 below resolves
# clean. ty is happy either way and does not honour a coded mypy ignore, so this line
# carries mypy's only.
from google.protobuf.message import DecodeError  # type: ignore[import-untyped]
from google.transit import gtfs_realtime_pb2

from tracker.cache import DiskCache
from tracker.cache import key as cache_key
from tracker.contracts.base import ContractViolationError
from tracker.contracts.geo import Point
from tracker.contracts.transit import MAX_PLAUSIBLE_SPEED_MS, TransitVehicle
from tracker.sources.base import (
    RATE_LIMIT_STATUS_CODES,
    ParsedRecords,
    RateLimitedError,
    describe_exception,
    retry_after_seconds,
)

_log = logging.getLogger(__name__)

SOURCE_NAME: Final = "gtfs-rt"
"""Layer name in health output and logs."""

CACHE_NAMESPACE: Final = "gtfsrt"
"""Prefix for every key this adapter writes to the shared disk cache."""

REGISTRY_FILE_NAME: Final = "gtfsrt_feeds.csv"
"""The committed feed registry, alongside this module so it travels with the package."""

REGISTRY_VERIFIED: Final = "2026-08-23"
"""When every URL in the registry was last called successfully. The as-of date of the layer."""

EXPECTED_FEED_COUNT: Final = 258
"""Rows in the committed registry. Asserted on load, so a truncated file fails loudly."""

CATALOGUE_URL: Final = "https://files.mobilitydatabase.org/feeds_v2.csv"
"""Where the registry was derived from. 2,647,828 bytes on 2026-08-23, 1,964 realtime rows.

Not fetched at runtime, and there is a second reason beyond keeping HTTP off a render path:
this host's ``robots.txt`` is ``Disallow: /`` while ``mobilitydatabase.org/robots.txt`` is
``Allow: /``. That conflict is the same open question as R4 in ``docs/pending-decisions.md``,
so refreshing the registry is a deliberate manual step rather than something this code does
on a timer behind an unratified reading.
"""

COVERAGE_REASON: Final = (
    "17 countries. Latin America, Africa, the Middle East, India and China publish "
    "schedules, not positions."
)
"""What the layer says about itself, in 103 characters.

Alexander Fanthome asked for global transit and the honest answer is 17 countries.

**It names a country count rather than continents, and that is a correction.** The first
version read "Europe and North America only", which the live feed contradicts: Japan and
Australia both report, 676 and 53 vehicles in one reading. Naming continents put the product
in the position of telling a viewer in Tokyo there is no coverage in Tokyo while their screen
showed buses.

Three facts will not fit in 120 characters. The licensed set is 17 countries; the set actually
reporting at any instant is smaller and moves with the clock, measured across seven sweeps
spanning a full day at a factor of 2.7, 3,629 vehicles to 9,668;
and the absent regions are absent because they publish schedules and not live positions. This
carries the first and the third, which are the two a viewer needs to judge what they are
looking at. The second belongs beside the vehicle count, which is what moves.
"""


def _utc_now() -> datetime:
    """Wall clock, injectable everywhere below so staleness is asserted rather than slept."""
    return datetime.now(UTC)


DEFAULT_MIN_INTERVAL_SECONDS: Final = 30.0
"""Cadence floor for a host we hold no specific figure for. The GTFS-Realtime convention."""

HOST_MIN_INTERVAL_SECONDS: Final[dict[str, float]] = {
    # The only host in the set that states a numeric cap, and it states it in a response
    # header rather than a document: ``X-RateLimit-Limit: 6000`` with
    # ``X-RateLimit-Remaining: 5999``, seen live on 2026-08-23. 6,000 is a daily budget
    # shared by every feed on the host, so 86400 / (6000 / 23 feeds) is 331 seconds and this
    # rounds it up.
    "passio3.com": 350.0,
    # No stated cap, and 99 feeds on one public-sector host. At the default floor we would
    # take 3.3 requests a second off data.gouv.fr, 285,120 a day, for feeds carrying under
    # 1,400 vehicles between them. The floor is ours, chosen to be defensible.
    "www.data.gouv.fr": 120.0,
    "proxy.transport.data.gouv.fr": 120.0,
    # 30 feeds on one host, same reasoning at a smaller scale.
    "gtfs-rt-files.buscatch.jp": 60.0,
}
"""Per **host** floors, because a per-feed floor is the wrong unit.

52 hosts serve the 258 registry feeds and the distribution is not close to even: 99 sit on
``www.data.gouv.fr`` alone. A floor applied per feed multiplies by however many feeds a host
happens to publish, which is exactly how a polite cadence becomes a denial of service. This
is the same shape as the ADS-B per-provider floors in ``sources/adsb.py``, moved down a level
because here the provider is the host rather than the feed.
"""

MAX_REPORT_AGE_SECONDS: Final = 300.0
"""How old a vehicle report may be before it is dropped rather than drawn.

**This is a rendering bound, not a liveness bound, and the two are different questions.**
Whether a feed is alive is answered by its own header timestamp, which is why 261 of 265 feeds
carrying no vehicles in one sweep were working feeds with no buses running. This decides
whether a position may be drawn on a map a viewer can check against the street.

**Retuned from 900 to 300 on 2026-08-23, and the measurement is why it was nearly free.** A
live sweep of the registry gave acceptance ages of **median 49s, p75 68s, p90 82s, p99 762s**.
The tail is thin, not fat: only two records of 5,196 sat between 600 and 900 seconds. So the
old bound was doing almost nothing while permitting a great deal.

====== ================ ==========================
bound  kept of the set  unknown movement at 12km/h
====== ================ ==========================
60s              64.3%                     0.20 km
120s             93.8%                     0.40 km
180s             95.6%                     0.59 km
**300s**       **97.1%**                 **0.99 km**
600s             98.4%                     1.98 km
900s            100.0%                     2.98 km
====== ================ ==========================

300 seconds costs **151 vehicles of 5,196, 2.9%**, and halves the distance a bus could have
travelled unobserved. Below 120 seconds the curve falls off a cliff, 64.3% at 60s, because
feed publish cadences are themselves 30 to 60 seconds and a freshly fetched report is already
that old.

The argument for tightening is the one the clustering work already made against dead
reckoning: 120 metres along a bearing puts a bus on the wrong street and a viewer can see it
against the map. A position accepted at 14 minutes old is that error a hundred times over,
held silently rather than extrapolated openly. A bus neither travels in a straight line for
fourteen minutes nor stays put.

**Who pays is the right set.** Over-300-seconds by country: France 22.8% and Norway 19.6%,
everyone else under 3% and most at zero. Those two are the retention-policy feeds, Entur
keeping a last-known position for hours and the French aggregator behind it. Losing a
last-known position is the point rather than the cost.

**This bound must stay above the largest host floor in** :data:`HOST_MIN_INTERVAL_SECONDS`, or
our own rate discipline manufactures stale drops: a feed we choose to poll every 350 seconds
cannot produce a report under 300 seconds old. The largest floor governing a feed actually in
the registry is 120 seconds, so there is 180 seconds of headroom. ``passio3.com`` carries a
350-second floor and currently governs no feed at all, every one of its 23 having been dropped
for having no licence recorded.
"""

MAX_CLOCK_SKEW_SECONDS: Final = 120.0
"""How far ahead of our clock a report may be before it is dropped.

89 feeds ran a few seconds fast, which is ordinary skew between two machines. Eight feeds, all
New York MTA, ran up to 3,584 seconds ahead, just under an hour. MTA is out on licence anyway,
so nothing in the registry needs this today, and it is here because a negative age would
otherwise reach the contract's ``ge=0.0`` and raise instead of counting a drop.
"""

TIMESTAMP_SENTINEL: Final = 0
"""``timestamp == 0`` means "not set", not 1 January 1970. 35 vehicles sent it on 2026-08-23."""

OCCUPANCY_NO_DATA: Final = "NO_DATA_AVAILABLE"
"""The OccupancyStatus value that means the field is absent. Mapped to ``None``, not shown."""

FULL_CIRCLE_DEGREES: Final = 360.0
"""Exactly 360.0 is a not-available sentinel, not a heading. 18 vehicles sent it.

Same convention as Digitraffic's ``cog`` of 360.0, already documented in ``AGENTS.md``. A
bearing legitimately reads 0.0, so 360.0 is the only value that can carry the meaning.
"""

DROP_NO_POSITION: Final = "reported without a position"
DROP_NULL_ISLAND: Final = "positioned at 0,0"
DROP_NO_IDENTITY: Final = "no feed entity id"
DROP_NO_TIMESTAMP: Final = "no usable timestamp"
DROP_STALE: Final = "report older than 5 minutes"
DROP_FUTURE: Final = "report timestamped in the future"
DROP_UNMAPPABLE: Final = "will not map to the contract"
DROP_DUPLICATE_ENTITY: Final = "entity id repeated inside one message"
"""Drop reasons in the adapter's own words, served per feed on ``/api/layers``."""


@dataclass(frozen=True, slots=True)
class TransitFeed:
    """One publisher in the committed registry, and the terms it travels under.

    Held as data for the same reason ``sources/adsb.py`` holds its provider rows that way:
    the feeds are not interchangeable and the differences between them are facts worth
    reading. Here the difference that matters is the licence, because it decides whether the
    feed may be shown at all, and it rides on every record rather than only on the layer.
    """

    feed_id: str
    """Stable id from the Mobility Database, or a name we assigned for a feed it omits."""

    country: str
    """ISO 3166-1 alpha-2, corrected against measured positions. See the module docstring."""

    provider: str
    """The operator, shown on the card and in the credit."""

    name: str
    """The feed's own title, which is often empty in the catalogue."""

    url: str
    """The vehicle-positions endpoint. Called successfully on :data:`REGISTRY_VERIFIED`."""

    licence: str
    """Short family name, e.g. ``ODbL 1.0``. Travels onto every record."""

    licence_url: str
    """Where that licence is published, for the attribution list."""

    attribution: str = ""
    """A form of words the licensor mandates, or empty when it does not care how we credit it.

    Two of the 258 mandate one, found by reading the terms rather than by matching a URL. King
    County Metro requires "Transit scheduling, geographic, and real-time data provided by
    permission of King County", prominently displayed, "unless otherwise agreed by King County in
    writing". The City of Hamilton requires "Contains public sector Data made available under the
    City of Hamilton's Open Data Licence", and reserves the right to make us remove it.

    A mandated string cannot be folded into a grouped credit, so this field is what any grouping
    of :data:`ATTRIBUTIONS` has to leave alone.
    """

    @property
    def host(self) -> str:
        """The host this feed is served from, which is what the cadence floor applies to."""
        return urlsplit(self.url).netloc

    @property
    def min_interval_seconds(self) -> float:
        """This feed's polling floor, taken from its host rather than from itself."""
        return HOST_MIN_INTERVAL_SECONDS.get(self.host, DEFAULT_MIN_INTERVAL_SECONDS)

    @property
    def credit(self) -> str:
        """The credit to show wherever this feed's vehicles are.

        The licensor's own wording where it mandates one, otherwise the operator and the licence.
        Naming the licence is not decoration: ODbL 1.0 requires a notice "reasonably calculated"
        to make a viewer aware both that the content came from the database **and** that it is
        available under that licence, so a credit naming only the operator does not satisfy it,
        and 46 of these feeds are ODbL.
        """
        return self.attribution or f"{self.provider} ({self.licence})"


def _load_registry(path: Path) -> tuple[TransitFeed, ...]:
    """Read the committed registry, refusing a file that is not the one we verified."""
    with path.open(encoding="utf-8", newline="") as handle:
        rows = tuple(
            TransitFeed(
                feed_id=row["feed_id"],
                country=row["country"],
                provider=row["provider"],
                name=row["name"],
                url=row["url"],
                licence=row["licence"],
                licence_url=row["licence_url"],
                attribution=row["attribution"],
            )
            for row in csv.DictReader(handle)
        )
    if len(rows) != EXPECTED_FEED_COUNT:
        msg = f"registry has {len(rows)} rows, expected {EXPECTED_FEED_COUNT}"
        raise ValueError(msg)
    return rows


FEEDS: Final = _load_registry(Path(__file__).with_name(REGISTRY_FILE_NAME))
"""Every feed this layer may poll. Keyless, licensed, and verified answering."""

FEEDS_BY_ID: Final = {feed.feed_id: feed for feed in FEEDS}
"""Registry indexed by merge-key half, for wiring that holds an id and needs the terms."""

ATTRIBUTIONS: Final = tuple(sorted({feed.credit for feed in FEEDS}))
"""Every credit this layer owes, deduplicated. 182 of them, and they are not interchangeable.

What each licence family actually asks for, read from the licence texts on 2026-08-23 rather than
assumed:

- **CC0 1.0, 31 feeds: nothing.** The affirmer waives attribution outright. These 18 credits are
  courtesy, and are the only ones a grouping may drop entirely.
- **CC-BY 4.0, 35 feeds:** the creator as identified, a copyright notice, a licence notice, a
  disclaimer notice and a URI for the licence, satisfiable "in any reasonable manner based on the
  medium". No wording mandated, but the **licence link is not optional**.
- **ODbL 1.0, 46 feeds:** a notice "reasonably calculated" to make a viewer aware the content came
  from the database **and that it is available under this licence**. It offers a safe-harbour text
  and does not mandate it. A credit naming only the operator does not satisfy this.
- **Etalab 2.0, 101 feeds:** the source, "a minima le nom du Concédant", **and the date of the last
  update of the information reused**. The date is the part nobody guesses, and it is 101 feeds.
- **NLOD 2.0, 1 feed:** the source "as specified by the licensor" plus a reference to the licence.
- **Bespoke operator terms, 44 feeds:** two mandate exact words, carried on
  :attr:`TransitFeed.attribution`. Several others restrict how their name may appear rather than
  what it says: COTA, Community Transit and Duluth Transit each forbid use of their marks "in any
  manner that is likely to cause confusion, or in any manner that disparages or discredits" them.
"""

COUNTRIES: Final = tuple(sorted({feed.country for feed in FEEDS}))
"""The 17 countries with a keyless licensed feed. The honest scope of the word "global"."""


def _bearing(raw: float | None) -> float | None:
    """Normalise a reported bearing, or ``None`` where the feed said nothing usable.

    470 vehicles reported a negative bearing on 2026-08-23 and 2 reported over 360, so the
    modulo is not defensive coding. Exact 360.0 is a sentinel and maps to ``None``.
    """
    if raw is None or raw == FULL_CIRCLE_DEGREES:
        return None
    return raw % FULL_CIRCLE_DEGREES


def _speed(raw: float | None) -> float | None:
    """Believe a speed only inside the plausible range. See :data:`MAX_PLAUSIBLE_SPEED_MS`."""
    if raw is None or raw < 0.0 or raw > MAX_PLAUSIBLE_SPEED_MS:
        return None
    return raw


def _occupancy(vehicle: gtfs_realtime_pb2.VehiclePosition) -> str | None:
    """Name the OccupancyStatus enum value, or ``None`` when the feed reported no data."""
    if not vehicle.HasField("occupancy_status"):
        return None
    name = gtfs_realtime_pb2.VehiclePosition.OccupancyStatus.Name(vehicle.occupancy_status)
    return None if name == OCCUPANCY_NO_DATA else name


def _text(value: str) -> str | None:
    """An empty protobuf string means absent, never an empty name."""
    return value or None


@dataclass(frozen=True, slots=True)
class _Timing:
    """When a record was observed, which clock said so, and how stale that makes it."""

    observed_at: datetime
    basis: str
    age_s: float


def _timing(
    vehicle: gtfs_realtime_pb2.VehiclePosition,
    *,
    header_epoch: int,
    now: datetime,
) -> _Timing | str:
    """Resolve the record's time, or return the drop reason that stopped us.

    Prefers the vehicle's own timestamp, true for 99.2% of records, and falls back to the feed
    header. Which one was used reaches the contract, because dating every vehicle in a message
    to one instant is a weaker claim than dating each to its own fix.
    """
    epoch = vehicle.timestamp if vehicle.timestamp != TIMESTAMP_SENTINEL else header_epoch
    basis = "vehicle" if vehicle.timestamp != TIMESTAMP_SENTINEL else "feed"
    if epoch == TIMESTAMP_SENTINEL:
        return DROP_NO_TIMESTAMP
    try:
        observed_at = datetime.fromtimestamp(epoch, tz=UTC)
    except (OSError, OverflowError, ValueError):
        return DROP_NO_TIMESTAMP
    age_s = (now - observed_at).total_seconds()
    if age_s < -MAX_CLOCK_SKEW_SECONDS:
        return DROP_FUTURE
    if age_s > MAX_REPORT_AGE_SECONDS:
        return DROP_STALE
    return _Timing(observed_at=observed_at, basis=basis, age_s=max(age_s, 0.0))


def _to_domain(
    entity: gtfs_realtime_pb2.FeedEntity,
    *,
    feed: TransitFeed,
    header_epoch: int,
    now: datetime,
) -> TransitVehicle | str:
    """Map one entity to the contract, or return the reason it was refused.

    Returning the reason rather than ``None`` is what lets the caller count refusals by cause
    instead of reporting one undifferentiated number. Every refusal below was measured.
    """
    if not entity.id:
        return DROP_NO_IDENTITY
    vehicle = entity.vehicle
    if not vehicle.HasField("position"):
        return DROP_NO_POSITION
    position = vehicle.position
    if position.latitude == 0.0 and position.longitude == 0.0:
        # 104 vehicles on 2026-08-23, 93 of them from Minneapolis Metro Transit, which emits
        # 0,0 for a vehicle it has no fix for rather than omitting the position. It gave one
        # bus an apparent 10,266 km trip in 9.6 minutes and put Krakow's feed bounding box in
        # the Gulf of Guinea. Same rule as aircraft heard but not located.
        return DROP_NULL_ISLAND

    timing = _timing(vehicle, header_epoch=header_epoch, now=now)
    if isinstance(timing, str):
        return timing

    return TransitVehicle(
        feed_id=feed.feed_id,
        entity_id=entity.id,
        # The reference sends latitude first as two separate floats. Ours is longitude first.
        point=Point(lon=position.longitude, lat=position.latitude),
        observed_at=timing.observed_at,
        timestamp_basis="vehicle" if timing.basis == "vehicle" else "feed",
        position_age_s=timing.age_s,
        source=feed.provider,
        licence=feed.licence,
        country=feed.country,
        vehicle_id=_text(vehicle.vehicle.id),
        vehicle_label=_text(vehicle.vehicle.label),
        route_id=_text(vehicle.trip.route_id),
        trip_id=_text(vehicle.trip.trip_id),
        bearing=_bearing(position.bearing if position.HasField("bearing") else None),
        speed_ms=_speed(position.speed if position.HasField("speed") else None),
        occupancy=_occupancy(vehicle),
    )


def parse_records(
    payload: bytes,
    *,
    feed: TransitFeed,
    now: datetime | None = None,
) -> ParsedRecords[TransitVehicle]:
    """Decode one feed body into domain vehicles, with the refusals counted by reason.

    Raises :class:`~tracker.contracts.base.ContractViolationError` when the body is not a
    GTFS-Realtime message at all, because that is a provider changing shape rather than one
    bad record, and it happens on a **HTTP 200**. Six of 518 successful responses on
    2026-08-23 were not feeds: an HTML error page, a second HTML page, a GTFS *static* zip,
    protobuf in text format rather than binary, and two JSON documents. ``Content-Type`` is no
    help at all, taking twelve distinct values across the set including
    ``application/octet-stream`` on 273 of them and nothing at all on 32. Only the decode
    tells you.

    Individual records that will not map are dropped and counted, never defaulted.
    """
    now = now or _utc_now()
    message = gtfs_realtime_pb2.FeedMessage()
    try:
        message.ParseFromString(payload)
    except (DecodeError, UnicodeDecodeError, ValueError) as exc:
        msg = f"body is not a GTFS-Realtime message: {describe_exception(exc)}"
        raise ContractViolationError(feed.feed_id, msg) from exc

    header_epoch = message.header.timestamp
    vehicles: list[TransitVehicle] = []
    drops: Counter[str] = Counter()
    for entity in message.entity:
        if not entity.HasField("vehicle"):
            continue
        try:
            mapped = _to_domain(entity, feed=feed, header_epoch=header_epoch, now=now)
        except (ValueError, TypeError) as exc:
            drops[DROP_UNMAPPABLE] += 1
            _log.debug("skipping malformed vehicle %s: %s", entity.id, exc)
            continue
        if isinstance(mapped, str):
            drops[mapped] += 1
        else:
            vehicles.append(mapped)

    kept = _deduplicate(vehicles, drops=drops)
    if drops:
        _log.info(
            "%s: kept %d vehicles, dropped %d %s",
            feed.feed_id,
            len(kept),
            sum(drops.values()),
            dict(drops),
        )
    return ParsedRecords(records=kept, drops=drops)


def _deduplicate(
    vehicles: list[TransitVehicle], *, drops: Counter[str]
) -> tuple[TransitVehicle, ...]:
    """Keep one record per entity id, newest fix wins, and count what that cost.

    ``FeedEntity.id`` is unique within a feed **by specification**, so this should never fire.
    It fires on 17 of 10,576 records across the registry, 0.16%, because a handful of feeds
    break their own spec: Metro Transit served 189 vehicle records under 133 distinct vehicle
    ids on 2026-08-23, and SEPTA, Go-Ahead, Atoumod and Sofia did smaller versions of it.

    Leaving it to the store would be the quiet version of this bug. ``EntityStore`` keyed on
    ``(feed_id, entity_id)`` would take the last one it was handed and the other bus would
    simply not exist, with nothing anywhere saying a bus had gone missing. Counted here, it
    reaches ``/api/layers`` as a number somebody can look at.
    """
    newest: dict[str, TransitVehicle] = {}
    for vehicle in vehicles:
        held = newest.get(vehicle.entity_id)
        if held is None:
            newest[vehicle.entity_id] = vehicle
            continue
        drops[DROP_DUPLICATE_ENTITY] += 1
        if vehicle.observed_at > held.observed_at:
            newest[vehicle.entity_id] = vehicle
    return tuple(newest.values())


class GtfsRtCoolingDownError(RateLimitedError):
    """Raised instead of calling a host that has asked us to stay away, or is inside its floor.

    Same shape as ``AdsbCoolingDownError``: the cooldown is checked before the request rather
    than after it, so a throttled host gets silence rather than one more call it has to refuse.
    """


@dataclass(frozen=True, slots=True)
class SweepResult:
    """One pass over the registry: what came back, what did not, and why.

    ``unchanged`` is separated from ``polled`` on purpose. A host answering **304 Not
    Modified** with a zero-byte body has told us its held records still stand, which is not the
    same as a feed returning nothing. Collapsing the two would let a working conditional
    request empty the store, so the caller must leave an unchanged feed's records alone.
    """

    records: tuple[TransitVehicle, ...]
    drops: Counter[str]
    polled: int
    unchanged: int
    skipped: int
    failures: dict[str, str]

    @property
    def failed(self) -> int:
        """How many feeds this pass could not read at all."""
        return len(self.failures)


class GtfsRtClient:
    """Reads vehicle positions from the committed registry, one host at a time.

    **The rate discipline is per host and it has to be**, because the registry is nothing like
    evenly distributed: 52 hosts serve 258 feeds and 99 of them sit on ``www.data.gouv.fr``. A
    per-feed floor multiplies by whatever a host happens to publish, so a polite 30-second
    cadence becomes 3.3 requests a second at one public-sector operator. Feeds on one host are
    therefore walked in sequence by a single task while hosts run concurrently, and a host's
    floor gates the whole pass rather than each feed in it.

    Every piece of that state goes through :class:`~tracker.cache.DiskCache`, for the reason
    already recorded against CelesTrak and adsb.lol: in-memory rate state does not survive a
    restart, and a restart loop is indistinguishable from hammering as far as the host is
    concerned. Validators are cached for the same reason they exist: 33 of 39 feeds offering
    one answered 304 with a zero-byte body when it was sent back, so roughly 55% of this
    layer's traffic is avoidable for free.

    Freshness is never tested with a HEAD. That is the FAA lesson in ``AGENTS.md``, where a
    HEAD returns 503 and a decoy ``Last-Modified`` from 2013 while a GET returns the file.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        cache: DiskCache | None = None,
        clock: Callable[[], datetime] = _utc_now,
        feeds: tuple[TransitFeed, ...] = FEEDS,
    ) -> None:
        self._client = client
        self._cache = cache
        self._clock = clock
        self._feeds = feeds
        self._not_before: dict[str, datetime] = {}
        self._validators: dict[str, tuple[str | None, str | None]] = {}

    @property
    def feeds(self) -> tuple[TransitFeed, ...]:
        """The registry this client polls. Injectable so a test can hold one feed."""
        return self._feeds

    def _host_key(self, host: str) -> str:
        return cache_key(CACHE_NAMESPACE, "host", host)

    def not_before(self, host: str) -> datetime | None:
        """When this host may next be called, read from disk so a restart honours it."""
        if self._cache is not None:
            held = self._cache.get_time(self._host_key(host))
            if held is not None:
                return held
        return self._not_before.get(host)

    def _hold_host(self, host: str, until: datetime) -> None:
        """Hold a host until at least ``until``. A hold only ever extends, never shortens.

        The ``max`` is the whole point. A host that answered 429 asking for ten minutes must
        not have that shortened to the ordinary floor by the next thing that touches it, and
        the two paths do both fire: the throttling response sets the long hold and the pass
        that provoked it sets the short one on its way out.
        """
        held = self._not_before.get(host)
        if self._cache is not None:
            stored = self._cache.get_time(self._host_key(host))
            if stored is not None and (held is None or stored > held):
                held = stored
        if held is not None and held > until:
            return
        self._not_before[host] = until
        if self._cache is not None:
            self._cache.set_time(self._host_key(host), until)

    def _require_host_ready(self, host: str) -> None:
        """Raise rather than call a host inside its floor or its backoff."""
        now = self._clock()
        held = self.not_before(host)
        if held is not None and now < held:
            raise GtfsRtCoolingDownError(host, 0, max((held - now).total_seconds(), 1.0))

    def _validator(self, feed: TransitFeed) -> tuple[str | None, str | None]:
        """The ``ETag`` and ``Last-Modified`` last seen for this feed, if any."""
        if self._cache is not None:
            entry = self._cache.get(cache_key(CACHE_NAMESPACE, "etag", feed.feed_id))
            stamp = self._cache.get(cache_key(CACHE_NAMESPACE, "lastmod", feed.feed_id))
            return (
                entry.value if entry is not None else None,
                stamp.value if stamp is not None else None,
            )
        return self._validators.get(feed.feed_id, (None, None))

    def _remember_validator(self, feed: TransitFeed, response: httpx.Response) -> None:
        """Keep whatever validator the host offered, so the next call can be conditional."""
        etag = response.headers.get("etag")
        last_modified = response.headers.get("last-modified")
        self._validators[feed.feed_id] = (etag, last_modified)
        if self._cache is None:
            return
        if etag:
            self._cache.set(cache_key(CACHE_NAMESPACE, "etag", feed.feed_id), etag)
        if last_modified:
            self._cache.set(cache_key(CACHE_NAMESPACE, "lastmod", feed.feed_id), last_modified)

    async def _request(self, feed: TransitFeed) -> ParsedRecords[TransitVehicle] | None:
        """One conditional GET, with no floor logic. ``None`` means Not Modified.

        Separate from :meth:`fetch` because the floor is a property of the host and a host
        publishes many feeds. Applying it per request would let a host with 99 feeds refresh
        exactly one of them per floor window, so each feed would update every three hours.
        """
        headers: dict[str, str] = {}
        etag, last_modified = self._validator(feed)
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified

        response = await self._client.get(feed.url, headers=headers)

        if response.status_code in RATE_LIMIT_STATUS_CODES:
            backoff = retry_after_seconds(response)
            self._hold_host(feed.host, self._clock() + timedelta(seconds=backoff))
            raise RateLimitedError(feed.host, response.status_code, backoff)

        if response.status_code == httpx.codes.NOT_MODIFIED:
            return None

        response.raise_for_status()
        self._remember_validator(feed, response)
        return parse_records(response.content, feed=feed, now=self._clock())

    async def fetch(self, feed: TransitFeed) -> ParsedRecords[TransitVehicle] | None:
        """Read one feed on its own, honouring its host's floor. ``None`` means Not Modified.

        This is the demand-driven path, for a caller that wants one feed now. A sweep does not
        route through here, because a sweep already holds the host once for the whole pass.

        Raises :class:`GtfsRtCoolingDownError` if the host is inside its floor or a backoff,
        and :class:`~tracker.sources.base.RateLimitedError` if the host says so on this call.
        """
        self._require_host_ready(feed.host)
        try:
            return await self._request(feed)
        finally:
            self._hold_host(feed.host, self._clock() + timedelta(seconds=feed.min_interval_seconds))

    async def _sweep_host(self, feeds: tuple[TransitFeed, ...]) -> SweepResult:
        """Walk one host's feeds in sequence, then hold the host for its floor.

        **The floor gates the pass, not each request in it.** One host is never called in
        parallel with itself, which is what keeps a 99-feed operator from taking 99 concurrent
        connections, and serialising is the only spacing needed: per-feed latency measured
        0.20s at the median, so that host's pass takes about twenty seconds and then waits out
        two minutes. That is 0.83 requests a second averaged, against 3.3 if the floor had
        been applied per feed at the default cadence.

        A throttling response ends the pass for that host immediately. It has just told us to
        stop, and working through its remaining 98 feeds to hear it 98 more times is the
        behaviour the backoff exists to prevent.
        """
        host = feeds[0].host
        try:
            self._require_host_ready(host)
        except GtfsRtCoolingDownError:
            return SweepResult(
                records=(),
                drops=Counter(),
                polled=0,
                unchanged=0,
                skipped=len(feeds),
                failures={},
            )

        records: list[TransitVehicle] = []
        drops: Counter[str] = Counter()
        failures: dict[str, str] = {}
        polled = unchanged = skipped = 0
        floor = max(feed.min_interval_seconds for feed in feeds)
        try:
            for index, feed in enumerate(feeds):
                try:
                    parsed = await self._request(feed)
                except RateLimitedError as exc:
                    failures[feed.feed_id] = describe_exception(exc)
                    skipped += len(feeds) - index - 1
                    break
                except (httpx.HTTPError, ContractViolationError) as exc:
                    failures[feed.feed_id] = describe_exception(exc)
                    continue
                if parsed is None:
                    unchanged += 1
                    continue
                polled += 1
                records.extend(parsed.records)
                drops.update(parsed.drops)
        finally:
            self._hold_host(host, self._clock() + timedelta(seconds=floor))
        return SweepResult(
            records=tuple(records),
            drops=drops,
            polled=polled,
            unchanged=unchanged,
            skipped=skipped,
            failures=failures,
        )

    async def sweep(self) -> SweepResult:
        """One pass over every feed in the registry, hosts concurrently and feeds serially.

        Measured shape on 2026-08-23: 553 candidate URLs in 54.9 seconds at 16 concurrent, and
        the registry is smaller than that. Per-feed latency was 0.03s minimum, 0.20s median and
        1.40s worst, so a host with 99 feeds takes roughly 20 seconds to walk and then waits
        out its floor.

        One dead agency never fails the pass. Failures are counted per feed and returned, so
        ``/api/layers`` can say which feeds are down instead of reporting a healthy layer with
        a quietly missing city.
        """
        by_host: dict[str, list[TransitFeed]] = {}
        for feed in self._feeds:
            by_host.setdefault(feed.host, []).append(feed)
        passes = await asyncio.gather(
            *(self._sweep_host(tuple(group)) for group in by_host.values())
        )
        records: list[TransitVehicle] = []
        drops: Counter[str] = Counter()
        failures: dict[str, str] = {}
        polled = unchanged = skipped = 0
        for result in passes:
            records.extend(result.records)
            drops.update(result.drops)
            failures.update(result.failures)
            polled += result.polled
            unchanged += result.unchanged
            skipped += result.skipped
        return SweepResult(
            records=tuple(records),
            drops=drops,
            polled=polled,
            unchanged=unchanged,
            skipped=skipped,
            failures=failures,
        )


def merge_key(vehicle: TransitVehicle) -> str:
    """The store key for one vehicle: ``feed_id`` and ``entity_id``, never ``vehicle_id``.

    See :mod:`tracker.contracts.transit` for the measurements. The short version is that
    ``vehicle.id`` alone put 35.9% of vehicles on an id another agency was also using, and
    14.7% of vehicles do not carry one at all.
    """
    return f"{vehicle.feed_id}/{vehicle.entity_id}"


def fix_time(vehicle: TransitVehicle) -> datetime:
    """When the position was actually measured, for the store's newer-wins guard.

    ``observed_at`` already is that instant, so this exists to be handed to
    :class:`~tracker.services.store.EntityStore` as its ``fix_time`` rather than to compute
    anything. Without it the store takes whatever it is handed last, and a feed re-serving a
    stale fix walks a bus backwards, which is the defect already recorded against vessels.
    """
    return vehicle.observed_at
