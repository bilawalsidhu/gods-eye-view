"""The vessel domain contract.

Modelled from live Fintraffic Digitraffic AIS responses captured on 2026-08-19, not from
documentation. Two endpoints on the same API version feed one vessel: positions come from
``/api/ais/v1/locations`` (1,058 features in the captured body, sliced to 110 in
``tests/fixtures/digitraffic_ais_locations_live.json``) and static data from
``/api/ais/v1/vessels`` (950 records, sliced to 93 in
``tests/fixtures/digitraffic_ais_vessels_live.json``). They join on MMSI, and the join is
not total: 1,058 positions against 950 metadata records, so 108 vessels had a position and
no name. A vessel with a position and nothing else is normal, which is why ``mmsi``,
``point``, ``observed_at``, ``position_age_s`` and ``source`` are the only required fields.

Availability in that sample, before anything here is marked required. Every key was present
on every record and nothing was ever ``null``, so the interesting number is how many carried
a sentinel meaning "not available":

- Position body, out of 1,058: ``cog`` 360.0 on 110 (and a legitimate 0.0 on 37), ``sog``
  102.3 on 9, ``heading`` 511 on 184, ``rot`` -128 on 184, ``navStat`` 15 on 47.
- Static body, out of 950: ``imo`` 0 on 322, ``draught`` 0 on 116, ``eta`` unusable on 238
  (1596 on 198 and 0 on 38), ``callSign`` an empty string on 5, ``destination`` an empty
  string on 91. Missing text arrives as ``""`` rather than ``null``, so the adapter maps
  empty to ``None`` and no text field here carries ``min_length=1``.

Sentinels are part of the AIS standard rather than one provider's quirk, so aisstream.io,
AISHub and the Kystverket NMEA feed carry the same ones. They are named constants below and
the adapter maps every one of them to ``None`` **before** validating a range, because
``cog`` 360.0 is not-available while ``cog`` 0.0 is a real course due north: a bearing check
applied first rejects 110 real vessels and looks like thin coverage rather than a bug.

Units differ between endpoints of the same provider, so conversion is per endpoint in the
adapter and never downstream: ``draught`` is decimetres on ``/api/ais/v1/vessels`` (int, 49
is 4.9 m) and metres on ``/api/port-call/v1/vessel-details`` (float, 8.15). Speed over
ground is knots on every AIS feed and metres per second here, via
``geo.KNOTS_TO_METRES_PER_SECOND``.

**MMSI is the merge key under ADR 010 and the live feed carries two kinds of MMSI that
break it.** Both pass a one-record-per-MMSI test while being wrong, so both are refused
here rather than left to a store.

- **Placeholders.** A real record on the live feed reads ``{"mmsi": 999999999, "name":
  "NATO WARSHIP"}``. 999 is not an allocated ITU MID, so every ship using that placeholder
  merges into one record: the count looks right, the duplicate assertion passes, and ships
  disappear. Such a record is **dropped and counted**, not kept under a generated key. A
  generated key would churn on every poll, drawing a new pin each cycle and never merging
  by recency, which is a worse lie than an honest drop. We cannot establish the identity,
  so we do not render the vessel.
- **Aircraft.** MMSI 111265583 and 111265584 on the live feed are "LIFEGUARD 003" and
  "LIFEGUARD 004", callsigns SE JRJ and SE JRK, ``shipType`` 51, one of them doing 36
  knots. ``111`` is the ITU allocation for search-and-rescue aircraft. They are dropped and
  counted too: a 36-knot vessel is exactly what a viewer notices, and they have no ICAO
  24-bit address so they cannot become an :class:`~tracker.contracts.aircraft.Aircraft`
  either.

Both fall out of one rule, :func:`mmsi_category` over the ITU-R M.585 prefix table, so
neither value is special-cased. Only a ship-station MMSI reaches the domain; the reason for
every other drop is named in the validation error the adapter counts.
"""

from enum import StrEnum
from typing import Annotated, Final, Literal, Self

from pydantic import AfterValidator, Field, ValidationError

