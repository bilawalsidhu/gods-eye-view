"""The vessel ownership registry: MMSI to owner, flag, tonnage and dimensions.

The vessel half of the phase 5 ownership spine. ``sources/fintraffic.py`` polls
``/api/ais/v1/*`` for positions; this reads ``/api/port-call/v1/vessel-details``, which is a
**different store on the same host** and is the registry rather than the receiver network.
The two are disjoint on the same key: MMSI 305904000 exists here and answers HTTP 404 on
``/api/ais/v1/vessels/{mmsi}``. Anyone assuming one Fintraffic vessel lookup gets this wrong.

**Why this and not ITU MARS, which the plan names.** MARS is reachable keyless, verified again
on 2026-08-20, and it does carry the registered owner, gross tonnage and person capacity. It
is refused on licence: the ITU terms prohibit distribution and commercial use without prior
written permission, and serving those fields to a browser is distribution. See the module
docstring in ``sources/itu.py``. Fintraffic is **CC BY 4.0**, commercial use and
redistribution permitted with attribution, and it carries everything MARS carries plus net
tonnage, deadweight, length, beam, draught, ISO nationality and port of registry. So the
licence-clean source is also the richer one.

**What it costs us is coverage, and that is stated rather than papered over.** Portnet holds
vessels that call at Finnish ports, so global superyacht coverage is effectively nil. It is
the right registry for this product anyway, because the vessel position layer is Fintraffic
too: the ships we render are the ships that call at Finnish ports.

Demand-driven, one MMSI at a time, cached, exactly like ``sources/adsbdb.py``. There is no
bulk file to download here, so there is no local index and no sweep: a sweep of a live vessel
layer would spend the provider's whole minute budget inside one poll.

Traps, every one measured against the recorded extract or a live call on 2026-08-20.

- **``mmsi`` is ``0`` when absent, on 8 of 17 records, and ``?mmsi=0`` answers with those
  ships.** Verified live: the query returned ``Imavere``, IMO 9612325, a real vessel with no
  MMSI. So a caller that passes a falsy MMSI gets a real-looking record for a ship it did not
  ask about. :func:`normalise_mmsi` refuses anything that is not a ship-station MMSI before
  the request is made, and a record whose own MMSI is 0 is dropped and counted.
- **``shipOwner``, ``shipTelephone1`` and ``shipEmail`` use a single space as the
  missing-value sentinel**, not ``null`` and not ``""``. 10 of 17 records have
  ``shipOwner == " "``, which a strict ``str`` field accepts happily, so the demo would ship
  owner cards that look blank and are technically populated.
- **``radioCallSignType`` can be ``FAKE``**, on 4 of 17, and the provider is telling you the
  call sign is invented: the four values are the vessel name uppercased. A call sign is a join
  key to MARS and to PSIX, so a synthetic one matches the wrong vessel with full confidence.
  ``REAL`` is not sufficient either: ``-``, ``0`` and ``10563`` all arrive with
  ``radioCallSignType: "REAL"``. Both filters are in :func:`_call_sign`.
- **``0`` and ``0.0`` are the not-available sentinel on every dimension and tonnage field**,
  and they arrive as numbers rather than nulls: ``overallLength`` is 0.0 on 6 of 17,
  ``deathWeight`` on 12, ``draught`` on 4. ``maxSpeed`` is the one field that is genuinely
  ``null``, on all 17. Zero and null in one object, meaning the same thing.
- **``vesselTypeCode`` is Portnet's vocabulary, not the AIS ship type.** Code 50 here is a
  container ship; in AIS ship-type coding 50 is a pilot vessel. Carried under its own name so
  it can never be compared with :attr:`~tracker.contracts.vessel.Vessel.ship_type`.
- ``portOfRegistry`` is free text and one record carries ``9147605``, which is that vessel's
  own IMO number in the wrong column. Kept verbatim as text, never parsed.
- **``Accept-Encoding: gzip`` is mandatory and the failure is HTTP 406 with a plain-text body
  and an empty content type.** Same handling as ``sources/fintraffic.py``, whose header
  constant this module reuses rather than copying.

**The ship telephone and ship email are deliberately not ingested.** The recorded extract
holds two real Finnish mobile numbers in ``shipTelephone1``. They are contact data under
ADR 008, which means a PII marker, a suppression path and a removal path, and none of those
can be added without a contract change this module is not making. A registry field nobody
asked for is not worth acquiring a removal obligation over.
"""

