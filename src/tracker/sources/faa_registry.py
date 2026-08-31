"""FAA Releasable Aircraft Database: the US half of the asset ownership spine.

316,030 current US registrations, public domain, and the only registry in the group whose
join key needs no derivation. ``MASTER.txt`` carries ``MODE S CODE HEX``, which is the same
ICAO 24-bit address the ADS-B feeds broadcast, so an aircraft on the globe resolves to its
registered owner with a dictionary lookup and no request. Verified against the real
316,030-row file on 2026-08-20.

**This is a download, not a poll**, so it follows ``sources/geonames.py`` rather than
``sources/adsb.py``: one conditional request a day at most, the zip kept on disk, and an
index built in memory. Nothing here is on the hot path of a card opening.
:class:`FaaRegistry` owns the network and the disk; :class:`FaaRegistryIndex` owns the
lookup and has no client, which is what makes "resolving an owner issues zero requests" a
structural fact rather than a rule somebody has to remember.

**The fetch needs cloudscraper, and that was a decision rather than a convenience.**
``registry.faa.gov`` answers HTTP 403 from Akamai to the descriptive User-Agent AGENTS.md
mandates, across the whole host, ``robots.txt`` included, while that same ``robots.txt``
permits ``/database/``. Alexander Fanthome decided on 2026-08-20 that where ``robots.txt``
permits a path and the CDN refuses the User-Agent, the ``robots.txt`` governs, because a CDN
bot filter is not a stated directive. Recorded as U3 in ``docs/pending-decisions.md``. The
narrow scope matters: cloudscraper is for a bot filter and never for a provider who has
stated a route in, so it is not used for airplanes.live (which asks for an email) or the
ADS-B Exchange globe map (which disallows the paths by name and prohibits redistribution).

**GET, never HEAD.** Through cloudscraper a ``HEAD`` on the zip answers HTTP 503 with a 3KB
HTML body and a decoy ``Last-Modified`` of 2013, so a freshness check written as a HEAD
reports the source down every single day. The daily check is a conditional GET, and
``If-Modified-Since`` with the held value answers a real HTTP 304 with zero bytes. Measured
2026-08-20, both verbs.

**The extract date is the HTTP ``Last-Modified`` and there is no alternative.** Nothing in
the data carries one: 35 MASTER columns and 14 ACFTREF columns, and every date in them is
per-record. ADR 008 requires the extract date as the attribute date for the owner address,
so it comes off the header, which is RFC 7231 and explicitly GMT and therefore converts to
an aware UTC datetime cleanly. **The zip entry mtimes are not usable**: they are naive local
US central with no zone in the format at all, so reading them needs a hardcoded FAA timezone
and a DST rule.

**The owner address is ingested, not dropped** (ADR 008, and phase 5 acceptance 2). It
carries the registry as its source, the extract date as its date and a PII marker, and for
an individually registered aircraft it usually is a home address. That was decided
deliberately. An address with no date does not exist in this domain: if the extract date is
unknown the address is dropped and counted and the owner name survives, because losing one
attribute beats losing 316,030 ownership records.

**1.51% of rows arrive with no owner at all, and it is not LADD.** 4,773 of 316,030 rows
have a blank ``NAME`` and 4,771 a blank ``STREET``. That is 49 U.S.C. section 44114(b), a
withholding programme that operates on the registry rather than on flight data, and the
withholding has already happened upstream before we fetch anything. ADR 009 does not cover
it and there is no suppression logic to go looking for: the record simply arrives empty and
is dropped and counted like any other unmappable row. See ``docs/data-sources.md`` for the
provider's own wording.

**Nothing here reads a suppression list of any kind** (phase 5 acceptance 3). A LADD-listed
aircraft resolves to its owner exactly like any other, per ADR 009, and the only list in
this module is the ITU-style column layout below.

**DEREG.txt is deliberately not consumed.** The zip ships eight files and this module reads
two. ``DEREG.txt`` is 277,790,071 bytes uncompressed, larger than ``MASTER.txt`` itself, and
it is a history file: a deregistered aircraft is simply absent from ``MASTER.txt``, so the
live-feed join already answers "this registry does not hold that address" without it. What
DEREG adds is who *used* to own an airframe, which is a past-ownership claim and belongs
with the dated series in phase 6, not with the current ownership spine. No phase 5
acceptance criterion needs it and reading it would roughly double the parse and the resident
set for data nothing asks for. ``DEALER.txt``, ``ENGINE.txt``, ``RESERVED.txt`` and
``DOCINDEX.txt`` are skipped for the same reason.

Licence: public domain, US Government work under 17 U.S.C. section 105. No redistribution
grant is given because none is needed, and no attribution is required, though
:data:`ATTRIBUTION` names the source anyway because every layer in this product says where
its data came from.
"""

import asyncio
import csv
import io
import logging
import sys
import zipfile
from collections import Counter
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from enum import StrEnum
from pathlib import Path
from typing import IO, Final, NamedTuple

import cloudscraper  # type: ignore[import-untyped]
from pydantic import Field

from tracker.contracts.aircraft import Aircraft
from tracker.contracts.base import StrictModel, UtcDatetime
from tracker.sources.base import SourceError, describe_exception

_log = logging.getLogger(__name__)

SOURCE_NAME: Final = "faa"
"""Provenance on the card and the key this registry's drops are counted under."""

ATTRIBUTION: Final = (
    "Aircraft ownership from the FAA Releasable Aircraft Database "
    "(https://registry.faa.gov/database/ReleasableAircraft.zip), public domain"
)
"""Shown wherever an FAA-sourced owner is displayed."""

DOWNLOAD_URL: Final = "https://registry.faa.gov/database/ReleasableAircraft.zip"
"""The bulk zip. Verified 2026-08-20: HTTP 200, 73,046,130 bytes, x-zip-compressed."""

ARCHIVE_NAME: Final = "ReleasableAircraft.zip"
"""What the cached copy is called on disk, matching the last path segment of the URL."""

MASTER_MEMBER: Final = "MASTER.txt"
"""316,030 data rows, 194,042,820 bytes. The extension is ``.txt`` and the format is CSV."""

ACFTREF_MEMBER: Final = "ACFTREF.txt"
"""93,982 rows of make and model, joined on ``MASTER."MFR MDL CODE"``."""