from tracker.contracts.base import Bearing, StrictModel, UtcDatetime
from tracker.contracts.geo import KNOTS_TO_METRES_PER_SECOND, Point

# ---------------------------------------------------------------- AIS sentinels
#
# Every constant here is a value the wire uses to mean "not available". None of them is a
# null and none of them is absent from the payload. Each maps to None in the adapter.

AIS_COG_NOT_AVAILABLE: Final = 360.0
"""Course over ground unavailable, in degrees. 110 of 1,058 live records on 2026-08-19."""

AIS_COG_NOT_AVAILABLE_SCALED: Final = 3600
"""The same sentinel in tenths of a degree, which is what AISHub ``format=0`` sends."""

AIS_SOG_NOT_AVAILABLE: Final = 102.3
"""Speed over ground unavailable, in knots. 9 of 1,058 live records on 2026-08-19.

Treat any value **at or above** this as unavailable. ITU-R M.1371 encodes it as 1023 in
tenths of a knot, and ``AGENTS.md`` records AISHub sending 102.4, one tenth higher. No
vessel does 102 knots, so the inequality covers both readings with one constant.
"""

AIS_SOG_NOT_AVAILABLE_SCALED: Final = 1023
"""The same sentinel in tenths of a knot, for AISHub ``format=0``. Also read as at-or-above."""

AIS_HEADING_NOT_AVAILABLE: Final = 511
"""True heading unavailable. 184 of 1,058 live records on 2026-08-19."""

AIS_ROT_NOT_AVAILABLE: Final = -128
"""Rate of turn unavailable. 184 of 1,058 live records on 2026-08-19."""

AIS_ROT_TURNING_RIGHT_NO_RATE: Final = 127
"""Turning right faster than 5 degrees per 30 seconds, with no rate given.

Not a rate, so it does not become one. Running it through the ROT_AIS conversion would
publish 709 degrees per minute, which no vessel does and no receiver reported.
"""

AIS_ROT_TURNING_LEFT_NO_RATE: Final = -127
"""Turning left faster than 5 degrees per 30 seconds, with no rate given."""

AIS_NAV_STATUS_UNDEFINED: Final = 15
"""Navigational status undefined. 47 of 1,058 live records on 2026-08-19."""

AIS_ETA_NOT_AVAILABLE: Final = 1596
"""The packed ETA meaning month 0, day 0, hour 24, minute 60.

The single most common value in the static body: 198 of 950 records, with ``eta`` 0 on 38
more and 238 in total unusable.
"""

AIS_IMO_NOT_AVAILABLE: Final = 0
"""IMO number unavailable. 322 of 950 live records, a third of the feed."""

AIS_SHIP_TYPE_NOT_AVAILABLE: Final = 0
"""Ship and cargo type unavailable."""

AIS_DRAUGHT_NOT_AVAILABLE: Final = 0
"""Draught unavailable. 116 of 950 live records."""

AIS_ROT_SCALE: Final = 4.733
"""ROT_AIS is ``4.733 * sqrt(degrees per minute)``, signed, per ITU-R M.1371."""

AIS_ROT_MAX_DEG_PER_MIN: Final = 710.0
"""Bound on a decoded rate of turn.

ROT_AIS is ``4.733 * sqrt(rate)`` signed, so the largest rate that carries one, +/-126,
decodes to 708.7 degrees per minute. The bound sits just above it.
"""

AIS_SOG_MAX_MPS: Final = 51.4
"""Bound on speed over ground, 100 knots.

Deliberately below the 102.3-knot sentinel, which converts to 52.63 m/s. An adapter that
forgets to map the sentinel fails validation here instead of rendering a ship at 190 km/h.
"""

# ---------------------------------------------------------------- field bounds
#
# Named once here, used in the fields below and imported by every AIS adapter. An adapter
# needs the number because it maps an out-of-range optional value to None rather than
# handing it to a strict field, where a rejection would drop the whole ship over a display
# attribute nobody needs. Both vessel adapters used to carry their own copies under their
# own names, so each bound existed three times and a change in one place was a silent
# divergence in two others.