import logging
from collections import Counter, deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final

import httpx
from pydantic import Field, RootModel, TypeAdapter

from tracker.contracts.base import (
    ContractViolationError,
    StrictModel,
    UtcDatetime,
    WireModel,
    validate_payload,
)
from tracker.contracts.vessel import (
    BEAM_MAX_M,
    CALL_SIGN_MAX_CHARS,
    DRAUGHT_MAX_M,
    IMO_MAX,
    IMO_MIN,
    LENGTH_MAX_M,
    MmsiCategory,
    ShipStationMmsi,
    mmsi_category,
)
from tracker.sources.base import (
    RATE_LIMIT_STATUS_CODES,
    ParsedRecords,
    RateLimitedError,
    SourceError,
    retry_after_seconds,
)
from tracker.sources.fintraffic import (
    ATTRIBUTION,
    ATTRIBUTION_URL,
    BASE_URL,
    DIGITRAFFIC_USER_HEADER,
    GZIP_REQUIRED_STATUS,
    LICENCE,
    REQUIRED_HEADERS,
)

_log = logging.getLogger(__name__)

__all__ = [
    "ATTRIBUTION",
    "ATTRIBUTION_URL",
    "LICENCE",
    "MAX_REQUESTS_PER_MINUTE",
    "SOURCE_NAME",
    "VESSEL_DETAILS_PATH",
    "FintrafficRegistryLookup",
    "VesselRegistration",
    "normalise_mmsi",
    "parse_vessel_details",
]
"""Re-exports the three licence constants so a caller need not know which module holds them.

They belong to the provider and not to an endpoint, and both adapters on this host owe the
same attribution string.
"""

SOURCE_NAME: Final = "digitraffic-port-call"
"""Provenance on every record, naming the endpoint rather than the host.

``sources/fintraffic.py`` records ``digitraffic`` for AIS positions. Two names on purpose: a
position seen by a Finnish receiver and a registry entry filed with Portnet are different
claims from different stores, and a card that showed one name for both would be unauditable.
The register that actually holds the record travels on
:attr:`VesselRegistration.registry`.
"""

VESSEL_DETAILS_PATH: Final = "/api/port-call/v1/vessel-details"
"""The registry endpoint. Returns a bare JSON array, with no envelope and no pagination."""

PROVIDER_LIMIT_PER_MINUTE: Final = 60
"""The provider's stated cap for a client sending no ``Digitraffic-User`` header, per IP."""

MAX_REQUESTS_PER_MINUTE: Final = 20
"""Our own budget, a third of the provider's, and a constant in code rather than a setting.

Deliberately well under :data:`PROVIDER_LIMIT_PER_MINUTE` because **the cap is per IP and
this module is not the only thing on it**. ``sources/fintraffic.py`` polls the same host
twice a minute for positions and static data, and a 429 earned here would land on that
poller, which is the layer people are actually looking at. A third leaves room for both plus
anything phase 6 adds on the same host.
"""

RATE_WINDOW_SECONDS: Final = 60.0
"""The window the budget above is counted over."""

DEFAULT_CACHE_TTL_SECONDS: Final = 86_400.0
"""How long one answer is held. A day.

The registry moves in months: ``updateTimestamp`` on the recorded extract ranges over three
weeks and one live record was last touched in December 2023. A shorter TTL would spend the
request budget re-reading facts that had not changed.
"""

OWNER_MAX_CHARS: Final = 120
"""Owner name cap, the same width ``sources/adsbdb.py`` uses for an aircraft owner."""

NAME_MAX_CHARS: Final = 60
"""Registry vessel name cap. Wider than AIS's 20 because Portnet is not 6-bit ASCII."""

PORT_MAX_CHARS: Final = 60
VESSEL_TYPE_MAX_CHARS: Final = 60
REGISTRY_MAX_CHARS: Final = 40

CALL_SIGN_REAL: Final = "REAL"
"""The only ``radioCallSignType`` whose call sign may be used as a join key."""

CALL_SIGN_MIN_CHARS: Final = 3
"""Shortest usable call sign. Refuses the ``-`` and ``0`` values seen with type ``REAL``."""