MIN_REFRESH_INTERVAL_S: Final = 24.0 * 60.0 * 60.0
"""One day, and no constructor argument or setting can lower it.

The FAA states its own cadence: "The data in the download is refreshed daily at 11:30 pm
central time." No request cap is published, so this is our own floor and it is the provider's
own rebuild interval. A constant rather than a setting for the same reason CelesTrak's
two-hour floor is one: configuration may slow a fetch down and must never speed it up.
cloudscraper does not buy permission to poll harder.
"""

CONNECT_TIMEOUT_S: Final = 30.0
READ_TIMEOUT_S: Final = 300.0
"""Generous, because the body is 70MB. A 304 returns in well under a second."""

MAX_MEMBER_BYTES: Final = 320 * 1024 * 1024
"""Decompression ceiling per member, about 1.6x the real ``MASTER.txt``.

A zip is attacker-controllable in a way its ``Content-Length`` is not. Both members are read
as a stream rather than into memory, so this guard is about refusing an absurd member early
with a readable message rather than about bounding the heap: :data:`MAX_ROWS` does that.
"""

MAX_ROWS: Final = 2_000_000
"""Row ceiling on ``MASTER.txt``, about six times the real file.

The index is the only thing in this module that grows with the input, so this is the bound
that actually protects the process.
"""

OWNER_NAME_MAX_CHARS: Final = 120
"""Matches ``Aircraft.owner``, so a name that is legal here cannot fail the merge."""

REGISTRATION_MAX_CHARS: Final = 12
"""Matches ``Aircraft.registration``. An N-number plus its prefix is at most 6."""

ICAO_ADDRESS_HEX_DIGITS: Final = 6

MASTER_COLUMNS: Final = (
    "N-NUMBER",
    "SERIAL NUMBER",
    "MFR MDL CODE",
    "ENG MFR MDL",
    "YEAR MFR",
    "TYPE REGISTRANT",
    "NAME",
    "STREET",
    "STREET2",
    "CITY",
    "STATE",
    "ZIP CODE",
    "REGION",
    "COUNTY",
    "COUNTRY",
    "LAST ACTION DATE",
    "CERT ISSUE DATE",
    "CERTIFICATION",
    "TYPE AIRCRAFT",
    "TYPE ENGINE",
    "STATUS CODE",
    "MODE S CODE",
    "FRACT OWNER",
    "AIR WORTH DATE",
    "OTHER NAMES(1)",
    "OTHER NAMES(2)",
    "OTHER NAMES(3)",
    "OTHER NAMES(4)",
    "OTHER NAMES(5)",
    "EXPIRATION DATE",
    "UNIQUE ID",
    "KIT MFR",
    "KIT MODEL",
    "MODE S CODE HEX",
    "",
)
"""``MASTER.txt``'s header, verbatim and in order, with every name stripped.

The header is checked against this on every parse and a mismatch is fatal. That check is the
defence against the single most expensive mistake available in this file: ``MODE S CODE`` at
index 21 is the same number as ``MODE S CODE HEX`` at index 33 written in octal, matching on
20,000 of 20,000 sampled rows, so reading the wrong column yields ``50002263`` where
``A004B3`` was wanted and joins to nothing at all, silently and forever. Column indices below
are derived from this tuple rather than written out, so they cannot drift from it.

Two shape facts are baked in. The 35th entry is empty because there is a trailing comma on
the header and on every data row, which creates a column that is not a field. And the real
header for index 32 is ``" KIT MODEL"`` with a leading space, which is why the comparison
strips.
"""

ACFTREF_COLUMNS: Final = (
    "CODE",
    "MFR",
    "MODEL",
    "TYPE-ACFT",
    "TYPE-ENG",
    "AC-CAT",
    "BUILD-CERT-IND",
    "NO-ENG",
    "NO-SEATS",
    "AC-WEIGHT",
    "SPEED",
    "TC-DATA-SHEET",
    "TC-DATA-HOLDER",
    "",
)
"""``ACFTREF.txt``'s header, same trailing-comma column, same fatal mismatch check."""

_N_NUMBER: Final = MASTER_COLUMNS.index("N-NUMBER")
_MFR_MDL_CODE: Final = MASTER_COLUMNS.index("MFR MDL CODE")
_YEAR_MFR: Final = MASTER_COLUMNS.index("YEAR MFR")
_TYPE_REGISTRANT: Final = MASTER_COLUMNS.index("TYPE REGISTRANT")
_NAME: Final = MASTER_COLUMNS.index("NAME")
_STREET: Final = MASTER_COLUMNS.index("STREET")
_STREET2: Final = MASTER_COLUMNS.index("STREET2")
_CITY: Final = MASTER_COLUMNS.index("CITY")
_STATE: Final = MASTER_COLUMNS.index("STATE")
_ZIP_CODE: Final = MASTER_COLUMNS.index("ZIP CODE")
_COUNTRY: Final = MASTER_COLUMNS.index("COUNTRY")
_CERT_ISSUE_DATE: Final = MASTER_COLUMNS.index("CERT ISSUE DATE")
_STATUS_CODE: Final = MASTER_COLUMNS.index("STATUS CODE")
_EXPIRATION_DATE: Final = MASTER_COLUMNS.index("EXPIRATION DATE")
_MODE_S_HEX: Final = MASTER_COLUMNS.index("MODE S CODE HEX")
_OTHER_NAMES: Final = tuple(MASTER_COLUMNS.index(f"OTHER NAMES({n})") for n in range(1, 6))

_ACFT_CODE: Final = ACFTREF_COLUMNS.index("CODE")
_ACFT_MFR: Final = ACFTREF_COLUMNS.index("MFR")
_ACFT_MODEL: Final = ACFTREF_COLUMNS.index("MODEL")
_ACFT_NO_ENG: Final = ACFTREF_COLUMNS.index("NO-ENG")
_ACFT_NO_SEATS: Final = ACFTREF_COLUMNS.index("NO-SEATS")
_ACFT_WEIGHT: Final = ACFTREF_COLUMNS.index("AC-WEIGHT")
_ACFT_SPEED: Final = ACFTREF_COLUMNS.index("SPEED")

_HEX_DIGITS: Final = frozenset("0123456789abcdef")
_LAST_MODIFIED_SUFFIX: Final = ".last-modified"
_MASTER_DATE_CHARS: Final = 8
"""``YYYYMMDD``, bare, no separator, no zone. ``20230122``."""