IMO_MIN: Final = 1_000_000
IMO_MAX: Final = 9_999_999
"""An IMO number is seven digits. The live Digitraffic feed carried values up to 912974400."""

SHIP_TYPE_MIN: Final = 1
SHIP_TYPE_MAX: Final = 99
"""AIS ship and cargo type codes. 0 means not available."""

NAME_MAX_CHARS: Final = 20
CALL_SIGN_MAX_CHARS: Final = 7
DESTINATION_MAX_CHARS: Final = 20
"""Upstream text caps. An adapter truncates to these rather than dropping the vessel."""

DRAUGHT_MAX_M: Final = 25.5
LENGTH_MAX_M: Final = 1_022.0
BEAM_MAX_M: Final = 126.0
"""Dimension bounds. Length and beam are what the AIS 9-bit reference-point fields hold,
not what a real ship is, so a junk dimension does not drop a real vessel."""

_BEARING_LIMIT_DEG: Final = 360.0
"""Exclusive upper bound of :data:`~tracker.contracts.base.Bearing`, for the check below."""

# ---------------------------------------------------------------- MMSI identity

# The allocated ITU MID range is 201 to 775, read off the published table on 2026-08-20
# (292 MIDs across 249 rows at itu.int/gladapp/Allocation/MIDs). The table itself is a phase
# 5 job, not this one: it resolves a MID to a flag state with no API call per vessel, and one
# MID can cover several territories (306 is Bonaire, Curacao and Sint Maarten), so it narrows
# a flag rather than asserting one. The structural range is all this contract needs.

AIS_MID_MIN: Final = 201
"""Lowest allocated ITU MID."""

AIS_MID_MAX: Final = 775
"""Highest allocated ITU MID. First digits 2 to 7, so 8xx and 9xx are never a MID."""


class MmsiCategory(StrEnum):
    """What an MMSI identifies, per the ITU-R M.585 prefix rules.

    Only :attr:`SHIP_STATION` is a vessel. The rest exist so a dropped record can say what
    it was rather than being counted as anonymous junk.
    """

    SHIP_STATION = "ship_station"
    GROUP_OF_SHIPS = "group_of_ships"
    COAST_STATION = "coast_station"
    SAR_AIRCRAFT = "sar_aircraft"
    HANDHELD_DSC = "handheld_dsc"
    AUXILIARY_CRAFT = "auxiliary_craft"
    NAVIGATIONAL_AID = "navigational_aid"
    AIS_SART = "ais_sart"
    MOB_DEVICE = "mob_device"
    EPIRB_AIS = "epirb_ais"
    UNALLOCATED = "unallocated"
    """No ITU allocation covers this number, so it is not an identity.

    Covers the 999999999 placeholder on the live feed and anything else whose embedded MID
    falls outside 201 to 775.
    """


_RESERVED_MMSI_PREFIXES: Final[tuple[tuple[str, MmsiCategory, int | None], ...]] = (
    ("00", MmsiCategory.COAST_STATION, 2),
    ("111", MmsiCategory.SAR_AIRCRAFT, 3),
    ("970", MmsiCategory.AIS_SART, 3),
    ("972", MmsiCategory.MOB_DEVICE, None),
    ("974", MmsiCategory.EPIRB_AIS, None),
    ("98", MmsiCategory.AUXILIARY_CRAFT, 2),
    ("99", MmsiCategory.NAVIGATIONAL_AID, 2),
    ("8", MmsiCategory.HANDHELD_DSC, 1),
    ("0", MmsiCategory.GROUP_OF_SHIPS, 1),
)
"""ITU-R M.585 prefixes, longest first, with where the MID sits inside each.

Order is load-bearing: ``00`` must be tested before ``0``. ``None`` means the format
carries no MID at all, which is true of MOB and EPIRB-AIS devices.
"""


def _mid_is_allocated(mid: str) -> bool:
    """Whether three digits fall inside the allocated ITU MID range."""
    return AIS_MID_MIN <= int(mid) <= AIS_MID_MAX


