"""AISHub, the crowd-sourced AIS vessel provider.

The third vessel provider in the phase 2 union alongside Fintraffic Digitraffic and
aisstream.io, per ADR 010, merged on MMSI like the others. Every record carries the
provider that supplied it and how old that report is.

**Nobody can call this feed today, and that is a hardware problem rather than a code one.**
AISHub grants API access only to members streaming raw NMEA off a physical AIS receiver: at
least 10 vessels averaged over 7 days, 90% uptime, downsampling no coarser than 60 seconds,
delay under 10 seconds. Synthesized NMEA, scraped data and data from other public AIS
services are prohibited by name, so there is no software route in. With no username the
layer is unavailable exactly like one with a missing key, and :meth:`AishubClient.vessels`
says so without making a request.

What is verified and what is not, because the difference matters here more than usual.

*Verified 2026-08-19*, from one live call with a deliberately invalid username: HTTP 200,
115 bytes, ``content-type: application/json``, body
``[{"ERROR":true,"USERNAME":"...","FORMAT":"HUMAN","ERROR_MESSAGE":"Invalid username or
password!"}]``, recorded at ``tests/fixtures/aishub_ws_invalid_username_live.json``. So a
bad username is a **structured error envelope** rather than the empty body this repo used to
claim, the response is an array whose element 0 is that envelope rather than a flat list of
ships, and ``FORMAT`` echoes ``HUMAN`` for ``format=1``.

*Not verified*: any successful payload. No member username exists, so the vessel field
names in :class:`AishubVesselWire` come from the provider's published API page and not from
a call anybody made. They are permissive and aliased, a record that will not map is dropped
and counted rather than partially accepted, and the field names the recon could not
establish are listed on that class. The provider's other claim, that an over-frequent call
"will return nothing", is also untested, because confirming it needs the abuse
:data:`MIN_INTERVAL_SECONDS` exists to prevent. An empty body and an ``ERROR`` envelope are
both treated as provider failure, so being wrong about which one arrives costs nothing.
"""

import json
import logging
import re
import time
from collections import Counter
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from typing import Final, Literal

import httpx
from pydantic import AliasChoices, Field, TypeAdapter, ValidationError

