"""One ocean observing station and the measurements it last transmitted.

**The identity is the station id, and this contract exists because the obvious NOAA feed
fails that test.** ``docs/status.md`` records the near miss: NOAA's Voluntary Observing Ship
reports are keyless and global and carry **nine distinct ship identifiers across 9,211
observations**, eight buoy numbers and the literal string ``SHIP``. Under ADR 010's merge rule
every one of those 9,211 reports would have collapsed into nine records, and the
one-record-per-key test would have passed while swallowing the feed.

The National Data Buoy Center's own station feed does not have that problem, measured rather
than assumed. ``latest_obs.txt`` on 2026-08-24 carried **890 rows and 890 distinct station
ids, zero duplicates**, and every one of the 890 resolved into the 1,351-station metadata
document. So a station id is a real identity: it names one moored hull or one fixed platform,
it is stable across reports, and no two stations share one.

**"Buoy" is the ask and "station" is what the feed actually publishes**, so the contract says
station and the card says which kind. Of the 890 stations reporting on 2026-08-24, **310 were
moored buoys**, 542 were fixed coastal or lake stations, 24 were oil platforms with automatic
weather stations on them, 13 were other, and 1 was an uncrewed surface vehicle. Calling all
890 buoys would be a fabricated claim about 580 of them, so :attr:`BuoyObservation.station_type`
carries the provider's own word and a viewer filtering for hulls in the water can.

**Every measurement carries its unit in its own field name, and two of the source's fields are
converted here rather than downstream.** NDBC publishes visibility in nautical miles and tide
in feet, which is exactly the class of thing this project's geospatial rules say must be
converted in the adapter: ``sources/ndbc.py`` does it, and the names below are what came out.
"""

from typing import Final, Literal

from pydantic import Field

from tracker.contracts.base import Bearing, StrictModel, UtcDatetime
from tracker.contracts.geo import Point

MAX_WIND_SPEED_MS: Final = 120.0
"""Above this a reported wind speed is not believed and the field is left empty.

The highest surface wind ever measured is about 113 m/s (Barrow Island, 1996). The observed
range across 653 reporting stations on 2026-08-24 was 0.0 to 33.0 m/s, so this bound refuses
nothing real and exists to stop a corrupted digit being drawn as weather.
"""

MAX_WAVE_HEIGHT_M: Final = 40.0
"""Above this a significant wave height is refused. The largest ever recorded is about 30m.

Measured range on 2026-08-24 across 239 reporting stations: 0.0m to 3.2m.
"""

MAX_WAVE_PERIOD_S: Final = 40.0
"""Above this a wave period is refused. Measured range 0.0s to 26.0s across 198 stations."""

MIN_PRESSURE_HPA: Final = 800.0
MAX_PRESSURE_HPA: Final = 1100.0
"""Sea-level pressure bounds. The extremes ever recorded are 870 hPa (Typhoon Tip) and
1085 hPa (Agata, Siberia). Measured range on 2026-08-24: 991.5 to 1025.5 hPa.
"""

MAX_PRESSURE_TENDENCY_HPA: Final = 50.0
"""Bound on the three-hour pressure change, either direction. Measured: -2.8 to +1.8 hPa."""

MIN_TEMPERATURE_C: Final = -80.0
MAX_TEMPERATURE_C: Final = 60.0
"""Air, sea and dew-point bounds. Measured on 2026-08-24: air -17.8 to 37.0, sea 7.6 to 35.0."""

MAX_VISIBILITY_M: Final = 100_000.0
"""Bound on visibility after the nautical-mile conversion. 27.0 nmi was the measured maximum,
which is 50,004 metres, and NDBC's own field is capped well below this.
"""

MAX_TIDE_M: Final = 20.0
"""Bound on water level either side of the station datum, after the feet conversion.

Measured range on 2026-08-24 was -0.40ft to 2.66ft, which is -0.12m to 0.81m. The bound is
generous because the Bay of Fundy runs to 16m and a station there is in range of this feed.
"""

type StationType = Literal["buoy", "fixed", "oilrig", "dart", "tao", "usv", "other"]
"""The provider's own classification of the hull or platform, passed through unchanged.

Seven values, taken from the ``type`` attribute of NDBC's station metadata document rather
than invented here. ``dart`` is a tsunami-detection mooring, ``tao`` a tropical-atmosphere
array mooring, ``usv`` an uncrewed surface vehicle. A station whose type the metadata does not
give is left empty rather than defaulted to ``other``, because ``other`` is a value the
provider itself uses and borrowing it would put words in the provider's mouth.
"""