def mmsi_category(mmsi: str) -> MmsiCategory:
    """Classify a nine-digit MMSI on its ITU prefix.

    Args:
        mmsi: Nine digits, zero-padded. Not validated here; callers reach this through
            :data:`ShipStationMmsi` or hold a string they already know is nine digits.

    Returns:
        The ITU category, or :attr:`MmsiCategory.UNALLOCATED` when the embedded MID is
        outside the allocated range. 999999999 lands there: ``99`` reads as an aid to
        navigation whose MID would be 999, which the ITU has never allocated.
    """
    for prefix, category, mid_at in _RESERVED_MMSI_PREFIXES:
        if mmsi.startswith(prefix):
            if mid_at is not None and not _mid_is_allocated(mmsi[mid_at : mid_at + 3]):
                return MmsiCategory.UNALLOCATED
            return category
    if _mid_is_allocated(mmsi[:3]):
        return MmsiCategory.SHIP_STATION
    return MmsiCategory.UNALLOCATED


def _require_ship_station(value: str) -> str:
    """Reject any MMSI that is not a usable vessel identity.

    A placeholder or a non-vessel station is not partially accepted and is not given a
    substitute key: the record fails to map, the adapter drops it, and the count carries
    the category so "we dropped 2 SAR aircraft" is a fact rather than a guess.
    """
    category = mmsi_category(value)
    if category is not MmsiCategory.SHIP_STATION:
        msg = f"MMSI {value} is a {category.value}, not a usable vessel identity"
        raise ValueError(msg)
    return value


ShipStationMmsi = Annotated[
    str,
    Field(
        pattern=r"^[0-9]{9}$",
        description="Maritime Mobile Service Identity, nine digits, zero-padded. The "
        "vessel merge key under ADR 010, and only ever a ship-station MMSI: the first "
        "three digits are the ITU MID, which gives the flag state in phase 5 with no "
        "registry call.",
    ),
    AfterValidator(_require_ship_station),
]
"""A nine-digit ship-station MMSI. A string, not an int, so the merge key is a store key."""


def rate_of_turn_from_ais(rot: int) -> float | None:
    """Decode the signed ROT_AIS wire value into degrees per minute.

    Lives here rather than in an adapter because the encoding is the AIS standard and three
    providers send it: Digitraffic, AISHub and the Kystverket NMEA stream. Squaring it in
    three places is three chances to get it wrong.

    Args:
        rot: The wire value, -128 to 127.

    Returns:
        Degrees per minute, negative to port, or ``None`` when the feed reported no rate.
        That is -128 (not available, 184 of 1,058 live records) and also +/-127, where the
        feed says the vessel is turning faster than 5 degrees per 30 seconds without saying
        how fast. Neither is a rate, so neither becomes one.
    """
    if rot in {
        AIS_ROT_NOT_AVAILABLE,
        AIS_ROT_TURNING_RIGHT_NO_RATE,
        AIS_ROT_TURNING_LEFT_NO_RATE,
    }:
        return None
    rate = (rot / AIS_ROT_SCALE) ** 2
    return -rate if rot < 0 else rate


def ais_bearing(value: float | None, sentinel: float) -> float | None:
    """Map an AIS bearing field to degrees, or ``None`` when it carries no bearing.

    Here for the same reason as :func:`rate_of_turn_from_ais`: the encoding is the AIS
    standard and Digitraffic, AISHub and aisstream.io all send it. Three adapter copies had
    already drifted, and the copy that checked only the top of the range handed a negative
    heading to :data:`~tracker.contracts.base.Bearing`, which dropped the whole vessel over
    one optional field.

    Order is load-bearing. ``cog`` 360.0 means not available while ``cog`` 0.0 is a real
    course due north, so a ``0 <= x < 360`` check applied first rejects 110 of 1,058 live
    records and reads as thin coverage rather than as a bug. Everything else outside a
    bearing's range is not a bearing and is also not available: heading is specified 0 to
    359 with 511 for unavailable, so 360 to 510 and every negative value are simply invalid.

    Args:
        value: The wire value in degrees, already descaled if the provider scaled it.
        sentinel: The field's own not-available value, :data:`AIS_COG_NOT_AVAILABLE` for a
            course and :data:`AIS_HEADING_NOT_AVAILABLE` for a heading.

    Returns:
        Degrees clockwise from true north, or ``None``.
    """
    if value is None or value >= sentinel or not 0.0 <= value < _BEARING_LIMIT_DEG:
        return None
    return float(value)