from tracker.contracts.base import ContractViolationError, WireModel, validate_payload
from tracker.contracts.geo import BoundingBox, Point
from tracker.contracts.vessel import (
    AIS_COG_NOT_AVAILABLE,
    AIS_HEADING_NOT_AVAILABLE,
    AIS_NAV_STATUS_CODES,
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
    Vessel,
    VesselEta,
    ais_bearing,
    rate_of_turn_from_ais,
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

SOURCE_NAME: Final = "aishub"
"""Per-record provider name, per ADR 010. Never a per-layer field."""

BASE_URL: Final = "https://data.aishub.net/ws.php"
"""The only endpoint. Verified reachable 2026-08-19; ``robots.txt`` on this host is 404."""

MIN_INTERVAL_SECONDS: Final = 60.0
"""Once per minute, hard, and a constant here rather than a setting on purpose.

This is the provider's documented behaviour and not a courtesy figure: their own note says
the web service "will return nothing if executed more frequently", so calling too often
does not earn a 429, it earns a body with no ships in it. Same treatment as CelesTrak's
two-hour floor. :meth:`AishubClient._claim_call_slot` enforces it inside the client as well,
so the floor holds whatever cadence a caller or a config file asks for.
"""

OUTPUT_JSON: Final = "json"
"""Always passed explicitly. ``output`` defaults to XML upstream, the CelesTrak ``FORMAT`` trap."""

FORMAT_HUMAN: Final[Literal[1]] = 1
"""Degrees, knots and metres. What this adapter asks for, and the envelope echoes ``HUMAN``."""

FORMAT_SCALED: Final[Literal[0]] = 0
"""AIS-encoded integers: longitude and latitude by 600000, course, speed and draught by 10."""

COMPRESS_NONE: Final = 0
"""Uncompressed. httpx handles transport compression; a ZIP body would need unpacking here."""

RESPONSE_PARTS: Final = 2
"""A successful body is two elements: the status envelope, then the array of vessels.

The failure body is one, just the envelope. Verified against the live invalid-username call.
"""

SHORT_ARRAY_DETAIL: Final = (
    "the envelope claimed records the vessel array does not carry, so the response is "
    "truncated: counted as a failed poll, never as an empty sea"
)
"""Why an envelope that disagrees with its own array is a failure.

``RECORDS`` is the only cross-check available on this provider, and it is worth having
because AISHub answers both a bad username and an over-frequent call with HTTP 200. An
envelope saying 500 records above an empty array is a broken answer, and reading it as an
empty sea drops real vessels out of a merged store.

The opposite shape, ``RECORDS`` of zero above an empty array, is **not** an error and is
deliberately allowed: the client takes a bounding box, an MMSI list and an interval, so a
box over quiet water or an MMSI that is not currently reporting is a correct zero. Refusing
that would report the provider unavailable for a right answer.
"""

LONLAT_SCALE: Final = 600_000.0
"""``format=0`` longitude and latitude divisor: degrees in ten-thousandths of a minute."""

COURSE_SCALE: Final = 10.0
"""``format=0`` course divisor, tenths of a degree. Also turns the 3600 sentinel into 360.0."""

SPEED_SCALE: Final = 10.0
"""``format=0`` speed divisor, tenths of a knot. Also turns the 1023 sentinel into 102.3."""

DRAUGHT_SCALE: Final = 10.0
"""``format=0`` draught divisor, decimetres."""

_FORMAT_LABELS: Final[dict[int, str]] = {FORMAT_HUMAN: "HUMAN", FORMAT_SCALED: "AIS"}
"""What ``FORMAT`` echoes back for each mode.

``HUMAN`` for ``format=1`` is verified off the live error envelope. ``AIS`` for ``format=0``
is the provider's own word for that mode and is **not** verified, which is why a mismatch
raises rather than being silently trusted: an unnoticed mode swap means every position is
600000 times too large.
"""

ROT_WIRE_MIN: Final = -128
ROT_WIRE_MAX: Final = 127
"""The signed ROT_AIS wire range. An encoding bound rather than a contract bound, so it is
declared here; every other bound this adapter needs is imported from ``contracts/vessel.py``
so the number exists once. A value outside a bound is mapped to None rather than handed to
the contract, because a strict field rejecting one junk optional attribute would drop an
otherwise good ship."""

NO_USERNAME_REASON: Final = (
    "AISHub grants API access only to members streaming raw NMEA from a physical AIS "
    "receiver, so no username exists to configure and the provider is unavailable"
)
"""The capability reason string, so ``/api/capabilities`` can name it without knowing AISHub."""

EMPTY_BODY_DETAIL: Final = (
    "HTTP 200 with an empty body: counted as a failed poll, never as an empty sea. The "
    "existing vessels stay in the store"
)
"""Why an empty success is an error.

An empty body read as "this provider sees no ships" would drop real vessels out of a merged
store, which is the union making a documented quirk dangerous. Plan phase 2 acceptance 8.
"""

_TIME_TEXT_FORMAT: Final = "%Y-%m-%d %H:%M:%S"
"""``TIME`` in human form, e.g. ``2021-07-09 08:06:53 GMT``. Naive, so UTC is attached here."""

_UTC_SUFFIXES: Final = (" GMT", " UTC")

_ETA_TEXT: Final = re.compile(r"^(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})$")
"""Month-day hour-minute, the human form of the packed AIS ETA. No year, because AIS has none."""


class AishubUnavailableError(SourceError):
    """AISHub produced no usable data, or we declined to ask it for any.

    One exception for four situations, because the caller does the same thing in all of
    them: count a failed poll, leave the vessel store exactly as it is, try again next
    cycle. The detail says which happened. The four are no username configured, a call
    inside the once-per-minute floor, an empty HTTP 200, and an ``ERROR`` envelope.

    Deliberately not a :class:`~tracker.sources.base.RateLimitedError`, even though an
    over-frequent call is one of the causes: our own floor already exceeds the provider's,
    so there is nothing to back off from and mislabelling a bad username as throttling would
    put the wrong reason in the health output.
    """


class AishubEnvelopeWire(WireModel):
    """Element 0 of every AISHub response: the status envelope, not a vessel.

    Verified against the live 115-byte invalid-username body. Anything iterating the
    response as though it were a list of ships reads this object as a ship.
    """

    error: bool = Field(default=False, alias="ERROR")
    error_message: str | None = Field(default=None, alias="ERROR_MESSAGE")
    username: str | None = Field(default=None, alias="USERNAME")
    format_name: str | None = Field(default=None, alias="FORMAT")
    records: int | None = Field(default=None, alias="RECORDS")


class AishubVesselWire(WireModel):
    """One vessel record as AISHub's published API page describes it.

    **No successful payload has ever been captured**, so every field here is optional and
    every type is a union: this is the least trustworthy wire model in the repo and it is
    permissive to match. What the recon could not establish, and what happens if it is
    wrong:

    - The exact case and spelling of every key below. A key we do not recognise is ignored
      and the attribute stays ``None``, so a wrong guess loses one optional attribute
      rather than the vessel. ``MMSI``, ``LONGITUDE``, ``LATITUDE`` and ``TIME`` are the
      four that would lose the vessel, and they are the four the provider documents most
      plainly.
    - Whether ``TIME`` carries the human string in ``format=0`` or an epoch. Both are
      handled.
    - Whether ``ETA`` arrives packed as an integer or as ``MM-DD HH:MM``. Both are handled.
    - Whether ``ROT`` is the raw signed ROT_AIS value. Treated as ROT_AIS, on the authority
      of ``contracts/vessel.py``, which puts the decoder there precisely because AISHub,
      Digitraffic and the Kystverket stream all send it.

    ``TIME`` in JSON is ``TSTAMP`` in the XML and CSV outputs, for the same value. We ask
    for JSON, so the alias is defence against a mode we did not intend, not a feature.
    """

    mmsi: int | str | None = Field(default=None, alias="MMSI")
    time: str | int | float | None = Field(
        default=None, validation_alias=AliasChoices("TIME", "TSTAMP")
    )
    longitude: float | int | None = Field(default=None, alias="LONGITUDE")
    latitude: float | int | None = Field(default=None, alias="LATITUDE")
    cog: float | int | None = Field(default=None, alias="COG")
    sog: float | int | None = Field(default=None, alias="SOG")
    heading: float | int | None = Field(default=None, alias="HEADING")
    rot: float | int | None = Field(default=None, alias="ROT")
    navstat: int | None = Field(default=None, alias="NAVSTAT")
    imo: int | None = Field(default=None, alias="IMO")
    name: str | None = Field(default=None, alias="NAME")
    callsign: str | None = Field(default=None, alias="CALLSIGN")
    ship_type: int | None = Field(default=None, alias="TYPE")
    ref_a: float | int | None = Field(default=None, alias="A")
    ref_b: float | int | None = Field(default=None, alias="B")
    ref_c: float | int | None = Field(default=None, alias="C")
    ref_d: float | int | None = Field(default=None, alias="D")
    draught: float | int | None = Field(default=None, alias="DRAUGHT")
    destination: str | None = Field(default=None, alias="DEST")
    eta: int | str | None = Field(default=None, alias="ETA")


_ENVELOPE_ADAPTER: Final = TypeAdapter(AishubEnvelopeWire)
_RECORD_ADAPTER: Final = TypeAdapter(AishubVesselWire)
"""One record at a time, not the whole array.

Validating the array in one pass would let a single junk element fail the batch, and a
provider hiccup on one ship must not blank the layer. Per record, an element that is not
even an object is dropped and counted like any other unmappable record.
"""


def _descale(value: float | None, divisor: float) -> float | None:
    """Undo the ``format=0`` integer scaling, or pass a human value straight through.

    Callers pass ``1.0`` for ``format=1``. Descaling first means one sentinel rule covers
    both modes: 3600 tenths of a degree and 360.0 degrees are the same not-available value
    once divided.
    """
    return None if value is None else float(value) / divisor


def _bounded_int(value: int | None, *, low: int, high: int) -> int | None:
    """``None`` when an integer code is absent or outside the range the contract accepts."""
    return value if value is not None and low <= value <= high else None


def _bounded_float(value: float | None, *, high: float) -> float | None:
    """``None`` unless a measurement is positive and inside its contract bound.

    Zero is the AIS not-available value for both draught and a reference-point dimension,
    so it is excluded by the lower bound rather than by a second check.
    """
    return value if value is not None and 0.0 < value <= high else None


def _dimension(first: float | None, second: float | None, *, high: float) -> float | None:
    """Sum two AIS reference-point offsets into an overall dimension.

    A + B is the length and C + D is the beam. Either half missing means no dimension, not
    half a ship.
    """
    if first is None or second is None:
        return None
    return _bounded_float(float(first) + float(second), high=high)


def _text(value: str | None, *, cap: int) -> str | None:
    """Trim upstream text, mapping the empty string to ``None`` and honouring the field cap.

    AIS pads and truncates text fields, and every AIS feed sends ``""`` rather than null for
    missing text. The cap is applied here so a provider sending one character too many costs
    a truncated name, which is upstream truth anyway, rather than the whole vessel.
    """
    if value is None:
        return None
    return value.strip()[:cap].strip() or None


def _fix_time(raw: str | int | float | None) -> datetime | None:
    """Parse ``TIME`` into an aware UTC datetime, or ``None`` if it cannot be read.

    The human form is ``2021-07-09 08:06:53 GMT``, which parses naive: the suffix is dropped
    and UTC attached here, in the adapter, the same fix CelesTrak's ``EPOCH`` needs. A
    numeric value is treated as epoch seconds, which is the form the AIS-encoded mode is
    expected to use and is not verified.
    """
    if raw is None:
        return None
    if isinstance(raw, str):
        text = raw.strip()
        for suffix in _UTC_SUFFIXES:
            text = text.removesuffix(suffix)
        try:
            return datetime.strptime(text.strip(), _TIME_TEXT_FORMAT).replace(tzinfo=UTC)
        except ValueError:
            return None
    try:
        return datetime.fromtimestamp(float(raw), tz=UTC)
    except (OverflowError, OSError, ValueError):
        return None


def _eta(raw: int | str | None) -> VesselEta | None:
    """Decode ``ETA``, packed integer or ``MM-DD HH:MM`` text, or ``None`` if unusable.

    Never a datetime: the AIS field holds month, day, hour and minute and carries no year,
    so any year would be invented. Out-of-range combinations, including the 1596
    not-available value, fail the contract's own bounds and come back ``None``.
    """
    if raw is None:
        return None
    if isinstance(raw, int):
        return VesselEta.from_ais_packed(raw)
    match = _ETA_TEXT.match(raw.strip())
    if match is None:
        return None
    month, day, hour, minute = (int(part) for part in match.groups())
    try:
        return VesselEta(month=month, day=day, hour=hour, minute=minute)
    except ValidationError:
        return None


def _to_domain(
    wire: AishubVesselWire,
    *,
    received_at: datetime,
    ais_format: Literal[0, 1],
    source: str,
) -> Vessel:
    """Map one AISHub record to the domain contract.

    Raises:
        ValueError: when the record carries no MMSI, no position or no readable timestamp.
            The caller counts the reason and drops the record; nothing is defaulted, because
            a vessel at (0, 0) or dated to 1970 is a lie the renderer cannot see through.
        ValidationError: when a mapped value fails the domain contract. That is how an MMSI
            belonging to a search-and-rescue aircraft or a 999999999 placeholder gets
            dropped, with the ITU category named in the reason.
    """
    scaled = ais_format == FORMAT_SCALED
    if wire.mmsi is None:
        msg = "record carries no MMSI"
        raise ValueError(msg)
    lon = _descale(wire.longitude, LONLAT_SCALE if scaled else 1.0)
    lat = _descale(wire.latitude, LONLAT_SCALE if scaled else 1.0)
    if lon is None or lat is None:
        msg = "record carries no position"
        raise ValueError(msg)
    fix_time = _fix_time(wire.time)
    if fix_time is None:
        msg = f"record carries no readable timestamp ({wire.time!r})"
        raise ValueError(msg)

    rot_wire = _bounded_int(
        None if wire.rot is None else int(wire.rot), low=ROT_WIRE_MIN, high=ROT_WIRE_MAX
    )
    return Vessel(
        mmsi=f"{int(wire.mmsi):09d}",
        name=_text(wire.name, cap=NAME_MAX_CHARS),
        call_sign=_text(wire.callsign, cap=CALL_SIGN_MAX_CHARS),
        imo=_bounded_int(wire.imo, low=IMO_MIN, high=IMO_MAX),
        ship_type=_bounded_int(wire.ship_type, low=SHIP_TYPE_MIN, high=SHIP_TYPE_MAX),
        point=Point(lon=lon, lat=lat),
        course_over_ground_deg=ais_bearing(
            _descale(wire.cog, COURSE_SCALE if scaled else 1.0), AIS_COG_NOT_AVAILABLE
        ),
        speed_over_ground_mps=speed_over_ground_mps(
            _descale(wire.sog, SPEED_SCALE if scaled else 1.0)
        ),
        true_heading_deg=ais_bearing(_descale(wire.heading, 1.0), AIS_HEADING_NOT_AVAILABLE),
        rate_of_turn_deg_per_min=None if rot_wire is None else rate_of_turn_from_ais(rot_wire),
        navigational_status=(
            None if wire.navstat is None else AIS_NAV_STATUS_CODES.get(wire.navstat)
        ),
        draught_m=_bounded_float(
            _descale(wire.draught, DRAUGHT_SCALE if scaled else 1.0), high=DRAUGHT_MAX_M
        ),
        length_m=_dimension(wire.ref_a, wire.ref_b, high=LENGTH_MAX_M),
        beam_m=_dimension(wire.ref_c, wire.ref_d, high=BEAM_MAX_M),
        destination=_text(wire.destination, cap=DESTINATION_MAX_CHARS),
        eta=_eta(wire.eta),
        observed_at=received_at,
        position_age_s=max(0.0, (received_at - fix_time).total_seconds()),
        source=source,
    )


def _split_response(
    payload: bytes | str, *, source: str
) -> tuple[AishubEnvelopeWire, list[object]]:
    """Split a response into its status envelope and its raw vessel array.

    Returns:
        The validated envelope and the untouched element 1 of the array, left as raw JSON
        so the records are validated in one pass by their own adapter.

    Raises:
        AishubUnavailableError: on an empty body, an empty array, an ``ERROR`` envelope, or
            an envelope claiming more records than the array carries. All four mean no usable
            data this cycle and none of them empties the store.
        ContractViolationError: when the body is not the array of envelope-then-records that
            AISHub documents. A shape we do not recognise must fail loudly rather than parse
            to zero ships, which is a healthy feed with an empty layer.
    """
    text = payload.decode("utf-8", errors="replace") if isinstance(payload, bytes) else payload
    if not text.strip():
        raise AishubUnavailableError(source, EMPTY_BODY_DETAIL)
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ContractViolationError(source, f"payload is not JSON: {exc}") from exc
    if not isinstance(raw, list):
        raise ContractViolationError(source, f"expected a JSON array, got {type(raw).__name__}")
    if not raw:
        raise AishubUnavailableError(source, EMPTY_BODY_DETAIL)
    envelope = validate_payload(_ENVELOPE_ADAPTER, raw[0], source=source)
    if envelope.error:
        detail = envelope.error_message or "provider reported an error with no message"
        raise AishubUnavailableError(source, detail)
    if len(raw) < RESPONSE_PARTS or not isinstance(raw[1], list):
        raise ContractViolationError(
            source, "envelope reported success but the body carried no vessel array"
        )
    if envelope.records is not None and envelope.records > len(raw[1]):
        raise AishubUnavailableError(
            source, f"{SHORT_ARRAY_DETAIL} (RECORDS {envelope.records}, array {len(raw[1])})"
        )
    return envelope, raw[1]


def _require_expected_format(
    envelope: AishubEnvelopeWire, *, ais_format: Literal[0, 1], source: str
) -> None:
    """Reject a response served in a different mode from the one we asked for.

    Without this, a provider ignoring ``format`` sends AIS-encoded integers into a parser
    treating them as degrees. Every position then lands outside the WGS84 bounds, every
    record is dropped and counted, and the layer looks like poor coverage instead of a bug.
    An echo we do not recognise is not a contradiction, so it is left alone.
    """
    echoed = (envelope.format_name or "").strip().upper()
    expected = _FORMAT_LABELS[ais_format]
    if echoed and echoed in set(_FORMAT_LABELS.values()) and echoed != expected:
        raise ContractViolationError(
            source,
            f"asked for format={ais_format} ({expected}) but the envelope echoed {echoed!r}; "
            "the values would be scaled wrong",
        )


def _drop_reason(exc: ValidationError) -> str:
    """The first contract error, used as the drop reason so the count says what was wrong."""
    errors = exc.errors()
    return str(errors[0]["msg"]) if errors else "record failed the domain contract"


def parse_response(
    payload: bytes | str,
    *,
    source: str = SOURCE_NAME,
    ais_format: Literal[0, 1] = FORMAT_HUMAN,
    received_at: datetime | None = None,
) -> ParsedRecords[Vessel]:
    """Parse an AISHub response into domain vessels.

    Args:
        payload: The raw body.
        source: Provider name written onto every record, per ADR 010.
        ais_format: The ``format`` we asked for, so the parser and the query cannot
            disagree about whether values are scaled.
        received_at: When the response arrived, which becomes ``observed_at`` and the
            baseline for ``position_age_s``. AISHub sends no envelope timestamp, so there is
            nothing better; defaults to now.

    Returns:
        The vessels that mapped, and a count of the records that did not, by reason.

    Raises:
        AishubUnavailableError: empty body, empty array, an ``ERROR`` envelope, or an
            envelope claiming more records than the array carries.
        ContractViolationError: an unrecognisable response shape or the wrong ``format``.
    """
    envelope, raw_records = _split_response(payload, source=source)
    _require_expected_format(envelope, ais_format=ais_format, source=source)
    observed = received_at if received_at is not None else datetime.now(UTC)

    vessels: list[Vessel] = []
    drops: Counter[str] = Counter()
    for record in raw_records:
        try:
            wire = _RECORD_ADAPTER.validate_python(record)
            vessels.append(
                _to_domain(wire, received_at=observed, ais_format=ais_format, source=source)
            )
        except ValidationError as exc:
            drops[_drop_reason(exc)] += 1
        except ValueError as exc:
            drops[str(exc)] += 1

    if drops:
        _log.info(
            "%s: kept %d vessels, dropped %d %s",
            source,
            len(vessels),
            sum(drops.values()),
            dict(drops),
        )
    return ParsedRecords(records=tuple(vessels), drops=drops)


class AishubClient:
    """Fetches vessels from AISHub, and refuses to call it wrongly.

    Holds one piece of state, the time of the last request, because the once-per-minute
    floor has to survive a caller polling on a shorter cadence. Keep one instance per
    process for that to mean anything.

    **That floor is deliberately not on disk**, unlike the others moved onto
    :class:`~tracker.cache.DiskCache` on 2026-08-20. Two reasons. It is a **monotonic** reading
    rather than a wall clock, and a monotonic value means nothing in another process, so
    persisting it would need it converted first: real work for no gain. And the restart case is
    already covered one level up, by the vessel poller's persisted floor, which is 60 seconds
    from the same provider figure. There is also nothing to protect today, because AISHub grants
    access only to members running a physical receiver and this client never calls at all
    without a username.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        username: str,
        base_url: str = BASE_URL,
        ais_format: Literal[0, 1] = FORMAT_HUMAN,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._client = client
        self._username = username.strip()
        self._base_url = base_url
        self._ais_format = ais_format
        self._monotonic = monotonic
        self._last_call_at: float | None = None

    @property
    def name(self) -> str:
        """Short identifier for this feed, used in health output and on every record."""
        return SOURCE_NAME

    @property
    def min_interval_seconds(self) -> float:
        """The provider's documented floor.

        Read-only and taken straight from :data:`MIN_INTERVAL_SECONDS`. There is no
        constructor argument and no setter, so no configuration can lower it.
        """
        return MIN_INTERVAL_SECONDS

    @property
    def available(self) -> bool:
        """Whether a username is configured. False until an AIS receiver is sited and accepted."""
        return bool(self._username)

    async def vessels(
        self,
        *,
        box: BoundingBox | None = None,
        mmsi: Sequence[str] | None = None,
        interval_minutes: int | None = None,
    ) -> ParsedRecords[Vessel]:
        """Fetch vessels, optionally bounded by a box, an MMSI list or a position age.

        Args:
            box: Bounding box. Sent as the provider's four separate parameters.
            mmsi: MMSIs to restrict the answer to, sent comma-separated.
            interval_minutes: Cap on the age of the positions returned, which is the
                parameter that keeps a worldwide poll cheap.

        Returns:
            The vessels that mapped, plus the drop counts.

        Raises:
            AishubUnavailableError: no username configured, or a call inside the
                once-per-minute floor, or the provider returned no usable data.
            RateLimitedError: the provider asked us to back off.
            ValueError: ``box`` crosses the antimeridian, which the provider's four
                parameters cannot express.
            ContractViolationError: the response shape or mode was not what we asked for.
        """
        if not self.available:
            raise AishubUnavailableError(SOURCE_NAME, NO_USERNAME_REASON)
        params = self._params(box, mmsi, interval_minutes)
        self._claim_call_slot()
        response = await self._client.get(self._base_url, params=params)
        if response.status_code in RATE_LIMIT_STATUS_CODES:
            raise RateLimitedError(SOURCE_NAME, response.status_code, retry_after_seconds(response))
        response.raise_for_status()
        return parse_response(response.content, source=SOURCE_NAME, ais_format=self._ais_format)

    def _claim_call_slot(self) -> None:
        """Enforce the once-per-minute floor, before the request rather than after it.

        The slot is claimed even if the request then fails, because retrying immediately
        after a failure is exactly what produces the empty body: an over-frequent call is
        one of the two things AISHub answers with no data at all.

        Raises:
            AishubUnavailableError: the floor has not elapsed since the previous call.
        """
        now = self._monotonic()
        if self._last_call_at is not None and now - self._last_call_at < MIN_INTERVAL_SECONDS:
            detail = (
                f"refusing to call AISHub {now - self._last_call_at:.1f}s after the previous "
                f"call; the floor is {MIN_INTERVAL_SECONDS:.0f}s and the provider answers an "
                "over-frequent call with no data at all"
            )
            raise AishubUnavailableError(SOURCE_NAME, detail)
        self._last_call_at = now

    def _params(
        self,
        box: BoundingBox | None,
        mmsi: Sequence[str] | None,
        interval_minutes: int | None,
    ) -> dict[str, str | float]:
        """Build the query, with the two parameters that must never be defaulted spelled out.

        Raises:
            ValueError: ``box`` crosses the antimeridian. The provider takes ``lonmin`` and
                ``lonmax``, which cannot express a box whose west edge is numerically east
                of its east edge, and sending it anyway returns everything except the ships
                asked for.
        """
        params: dict[str, str | float] = {
            "username": self._username,
            "output": OUTPUT_JSON,
            "format": self._ais_format,
            "compress": COMPRESS_NONE,
        }
        if box is not None:
            if box.crosses_antimeridian:
                msg = (
                    "AISHub's lonmin/lonmax box cannot express an antimeridian crossing; "
                    "query the two halves separately"
                )
                raise ValueError(msg)
            params |= {
                "latmin": box.south,
                "latmax": box.north,
                "lonmin": box.west,
                "lonmax": box.east,
            }
        if mmsi:
            params["mmsi"] = ",".join(mmsi)
        if interval_minutes is not None:
            params["interval"] = interval_minutes
        return params
