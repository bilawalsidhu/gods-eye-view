"""The aircraft domain contract.

Modelled from live ``adsb.lol`` ``/v2/point`` and ``/v2/mil`` responses captured on
2026-08-19 (``tests/fixtures/adsb_*_live.json``), not from documentation. Field
availability in that sample is worth knowing before you mark anything required: ``hex``,
``lat`` and ``lon`` were present on all 65 records, ``flight`` on 63, ``t`` and ``r`` on
59, and ``track`` on only 28.
"""

from enum import StrEnum
from typing import Literal

from pydantic import Field, computed_field

from tracker.contracts.base import Bearing, StrictModel, UtcDatetime
from tracker.contracts.geo import Point


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
    privacy ICAO address, which we display as anonymous by design and never attempt to
    resolve to an owner.
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
        description="Aircraft is broadcasting a privacy ICAO address. Not resolvable to "
        "an owner by design; we do not attempt to unmask it.",
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
    source: str = Field(
        min_length=1,
        max_length=40,
        description="Which adapter produced this record, e.g. adsb.lol. Shown as attribution.",
    )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def in_emergency(self) -> bool:
        """True when either the emergency field or the squawk indicates distress."""
        return self.emergency is not EmergencyState.NONE or self.squawk in {"7500", "7600", "7700"}

    @computed_field  # type: ignore[prop-decorator]
    @property
    def label(self) -> str:
        """Best available human label, preferring what a controller would say."""
        return self.callsign or self.registration or self.icao24.upper()