def speed_over_ground_mps(knots: float | None) -> float | None:
    """Convert speed over ground from knots, mapping the not-available sentinel first.

    Shared for the same reason as :func:`ais_bearing`: knots on every AIS feed, metres per
    second in the domain, and the conversion belongs at the boundary rather than in three
    adapters.

    At or above :data:`AIS_SOG_NOT_AVAILABLE` rather than equal to it, because ITU-R M.1371
    encodes the sentinel as 1023 tenths of a knot and ``AGENTS.md`` records AISHub sending
    102.4. No vessel does 102 knots, so one inequality covers both readings.

    **There is a gap between the sentinel and the field's own bound, and a real ship fell down
    it.** :data:`AIS_SOG_MAX_MPS` is 100 knots and the sentinel is 102.3, so a wire value in
    between passes the sentinel check, converts cleanly, and is then refused by
    :attr:`Vessel.speed_over_ground_mps`, which drops the **whole vessel** over one junk
    display field. Measured live on 2026-08-23: MMSI 273253530, "RATNIK", reported 102.2 knots
    on the Estonian feed and vanished from the globe because of it. Every AIS provider here
    shares this helper, so the guard belongs here rather than in five adapters, and the
    contract's own field documentation already says an adapter must map an out-of-range
    optional value to ``None`` rather than hand it to a strict field.

    Args:
        knots: The wire value in knots, already descaled if the provider scaled it.

    Returns:
        Metres per second, or ``None`` when the field carries no speed. A negative value is
        not a speed either, and mapping it to ``None`` rather than clamping it to zero keeps
        the record: zero would claim the receiver said the vessel was stopped. A value above
        the domain bound is refused for the same reason: the ship stays, the speed goes.
    """
    if knots is None or knots >= AIS_SOG_NOT_AVAILABLE or knots < 0.0:
        return None
    metres_per_second = float(knots) * KNOTS_TO_METRES_PER_SECOND
    return None if metres_per_second > AIS_SOG_MAX_MPS else metres_per_second


# ---------------------------------------------------------------- navigational status


class NavigationalStatus(StrEnum):
    """AIS navigational status, as broadcast, per ITU-R M.1371.

    What the master set on the transponder, so it disagrees with the vessel's actual
    behaviour often enough that the card shows both this and the speed.
    """

    UNDER_WAY_USING_ENGINE = "under_way_using_engine"
    AT_ANCHOR = "at_anchor"
    NOT_UNDER_COMMAND = "not_under_command"
    RESTRICTED_MANOEUVRABILITY = "restricted_manoeuvrability"
    CONSTRAINED_BY_DRAUGHT = "constrained_by_draught"
    MOORED = "moored"
    AGROUND = "aground"
    ENGAGED_IN_FISHING = "engaged_in_fishing"
    UNDER_WAY_SAILING = "under_way_sailing"
    TOWING_ASTERN = "towing_astern"
    PUSHING_AHEAD = "pushing_ahead"
    AIS_SART_ACTIVE = "ais_sart_active"


AIS_NAV_STATUS_CODES: Final[dict[int, NavigationalStatus]] = {
    0: NavigationalStatus.UNDER_WAY_USING_ENGINE,
    1: NavigationalStatus.AT_ANCHOR,
    2: NavigationalStatus.NOT_UNDER_COMMAND,
    3: NavigationalStatus.RESTRICTED_MANOEUVRABILITY,
    4: NavigationalStatus.CONSTRAINED_BY_DRAUGHT,
    5: NavigationalStatus.MOORED,
    6: NavigationalStatus.AGROUND,
    7: NavigationalStatus.ENGAGED_IN_FISHING,
    8: NavigationalStatus.UNDER_WAY_SAILING,
    11: NavigationalStatus.TOWING_ASTERN,
    12: NavigationalStatus.PUSHING_AHEAD,
    14: NavigationalStatus.AIS_SART_ACTIVE,
}
"""Wire code to status. ``dict.get`` is the whole mapping the adapter needs.

Codes 9, 10 and 13 are reserved and 15 is undefined, so all four are absent and resolve to
``None`` without a second sentinel check. The undefined code alone was 47 of 1,058 records.
"""