ABSENT_NUMBER: Final = 0
"""What this endpoint sends instead of a null on ``mmsi``, every tonnage and every dimension.

Read as at-or-below, so a negative value is absent too. Nothing here is legitimately zero: a
ship has a length, a beam and a gross tonnage, and a ship with no MMSI has no MMSI rather
than MMSI zero.
"""

MAX_TONNAGE: Final = 1_000_000
"""Upper bound on any tonnage field. About four times the largest ship afloat.

A bound rather than a limit: it is here to catch a unit change, not to judge a vessel.
"""

MMSI_DIGITS: Final = 9

_DROP_NO_MMSI: Final = "registry record carries no MMSI, so it cannot join to a live vessel"
_DROP_MMSI_NOT_SHIP_STATION: Final = "MMSI is not a ship-station identity"
_DROP_NO_UPDATE_TIME: Final = "no updateTimestamp, so the registry facts carry no date"
_DROP_WIRE_SHAPE: Final = "record does not match the shape this endpoint sends"
_DROP_CONTRACT: Final = "failed the vessel registration contract"
_DROP_MMSI_MISMATCH: Final = "answer is for a different MMSI than the one requested"
_DROP_AMBIGUOUS_MMSI: Final = "one MMSI answered with more than one vessel"
"""Drop reasons. Constants so a test can assert one and a count can be read by name."""

_RATE_WINDOW: Final = timedelta(seconds=RATE_WINDOW_SECONDS)


def _now() -> datetime:
    return datetime.now(UTC)


# ---------------------------------------------------------------- wire


class _ConstructionWire(WireModel):
    """``vesselConstruction``. Only the type is read; ice class and hull flags are not."""

    vessel_type_code: int | None = Field(default=None, alias="vesselTypeCode")
    vessel_type_name: str | None = Field(default=None, alias="vesselTypeName")


class _DimensionsWire(WireModel):
    """``vesselDimensions``. Metres and tonnes, unlike the AIS endpoint's decimetres.

    ``deathWeight`` is spelled exactly that way upstream and means deadweight.
    """

    gross_tonnage: int | None = Field(default=None, alias="grossTonnage")
    net_tonnage: int | None = Field(default=None, alias="netTonnage")
    deadweight: int | None = Field(default=None, alias="deathWeight")
    length: float | None = None
    overall_length: float | None = Field(default=None, alias="overallLength")
    breadth: float | None = None
    draught: float | None = None


class _RegistrationWire(WireModel):
    """``vesselRegistration``. The flag, as an ISO alpha-2 code, and the port of registry."""

    nationality: str | None = None
    port_of_registry: str | None = Field(default=None, alias="portOfRegistry")


class _SystemWire(WireModel):
    """``vesselSystem``. Only the owner is read.

    ``shipTelephone1`` and ``shipEmail`` are not mapped, on purpose. See the module
    docstring: the recorded extract holds two real mobile numbers and ingesting them would
    acquire an ADR 008 removal obligation for a field nobody asked for.
    """

    ship_owner: str | None = Field(default=None, alias="shipOwner")


class _VesselDetailsWire(WireModel):
    """One record from ``/api/port-call/v1/vessel-details``.

    ``updateTimestamp`` carries an explicit ``Z``, so it validates as timezone-aware and
    nothing here has to attach UTC. That is unusual for a registry and worth saying: the FAA
    and CASA bulk files are naive by construction, this endpoint is not.
    """

    mmsi: int | None = None
    name: str | None = None
    imo_lloyds: int | None = Field(default=None, alias="imoLloyds")
    radio_call_sign: str | None = Field(default=None, alias="radioCallSign")
    radio_call_sign_type: str | None = Field(default=None, alias="radioCallSignType")
    update_timestamp: datetime | None = Field(default=None, alias="updateTimestamp")
    data_source: str | None = Field(default=None, alias="dataSource")
    vessel_construction: _ConstructionWire | None = Field(default=None, alias="vesselConstruction")
    vessel_dimensions: _DimensionsWire | None = Field(default=None, alias="vesselDimensions")
    vessel_registration: _RegistrationWire | None = Field(default=None, alias="vesselRegistration")
    vessel_system: _SystemWire | None = Field(default=None, alias="vesselSystem")