class RegistrantType(StrEnum):
    """What kind of party holds the registration, from ``TYPE REGISTRANT``.

    This is the field that decides whether the registry address is likely to be a home
    address. It is not asserted as one: ADR 011 forbids asserting on a likelihood, and
    "usually" is not a fact. The type travels with the record and phase 6 decides.
    """

    INDIVIDUAL = "individual"
    PARTNERSHIP = "partnership"
    CORPORATION = "corporation"
    CO_OWNED = "co_owned"
    GOVERNMENT = "government"
    LLC = "llc"
    NON_CITIZEN_CORPORATION = "non_citizen_corporation"
    NON_CITIZEN_CO_OWNED = "non_citizen_co_owned"
    UNKNOWN = "unknown"


REGISTRANT_TYPE_CODES: Final[Mapping[str, RegistrantType]] = {
    "1": RegistrantType.INDIVIDUAL,
    "2": RegistrantType.PARTNERSHIP,
    "3": RegistrantType.CORPORATION,
    "4": RegistrantType.CO_OWNED,
    "5": RegistrantType.GOVERNMENT,
    "7": RegistrantType.LLC,
    "8": RegistrantType.NON_CITIZEN_CORPORATION,
    "9": RegistrantType.NON_CITIZEN_CO_OWNED,
}
"""The FAA's own codes. There is no 6, and a blank or unknown code is not a reason to drop
an ownership record, so it reads as :attr:`RegistrantType.UNKNOWN`."""


class OwnerAddress(StrictModel):
    """The registered owner's address as the FAA publishes it, dated and sourced.

    Ingested rather than dropped, per ADR 008: the registry address is a public record and
    the strongest match key in the dataset. For an individually registered aircraft it
    usually is a home address, and holding it was decided deliberately.

    ``as_of`` is the registry extract date and it is required. There is no such thing here as
    an undated address: ADR 008 drops an undated entry at the adapter, so this contract
    cannot express one.

    Unlike the SEC's ``rptOwnerStreet1`` and the Companies House PSC ``address``, this is not
    a service address standing in for a residence. The FAA publishes the registrant's own
    address, which is why 49 U.S.C. section 44114(b) exists to let owners have it withheld.
    """

    street: str | None = Field(default=None, max_length=60)
    street2: str | None = Field(default=None, max_length=60)
    city: str | None = Field(default=None, max_length=40)
    state: str | None = Field(default=None, max_length=2)
    postal_code: str | None = Field(
        default=None,
        max_length=12,
        description="ZIP as published, zero-padded and sometimes nine digits plus a "
        "trailing pad character. Kept verbatim rather than reformatted: it is a match key.",
    )
    country: str | None = Field(
        default=None,
        max_length=2,
        description="Not always US. 259 blanks and 41 RQ (Puerto Rico) in 20,000 sampled "
        "rows, so neither a default of US nor a required field is safe.",
    )
    as_of: UtcDatetime = Field(
        description="The registry extract date, from the zip's HTTP Last-Modified. Required: "
        "an address with no date is dropped at the adapter and counted."
    )
    source: str = Field(default=SOURCE_NAME, min_length=1, max_length=40)
    pii: bool = Field(
        default=True,
        description="Marks this as a contact attribute so the card and the API can serve a "
        "profile with it suppressed, mirroring the NoContactData and NoPII packages the "
        "business sells. A field rather than a comment because the suppression filter reads "
        "it off the serialised record, per ADR 008.",
    )


class FaaRegistration(StrictModel):
    """One current US registration, mapped from ``MASTER.txt`` and ``ACFTREF.txt``.

    Strict, frozen and safe to hand to :class:`~tracker.services.enrich.Enricher`, which is
    the same interface ``sources/adsbdb.py`` already feeds. Phase 5 adds registries behind
    that interface and writes no second enrichment service.

    ``extract_date`` dates the ownership claim itself and :attr:`OwnerAddress.as_of` dates
    the address attribute. They are the same instant and both are carried, because ADR 008
    dates each attribute entry separately and phase 6 will move the address onto a profile
    without the registration.
    """

    icao24: str = Field(
        pattern=r"^[0-9a-f]{6}$",
        description="ICAO 24-bit address, lowercase, from MODE S CODE HEX. The FAA publishes "
        "it uppercase and the ADS-B feeds send it lowercase; the feeds win because they are "
        "the merge key. MODE S CODE is the same number in octal and is never read.",
    )
    registration: str = Field(
        max_length=REGISTRATION_MAX_CHARS,
        description="Tail number with the N prefix restored. N-NUMBER carries no prefix: "
        "'100' means N100, and zero of 20,000 sampled rows start with an N.",
    )
    owner_name: str = Field(
        max_length=OWNER_NAME_MAX_CHARS,
        description="The registrant. Required, because a registration with no registrant is "
        "not an ownership record: see the 49 U.S.C. 44114(b) note in the module docstring.",
    )
    owner_type: RegistrantType = RegistrantType.UNKNOWN
    co_owner_names: tuple[str, ...] = Field(
        default=(),
        description="OTHER NAMES(1) to (5), blanks removed. Up to five co-owners.",
    )
    owner_address: OwnerAddress | None = Field(
        default=None,
        description="None means the registry published no address for this owner, or the "
        "extract date was unknown so the address was dropped and counted. Never a partial "
        "address and never an undated one.",
    )
    manufacturer: str | None = Field(default=None, max_length=80)
    model: str | None = Field(
        default=None,
        max_length=40,
        description="ACFTREF MODEL, e.g. '767-322'. **Not an ICAO type designator**: "
        "ACFTREF has none, and 'B763' is not derivable from this. The designator comes from "
        "adsbdb's icao_type or the feed's own t field, which is why nothing here writes "
        "Aircraft.type_designator.",
    )
    year_manufactured: int | None = Field(default=None, ge=1900, le=2100)
    seats: int | None = Field(default=None, ge=0, le=1000)
    engines: int | None = Field(
        default=None,
        ge=0,
        le=12,
        description="Zero-padded upstream ('02'). Zero is real and means a glider.",
    )
    weight_class: str | None = Field(
        default=None,
        max_length=16,
        description="AC-WEIGHT is a class string, 'CLASS 1' to 'CLASS 4', not a number. "
        "Carried verbatim because converting it to a mass would be inventing one.",
    )
    cruise_speed_kt: int | None = Field(
        default=None,
        ge=1,
        le=2000,
        description="SPEED, in knots. '0000' on most rows and there a zero means unknown "
        "rather than stationary, so it maps to None and the floor here is 1.",
    )
    status_code: str | None = Field(
        default=None,
        max_length=2,
        description="STATUS CODE as published. 'V' is a valid registration. Carried so an "
        "ownership claim resting on a lapsed registration can be told apart from a current "
        "one without a second lookup.",
    )
    cert_issue_date: UtcDatetime | None = Field(
        default=None,
        description="When the current certificate was issued, which dates the current "
        "registrant. Bare YYYYMMDD upstream with no separator and no zone; UTC is attached "
        "here, so the value is midnight UTC on the stated day and is a day rather than an "
        "instant. Attaching UTC is the choice made: the alternative under this project's "
        "rules is failing every registry date, and the FAA states no zone to honour.",
    )
    expiration_date: UtcDatetime | None = Field(
        default=None,
        description="Same format and the same attached UTC as cert_issue_date.",
    )
    extract_date: UtcDatetime | None = Field(
        default=None,
        description="When the FAA built the zip, from its HTTP Last-Modified. This dates "
        "the ownership claim. None only where the header was absent, in which case the "
        "owner address was dropped and counted rather than asserted undated.",
    )
    source: str = Field(default=SOURCE_NAME, min_length=1, max_length=40)


