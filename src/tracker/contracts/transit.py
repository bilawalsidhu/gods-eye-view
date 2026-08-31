"""One public-transport vehicle, from a GTFS-Realtime ``VehiclePosition``.

**The identity is a composite and that is not a style choice.** Measured across 247 answering
feeds on 2026-08-23: 14,103 vehicles carried a ``vehicle.vehicle.id``, and those resolved to
only 10,879 distinct strings. 1,901 id values were in use by more than one agency, so **35.9%
of every id-carrying vehicle sat on a colliding id**. ``'557'`` and ``'801'`` were each in use
by nine different operators, and 936 distinct ids were three characters or shorter. Keying a
global layer on ``vehicle.id`` alone would have silently collapsed 3,224 vehicles into other
vehicles, which is one bus swallowing another and no test noticing.

The GTFS-Realtime best practices document never promised otherwise. It says
``vehicle.vehicle.id`` "should uniquely and stably identify a vehicle over the entire trip
duration": within one feed, for the length of one trip.

So the key is ``(feed_id, entity_id)``, and ``entity_id`` is ``FeedEntity.id`` rather than
``vehicle.vehicle.id`` for a second measured reason: **14.7% of vehicles carry no
``vehicle.id`` at all**, so keying on it discards 2,432 records rather than merging them
wrongly. Every one of the 16,535 vehicles measured carried a ``FeedEntity.id``, and the
reference makes that field unique within a feed by definition. Candidates, measured:

===========================================  =======  ========  ==========  =========
key                                          records  distinct  cross-feed  collapsed
===========================================  =======  ========  ==========  =========
``vehicle.vehicle.id``                        14,103    10,879       1,901      3,224
``FeedEntity.id``                             16,535    13,753       1,557      2,782
``(feed_id, vehicle.vehicle.id)``             14,103    14,019           0         84
``(feed_id, FeedEntity.id)``                  16,535    16,468           0         67
===========================================  =======  ========  ==========  =========

``trip_id`` reaches zero collapses and is still wrong to key on: a vehicle between trips has
no ``trip_id``, so the key would change several times a day and make one physical bus into
several entities. The 67 residual collapses are feeds breaking their own spec, and they are
dropped and counted rather than designed around.

**This is not the ADR 010 union case.** ADR 010 merges providers reporting the same physical
object, which is why aircraft merge on ICAO address and vessels on MMSI. Here each feed is the
sole publisher of its own vehicles and no two agencies report the same bus, so ``feed_id`` is
part of the identity rather than provenance, and there is no cross-provider recency contest.
There is deliberately no ``providers`` tuple on this contract.
"""

from typing import Literal

from pydantic import Field

from tracker.contracts.base import Bearing, StrictModel, UtcDatetime
from tracker.contracts.geo import Point

MAX_PLAUSIBLE_SPEED_MS: float = 50.0
"""Above this a reported speed is not believed, and the field is left empty.

The reference says ``speed`` is "momentary speed measured by the vehicle, in meters per
second". Four feeds disagreed on 2026-08-23: Sofia (9 vehicles), Keretapi Tanah Melayu (7),
Rome (4) and Toulon Provence Mediterranee (1) all reported above 50, which would be 180 km/h
for a city bus and is almost certainly km/h in a metres-per-second field. Nothing in the
payload declares the unit, so an out-of-range reading is dropped rather than converted: a
guessed division is a fabricated value, and only 39.9% of vehicles carry speed at all.
"""