class _DetailsListWire(RootModel[tuple[object, ...]]):
    """The bare array the endpoint returns, wrapped so it can be validated.

    Elements stay raw so one malformed record cannot lose the rest of the answer, the same
    reason ``sources/fintraffic.py`` keeps its static list raw.
    """


_LIST_ADAPTER: Final = TypeAdapter(_DetailsListWire)
_RECORD_ADAPTER: Final = TypeAdapter(_VesselDetailsWire)


# ---------------------------------------------------------------- domain


class VesselRegistration(StrictModel):
    """What the Portnet registry holds about one vessel, mapped into the domain.

    Strict, frozen and safe to hand to :class:`~tracker.services.enrich.Enricher`. Modelled
    on :class:`tracker.sources.adsbdb.AircraftRegistration`, which is the same idea for the
    aircraft layer: a registry record keyed on the live feed's own merge key.

    **There is no merge onto :class:`~tracker.contracts.vessel.Vessel` in this module.** The
    vessel contract has no owner, flag or tonnage field, unlike
    :class:`~tracker.contracts.aircraft.Aircraft`, which carries ``owner`` and
    ``registered_country``. Adding them is a contract change and is not this module's to
    make, so this record stands on its own and the join is the wiring's step.

    ``owner`` is an organisation far more often than a person: the recorded extract holds
    ``ESL Shipping Oy``, ``Kvarken Link Ab Oy`` and ``Finnlines Plc, Ship Management``. Under
    ADR 011 a registry extract is a primary record and may assert on its own, but the
    beneficial owner *behind* a corporate vehicle never can on this evidence, and phase 6
    owns that resolution.
    """

    mmsi: ShipStationMmsi
    name: str | None = Field(
        default=None,
        max_length=NAME_MAX_CHARS,
        description="Registry name, mixed case, e.g. 'Aurora Botnia'. Not the AIS broadcast "
        "name, which is upstream-uppercased and capped at 20 characters.",
    )
    call_sign: str | None = Field(
        default=None,
        max_length=CALL_SIGN_MAX_CHARS,
        description="Radio call sign, and only ever one the provider marked REAL. See "
        "_call_sign for why REAL alone is not enough.",
    )
    imo: int | None = Field(default=None, ge=IMO_MIN, le=IMO_MAX)
    owner: str | None = Field(
        default=None,
        max_length=OWNER_MAX_CHARS,
        description="Registered owner as filed, usually a company. A single space upstream "
        "means not available and is mapped to None.",
    )
    flag_iso: str | None = Field(
        default=None,
        pattern=r"^[A-Z]{2}$",
        description="Flag state as an ISO alpha-2 code, from vesselRegistration.nationality. "
        "A different claim from the ITU MID derived from the MMSI, and where the two "
        "disagree ADR 011 says both stay with the disagreement shown.",
    )
    port_of_registry: str | None = Field(
        default=None,
        max_length=PORT_MAX_CHARS,
        description="Free text as filed, and one live record carries its own IMO number "
        "here. Never parsed, never joined on.",
    )
    gross_tonnage: int | None = Field(default=None, gt=ABSENT_NUMBER, le=MAX_TONNAGE)
    net_tonnage: int | None = Field(default=None, gt=ABSENT_NUMBER, le=MAX_TONNAGE)
    deadweight_t: int | None = Field(default=None, gt=ABSENT_NUMBER, le=MAX_TONNAGE)
    length_m: float | None = Field(default=None, gt=0.0, le=LENGTH_MAX_M)
    beam_m: float | None = Field(default=None, gt=0.0, le=BEAM_MAX_M)
    draught_m: float | None = Field(
        default=None,
        gt=0.0,
        le=DRAUGHT_MAX_M,
        description="Metres here, decimetres on /api/ais/v1/vessels. Same word, two units, "
        "two endpoints, one host, so the conversion is per endpoint in the adapter.",
    )
    vessel_type_code: int | None = Field(
        default=None,
        gt=ABSENT_NUMBER,
        description="Portnet's own code list, NOT the AIS ship and cargo type. 50 is a "
        "container ship here and a pilot vessel in AIS coding, so the two must never be "
        "compared.",
    )
    vessel_type_name: str | None = Field(default=None, max_length=VESSEL_TYPE_MAX_CHARS)
    registry: str = Field(
        min_length=1,
        max_length=REGISTRY_MAX_CHARS,
        description="Which register actually holds the record, from the payload's own "
        "dataSource field. 'Portnet' on every record measured. Named ``registry`` and not "
        "``register`` because pydantic's own base class already carries a ``register`` "
        "attribute, and a field that shadows it raises a UserWarning at class-creation "
        "time, which this project's pytest config turns into an import error.",
    )
    updated_at: UtcDatetime = Field(
        description="When the register last changed this record, from updateTimestamp. "
        "Required: this is the as-of date ADR 008 wants on every attribute, and a record "
        "without one is dropped at the adapter and counted rather than asserted undated."
    )
    retrieved_at: UtcDatetime = Field(
        description="When we fetched it. Not the registry's own date, which is updated_at."
    )
    source: str = Field(default=SOURCE_NAME, min_length=1, max_length=40)