@dataclass(frozen=True, slots=True)
class RegistryTally:
    """What one parse kept and what it lost, in a shape the API can serve.

    Dropped and counted has to mean counted where a person can read it, so both counters
    live on the index and reach ``/api/layers`` through the wiring. Two counters rather than
    one because they are different losses: a record drop costs a whole airframe, an address
    drop costs one attribute on an airframe we kept.
    """

    registrations: int
    record_drops: Counter[str] = field(default_factory=Counter)
    address_drops: Counter[str] = field(default_factory=Counter)

    @property
    def records_dropped(self) -> int:
        """Rows that produced no registration at all."""
        return sum(self.record_drops.values())

    @property
    def addresses_dropped(self) -> int:
        """Registrations that kept their owner and lost the address."""
        return sum(self.address_drops.values())


@dataclass(frozen=True, slots=True)
class ArchiveResponse:
    """What one conditional GET reported, with the body already on disk.

    ``last_modified`` is the raw header, kept as sent so it can be echoed back verbatim in
    the next ``If-Modified-Since``. It is also the only extract date this registry has.
    """

    status_code: int
    last_modified: str | None = None


ArchiveFetch = Callable[[str, Mapping[str, str], Path], ArchiveResponse]
"""One conditional GET, streaming the body to a path. The seam tests substitute.

Narrow on purpose. Everything cloudscraper-shaped stays behind it, so a test needs no
``requests`` response double and the product never holds 70MB in memory.
"""


class _AcftRef(NamedTuple):
    """One ``ACFTREF.txt`` row, shared by every MASTER row that names its code.

    93,982 of these against 316,030 registrations, so holding a reference rather than
    copying six strings per row is most of the difference between a 175MB index and a 435MB
    one. Measured 2026-08-20.
    """

    manufacturer: str
    model: str
    engines: str
    seats: str
    weight_class: str
    cruise_speed: str


class _Row(NamedTuple):
    """One registration, stripped and stored, waiting to be validated on lookup.

    The index holds these rather than 316,030 :class:`FaaRegistration` instances: measured
    2026-08-20, the models cost 435MB resident against 175MB for the tuples, and building
    one back costs 1.2 microseconds. Every row in here has already been through
    :func:`_to_domain` once at parse time and mapped cleanly, so the count of what was
    dropped is still made at the adapter and one function is still the only mapping.
    """

    n_number: str
    registrant_type: str
    owner_name: str
    street: str
    street2: str
    city: str
    state: str
    postal_code: str
    country: str
    cert_issue: str
    expiration: str
    status: str
    year: str
    other_names: tuple[str, ...]
    acft: _AcftRef | None


def _now() -> datetime:
    """Wall clock, injectable so the daily floor is asserted rather than slept through."""
    return datetime.now(UTC)


def _text(raw: str, limit: int) -> str | None:
    """Strip, and turn a blank or an over-long value into ``None``.

    Every field in these files is space-padded to a fixed width inside a CSV: ``NAME`` came
    back as ``'BENE MARY D'`` plus 39 spaces and ``N-NUMBER`` as ``'100  '``. Nothing is
    usable unstripped.

    Over-long is dropped rather than clipped. A clipped street is a different address and a
    clipped ZIP is a different place, and both are match keys.
    """
    value = raw.strip()
    if not value or len(value) > limit:
        return None
    return value


def _optional_int(raw: str) -> int | None:
    """Parse a zero-padded count, treating a blank or unparseable value as absent.

    ``NO-SEATS`` is ``'015'`` and ``NO-ENG`` is ``'02'``. A leading zero is not an octal
    prefix to Python, but it is worth naming here given ``MODE S CODE`` is genuinely octal
    eight columns away.
    """
    value = raw.strip()
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _faa_date(raw: str) -> datetime | None:
    """Parse a bare ``YYYYMMDD`` registry date, attaching UTC.

    The FAA writes ``20230122`` with no separator and no zone. This project's rule is that a
    naive datetime is a validation error, so the choice is between attaching UTC and failing
    every date in the file. UTC is attached, the value is midnight on the stated day, and the
    contract's field descriptions say it is a day rather than an instant.

    Anything that is not eight digits reads as absent rather than raising. ``AIR WORTH DATE``
    is blank on plenty of rows and a blank optional date is not a reason to lose an airframe.
    """
    value = raw.strip()
    if len(value) != _MASTER_DATE_CHARS:
        return None
    try:
        return datetime.strptime(value, "%Y%m%d").replace(tzinfo=UTC)
    except ValueError:
        return None


def parse_extract_date(last_modified: str | None) -> datetime | None:
    """Turn the zip's ``Last-Modified`` header into the registry extract date.

    RFC 7231 fixdate, explicitly GMT: ``Wed, 19 Aug 2026 04:57:29 GMT``. This is the only
    extract date the FAA gives us, because nothing in the data carries one and the zip entry
    mtimes are naive local US central.

    Returns:
        An aware UTC datetime, or ``None`` when the header is missing or unparseable. A
        ``None`` here is what makes every owner address on that batch undated, and ADR 008
        then drops each one and counts it.
    """
    if not last_modified:
        return None
    try:
        parsed = parsedate_to_datetime(last_modified)
    except (TypeError, ValueError):
        _log.warning("%s: unparseable Last-Modified %r", SOURCE_NAME, last_modified)
        return None
    # A '-0000' offset parses to naive, which the domain refuses. RFC 7231 says GMT either
    # way, so UTC is attached rather than the batch being thrown away over a formatting
    # choice at the CDN.
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)