class BuoyObservation(StrictModel):
    """One station's position and its most recent transmitted measurements.

    Frozen and strict like every other domain contract here. Required fields are only the
    ones without which the record is worthless: an identity, a place, a time, and the licence
    that lets us show it at all. Every measurement is optional, because **no station reports
    all of them**: the measured distribution on 2026-08-24 across 890 stations was 40 stations
    reporting one measurement, 242 reporting five, and a maximum of eleven. Not one station
    reported zero, which is why a row carrying nothing is treated as a fault rather than as a
    quiet station.
    """

    kind: Literal["buoy"] = "buoy"

    station_id: str = Field(
        min_length=1,
        max_length=32,
        description="The provider's station identifier, upper-cased. The merge key, and the "
        "whole reason this layer exists rather than the NOAA ship feed: 890 rows carried 890 "
        "distinct ids on 2026-08-24 where the ship feed carried nine across 9,211 reports. "
        "Five characters on 876 of the 890 and four on the other 14, mixing digits and "
        "letters, e.g. ``41001`` and ``AGXC1``.",
    )
    point: Point = Field(
        description="Where the station is, longitude first. The source publishes latitude "
        "first in fixed columns, so the adapter flips. Taken from the observation row rather "
        "than from the station metadata, because a DART, TAO or uncrewed-vehicle station "
        "moves and the row is what carries its position now. altitude_m is left unset: a "
        "station's elevation above the ellipsoid is not what the feed publishes and the sea "
        "surface is not a number this project may invent."
    )
    observed_at: UtcDatetime = Field(
        description="When the station made the measurement, not when we fetched it. The "
        "source publishes it as five separate integer columns in UTC, which the adapter "
        "assembles. There is no epoch anywhere in this feed, so none of the "
        "seconds-versus-milliseconds traps on the ADS-B and AIS feeds apply here.",
    )
    observation_age_s: float = Field(
        ge=0.0,
        description="Seconds between the measurement and the poll that read it. Named for "
        "the observation rather than the position, unlike the vessel and transit contracts, "
        "because a moored station does not move: an hour-old reading is an hour-old sea "
        "temperature at a place we still know exactly. Measured on 2026-08-24 across 890 "
        "stations: median 2,760s, p90 5,340s, worst 11,340s. That is not staleness, it is "
        "what hourly reporting looks like, and the card shows the number rather than "
        "implying the reading is current.",
    )

    station_type: StationType | None = Field(
        default=None,
        description="What kind of station this is, in the provider's own words. Empty when "
        "the metadata document does not list the station. See :data:`StationType`: 310 of "
        "890 reporting stations were moored buoys on 2026-08-24 and the rest were not, so "
        "this is the field that stops the layer claiming 890 buoys.",
    )
    name: str | None = Field(
        default=None,
        max_length=200,
        description="The station's published name, e.g. ``Sevenstones Lightship``. From the "
        "metadata document, absent when the station is not listed there.",
    )
    owner: str | None = Field(
        default=None,
        max_length=200,
        description="Who operates the station, e.g. ``UK Met Office``. 105 distinct owners "
        "across the metadata document. Shown on the card because a reading from a national "
        "meteorological service and a reading from an oil platform's own automatic weather "
        "station are not the same claim.",
    )
    programme: str | None = Field(
        default=None,
        max_length=200,
        description="The observing programme the station belongs to, e.g. ``International "
        "Partners``. British spelling here, ``pgm`` upstream.",
    )

    source: str = Field(
        min_length=1,
        max_length=120,
        description="The organisation that published this record, for the card and the "
        "credit. The publisher, not the station owner: NDBC republishes readings from 105 "
        "owners and those two facts are different.",
    )
    licence: str = Field(
        min_length=1,
        max_length=60,
        description="The licence this record travels under. Required, not optional: this "
        "project drops an item whose licence cannot be determined, so a record that reached "
        "the contract has one and it has to reach the card.",
    )

    wind_direction_deg: Bearing | None = Field(
        default=None,
        description="Where the wind is blowing **from**, degrees clockwise from true north. "
        "Present on 70.1% of stations. **The source counts 1 to 360 with 360 meaning north "
        "and never sends 0**, which is the opposite of its own wave-direction column in the "
        "same row: 624 readings ranged 10.0 to 360.0 with thirteen at exactly 360 and not "
        "one at zero. Applying this project's existing 'exactly 360 is a not-available "
        "sentinel' rule from the AIS feeds would silently throw away thirteen real "
        "north-wind readings, so the adapter maps 360 to 0.0 instead.",
    )
    wind_speed_ms: float | None = Field(
        default=None,
        ge=0.0,
        le=MAX_WIND_SPEED_MS,
        description="Metres per second, averaged over the station's own averaging period. "
        "Present on 73.4%. Already metric upstream, so no conversion.",
    )
    gust_ms: float | None = Field(
        default=None,
        ge=0.0,
        le=MAX_WIND_SPEED_MS,
        description="Peak gust in metres per second, present on 61.1%.",
    )

    wave_height_m: float | None = Field(
        default=None,
        ge=0.0,
        le=MAX_WAVE_HEIGHT_M,
        description="Significant wave height in metres, the mean of the highest third. "
        "Present on 26.9%, because most of the 890 stations are coastal or lake stations "
        "with no wave sensor.",
    )
    dominant_wave_period_s: float | None = Field(
        default=None,
        ge=0.0,
        le=MAX_WAVE_PERIOD_S,
        description="Seconds between crests at the frequency carrying the most energy. "
        "Present on 22.2%.",
    )
    average_wave_period_s: float | None = Field(
        default=None,
        ge=0.0,
        le=MAX_WAVE_PERIOD_S,
        description="Mean seconds between crests across all frequencies. Present on 17.8%.",
    )
    wave_direction_deg: Bearing | None = Field(
        default=None,
        description="Where the dominant waves are coming from, degrees clockwise from true "
        "north. Present on 20.4%. **This column counts 0 to 359 while the wind-direction "
        "column in the same row counts 1 to 360**: 182 readings ranged 0.0 to 357.0 with one "
        "at exactly zero and none at 360. Two conventions, one 22-column row, nothing in the "
        "file declaring either.",
    )

    pressure_hpa: float | None = Field(
        default=None,
        ge=MIN_PRESSURE_HPA,
        le=MAX_PRESSURE_HPA,
        description="Sea-level pressure in hectopascals, present on 70.2%.",
    )
    pressure_tendency_hpa: float | None = Field(
        default=None,
        ge=-MAX_PRESSURE_TENDENCY_HPA,
        le=MAX_PRESSURE_TENDENCY_HPA,
        description="Change in pressure over the last three hours, signed, present on 11.1%. "
        "Negative means falling. Not an absolute pressure and never rendered as one.",
    )
    air_temperature_c: float | None = Field(
        default=None,
        ge=MIN_TEMPERATURE_C,
        le=MAX_TEMPERATURE_C,
        description="Air temperature in degrees Celsius, present on 51.2%.",
    )
    water_temperature_c: float | None = Field(
        default=None,
        ge=MIN_TEMPERATURE_C,
        le=MAX_TEMPERATURE_C,
        description="Sea surface temperature in degrees Celsius, present on 56.7%.",
    )
    dew_point_c: float | None = Field(
        default=None,
        ge=MIN_TEMPERATURE_C,
        le=MAX_TEMPERATURE_C,
        description="Dew point in degrees Celsius, present on 31.3%.",
    )

    visibility_m: float | None = Field(
        default=None,
        ge=0.0,
        le=MAX_VISIBILITY_M,
        description="Horizontal visibility in metres, present on 4.8%. **The source "
        "publishes nautical miles** and the adapter multiplies by 1852, the same rule that "
        "makes an ADS-B feed sending feet convert in its own adapter and never downstream.",
    )
    water_level_m: float | None = Field(
        default=None,
        ge=-MAX_TIDE_M,
        le=MAX_TIDE_M,
        description="Water level above or below the station's own datum, in metres, present "
        "on 4.2%. **The source publishes feet** and the adapter multiplies by 0.3048. Named "
        "for water level rather than for tide, which is what the upstream column is called, "
        "because the reading is a level against a local datum and not a tidal prediction.",
    )

    @property
    def measurement_count(self) -> int:
        """How many of the fourteen measurements this station actually transmitted.

        A plain property rather than a computed field, per the note on ``StrictModel``: a
        before-validator or computed field on a strict model breaks JSON round-tripping for
        every contract in the app.

        Worth having because the spread is wide and it is the number that says how much of a
        card will be empty. Measured on 2026-08-24: 40 stations at one, 242 at five, 21 at
        eleven, and none at zero.
        """
        return sum(
            value is not None
            for value in (
                self.wind_direction_deg,
                self.wind_speed_ms,
                self.gust_ms,
                self.wave_height_m,
                self.dominant_wave_period_s,
                self.average_wave_period_s,
                self.wave_direction_deg,
                self.pressure_hpa,
                self.pressure_tendency_hpa,
                self.air_temperature_c,
                self.water_temperature_c,
                self.dew_point_c,
                self.visibility_m,
                self.water_level_m,
            )
        )