# ---------------------------------------------------------------- mapping


def normalise_mmsi(raw: str) -> str:
    """Check an MMSI is a usable ship-station identity before it reaches the network.

    **This is the guard against ``?mmsi=0``.** Verified live on 2026-08-20: that query
    answers HTTP 200 with real vessels, because 8 of 17 records in the register carry
    ``mmsi: 0`` for "not filed". A caller passing a falsy MMSI would get a plausible record
    for a ship it never asked about, with no error anywhere.

    Args:
        raw: Nine digits, zero-padded, which is what the vessel contract holds.

    Returns:
        The MMSI, stripped.

    Raises:
        ValueError: Not nine digits, or not a ship station. A placeholder such as 999999999
            and a search-and-rescue aircraft such as 111265583 are both refused here, for the
            reasons ``contracts/vessel.py`` sets out at length.
    """
    mmsi = raw.strip()
    if len(mmsi) != MMSI_DIGITS or not mmsi.isdigit():
        msg = f"{raw!r} is not a nine-digit MMSI"
        raise ValueError(msg)
    category = mmsi_category(mmsi)
    if category is not MmsiCategory.SHIP_STATION:
        msg = f"MMSI {mmsi} is a {category.value}, not a vessel this registry can answer for"
        raise ValueError(msg)
    return mmsi


def _text(raw: str | None, limit: int) -> str | None:
    """Strip, clip and map the provider's single-space sentinel to ``None``.

    ``" "`` rather than ``null`` or ``""`` is how this endpoint says a text field is empty:
    ``shipOwner`` on 10 of 17 records, ``namePrefix`` on 5, ``portOfRegistry`` on 1. Stripping
    first is what turns every one of them into ``None``.
    """
    if raw is None:
        return None
    return raw.strip()[:limit] or None


def _call_sign(raw: str | None, kind: str | None) -> str | None:
    """Return a call sign only when it can safely be used as a join key.

    Two filters, and both are needed.

    ``radioCallSignType`` must be ``REAL``. 4 of 17 records say ``FAKE``, and the provider
    means it: those four values are the vessel's own name uppercased (``KIKKAX``, ``NIINA2``,
    ``BOTNIA``, ``SCG4``). A call sign is the join key into ITU MARS and USCG PSIX, so a
    synthetic one matches the wrong vessel with full confidence.

    ``REAL`` is then not sufficient. ``-``, ``0`` and ``10563`` all arrive marked ``REAL``, so
    the shape is checked as well: at least three characters and at least one letter. That is a
    shape test and not a validation of the ITU allocation, which we have no table for.

    A refused call sign costs one field and never the record, so it is not counted as a drop.
    """
    call_sign = _text(raw, CALL_SIGN_MAX_CHARS)
    if call_sign is None:
        return None
    if (kind or "").strip().upper() != CALL_SIGN_REAL:
        _log.debug("%s: refusing call sign %r marked %r", SOURCE_NAME, call_sign, kind)
        return None
    if len(call_sign) < CALL_SIGN_MIN_CHARS or not any(char.isalpha() for char in call_sign):
        _log.debug("%s: refusing call sign %r on shape", SOURCE_NAME, call_sign)
        return None
    return call_sign


def _positive(value: float | None) -> float | None:
    """Map this endpoint's zero-means-absent numbers to ``None``.

    Applied to every tonnage and every dimension. ``overallLength`` is 0.0 on 6 of 17
    records, ``deathWeight`` on 12, ``height`` on 9. A zero-metre ship is not a measurement.
    """
    if value is None or value <= ABSENT_NUMBER:
        return None
    return value