def _owner_address(row: _Row, extract_date: datetime | None) -> OwnerAddress | None:
    """Build the dated, sourced, PII-marked address, or return ``None`` to have it counted.

    Two ways to get ``None`` and the caller tells them apart: the registry published no
    address at all, or there is no extract date and ADR 008 will not hold an undated
    attribute.
    """
    if extract_date is None:
        return None
    parts = (row.street, row.street2, row.city, row.state, row.postal_code, row.country)
    if not any(part.strip() for part in parts):
        return None
    return OwnerAddress(
        street=_text(row.street, 60),
        street2=_text(row.street2, 60),
        city=_text(row.city, 40),
        state=_text(row.state, 2),
        postal_code=_text(row.postal_code, 12),
        country=_text(row.country, 2),
        as_of=extract_date,
    )


def _to_domain(icao24: str, row: _Row, extract_date: datetime | None) -> FaaRegistration:
    """Map one stored row to the domain contract.

    The only mapping in this module, called once per row at parse time so drops are counted
    at the adapter, and again on lookup so the index can stay compact. Both callers get the
    same object.

    Raises:
        ValueError: The row has no usable N-number or no owner name, or a value the contract
            will not take. The caller counts it and moves on.
        pydantic.ValidationError: A subclass of ``ValueError``, raised the same way.
    """
    n_number = _text(row.n_number, REGISTRATION_MAX_CHARS - 1)
    if n_number is None:
        msg = "N-NUMBER is blank"
        raise ValueError(msg)
    owner_name = _text(row.owner_name, OWNER_NAME_MAX_CHARS)
    if owner_name is None:
        # 4,773 of 316,030 rows. 49 U.S.C. section 44114(b), withheld upstream before we
        # fetched anything. Not LADD, not ADR 009, and there is no suppression logic here.
        msg = "no owner name: withheld upstream under 49 U.S.C. 44114(b), or absent"
        raise ValueError(msg)
    acft = row.acft
    return FaaRegistration(
        icao24=icao24,
        registration=f"N{n_number}",
        owner_name=owner_name,
        owner_type=REGISTRANT_TYPE_CODES.get(row.registrant_type.strip(), RegistrantType.UNKNOWN),
        co_owner_names=row.other_names,
        owner_address=_owner_address(row, extract_date),
        manufacturer=_text(acft.manufacturer, 80) if acft else None,
        model=_text(acft.model, 40) if acft else None,
        year_manufactured=_optional_int(row.year),
        seats=_optional_int(acft.seats) if acft else None,
        engines=_optional_int(acft.engines) if acft else None,
        weight_class=_text(acft.weight_class, 16) if acft else None,
        # 0000 means unknown, not stationary, and the contract's floor of 1 enforces it.
        cruise_speed_kt=_optional_int(acft.cruise_speed) or None if acft else None,
        status_code=_text(row.status, 2),
        cert_issue_date=_faa_date(row.cert_issue),
        expiration_date=_faa_date(row.expiration),
        extract_date=extract_date,
    )


def _rows(member: IO[bytes], columns: tuple[str, ...], name: str) -> Iterator[list[str]]:
    """Read one member as CSV, checking its header and refusing a reshaped file.

    ``utf-8-sig`` because a UTF-8 BOM sits on the header line of both members: naive parsing
    produces a column literally named ``﻿N-NUMBER``. The ``csv`` module is used even
    though these files contain zero double-quote characters, so a name with a comma corrupts
    a row undetectably. Quoting saves nobody here; the field-count check downstream is what
    catches the damage.

    Raises:
        SourceError: The header is not the header we mapped against.
    """
    reader = csv.reader(io.TextIOWrapper(member, encoding="utf-8-sig", newline=""))
    try:
        header = tuple(cell.strip() for cell in next(reader, []))
    except csv.Error as exc:
        raise SourceError(SOURCE_NAME, f"{name} is not readable as CSV: {exc}") from exc
    if header != columns:
        raise SourceError(
            SOURCE_NAME,
            f"{name} header changed: expected {len(columns)} columns starting "
            f"{columns[:3]}, got {len(header)} starting {header[:3]}",
        )
    return reader


def parse_acftref(member: IO[bytes]) -> dict[str, _AcftRef]:
    """Index ``ACFTREF.txt`` by its ``CODE``, which is what MASTER joins on.

    The join is complete on the real file: 0 of 316,030 MASTER rows carry a code missing
    from here, across 93,982 unique keys with no duplicates. So a plain dict is safe and the
    left join below exists only because the two committed test extracts were sliced
    independently and share no codes.

    Raises:
        SourceError: The header changed.
    """
    intern = sys.intern
    table: dict[str, _AcftRef] = {}
    for row in _rows(member, ACFTREF_COLUMNS, ACFTREF_MEMBER):
        if len(row) != len(ACFTREF_COLUMNS):
            continue
        table[row[_ACFT_CODE].strip()] = _AcftRef(
            manufacturer=row[_ACFT_MFR].strip(),
            model=row[_ACFT_MODEL].strip(),
            engines=intern(row[_ACFT_NO_ENG].strip()),
            seats=intern(row[_ACFT_NO_SEATS].strip()),
            weight_class=intern(row[_ACFT_WEIGHT].strip()),
            cruise_speed=intern(row[_ACFT_SPEED].strip()),
        )
    return table


def _store_row(row: list[str], acftref: Mapping[str, _AcftRef]) -> _Row:
    """Strip one MASTER row into the compact form the index holds.

    ``sys.intern`` on the low-cardinality columns because 316,030 rows share about 60 states,
    a handful of country and status codes and roughly 20,000 distinct dates, so interning
    turns each of those into one string object and a pointer.
    """
    intern = sys.intern
    return _Row(
        n_number=row[_N_NUMBER].strip(),
        registrant_type=intern(row[_TYPE_REGISTRANT].strip()),
        owner_name=row[_NAME].strip(),
        street=row[_STREET].strip(),
        street2=row[_STREET2].strip(),
        city=row[_CITY].strip(),
        state=intern(row[_STATE].strip()),
        postal_code=row[_ZIP_CODE].strip(),
        country=intern(row[_COUNTRY].strip()),
        cert_issue=intern(row[_CERT_ISSUE_DATE].strip()),
        expiration=intern(row[_EXPIRATION_DATE].strip()),
        status=intern(row[_STATUS_CODE].strip()),
        year=intern(row[_YEAR_MFR].strip()),
        other_names=tuple(filter(None, (row[i].strip() for i in _OTHER_NAMES))),
        acft=acftref.get(row[_MFR_MDL_CODE].strip()),
    )


