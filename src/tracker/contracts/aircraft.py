"""The aircraft domain contract.

Modelled from live ``adsb.lol`` ``/v2/point`` and ``/v2/mil`` responses captured on
2026-08-19 (``tests/fixtures/adsb_*_live.json``), not from documentation. Field
availability in that sample is worth knowing before you mark anything required: ``hex``,
``lat`` and ``lon`` were present on all 65 records, ``flight`` on 63, ``t`` and ``r`` on
59, and ``track`` on only 28.
"""

from enum import StrEnum
from typing import Final, Literal

from pydantic import Field

from tracker.contracts.base import Bearing, StrictModel, UtcDatetime
from tracker.contracts.geo import Point

_EMERGENCY_SQUAWKS: Final = frozenset({"7500", "7600", "7700"})
"""Squawk codes that mean distress by convention: hijack, radio failure, general emergency."""


class EmergencyState(StrEnum):
    """ADS-B emergency/priority status, as broadcast.

    The squawk codes carry the same meaning by convention: 7500 hijack, 7600 radio
    failure, 7700 general emergency. Both are surfaced because an aircraft may set one
    without the other.
    """

    NONE = "none"
    GENERAL = "general"
    LIFEGUARD = "lifeguard"
    MINIMUM_FUEL = "minfuel"
    NO_COMMUNICATIONS = "nordo"
    UNLAWFUL_INTERFERENCE = "unlawful"
    DOWNED_AIRCRAFT = "downed"
    RESERVED = "reserved"


class AircraftClass(StrEnum):
    """How we classify an aircraft for display purposes.

    Derived, not broadcast. ``MILITARY`` comes from the feed's own database flag;
    ``BUSINESS_JET`` from the type designator; ``ANONYMOUS`` marks an aircraft using a
    privacy ICAO address, which displays anonymised at this phase and is correlated back to a
    registration in phase 11, per ADR 009, above a threshold set higher than an ordinary
    registry join. The anonymity is never hidden: a correlated card says the identification is
    inferred rather than observed.
    """

    UNKNOWN = "unknown"
    COMMERCIAL = "commercial"
    BUSINESS_JET = "business_jet"
    GENERAL_AVIATION = "general_aviation"
    MILITARY = "military"
    HELICOPTER = "helicopter"
    ANONYMOUS = "anonymous"