def _int_or_none(value: int | None) -> int | None:
    """The integer form of :func:`_positive`, for tonnage fields."""
    if value is None or value <= ABSENT_NUMBER:
        return None
    return value


def _imo(value: int | None) -> int | None:
    """Keep an IMO number only when it is seven digits.

    ``imoLloyds`` is ``null`` on 7 of 17 records and one live value is ``1095363``, which is
    seven digits but is not an IMO number. There is no check-digit test applied here: the
    range test is what keeps a junk value out of the contract, and an unvalidated identifier
    that passes it is carried as one.
    """
    if value is None or not IMO_MIN <= value <= IMO_MAX:
        return None
    return value


def _to_domain(wire: _VesselDetailsWire, *, retrieved_at: datetime) -> VesselRegistration:
    """Map one wire record to the domain contract.

    Raises:
        ContractViolationError: The record has no MMSI, has an MMSI that is not a ship
            station, or has no ``updateTimestamp``. All three make the record unusable rather
            than partially usable: without an MMSI it joins to nothing, and without a date it
            is an undated attribute, which ADR 008 drops rather than asserts.
    """
    if wire.mmsi is None or wire.mmsi <= ABSENT_NUMBER:
        raise ContractViolationError(SOURCE_NAME, _DROP_NO_MMSI)
    mmsi = f"{wire.mmsi:0{MMSI_DIGITS}d}"
    if len(mmsi) != MMSI_DIGITS or mmsi_category(mmsi) is not MmsiCategory.SHIP_STATION:
        raise ContractViolationError(SOURCE_NAME, f"{_DROP_MMSI_NOT_SHIP_STATION}: {mmsi}")
    if wire.update_timestamp is None:
        raise ContractViolationError(SOURCE_NAME, _DROP_NO_UPDATE_TIME)

    dimensions = wire.vessel_dimensions or _DimensionsWire()
    registration = wire.vessel_registration or _RegistrationWire()
    construction = wire.vessel_construction or _ConstructionWire()
    system = wire.vessel_system or _SystemWire()
    # overallLength is the figure a berth cares about, and it is absent more often than
    # `length`, so it leads and `length` is the fallback rather than a second field.
    length = _positive(dimensions.overall_length) or _positive(dimensions.length)
    flag = _text(registration.nationality, 2)

    return VesselRegistration(
        mmsi=mmsi,
        name=_text(wire.name, NAME_MAX_CHARS),
        call_sign=_call_sign(wire.radio_call_sign, wire.radio_call_sign_type),
        imo=_imo(wire.imo_lloyds),
        owner=_text(system.ship_owner, OWNER_MAX_CHARS),
        flag_iso=flag.upper() if flag else None,
        port_of_registry=_text(registration.port_of_registry, PORT_MAX_CHARS),
        gross_tonnage=_int_or_none(dimensions.gross_tonnage),
        net_tonnage=_int_or_none(dimensions.net_tonnage),
        deadweight_t=_int_or_none(dimensions.deadweight),
        length_m=length,
        beam_m=_positive(dimensions.breadth),
        draught_m=_positive(dimensions.draught),
        vessel_type_code=_int_or_none(construction.vessel_type_code),
        vessel_type_name=_text(construction.vessel_type_name, VESSEL_TYPE_MAX_CHARS),
        registry=_text(wire.data_source, REGISTRY_MAX_CHARS) or SOURCE_NAME,
        updated_at=wire.update_timestamp,
        retrieved_at=retrieved_at,
    )