def _icao24(row: list[str]) -> str | None:
    """The join key, folded to lowercase, or ``None`` when it is unusable.

    ``MODE S CODE HEX`` is uppercase and space-padded and adsb.lol is lowercase, so the fold
    happens here and once. Column 33, never column 21: ``MODE S CODE`` is the identical
    number in octal and matched on 20,000 of 20,000 sampled rows.
    """
    value = row[_MODE_S_HEX].strip().lower()
    if len(value) != ICAO_ADDRESS_HEX_DIGITS or not _HEX_DIGITS.issuperset(value):
        return None
    return value


class FaaRegistryIndex:
    """Every current US registration, keyed on the lowercase ICAO 24-bit address.

    Holds no HTTP client and issues no request, which is phase 5 acceptance 1 made
    structural: an aircraft in view resolves to its owner from memory.

    Built by :func:`parse_registry`. One process owns one of these and replaces it wholesale
    when a new extract lands, so a lookup never sees a half-built index.
    """

    __slots__ = ("_extract_date", "_rows", "_tally")

    def __init__(
        self,
        rows: dict[str, _Row],
        *,
        extract_date: datetime | None,
        tally: RegistryTally,
    ) -> None:
        self._rows = rows
        self._extract_date = extract_date
        self._tally = tally

    def __len__(self) -> int:
        return len(self._rows)

    @property
    def extract_date(self) -> datetime | None:
        """When the FAA built this extract, from the zip's HTTP ``Last-Modified``."""
        return self._extract_date

    @property
    def tally(self) -> RegistryTally:
        """What this parse kept and what it dropped, for the API to serve."""
        return self._tally

    def registration(self, icao24: str) -> FaaRegistration | None:
        """The registration for one ICAO 24-bit address, or ``None`` if the FAA has none.

        Case-folded on the way in, because the FAA publishes uppercase and the feeds send
        lowercase and a card must not care which it holds.

        ``None`` means the register does not hold this address, which is normal: US military
        aircraft are not on the civil register, and of 326 A-prefix hexes across the recorded
        live captures 315 missed and every single miss was military.
        """
        row = self._rows.get(icao24.strip().lower())
        if row is None:
            return None
        return _to_domain(icao24.strip().lower(), row, self._extract_date)


def parse_registry(
    master: IO[bytes],
    acftref: IO[bytes],
    *,
    extract_date: datetime | None,
) -> FaaRegistryIndex:
    """Build the index from the two members, dropping and counting everything unmappable.

    Both members are read as streams. ``MASTER.txt`` is 194MB uncompressed and holding it as
    bytes would cost more than the index it produces.

    Every row goes through :func:`_to_domain` here so a row that will not satisfy the
    contract is dropped at the adapter and counted, then the stripped row is stored and the
    model thrown away. The measurement behind that is on :class:`_Row`.

    Args:
        master: Open ``MASTER.txt`` stream.
        acftref: Open ``ACFTREF.txt`` stream.
        extract_date: The zip's ``Last-Modified`` as an aware UTC datetime. ``None`` means
            every owner address in this batch is undated and is dropped and counted, per
            ADR 008, while the owner names survive.

    Raises:
        SourceError: A header changed, the row ceiling was passed, or not one row mapped.
    """
    table = parse_acftref(acftref)
    rows: dict[str, _Row] = {}
    record_drops: Counter[str] = Counter()
    address_drops: Counter[str] = Counter()

    for raw in _rows(master, MASTER_COLUMNS, MASTER_MEMBER):
        if len(raw) != len(MASTER_COLUMNS):
            record_drops[f"row has {len(raw)} fields, expected {len(MASTER_COLUMNS)}"] += 1
            continue
        icao24 = _icao24(raw)
        if icao24 is None:
            record_drops["MODE S CODE HEX is not a six-digit hex address"] += 1
            continue
        if icao24 in rows:
            # Two owners on one address would break ADR 010's one-record-per-hex rule
            # downstream, where it would read as a merge bug rather than as registry data.
            record_drops["duplicate Mode S hex; the first row wins"] += 1
            continue
        row = _store_row(raw, table)
        try:
            registration = _to_domain(icao24, row, extract_date)
        except ValueError as exc:
            record_drops[_drop_reason(exc)] += 1
            continue
        if registration.owner_address is None:
            address_drops[
                "owner address undated: no extract date on the zip"
                if extract_date is None
                else "the registry published no address for this owner"
            ] += 1
        rows[icao24] = row
        if len(rows) > MAX_ROWS:
            raise SourceError(SOURCE_NAME, f"{MASTER_MEMBER} exceeded the {MAX_ROWS} row ceiling")

    if not rows:
        raise SourceError(
            SOURCE_NAME,
            f"no usable rows in {MASTER_MEMBER} ({sum(record_drops.values())} dropped); "
            "treating as an upstream shape change, not as an empty register",
        )
    tally = RegistryTally(
        registrations=len(rows), record_drops=record_drops, address_drops=address_drops
    )
    if record_drops or address_drops:
        _log.info(
            "%s: kept %d registrations, dropped %d rows %r and %d addresses %r",
            SOURCE_NAME,
            len(rows),
            tally.records_dropped,
            dict(record_drops),
            tally.addresses_dropped,
            dict(address_drops),
        )
    return FaaRegistryIndex(rows, extract_date=extract_date, tally=tally)


def _drop_reason(exc: ValueError) -> str:
    """One readable reason per dropped row, short enough to be a counter key.

    A pydantic ``ValidationError`` stringifies to several lines with a documentation URL, and
    that as a Counter key gives one bucket per row instead of one per reason.
    """
    if type(exc) is ValueError:
        return str(exc)
    return "row does not satisfy the FaaRegistration contract"