# ---------------------------------------------------------------- ETA


class VesselEta(StrictModel):
    """A decoded AIS estimated time of arrival.

    **Not a datetime, and it must never be turned into one.** The wire field is a 20-bit
    packed integer holding month, day, hour and minute, and it carries no year at all, so
    any year is a guess. Storing the raw integer as though it were an epoch dates every
    vessel to 1970.
    """

    month: int = Field(ge=1, le=12)
    day: int = Field(ge=1, le=31)
    hour: int = Field(ge=0, le=23)
    minute: int = Field(ge=0, le=59)

    @classmethod
    def from_ais_packed(cls, packed: int) -> Self | None:
        """Decode the packed AIS ETA field, or ``None`` when it is unusable.

        Layout is month in bits 19 to 16, day in 15 to 11, hour in 10 to 6, minute in 5 to
        0. Checked against the live static body on 2026-08-19: 562112 decodes to 18 August
        15:00 for SERENADA, 564096 to 19 August 14:00 for ELBSTROM, 613120 to 11 September
        12:00 for THRASYVOULOS V.

        Args:
            packed: The wire value, ``eta`` on Digitraffic.

        Returns:
            The decoded ETA, or ``None`` for the 1596 not-available value, for 0, and for
            any other combination outside the field ranges. 238 of 950 live records.
        """
        try:
            decoded = cls(
                month=(packed >> 16) & 0x0F,
                day=(packed >> 11) & 0x1F,
                hour=(packed >> 6) & 0x1F,
                minute=packed & 0x3F,
            )
        except ValidationError:
            return None
        return decoded


# ---------------------------------------------------------------- vessel