def parse_vessel_details(
    payload: bytes | str, *, retrieved_at: datetime
) -> ParsedRecords[VesselRegistration]:
    """Parse a 200 body from ``/api/port-call/v1/vessel-details``, counting what did not map.

    The body is a bare array. Records are validated one at a time so that one unmappable
    entry costs one vessel rather than the whole answer, which matters here more than
    elsewhere: 8 of 17 records in the recorded extract have no MMSI and would take the other
    9 with them.

    Args:
        payload: Raw response body.
        retrieved_at: When the response arrived, timezone-aware.

    Returns:
        The records that mapped, plus a count of the rest keyed by reason.

    Raises:
        ContractViolationError: The body is not a JSON array.
    """
    envelope = validate_payload(_LIST_ADAPTER, payload, source=SOURCE_NAME)
    records: list[VesselRegistration] = []
    drops: Counter[str] = Counter()
    for raw in envelope.root:
        try:
            wire = validate_payload(_RECORD_ADAPTER, raw, source=SOURCE_NAME)
        except ContractViolationError:
            drops[_DROP_WIRE_SHAPE] += 1
            continue
        try:
            records.append(_to_domain(wire, retrieved_at=retrieved_at))
        except ContractViolationError as exc:
            drops[exc.detail or _DROP_CONTRACT] += 1
        except ValueError:
            drops[_DROP_CONTRACT] += 1
    return ParsedRecords(records=tuple(records), drops=drops)


# ---------------------------------------------------------------- lookup


@dataclass(frozen=True, slots=True)
class _CachedLookup:
    """One answered lookup, hit or miss.

    ``registration is None`` means the register answered and does not hold this MMSI, which is
    an empty array and HTTP 200. A *failed* lookup is never stored, so "we asked and got
    nothing" and "we could not ask" stay distinguishable.
    """

    fetched_at: datetime
    registration: VesselRegistration | None