def read_archive(path: Path, extract_date: datetime | None) -> FaaRegistryIndex:
    """Open the zip on disk and parse its two members, streaming both.

    Raises:
        SourceError: Not a zip, a member is missing, a member declares more than
            :data:`MAX_MEMBER_BYTES` decompressed, or the parse failed.
    """
    try:
        with zipfile.ZipFile(path) as bundle:
            for name in (MASTER_MEMBER, ACFTREF_MEMBER):
                declared = bundle.getinfo(name).file_size
                if declared > MAX_MEMBER_BYTES:
                    raise SourceError(
                        SOURCE_NAME,
                        f"{name} declares {declared} bytes, over the "
                        f"{MAX_MEMBER_BYTES} byte decompression ceiling",
                    )
            with bundle.open(MASTER_MEMBER) as master, bundle.open(ACFTREF_MEMBER) as acftref:
                return parse_registry(master, acftref, extract_date=extract_date)
    except (zipfile.BadZipFile, KeyError, OSError) as exc:
        raise SourceError(SOURCE_NAME, f"{path.name} is not readable: {exc!r}") from exc


def apply_to_aircraft(aircraft: Aircraft, registration: FaaRegistration) -> Aircraft:
    """Write the registry's facts onto a live aircraft, and nothing else.

    The merge half of the join. :class:`~tracker.services.enrich.Enricher` calls this and
    then reverts any attribute the feed already supplied, keeping the disagreement as a
    conflict, so this maps generously and the service arbitrates.

    Three fields. ``owner`` and ``registered_country`` are what the registry is for.
    ``registration`` is mapped because a feed record often carries none and the FAA's is
    authoritative for a US airframe.

    Three fields deliberately not mapped. **No ``type_designator``**: ACFTREF's ``MODEL`` is
    ``'767-322'`` and not ``'B763'``, there is no ICAO designator anywhere in the file, and
    writing a model into a designator field would declassify every business jet keyed on the
    designator. **No ``operator``**: the FAA publishes a registrant, and a registrant is not
    an operator. **Nothing touching ``on_ladd``, ``uses_privacy_address`` or any flag**: per
    ADR 009 a LADD-listed aircraft resolves like any other and this path reads no list.

    ``COUNTRY`` is blank on 259 of 20,000 sampled rows, so ``registered_country`` can come
    back ``None`` on a record the registry does hold.

    Raises:
        pydantic.ValidationError: The registry sent something the aircraft contract will not
            take, which the enrichment service counts as unmappable while keeping the feed's
            own record. The round trip through the wire format is what this project
            guarantees for every contract.
    """
    country = registration.owner_address.country if registration.owner_address else None
    proposed = aircraft.model_copy(
        update={
            "owner": registration.owner_name,
            "registered_country": country,
            "registration": registration.registration,
        }
    )
    return Aircraft.model_validate_json(proposed.model_dump_json())


def download_archive(url: str, headers: Mapping[str, str], destination: Path) -> ArchiveResponse:
    """One conditional GET through cloudscraper, streamed straight to ``destination``.

    The default :data:`ArchiveFetch`. cloudscraper because ``registry.faa.gov`` answers 403
    from Akamai to a descriptive User-Agent across the whole host while its own
    ``robots.txt`` permits this path: see the module docstring and U3 in
    ``docs/pending-decisions.md``. ``create_scraper()`` with no browser profile is enough;
    default, chrome/windows, firefox/linux and chrome/darwin all behaved identically on
    2026-08-20, so nothing is configured that buys nothing.

    GET and never HEAD. Through cloudscraper a HEAD answers HTTP 503 with a decoy
    ``Last-Modified`` of 2013, so a HEAD freshness check reports the source down every day.

    Nothing is written to ``destination`` on a 304, because a 304 has no body.
    """
    scraper = cloudscraper.create_scraper()
    with scraper.get(
        url,
        headers=dict(headers),
        timeout=(CONNECT_TIMEOUT_S, READ_TIMEOUT_S),
        stream=True,
    ) as response:
        status = int(response.status_code)
        last_modified = response.headers.get("Last-Modified")
        if status == 200:  # noqa: PLR2004 - the only status with a body worth keeping
            with destination.open("wb") as sink:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    sink.write(chunk)
    return ArchiveResponse(status_code=status, last_modified=last_modified)