class TransitVehicle(StrictModel):
    """A bus, tram, train or ferry at a moment, as one feed reported it.

    Frozen and strict like every other domain contract here. Required fields are only the
    ones without which the record is worthless: an identity, a place, a time, and the licence
    that lets us show it at all.
    """

    kind: Literal["transit"] = "transit"

    feed_id: str = Field(
        min_length=1,
        max_length=64,
        description="Which feed published this, as the committed registry names it. Half of "
        "the merge key, and the half that stops two agencies' bus number 1 becoming one bus.",
    )
    entity_id: str = Field(
        min_length=1,
        max_length=200,
        description="``FeedEntity.id``, unique within its feed by specification. The other "
        "half of the merge key. Present on 16,535 of 16,535 vehicles measured, which is why "
        "it is required here while vehicle_id is not.",
    )

    point: Point = Field(
        description="Where the vehicle is, longitude first. GTFS-Realtime sends latitude "
        "first as separate Position.latitude and Position.longitude floats, so the adapter "
        "flips. altitude_m is left unset: the feed reports none and inventing ground level "
        "would be a fabricated value."
    )
    observed_at: UtcDatetime = Field(
        description="When the position was measured, not when we fetched it. POSIX seconds "
        "on every feed measured, with no millisecond variant anywhere, which is the opposite "
        "of ADS-B where adsb.lol is milliseconds and adsb.fi is seconds under the same field "
        "name. Checked on 2026-08-23 across 247 feeds and recorded so the next reader does "
        "not assume the ADS-B trap applies here.",
    )
    timestamp_basis: Literal["vehicle", "feed"] = Field(
        description="Which clock observed_at came from. ``vehicle`` is the record's own "
        "VehiclePosition.timestamp, true for 99.2% of vehicles. ``feed`` means the record "
        "carried none and the FeedHeader timestamp was used instead, which dates every "
        "vehicle in that message to the same instant and is a weaker claim. The card says "
        "which, because a rider told the bus is 'now' when the feed only knows the batch is "
        "'now' has been told something the source did not say.",
    )
    position_age_s: float = Field(
        ge=0.0,
        description="Seconds between the fix and the sweep that read it. Present for the "
        "same reason it is on the vessel contract: a frozen feed is the hardest failure to "
        "see. Sixteen feeds returned identical positions ten minutes apart on 2026-08-23 "
        "with HTTP 200, and one of them had a newest record 908 days old.",
    )

    source: str = Field(
        min_length=1,
        max_length=120,
        description="The operator that published the feed, for the card and the credit.",
    )
    licence: str = Field(
        min_length=1,
        max_length=60,
        description="The licence this record travels under, e.g. ``ODbL 1.0``. Required, not "
        "optional: this project drops an item whose licence cannot be determined, so a "
        "record that reached the contract has one, and it has to reach the card rather than "
        "living only on the layer.",
    )
    country: str = Field(
        pattern=r"^[A-Z]{2}$",
        description="ISO 3166-1 alpha-2, from the registry rather than from the feed. The "
        "Mobility Database's own country column is wrong on the largest feed in the set, so "
        "the registry's values were checked against the vehicles' measured positions and "
        "corrected. See sources/gtfsrt.py.",
    )

    vehicle_id: str | None = Field(
        default=None,
        max_length=200,
        description="The operator's own vehicle number. Present on 85.3% of vehicles and "
        "never a key here, for the reason in this module's docstring. A display and "
        "diagnostic field only.",
    )
    vehicle_label: str | None = Field(
        default=None,
        max_length=200,
        description="The number shown to riders on the vehicle, present on 76.9%. Often "
        "differs from vehicle_id, which is the internal fleet number.",
    )
    route_id: str | None = Field(
        default=None,
        max_length=200,
        description="Route as the operator's static GTFS names it, present on 80.7%. Not a "
        "route name: resolving it needs that operator's routes.txt, which we do not fetch.",
    )
    trip_id: str | None = Field(
        default=None,
        max_length=200,
        description="The scheduled trip being run, present on 90.5%. Absent between trips, "
        "which is exactly why it is not part of the merge key.",
    )

    bearing: Bearing | None = Field(
        default=None,
        description="Degrees clockwise from true north, matching the reference and this "
        "project's convention. Normalised in the adapter: 470 vehicles reported a negative "
        "bearing and 18 reported exactly 360.0 on 2026-08-23, so a strict 0 <= x < 360 field "
        "fed the raw value would reject 490 real records. Exact 360.0 maps to None, the same "
        "treatment Digitraffic's cog of 360.0 already gets.",
    )
    speed_ms: float | None = Field(
        default=None,
        ge=0.0,
        le=MAX_PLAUSIBLE_SPEED_MS,
        description="Metres per second, present on 39.9% and believed only below "
        "MAX_PLAUSIBLE_SPEED_MS. See that constant for the four feeds that made the bound "
        "necessary.",
    )
    occupancy: str | None = Field(
        default=None,
        max_length=40,
        description="How full the vehicle is, as the GTFS-Realtime OccupancyStatus enum "
        "names it, e.g. ``MANY_SEATS_AVAILABLE``. Present on 18.3%.",
    )