class Aircraft(StrictModel):
    """One aircraft as last reported by an ADS-B feed.

    Immutable. The store replaces the whole object on each update rather than mutating,
    so a snapshot handed to the API or the WebSocket hub can never change underneath its
    reader.
    """

    kind: Literal["aircraft"] = "aircraft"

    icao24: str = Field(
        pattern=r"^[0-9a-f]{6}$",
        description="24-bit ICAO address, lowercase hex. The stable identity of the transponder.",
    )
    non_icao_address: bool = Field(
        default=False,
        description="The feed marked this address with a '~' prefix, meaning it is not a "
        "real ICAO allocation (typically a TIS-B ground vehicle or an ADS-R relay). The "
        "address is still a usable identity but should not be treated as an aircraft "
        "registration key.",
    )
    message_source: str = Field(
        default="unknown",
        max_length=20,
        description="How the position was derived, verbatim from the feed: adsb_icao is "
        "a direct broadcast, mlat is multilaterated and less accurate, tisb_icao is "
        "rebroadcast ground data. Surfaced so the UI can be honest about accuracy.",
    )
    callsign: str | None = Field(
        default=None,
        min_length=1,
        max_length=8,
        description="Flight identifier as broadcast, whitespace stripped.",
    )
    registration: str | None = Field(
        default=None,
        max_length=12,
        description="Tail number, from the feed's aircraft database rather than the air.",
    )
    type_designator: str | None = Field(
        default=None,
        max_length=4,
        description="ICAO type designator, e.g. B38M, GLF6, H60.",
    )

    point: Point
    on_ground: bool = Field(
        default=False,
        description="True when the feed reported altitude as 'ground' rather than a number.",
    )
    barometric_altitude_m: float | None = Field(default=None, ge=-500.0, le=30_000.0)
    geometric_altitude_m: float | None = Field(default=None, ge=-500.0, le=30_000.0)
    ground_speed_mps: float | None = Field(default=None, ge=0.0, le=1_500.0)
    track_deg: Bearing | None = Field(
        default=None,
        description="True track over ground. Resolved from track, true_heading, "
        "mag_heading or dir, in that order of preference.",
    )
    vertical_rate_mps: float | None = Field(
        default=None,
        ge=-200.0,
        le=200.0,
        description="Bounds are deliberately wider than any real aircraft. Live feeds "
        "emit glitch values (a -32,640 ft/min record appeared in the 2026-08-19 military "
        "sample); those must validate and be visible, not silently drop the aircraft.",
    )

    squawk: str | None = Field(default=None, pattern=r"^[0-7]{4}$")
    emergency: EmergencyState = EmergencyState.NONE
    category: str | None = Field(
        default=None,
        pattern=r"^[A-D][0-7]$",
        description="ADS-B emitter category, e.g. A3 for a large aeroplane.",
    )

    aircraft_class: AircraftClass = AircraftClass.UNKNOWN
    is_military: bool = False
    uses_privacy_address: bool = Field(
        default=False,
        description="Aircraft is broadcasting a privacy ICAO address, so the address it "
        "sends is not tied to its registration. Carried as-is at this phase, flagged and "
        "unresolved. Per ADR 009 correlation back to a registration is phase 11, above a "
        "threshold set higher than an ordinary registry join, and the flag stays on the "
        "record afterwards so a card can say the identification is inferred.",
    )
    on_ladd: bool = Field(
        default=False,
        description="The owner is on the FAA's Limiting Aircraft Data Displayed "
        "programme, read from dbFlags bit 8. An attribute, never a display block: per "
        "ADR 009 a LADD aircraft resolves and renders like any other, because LADD binds "
        "the feeds the FAA itself supplies and every position here comes from volunteer "
        "receivers. False means the provider's aircraft database does not flag this "
        "airframe, which is not the same as proof it is off the programme.",
    )

    operator: str | None = Field(default=None, max_length=120)
    owner: str | None = Field(default=None, max_length=120)
    registered_country: str | None = Field(default=None, max_length=80)

    observed_at: UtcDatetime = Field(
        description="When the feed generated the response carrying this record."
    )
    position_age_s: float = Field(
        ge=0.0,
        description="Seconds between the position fix and observed_at, as reported by "
        "the feed's seen_pos. Drives the stale badge in the UI.",
    )
    messages_received: int = Field(default=0, ge=0)
    # Per ADR 010 the provider is per record and never per layer, because a merged store
    # that cannot say which network saw a given aircraft is unauditable. Both fields below
    # are coverage rather than corroboration: under R1 in docs/pending-decisions.md the
    # whole list is still one origin, because the providers are repeating one transponder
    # broadcast and one volunteer antenna routinely feeds several networks at once.
    source: str = Field(
        min_length=1,
        max_length=40,
        description="Which adapter produced this record, e.g. adsb.lol. Shown as attribution.",
    )
    providers: tuple[str, ...] = Field(
        default=(),
        description="Every provider that saw this aircraft, freshest report first, so the "
        "first entry is the one named in source. Empty on a record no merge has touched.",
    )

    # Plain properties, NOT pydantic computed fields, so they stay off the wire.
    #
    # A computed field is serialised but rejected on the way back in by extra="forbid", so
    # an entity could not survive its own round-trip: nothing could re-validate our
    # published wire format. The obvious patch, a before-validator that strips them, breaks
    # JSON-mode validation for every contract (see contracts/base.py). Both values are
    # trivially derivable, so the frontend derives them instead and the contract stays
    # round-trippable.

    @property
    def in_emergency(self) -> bool:
        """True when either the emergency field or the squawk indicates distress."""
        return self.emergency is not EmergencyState.NONE or self.squawk in _EMERGENCY_SQUAWKS

    @property
    def label(self) -> str:
        """Best available human label, preferring what a controller would say."""
        return self.callsign or self.registration or self.icao24.upper()