class FaaRegistry:
    """The daily conditional download, the disk copy, and the index built from it.

    Owns the network and the disk and nothing else. The lookup lives on
    :class:`FaaRegistryIndex`, which has no client, so an owner resolves with no request at
    request time.

    :meth:`load` is what a caller schedules. :meth:`aircraft` is what a card calls, and it
    never fetches: an async lookup that might pull 70MB while a card is opening is not a
    lookup. One process owns one of these and it keeps two files under ``cache_dir``, the zip
    as served and the ``Last-Modified`` that came with it. The header is persisted because it
    is both the conditional-request validator and the extract date, so a process that
    restarts without it would re-download 70MB to learn nothing changed and would then have
    no date to hang the owner addresses on.
    """

    def __init__(
        self,
        *,
        cache_dir: Path,
        fetch: ArchiveFetch = download_archive,
        clock: Callable[[], datetime] = _now,
    ) -> None:
        self._path = cache_dir / ARCHIVE_NAME
        self._header_path = self._path.with_suffix(self._path.suffix + _LAST_MODIFIED_SUFFIX)
        self._fetch = fetch
        self._clock = clock
        self._index: FaaRegistryIndex | None = None
        self._last_error: str | None = None

    @property
    def index(self) -> FaaRegistryIndex | None:
        """The current index, or ``None`` before the first successful load."""
        return self._index

    @property
    def last_error(self) -> str | None:
        """Why the last refresh failed, or ``None``.

        Set alongside a successful load when the refresh failed and the disk copy was parsed
        instead. A day-old register is worth far more than an empty one, so the failure is
        reported rather than raised and a card can say which extract it is quoting.
        """
        return self._last_error

    @property
    def refreshed_at(self) -> datetime | None:
        """When the disk copy was last confirmed current, or ``None`` if there is none.

        A 304 counts as confirmation: the zip we hold is the zip the FAA has.
        """
        try:
            stat = self._path.stat()
        except OSError:
            return None
        return datetime.fromtimestamp(stat.st_mtime, tz=UTC)

    async def load(self) -> FaaRegistryIndex:
        """Refresh at most once a day, then build and keep the index.

        Inside the day this touches no socket. Outside it, one conditional GET goes out and a
        304 costs nothing but a restamp. The download and the 316,030-row parse both run on a
        worker thread, because cloudscraper is synchronous and a nine-figure-byte parse on
        the event loop stalls every other layer.

        Raises:
            SourceError: There is no disk copy and the download failed, or the zip that
                arrived is unusable and there is nothing to fall back on.
        """
        confirmed_at = self.refreshed_at
        if confirmed_at is not None:
            age = (self._clock() - confirmed_at).total_seconds()
            if age < MIN_REFRESH_INTERVAL_S:
                if self._index is not None:
                    return self._index
                return await self._reindex()
        return await asyncio.to_thread(self._refresh)

    async def aircraft(self, icao24: str) -> FaaRegistration | None:
        """Look one ICAO 24-bit address up locally. Never touches the network.

        Shaped for :class:`~tracker.services.enrich.Enricher`: ``None`` means the register
        answered and does not hold this airframe, and a raise means we could not ask, so the
        enrichment tally counts a miss and a fault separately.

        Raises:
            SourceError: Nothing has been loaded yet. Returning ``None`` instead would claim
                the FAA does not hold an airframe nobody has looked for.
        """
        index = self._index
        if index is None:
            raise SourceError(SOURCE_NAME, "the register has not been loaded yet")
        return index.registration(icao24)

    async def _reindex(self) -> FaaRegistryIndex:
        """Parse the copy on disk without asking the network anything.

        The restart path. Inside the day the zip on disk is the current extract by
        definition, so a process that comes back up re-reads it and sends no request.
        """
        held = self._read_header()
        index = await asyncio.to_thread(read_archive, self._path, parse_extract_date(held))
        self._index = index
        return index

    def _refresh(self) -> FaaRegistryIndex:
        """The blocking half of :meth:`load`, run on a worker thread."""
        held = self._read_header()
        temporary = self._path.with_suffix(self._path.suffix + ".part")
        try:
            response = self._fetch(
                DOWNLOAD_URL,
                {"If-Modified-Since": held} if held and self._path.exists() else {},
                temporary,
            )
        except Exception as exc:  # noqa: BLE001 - cloudscraper wraps requests, urllib3 and ssl
            temporary.unlink(missing_ok=True)
            return self._degrade(f"unreachable: {describe_exception(exc)}", held)

        if response.status_code == 304:  # noqa: PLR2004 - not modified, and there is no body
            temporary.unlink(missing_ok=True)
            if not self._path.exists():
                # We sent a validator for a file we no longer hold, so the 304 is unusable.
                return self._degrade("HTTP 304 but no cached zip to serve", held)
            self._touch()
            self._last_error = None
            _log.info("%s: zip unchanged (HTTP 304), serving the copy on disk", SOURCE_NAME)
            return self._parse(held)

        if response.status_code != 200:  # noqa: PLR2004
            temporary.unlink(missing_ok=True)
            return self._degrade(f"HTTP {response.status_code} for the zip", held)

        return self._install(temporary, response.last_modified, held)

    def _install(
        self, temporary: Path, last_modified: str | None, held: str | None
    ) -> FaaRegistryIndex:
        """Validate what arrived, then let it replace the copy on disk.

        Validated before it is installed, never after. A CDN error page served with HTTP 200
        is a usable-looking body that is not a zip, and installing it first destroys the copy
        on disk and gives the replacement a fresh mtime, so the daily floor would then
        short-circuit onto the poison for a day with no further request. An outright 503 is
        strictly kinder than that, which is the wrong way round.
        """
        extract_date = parse_extract_date(last_modified)
        if extract_date is None:
            # Not fatal, and this is the path phase 5 acceptance 2 turns on: the owner names
            # land and every address is dropped and counted rather than asserted undated.
            _log.warning(
                "%s: no usable Last-Modified on the zip; every owner address in this "
                "extract will be dropped and counted as undated",
                SOURCE_NAME,
            )
        try:
            index = read_archive(temporary, extract_date)
        except SourceError as exc:
            temporary.unlink(missing_ok=True)
            return self._degrade(f"HTTP 200 but {exc.detail}", held)
        try:
            temporary.replace(self._path)
            self._write_header(last_modified)
        except OSError as exc:
            # The index is already built, so this run works. Only the next restart pays, by
            # re-downloading rather than sending If-Modified-Since.
            _log.warning("%s: could not cache the zip at %s: %s", SOURCE_NAME, self._path, exc)
        self._index = index
        self._last_error = None
        _log.info(
            "%s: installed extract dated %s with %d registrations",
            SOURCE_NAME,
            extract_date.isoformat() if extract_date else "unknown",
            len(index),
        )
        return index

    def _parse(self, held: str | None) -> FaaRegistryIndex:
        """Parse the disk copy, recording the reason if those bytes turn out unusable.

        Without this the reason is thrown away: a copy on disk that will not open raises past
        the caller, ``last_error`` stays ``None``, and the layer then reports that the
        register has not been read when it was read and failed.
        """
        try:
            index = read_archive(self._path, parse_extract_date(held))
        except SourceError as exc:
            self._last_error = exc.detail
            raise
        self._index = index
        return index

    def _degrade(self, reason: str, held: str | None) -> FaaRegistryIndex:
        """Record a failed refresh, serving the copy on disk if there is one."""
        self._last_error = reason
        if self._index is not None:
            _log.warning("%s: refresh failed (%s); keeping the index in hand", SOURCE_NAME, reason)
            return self._index
        if not self._path.exists():
            raise SourceError(SOURCE_NAME, f"{reason}; no cached zip to fall back on")
        _log.warning("%s: refresh failed (%s); parsing the copy on disk", SOURCE_NAME, reason)
        try:
            return self._parse(held)
        except SourceError as exc:
            raise SourceError(SOURCE_NAME, f"{reason}; and {exc.detail}") from exc

    def _read_header(self) -> str | None:
        """The ``Last-Modified`` that came with the copy on disk, or ``None``."""
        try:
            value = self._header_path.read_text(encoding="utf-8").strip()
        except OSError:
            return None
        return value or None

    def _write_header(self, last_modified: str | None) -> None:
        """Persist the validator, or clear a stale one when the response carried none."""
        self._header_path.parent.mkdir(parents=True, exist_ok=True)
        if last_modified:
            self._header_path.write_text(last_modified, encoding="utf-8")
        else:
            self._header_path.unlink(missing_ok=True)

    def _touch(self) -> None:
        """Restart the day after a 304, without rewriting 70MB."""
        try:
            self._path.touch()
        except OSError as exc:
            _log.warning("%s: could not restamp %s: %s", SOURCE_NAME, self._path, exc)


def next_refresh_after(confirmed_at: datetime) -> datetime:
    """When the earliest legitimate next fetch is, given the last confirmation.

    Exported so a caller can schedule against the floor instead of guessing at it, and so
    the floor has exactly one implementation.
    """
    return confirmed_at + timedelta(seconds=MIN_REFRESH_INTERVAL_S)