class FintrafficRegistryLookup:
    """Cached, demand-driven vessel registry lookups. One MMSI at a time.

    Holds the cache and the request budget, so one instance lives for the process rather than
    being built per request.

    **The cache stays in memory, and that is a decision rather than an omission**, for the
    reasons set out at :class:`tracker.sources.adsbdb.AdsbdbLookup`. ``owner`` is a named
    individual on a privately registered vessel, so this holds personal data, which is why
    :meth:`forget` exists. Persisting it would put personal data in a file that an ADR 008
    removal has to reach, and a removal that reports success while a disk copy keeps serving
    the name for the rest of the day is worse than a slow one. Nothing polls this endpoint, so
    a restart replays no traffic: it costs one lookup per card a person actually opens.

    Not thread-safe, and neither is anything else in this package: one event loop owns it.
    """

    # ponytail: no in-flight coalescing. Two cards opened on one vessel inside the same round
    # trip cost two requests. Add a per-key future map if the count ever approaches
    # MAX_REQUESTS_PER_MINUTE; the cache covers every other case.

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        base_url: str = BASE_URL,
        digitraffic_user: str = "",
        clock: Callable[[], datetime] = _now,
    ) -> None:
        self._client = client
        self._base_url = base_url.rstrip("/")
        self._clock = clock
        self._ttl = timedelta(seconds=DEFAULT_CACHE_TTL_SECONDS)
        self._headers = dict(REQUIRED_HEADERS)
        if digitraffic_user.strip():
            self._headers[DIGITRAFFIC_USER_HEADER] = digitraffic_user.strip()
        self._cache: dict[str, _CachedLookup] = {}
        self._requests: deque[datetime] = deque()
        self._drops: Counter[str] = Counter()

    @property
    def name(self) -> str:
        """Provider name, recorded on every record this lookup produces."""
        return SOURCE_NAME

    @property
    def drops(self) -> Counter[str]:
        """Every registry record refused since start-up, keyed by reason.

        Cumulative and readable, because dropped and counted has to mean counted somewhere a
        person can see it rather than written to a log line and forgotten. A single
        :class:`~tracker.sources.base.ParsedRecords` describes one answer and its caller
        throws it away, so the totals live here and the wiring serves them.

        A copy, so a reader cannot reset the counter by accident.
        """
        return Counter(self._drops)

    async def vessel(self, mmsi: str) -> VesselRegistration | None:
        """Look up one vessel by MMSI.

        Answered from cache when there is a live entry, whether that entry is a hit or a miss.

        Args:
            mmsi: Nine digits, zero-padded, as the vessel contract holds it.

        Returns:
            The registry record, or ``None`` when the register does not hold this MMSI. A miss
            is an empty array and HTTP 200, verified live, and it is the normal case: Portnet
            covers vessels calling at Finnish ports and nothing else.

        Raises:
            ValueError: ``mmsi`` is not a ship-station MMSI. See :func:`normalise_mmsi`.
            RateLimitedError: Our own budget is spent, or the provider asked us to back off.
                Nothing is cached either way, so a later call is a real attempt.
            SourceError: HTTP 406, which only ever means our own ``Accept-Encoding`` was lost.
            ContractViolationError: The body is not the array this endpoint sends.
            httpx.HTTPError: Transport failure or a 5xx. Not cached, so the card degrades to
                feed-only data now and a later open tries again.
        """
        key = normalise_mmsi(mmsi)
        now = self._clock()
        entry = self._cache.get(key)
        if entry is not None and now - entry.fetched_at < self._ttl:
            return entry.registration
        found = self._select(key, await self._fetch(key))
        self._cache[key] = _CachedLookup(fetched_at=now, registration=found)
        return found

    def forget(self, mmsi: str) -> int:
        """Drop the cached answer for one vessel.

        The removal hook ADR 008 needs. ``owner`` on a privately registered vessel is a named
        individual and :data:`DEFAULT_CACHE_TTL_SECONDS` is a day, so a removal that could not
        reach this cache would report success while the deleted name kept being served.

        There is one key per vessel here, unlike ``sources/adsbdb.py``, which caches an answer
        under three aliases because it accepts a hex address or a registration. This endpoint
        is queried by MMSI and nothing else, so there is no alias to miss.

        No suppression register here: phase 6 owns that, and it is what stops the next card
        open fetching the name again. This empties the cache and claims nothing more.

        Args:
            mmsi: Nine digits, as the vessel contract holds it.

        Returns:
            1 if something was held, 0 if not.

        Raises:
            ValueError: ``mmsi`` is not a ship-station MMSI. A removal aimed at junk is loud
                rather than a silent success.
        """
        dropped = 1 if self._cache.pop(normalise_mmsi(mmsi), None) is not None else 0
        _log.info("%s: forgot %d cached entries", SOURCE_NAME, dropped)
        return dropped

    def _select(
        self, mmsi: str, parsed: ParsedRecords[VesselRegistration]
    ) -> VesselRegistration | None:
        """Pick the one record that answers this MMSI, or refuse to guess.

        Two ways an answer is refused rather than used, both counted. More than one mapped
        record means the register cannot say which vessel holds that MMSI, and an identity we
        cannot establish is not asserted. A single record for a different MMSI means the
        endpoint's own filter has stopped filtering, which is not theoretical on this API:
        ``bbox`` is accepted and silently ignored on the AIS endpoint, and ``?mmsi=0`` returns
        ships.
        """
        self._drops.update(parsed.drops)
        if not parsed.records:
            return None
        if len(parsed.records) > 1:
            self._drops[_DROP_AMBIGUOUS_MMSI] += len(parsed.records)
            _log.warning(
                "%s: %d vessels answered for MMSI %s", SOURCE_NAME, len(parsed.records), mmsi
            )
            return None
        record = parsed.records[0]
        if record.mmsi != mmsi:
            self._drops[_DROP_MMSI_MISMATCH] += 1
            _log.warning("%s: asked for MMSI %s and got %s", SOURCE_NAME, mmsi, record.mmsi)
            return None
        return record

    async def _fetch(self, mmsi: str) -> ParsedRecords[VesselRegistration]:
        """One GET, parsed. The budget is spent before the network is touched."""
        self._reserve_request_slot()
        response = await self._client.get(
            f"{self._base_url}{VESSEL_DETAILS_PATH}",
            params={"mmsi": mmsi},
            headers=self._headers,
        )
        if response.status_code in RATE_LIMIT_STATUS_CODES:
            raise RateLimitedError(SOURCE_NAME, response.status_code, retry_after_seconds(response))
        if response.status_code == GZIP_REQUIRED_STATUS:
            msg = f"HTTP 406 from {VESSEL_DETAILS_PATH}: {response.text.strip()}"
            raise SourceError(SOURCE_NAME, msg)
        response.raise_for_status()
        return parse_vessel_details(response.content, retrieved_at=self._clock())

    def _reserve_request_slot(self) -> None:
        """Spend one request from the budget, or refuse before touching the network."""
        now = self._clock()
        cutoff = now - _RATE_WINDOW
        while self._requests and self._requests[0] <= cutoff:
            self._requests.popleft()
        if len(self._requests) >= MAX_REQUESTS_PER_MINUTE:
            raise RateLimitedError(SOURCE_NAME, 429, RATE_WINDOW_SECONDS)
        self._requests.append(now)