class Vessel(StrictModel):
    """One vessel as last reported by an AIS feed.

    Immutable, like every entity here: the store replaces the whole object on update, so a
    snapshot handed to the API or the WebSocket hub cannot change underneath its reader.

    ``point.altitude_m`` is always ``None``. AIS reports no altitude, and 0.0 would be this
    contract asserting the source said "at the surface" when it said nothing at all.
    """

    kind: Literal["vessel"] = "vessel"

    mmsi: ShipStationMmsi

    name: str | None = Field(
        default=None,
        max_length=NAME_MAX_CHARS,
        description="Vessel name as broadcast, capped at 20 characters upstream. None when "
        "no static record joined to the position, which was 108 of 1,058 on 2026-08-19.",
    )
    call_sign: str | None = Field(
        default=None,
        max_length=CALL_SIGN_MAX_CHARS,
        description="Radio call sign. The feed sends an empty string when it has none, "
        "which the adapter maps to None.",
    )
    imo: int | None = Field(
        default=None,
        ge=IMO_MIN,
        le=IMO_MAX,
        description="IMO ship identification number, seven digits. 0 means not available "
        "on the wire and so does anything outside the seven-digit range: the live feed "
        "carried values up to 912974400, which is not an IMO number. Both map to None in "
        "the adapter, because dropping a real ship over one junk optional field would be "
        "worse than not knowing its IMO.",
    )
    ship_type: int | None = Field(
        default=None,
        ge=SHIP_TYPE_MIN,
        le=SHIP_TYPE_MAX,
        description="AIS ship and cargo type code, 1 to 99. 0 means not available.",
    )

    point: Point
    course_over_ground_deg: Bearing | None = Field(
        default=None,
        description="Course over ground, the direction the vessel is actually moving. 0.0 "
        "is a real course due north; 360.0 on the wire means not available and is mapped "
        "to None before this bound is applied.",
    )
    speed_over_ground_mps: float | None = Field(
        default=None,
        ge=0.0,
        le=AIS_SOG_MAX_MPS,
        description="Speed over ground, converted from knots in the adapter.",
    )
    true_heading_deg: Bearing | None = Field(
        default=None,
        description="Where the bow points, which is not the course over ground: a vessel "
        "in a tideway carries a heading well off its track. 511 means not available.",
    )
    rate_of_turn_deg_per_min: float | None = Field(
        default=None,
        ge=-AIS_ROT_MAX_DEG_PER_MIN,
        le=AIS_ROT_MAX_DEG_PER_MIN,
        description="Rate of turn, decoded from the signed ROT_AIS wire value where "
        "ROT_AIS is 4.733 times the square root of the rate. Negative is to port. None "
        "when the feed said not available (-128) and also at +/-127, where the feed says "
        "the vessel is turning faster than 5 degrees per 30 seconds without giving a rate.",
    )
    navigational_status: NavigationalStatus | None = Field(
        default=None,
        description="What the master set on the transponder. None for the undefined code "
        "and the reserved ones.",
    )

    draught_m: float | None = Field(
        default=None,
        gt=0.0,
        le=DRAUGHT_MAX_M,
        description="Maximum present static draught in metres. Decimetres on the AIS "
        "endpoint and metres on the port-call endpoint, so the conversion is per endpoint "
        "in the adapter. 0 means not available.",
    )
    length_m: float | None = Field(
        default=None,
        gt=0.0,
        le=LENGTH_MAX_M,
        description="Overall length, summed in the adapter from the AIS reference points "
        "A and B. The bound is what those two 9-bit fields can hold, not what a real ship "
        "is, so a junk dimension does not drop a real vessel.",
    )
    beam_m: float | None = Field(
        default=None,
        gt=0.0,
        le=BEAM_MAX_M,
        description="Overall beam, summed in the adapter from reference points C and D.",
    )
    destination: str | None = Field(
        default=None,
        max_length=DESTINATION_MAX_CHARS,
        description="Destination as typed by the crew, free text and often a route like "
        "FIHEL<>FIMHQ<>SESTO. Empty on 91 of 950 live records, mapped to None.",
    )
    eta: VesselEta | None = Field(
        default=None,
        description="Estimated time of arrival, decoded from the packed AIS field. Carries "
        "no year, because the wire field has none.",
    )

    observed_at: UtcDatetime = Field(
        description="When the provider generated the response carrying this record."
    )
    position_age_s: float = Field(
        ge=0.0,
        description="Seconds between the position fix and observed_at. Per ADR 010 every "
        "record carries how old its report is, because recency is what resolves a conflict "
        "between two providers and the card has to be able to show why. Digitraffic's "
        "default query window is 24 hours, so an age of tens of thousands of seconds is a "
        "real answer and not a fault.",
    )
    # Per ADR 010 the provider is per record and never per layer, because a merged store
    # that cannot say which network saw a given ship is unauditable. Both fields below are
    # coverage rather than corroboration: under R1 in docs/pending-decisions.md the whole
    # list is still one origin, because the providers are repeating one AIS broadcast.
    source: str = Field(
        min_length=1,
        max_length=40,
        description="Which provider supplied this record, e.g. digitraffic.",
    )
    providers: tuple[str, ...] = Field(
        default=(),
        description="Every provider that saw this ship, freshest report first, so the first "
        "entry is the one named in source. Empty on a record no merge has touched.",
    )

    # Plain properties, NOT pydantic computed fields, for the reason set out at
    # contracts/aircraft.py:160: a computed field serialises but is then rejected by
    # extra="forbid", so our own published wire format could not be re-validated.

    @property
    def label(self) -> str:
        """Best available human label, preferring what a port would call her."""
        return self.name or self.call_sign or self.mmsi

    @property
    def flag_mid(self) -> str:
        """The ITU MID, the first three digits of the MMSI.

        The lookup key for the flag state in phase 5, which needs no per-vessel registry
        call. One MID can cover several territories, so it narrows a flag rather than
        asserting one.
        """
        return self.mmsi[:3]
