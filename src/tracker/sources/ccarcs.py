"""Transport Canada CCARCS: the Canadian aircraft register, joined on the Mode S address.

The Canadian Civil Aircraft Register, 34,897 current registrations, keyless and served to
this project's own descriptive User-Agent with no bot filter of any kind. Verified live on
2026-08-24: HTTP 200, **4,507,573 bytes**, ``application/x-zip-compressed``,
``Last-Modified: Mon, 24 Aug 2026 15:42:02 GMT``, three members expanding to 37,591,773 bytes.

It is the second register in the ownership spine and the only other one that joins on the
same key the ADS-B feeds broadcast, which is what makes it worth having: a Canadian aircraft
on the globe resolves to its registered owner with a dictionary lookup and no request, exactly
as a US one does.

**The Mode S address is present and it is binary text, which is the trap in this file.** Field
44 of ``carscurr.txt``, zero-based index 42, ``MODE_S_TRANSPONDER_BINARY``, is a **24-character
string of ``0`` and ``1``**. Measured over the whole live file on 2026-08-24: all 34,897 rows
are exactly 24 binary characters with zero blanks, and ``f"{int(value, 2):06x}"`` derives
34,897 distinct hex addresses with **zero duplicates, every one of them in the ``c0`` block**.
Reading it as hexadecimal or as a decimal integer does not raise, it silently produces a
different aircraft.

**A ``c2`` or ``c3`` hex is Canadian military and this register will never hold it.** CCARCS
is the civil register and derives into ``c0`` only, so a miss there is the ordinary negative
rather than a fault, the same way a US military ``ae`` hex misses the FAA.

**Individual owners are dropped and counted, and that is a licence requirement rather than a
preference.** The Open Government Licence - Canada, which is what Transport Canada publishes
this under, states under *Exemptions*, verbatim and verified live on 2026-08-24: "This licence
does not grant you any right to use: **Personal Information**". A named natural person's home
address on this register is personal information, so there is no grant to use it and it never
enters the domain. The adapter drops the row at the boundary and counts it under a named
reason, so the loss is visible rather than silent.

The cost is measured and it is the right cost. Of 38,509 owner rows, 24,761 are typed
``Individual`` and 13,748 ``Entity``; of the 36,310 with an active address, 23,055 are
individuals and 13,255 are entities, and **13,067 aircraft keep at least one entity owner**.
Every dropped row is one the ownership spine would have refused anyway:
``services/spine.py`` never name-matches a natural person, on a measurement that found two
candidates for 23 such owners and both were wrong. So the licence and this project's own harm
rule point the same way, and the airframe survives the drop with its type, its mark and its
Mode S address intact.

**``ACTIVE_FLAG`` is not decoration.** 2,199 of 38,509 owner rows carry ``I`` for an inactive
address. Ingesting one as current attaches an owner to somewhere they have left, so an
inactive row is dropped and counted like any other unmappable record.

**``robots.txt`` on this host is ``Disallow: /`` and that is unratified ground.** Verified
2026-08-24: ``wwwapps.tc.gc.ca/robots.txt`` is 28 bytes reading ``User-agent: *`` then
``Disallow: /``, which covers the zip. This project already relies on the provisional reading
recorded as **R4** in ``docs/pending-decisions.md``, that ``robots.txt`` binds crawling rather
than a scheduled conditional fetch of a published, licensed bulk data file, and the GeoNames
gazetteer in ``sources/geonames.py`` runs on the same reading. Anyone relying on it should get
it ratified rather than treat this module as precedent. The download page itself is an
ASP.NET postback behind a licence agreement whose form posts a 302 to this exact path, so the
direct URL is the provider's own, not a guessed one.

Other traps, each of which has a guard below:

- **The files are cp1252, not UTF-8**, and fail UTF-8 decoding at byte 342 of ``carscurr.txt``.
  Every French column carries accented characters.
- **Neither data file has a header row.** The column names live only in ``carslayout.txt``,
  which ships inside the same zip, so :func:`parse_layout` reads it and
  :func:`_check_layout` fails the parse when a field has moved. That is this register's
  equivalent of the FAA's fatal header check, and it exists for the same reason: without it a
  column shift reads the wrong field silently and forever.
- **``MARK`` is leading-space padded and carries no country prefix.** The raw value is
  ``" AAC"`` and not one row starts with ``C-``, so the registration is built from
  ``TRIMMED_MARK`` with ``C-`` prepended.
- **Blank and single-column junk lines are present**, two in each data file, which is why the
  field-count check drops rather than raises.
- **The layout file's own field coding is wrong.** It documents ``TYPE_OF_OWNER_E`` as
  "1=Individual, 2=Company, M=Manufacturer"; the real values are the strings ``Individual``
  and ``Entity`` and nothing else. Trust the data, not the dictionary.
- **Up to 12 owners share one mark**, so co-ownership is normal rather than exceptional.
- Dates are ``YYYY/MM/DD``, a third format alongside the FAA's ``YYYYMMDD`` and CASA's
  ``DD/MM/YYYY``. Country fields are space-padded to 100 characters. Every field is
  double-quote delimited, unlike the FAA files which use no quoting at all.

Licence: Open Government Licence - Canada, attribution mandatory and reproduced in
:data:`ATTRIBUTION`, personal information excluded from the grant as above.
"""

import csv
import io
import logging
import re
import sys
import zipfile
from collections import Counter, defaultdict
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import IO, Final, NamedTuple

from pydantic import Field

from tracker.contracts.aircraft import Aircraft
from tracker.contracts.base import StrictModel, UtcDatetime
from tracker.sources.base import SourceError

_log = logging.getLogger(__name__)

SOURCE_NAME: Final = "ccarcs"
"""Provenance on the card and the key this register's drops are counted under."""

ATTRIBUTION: Final = (
    "Aircraft ownership from the Canadian Civil Aircraft Register (CCARCS), "
    "Transport Canada, under the Open Government Licence - Canada"
)
"""Shown wherever a CCARCS-sourced owner is displayed. Attribution is a licence condition."""

DOWNLOAD_URL: Final = "https://wwwapps.tc.gc.ca/saf-sec-sur/2/ccarcs-riacc/download/ccarcsdb.zip"
"""The bulk zip. Verified 2026-08-24: HTTP 200, 4,507,573 bytes. The path is case-insensitive."""

ARCHIVE_NAME: Final = "ccarcsdb.zip"
"""What the cached copy is called on disk, matching the last path segment of the URL."""

LAYOUT_MEMBER: Final = "carslayout.txt"
CURRENT_MEMBER: Final = "carscurr.txt"
OWNER_MEMBER: Final = "carsownr.txt"

ENCODING: Final = "cp1252"
"""Not UTF-8, and not a guess: ``carscurr.txt`` fails UTF-8 decoding at byte 342."""

MIN_REFRESH_INTERVAL_S: Final = 24.0 * 60.0 * 60.0
"""One day, and no constructor argument or setting can lower it.

Transport Canada publishes no cadence and no request cap, so this is our own floor. A constant
rather than a setting for the same reason CelesTrak's two-hour floor is one: configuration may
slow a fetch down and must never speed it up. The provider's ``Last-Modified`` moved on the day
of verification, so a day is also roughly its own rebuild interval.
"""

MAX_MEMBER_BYTES: Final = 64 * 1024 * 1024
"""Decompression ceiling per member, about 2.5x the real ``carscurr.txt``.

A zip is attacker-controllable in a way its ``Content-Length`` is not. Both data members are
read as streams, so this refuses an absurd member early with a readable message rather than
bounding the heap: :data:`MAX_ROWS` does that.
"""

MAX_ROWS: Final = 500_000
"""Row ceiling per data member, about 13 times the real files."""

CURRENT_FIELDS: Final = 47
OWNER_FIELDS: Final = 20
"""Field counts, checked per row because both files carry two junk lines with 0 and 1 field."""

ICAO_ADDRESS_BITS: Final = 24
CIVIL_HEX_PREFIX: Final = "c0"
"""Every one of the 34,897 live rows derives into this block. A ``c2``/``c3`` hex is military."""

OWNER_NAME_MAX_CHARS: Final = 120
REGISTRATION_MAX_CHARS: Final = 12

_BINARY_DIGITS: Final = frozenset("01")
_CCARCS_DATE: Final = re.compile(r"^(\d{4})/(\d{2})/(\d{2})$")

ENTITY_OWNER: Final = "Entity"
INDIVIDUAL_OWNER: Final = "Individual"
"""The only two values ``TYPE_OF_OWNER_E`` takes. The layout file's ``1``/``2``/``M`` is wrong."""

ACTIVE_ADDRESS: Final = "A"

DROP_PERSONAL_INFORMATION: Final = (
    "owner is a natural person; the Open Government Licence - Canada grants no right to use "
    "personal information"
)
DROP_INACTIVE_ADDRESS: Final = "owner address is flagged inactive"

# ``carslayout.txt`` writes one field per line as a right-aligned ordinal, the column name
# twice, an Oracle type and a description. The file-name rows (``CARSCURR.TXT``) separate the
# two tables and carry the literal type ``FILE``.
_LAYOUT_ROW: Final = re.compile(r"^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)")
_LAYOUT_FILE_TYPE: Final = "FILE"

EXPECTED_CURRENT_COLUMNS: Final[Mapping[int, str]] = {
    0: "MARK",
    3: "COMMON_NAME",
    4: "MODEL_NAME",
    5: "MANUFACTURERS_SERIAL_NUMBER",
    10: "AIRCRAFT_CATEGORY_E",
    17: "NUMBER_OF_ENGINES",
    18: "NUMBER_OF_SEATS",
    19: "AIR_WEIGHT_KILOS",
    21: "ISSUE_DATE",
    22: "EFFECTIVE_DATE",
    31: "DATE_MANUFACTURE_ASSEMBLY",
    38: "REGISTRATION_AUTH_STATUS_E",
    42: "MODE_S_TRANSPONDER_BINARY",
    46: "TRIMMED_MARK",
}
"""Every ``carscurr.txt`` column this module reads, by position, checked against the layout.

Index 42 is the one that matters. There is no header row to validate, so this mapping plus
:func:`_check_layout` is the guard that stops a column shift reading a serial number as a Mode
S address and joining every Canadian aircraft to nothing at all, silently.
"""

EXPECTED_OWNER_COLUMNS: Final[Mapping[int, str]] = {
    1: "FULL_NAME",
    2: "TRADE_NAME",
    3: "STREET_NAME",
    4: "STREET_NAME2",
    5: "CITY",
    6: "PROVINCE_OR_STATE_E",
    8: "POSTAL_CODE",
    9: "COUNTRY_E",
    11: "TYPE_OF_OWNER_E",
    13: "ACTIVE_FLAG",
    14: "CARE_OF",
    19: "TRIMMED_MARK",
}
"""Every ``carsownr.txt`` column this module reads, by position, checked against the layout."""

_MARK = 0
_COMMON_NAME = 3
_MODEL_NAME = 4
_SERIAL = 5
_CATEGORY = 10
_ENGINES = 17
_SEATS = 18
_WEIGHT_KG = 19
_ISSUE_DATE = 21
_EFFECTIVE_DATE = 22
_MANUFACTURE_DATE = 31
_STATUS = 38
_MODE_S_BINARY = 42
_TRIMMED_MARK = 46

_OWN_NAME = 1
_OWN_TRADE_NAME = 2
_OWN_STREET = 3
_OWN_STREET2 = 4
_OWN_CITY = 5
_OWN_PROVINCE = 6
_OWN_POSTAL = 8
_OWN_COUNTRY = 9
_OWN_TYPE = 11
_OWN_ACTIVE = 13
_OWN_CARE_OF = 14
_OWN_MARK = 19


class OwnerAddress(StrictModel):
    """A CCARCS registered owner's address, dated and sourced.

    **Only ever an entity's address.** A natural person's row never reaches this contract: it
    is dropped at the adapter under the Open Government Licence exemption for personal
    information, so unlike the FAA's equivalent this is a business address in every case that
    exists.

    ``as_of`` is the register's extract date and it is required. There is no such thing here as
    an undated address: ADR 008 drops an undated entry at the adapter, so this contract cannot
    express one.
    """

    street: str | None = Field(default=None, max_length=40)
    street2: str | None = Field(default=None, max_length=40)
    care_of: str | None = Field(default=None, max_length=40)
    city: str | None = Field(default=None, max_length=40)
    province: str | None = Field(default=None, max_length=100)
    postal_code: str | None = Field(
        default=None,
        max_length=20,
        description="Kept verbatim rather than reformatted, because it is a match key.",
    )
    country: str | None = Field(
        default=None,
        max_length=100,
        description="Space-padded to 100 characters upstream and stripped here. Usually "
        "CANADA, and not always: a Canadian mark may be held by a foreign lessor.",
    )
    as_of: UtcDatetime = Field(
        description="The register's extract date, from the zip's HTTP Last-Modified. Required: "
        "an address with no date is dropped at the adapter and counted."
    )
    source: str = Field(default=SOURCE_NAME, min_length=1, max_length=40)
    pii: bool = Field(
        default=True,
        description="Marks this as a contact attribute so the card and the API can serve it "
        "suppressed, mirroring the NoContactData and NoPII packages the business sells. True "
        "even though every address here belongs to an entity: the suppression filter reads "
        "this flag off the serialised record, and a register that starts publishing a sole "
        "trader's address under an Entity type must not need a code change to stay safe.",
    )


class CcarcsRegistration(StrictModel):
    """One current Canadian registration, mapped from ``carscurr.txt`` and ``carsownr.txt``.

    Strict, frozen, and shaped like :class:`~tracker.sources.faa_registry.FaaRegistration` so
    the router in ``services/registers.py`` can serve both without branching on the register.

    **``owner_name`` is optional here where the FAA's is required**, and that difference is the
    licence. A Canadian aircraft registered to a natural person keeps its airframe, its mark
    and its Mode S address and carries no owner at all, because there is no grant to use the
    owner. The card then says the register holds an owner we may not publish, which is a
    different and more honest statement than "not on the register".
    """

    icao24: str = Field(
        pattern=r"^[0-9a-f]{6}$",
        description="ICAO 24-bit address, lowercase, derived from the 24-character binary "
        "string in MODE_S_TRANSPONDER_BINARY. All 34,897 live rows derive into the c0 block.",
    )
    registration: str = Field(
        max_length=REGISTRATION_MAX_CHARS,
        description="Mark with the C- prefix restored. TRIMMED_MARK carries no prefix: 'AAC' "
        "means C-AAC, and not one of 34,897 rows starts with a C.",
    )
    owner_name: str | None = Field(
        default=None,
        max_length=OWNER_NAME_MAX_CHARS,
        description="The registered owner, or None where every owner on the mark is a natural "
        "person or holds no active address. Never a person's name: see the class docstring.",
    )
    owner_trade_name: str | None = Field(default=None, max_length=120)
    co_owner_names: tuple[str, ...] = Field(
        default=(),
        description="Further entity owners on the same mark, up to 11 more. 12 owners on one "
        "mark is the live maximum, so co-ownership here is normal rather than exceptional.",
    )
    withheld_owner_count: int = Field(
        default=0,
        ge=0,
        description="Owners on this mark dropped as personal information under the Open "
        "Government Licence. Carried rather than discarded so a card can say an owner exists "
        "and is withheld, instead of showing a company as though it were the sole owner.",
    )
    owner_address: OwnerAddress | None = Field(default=None)
    registrant_is_sole_entity: bool = Field(
        default=False,
        description="True only when every active owner on the mark is an Entity. The ownership "
        "spine name-matches on this and on nothing else, mirroring the FAA rule that a "
        "co-owned registration reads as a person because at least one party usually is one.",
    )
    manufacturer: str | None = Field(default=None, max_length=120)
    model: str | None = Field(
        default=None,
        max_length=50,
        description="MODEL_NAME, e.g. 'PA-28-235'. **Not an ICAO type designator**: CCARCS "
        "publishes none, which is why nothing here writes Aircraft.type_designator.",
    )
    serial_number: str | None = Field(default=None, max_length=30)
    category: str | None = Field(
        default=None,
        max_length=50,
        description="AIRCRAFT_CATEGORY_E, e.g. 'Aeroplane', 'Helicopter'. English column only.",
    )
    year_manufactured: int | None = Field(default=None, ge=1900, le=2100)
    seats: int | None = Field(default=None, ge=0, le=1000)
    engines: int | None = Field(default=None, ge=0, le=12)
    weight_kg: float | None = Field(
        default=None,
        gt=0,
        description="AIR_WEIGHT_KILOS, launch or take-off weight. Kilograms, stated by the "
        "column name, unlike CASA's MTOW which has no unit anywhere in the file.",
    )
    status: str | None = Field(
        default=None,
        max_length=100,
        description="REGISTRATION_AUTH_STATUS_E as published, so an ownership claim resting on "
        "a lapsed registration can be told from a current one without a second lookup.",
    )
    issue_date: UtcDatetime | None = Field(
        default=None,
        description="Certificate issue date. YYYY/MM/DD upstream with no zone; UTC is attached "
        "here, so the value is midnight UTC on the stated day and is a day, not an instant.",
    )
    effective_date: UtcDatetime | None = Field(default=None)
    extract_date: UtcDatetime | None = Field(
        default=None,
        description="When Transport Canada built the zip, from its HTTP Last-Modified. This "
        "dates the ownership claim. None only where the header was absent.",
    )
    source: str = Field(default=SOURCE_NAME, min_length=1, max_length=40)


@dataclass(frozen=True, slots=True)
class RegistryTally:
    """What one parse kept and what it lost, in a shape the API can serve.

    Three counters rather than one because they are different losses. A record drop costs a
    whole airframe; an owner drop costs the ownership of an airframe we kept; an address drop
    costs one attribute on an owner we kept. Rolling them together would hide the only number
    anyone should care about here, which is how many owners the licence took off the table.
    """

    registrations: int
    record_drops: Counter[str] = field(default_factory=Counter)
    owner_drops: Counter[str] = field(default_factory=Counter)
    address_drops: Counter[str] = field(default_factory=Counter)

    @property
    def records_dropped(self) -> int:
        """Rows that produced no registration at all."""
        return sum(self.record_drops.values())

    @property
    def owners_dropped(self) -> int:
        """Owner rows refused, overwhelmingly natural persons under the licence exemption."""
        return sum(self.owner_drops.values())

    @property
    def addresses_dropped(self) -> int:
        """Registrations that kept their owner and lost the address."""
        return sum(self.address_drops.values())


class _Owner(NamedTuple):
    """One active entity owner of one mark, stripped and stored."""

    name: str
    trade_name: str
    street: str
    street2: str
    care_of: str
    city: str
    province: str
    postal_code: str
    country: str


class _Mark(NamedTuple):
    """Every owner fact about one mark, resolved before any registration is built."""

    owners: tuple[_Owner, ...]
    withheld: int
    sole_entity: bool


class _Row(NamedTuple):
    """One registration, stripped and stored, validated once at parse time.

    The index holds these rather than 34,897 :class:`CcarcsRegistration` instances, for the
    reason ``faa_registry._Row`` gives: the models cost several times the resident set and
    rebuilding one on lookup costs microseconds. Every row in here has been through
    :func:`_to_domain` once already, so the drops are still counted at the adapter.
    """

    mark: str
    common_name: str
    model_name: str
    serial: str
    category: str
    engines: str
    seats: str
    weight_kg: str
    issue_date: str
    effective_date: str
    manufacture_date: str
    status: str
    owners: _Mark


def _text(raw: str, limit: int) -> str | None:
    """Strip, and turn a blank or an over-long value into ``None``.

    Country fields are space-padded to 100 characters and ``MARK`` is leading-space padded, so
    nothing in this file is usable unstripped. Over-long is dropped rather than clipped: a
    clipped street is a different address and a clipped postal code is a different place, and
    both are match keys.
    """
    value = raw.strip()
    if not value or len(value) > limit:
        return None
    return value


def _optional_int(raw: str) -> int | None:
    """Parse a count, treating a blank or unparseable value as absent."""
    value = raw.strip()
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _optional_float(raw: str) -> float | None:
    """Parse ``AIR_WEIGHT_KILOS``, which is ``NUMBER(12,3)`` and so may carry a decimal part.

    Zero means unknown rather than weightless, and the contract's ``gt=0`` enforces it.
    """
    value = raw.strip()
    if not value:
        return None
    try:
        weight = float(value)
    except ValueError:
        return None
    return weight or None


def _ccarcs_date(raw: str) -> datetime | None:
    """Parse a ``YYYY/MM/DD`` register date, attaching UTC.

    Transport Canada writes ``1993/05/03``, with no zone. This project's rule is that a naive
    datetime is a validation error, so the choice is between attaching UTC and failing every
    date in the file. UTC is attached and the contract's field descriptions say the value is a
    day rather than an instant.

    Anything not matching the pattern reads as absent rather than raising: plenty of optional
    dates are blank and a blank optional date is not a reason to lose an airframe.
    """
    match = _CCARCS_DATE.match(raw.strip())
    if match is None:
        return None
    try:
        return datetime(int(match.group(1)), int(match.group(2)), int(match.group(3)), tzinfo=UTC)
    except ValueError:
        return None


def icao24_from_binary(raw: str) -> str | None:
    """Derive the lowercase ICAO 24-bit address from the binary transponder string.

    The single most important function in this module. ``MODE_S_TRANSPONDER_BINARY`` is 24
    characters of ``0`` and ``1``; the ADS-B feeds send six lowercase hex digits. Reading the
    field as hex or as a decimal integer yields a valid-looking address for a different
    aircraft, so this is the only place the conversion happens.

    Verified against the committed extract: ``AAC`` gives ``c00003``, ``AAJ`` gives ``c0000a``
    and ``AAM`` gives ``c0000d``.

    Returns:
        Six lowercase hex digits, or ``None`` when the field is not 24 binary characters.
    """
    value = raw.strip()
    if len(value) != ICAO_ADDRESS_BITS or not _BINARY_DIGITS.issuperset(value):
        return None
    return f"{int(value, 2):06x}"


def is_canadian_civil_hex(icao24: str) -> bool:
    """Whether an address could be on this register at all, so a miss can be skipped.

    CCARCS derives entirely into ``c0``. A ``c2`` or ``c3`` address is Canadian military and
    will never be here, which is a skip rather than a miss, exactly as an ``ae`` address is
    for the FAA.
    """
    return icao24.strip().lower().startswith(CIVIL_HEX_PREFIX)


def parse_layout(member: IO[bytes]) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Read ``carslayout.txt`` and return the column names of the two data files, in order.

    This is the substitute for a header row, and it is why the layout member is read at all.
    The two data files ship no header, so without this a column inserted upstream shifts every
    index in this module and the parse keeps succeeding against the wrong fields.

    The file writes one field per line: an ordinal, the column name twice, an Oracle type and a
    description. A row whose type is literally ``FILE`` names a table and starts a new section.

    Raises:
        SourceError: The layout does not describe exactly two tables.
    """
    tables: list[list[str]] = []
    for line in io.TextIOWrapper(member, encoding=ENCODING, newline=""):
        match = _LAYOUT_ROW.match(line)
        if match is None:
            continue
        name, oracle_type = match.group(2), match.group(4)
        if oracle_type == _LAYOUT_FILE_TYPE:
            tables.append([])
            continue
        if tables:
            tables[-1].append(name)
    if len(tables) != 2:  # noqa: PLR2004 - carscurr and carsownr, and there is no third
        raise SourceError(
            SOURCE_NAME,
            f"{LAYOUT_MEMBER} describes {len(tables)} tables, expected carscurr and carsownr",
        )
    return tuple(tables[0]), tuple(tables[1])


def _check_layout(columns: Sequence[str], expected: Mapping[int, str], member: str) -> None:
    """Fail the parse when a column this module reads has moved or been renamed.

    Fatal rather than counted, and deliberately so. A shifted column is not a bad row, it is a
    reshaped file, and the damage from carrying on is that every value this module reads is
    quietly about something else.

    Raises:
        SourceError: A column is missing or is not where this module expects it.
    """
    wrong = {
        index: (name, columns[index] if index < len(columns) else "<past the end>")
        for index, name in expected.items()
        if index >= len(columns) or columns[index] != name
    }
    if wrong:
        raise SourceError(
            SOURCE_NAME,
            f"{member} layout changed: {len(columns)} columns, and "
            + ", ".join(
                f"index {i} is {got!r}, expected {want!r}" for i, (want, got) in wrong.items()
            ),
        )


def _rows(member: IO[bytes], fields: int) -> Iterator[list[str]]:
    """Read one data member as cp1252 CSV, skipping the junk lines it ships.

    Two lines in each file carry 0 or 1 field. They are not records and are not a reason to
    raise, so they are skipped here and counted by the caller.
    """
    reader = csv.reader(io.TextIOWrapper(member, encoding=ENCODING, newline=""))
    try:
        for row in reader:
            if len(row) == fields:
                yield row
    except csv.Error as exc:
        raise SourceError(SOURCE_NAME, f"member is not readable as CSV: {exc}") from exc


def parse_owners(
    member: IO[bytes], columns: Sequence[str]
) -> tuple[dict[str, _Mark], Counter[str]]:
    """Index the owner file by trimmed mark, keeping only what the licence permits.

    Every dropped owner is counted under a named reason. The two reasons are different
    obligations, not two flavours of the same one: a natural person's row is refused because
    the Open Government Licence exempts personal information from the grant, and an inactive
    address is refused because ingesting it attaches an owner to somewhere they have left.

    ``sole_entity`` is computed over the **active** owners of a mark, before the personal ones
    are discarded, so a company sharing a mark with a private individual is still not
    name-matched. Discarding first and asking afterwards would report a co-owned aircraft as
    solely owned by the one party we happen to be allowed to see, which is the subtler half of
    this whole module.

    Raises:
        SourceError: A column this module reads has moved.
    """
    _check_layout(columns, EXPECTED_OWNER_COLUMNS, OWNER_MEMBER)
    intern = sys.intern
    kept: defaultdict[str, list[_Owner]] = defaultdict(list)
    withheld: Counter[str] = Counter()
    entity_only: dict[str, bool] = {}
    drops: Counter[str] = Counter()

    for row in _rows(member, OWNER_FIELDS):
        mark = row[_OWN_MARK].strip()
        if not mark:
            drops["owner row carries no mark"] += 1
            continue
        if row[_OWN_ACTIVE].strip() != ACTIVE_ADDRESS:
            drops[DROP_INACTIVE_ADDRESS] += 1
            continue
        owner_type = row[_OWN_TYPE].strip()
        entity = owner_type == ENTITY_OWNER
        entity_only[mark] = entity_only.get(mark, True) and entity
        if not entity:
            # The licence exemption. Counted, never held, and the count reaches the API so the
            # loss is visible rather than looking like a register with no owners in it.
            drops[DROP_PERSONAL_INFORMATION] += 1
            withheld[mark] += 1
            continue
        name = _text(row[_OWN_NAME], OWNER_NAME_MAX_CHARS)
        if name is None:
            drops["entity owner row carries no name"] += 1
            continue
        kept[mark].append(
            _Owner(
                name=name,
                trade_name=row[_OWN_TRADE_NAME].strip(),
                street=row[_OWN_STREET].strip(),
                street2=row[_OWN_STREET2].strip(),
                care_of=row[_OWN_CARE_OF].strip(),
                city=row[_OWN_CITY].strip(),
                province=intern(row[_OWN_PROVINCE].strip()),
                postal_code=row[_OWN_POSTAL].strip(),
                country=intern(row[_OWN_COUNTRY].strip()),
            )
        )

    marks = {
        mark: _Mark(
            owners=tuple(kept.get(mark, ())),
            withheld=withheld.get(mark, 0),
            sole_entity=entity_only.get(mark, False),
        )
        for mark in set(kept) | set(withheld)
    }
    return marks, drops


def _owner_address(owner: _Owner, extract_date: datetime | None) -> OwnerAddress | None:
    """Build the dated, sourced address, or return ``None`` to have it counted.

    Two ways to get ``None`` and the caller tells them apart: the register published no address
    at all, or there is no extract date and ADR 008 will not hold an undated attribute.
    """
    if extract_date is None:
        return None
    parts = (
        owner.street,
        owner.street2,
        owner.care_of,
        owner.city,
        owner.province,
        owner.postal_code,
        owner.country,
    )
    if not any(parts):
        return None
    return OwnerAddress(
        street=_text(owner.street, 40),
        street2=_text(owner.street2, 40),
        care_of=_text(owner.care_of, 40),
        city=_text(owner.city, 40),
        province=_text(owner.province, 100),
        postal_code=_text(owner.postal_code, 20),
        country=_text(owner.country, 100),
        as_of=extract_date,
    )


def _to_domain(icao24: str, row: _Row, extract_date: datetime | None) -> CcarcsRegistration:
    """Map one stored row to the domain contract.

    The only mapping in this module, called once per row at parse time so an unmappable row is
    dropped and counted at the adapter, and again on lookup so the index can stay compact.

    Raises:
        ValueError: The row has no usable mark, or carries a value the contract will not take.
        pydantic.ValidationError: A subclass of ``ValueError``, raised the same way.
    """
    mark = _text(row.mark, REGISTRATION_MAX_CHARS - 2)
    if mark is None:
        msg = "TRIMMED_MARK is blank"
        raise ValueError(msg)
    owners = row.owners
    first = owners.owners[0] if owners.owners else None
    manufactured = _ccarcs_date(row.manufacture_date)
    return CcarcsRegistration(
        icao24=icao24,
        registration=f"C-{mark}",
        owner_name=first.name if first else None,
        owner_trade_name=_text(first.trade_name, 120) if first else None,
        co_owner_names=tuple(other.name for other in owners.owners[1:]),
        withheld_owner_count=owners.withheld,
        owner_address=_owner_address(first, extract_date) if first else None,
        registrant_is_sole_entity=owners.sole_entity and bool(owners.owners),
        manufacturer=_text(row.common_name, 120),
        model=_text(row.model_name, 50),
        serial_number=_text(row.serial, 30),
        category=_text(row.category, 50),
        year_manufactured=manufactured.year if manufactured else None,
        seats=_optional_int(row.seats),
        engines=_optional_int(row.engines),
        weight_kg=_optional_float(row.weight_kg),
        status=_text(row.status, 100),
        issue_date=_ccarcs_date(row.issue_date),
        effective_date=_ccarcs_date(row.effective_date),
        extract_date=extract_date,
    )


def _store_row(row: list[str], owners: _Mark) -> _Row:
    """Strip one ``carscurr.txt`` row into the compact form the index holds.

    ``sys.intern`` on the low-cardinality columns because 34,897 rows share a handful of
    categories, statuses and engine counts, so interning turns each into one string object.
    """
    intern = sys.intern
    return _Row(
        mark=row[_TRIMMED_MARK].strip(),
        common_name=row[_COMMON_NAME].strip(),
        model_name=row[_MODEL_NAME].strip(),
        serial=row[_SERIAL].strip(),
        category=intern(row[_CATEGORY].strip()),
        engines=intern(row[_ENGINES].strip()),
        seats=intern(row[_SEATS].strip()),
        weight_kg=intern(row[_WEIGHT_KG].strip()),
        issue_date=intern(row[_ISSUE_DATE].strip()),
        effective_date=intern(row[_EFFECTIVE_DATE].strip()),
        manufacture_date=intern(row[_MANUFACTURE_DATE].strip()),
        status=intern(row[_STATUS].strip()),
        owners=owners,
    )


class CcarcsIndex:
    """Every current Canadian registration, keyed on the lowercase ICAO 24-bit address.

    Holds no HTTP client and issues no request, so an aircraft in view resolves to its owner
    from memory. One process owns one of these and replaces it wholesale when a new extract
    lands, so a lookup never sees a half-built index.
    """

    __slots__ = ("_by_registration", "_extract_date", "_rows", "_tally")

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
        self._by_registration = {row.mark.upper(): icao for icao, row in rows.items()}

    def __len__(self) -> int:
        return len(self._rows)

    @property
    def extract_date(self) -> datetime | None:
        """When Transport Canada built this extract, from the zip's HTTP ``Last-Modified``."""
        return self._extract_date

    @property
    def tally(self) -> RegistryTally:
        """What this parse kept and what it dropped, for the API to serve."""
        return self._tally

    def registration(self, icao24: str) -> CcarcsRegistration | None:
        """The registration for one ICAO 24-bit address, or ``None`` if CCARCS has none.

        Case-folded on the way in. ``None`` is normal rather than a fault: Canadian military
        aircraft sit in the ``c2`` and ``c3`` blocks and are not on the civil register.
        """
        key = icao24.strip().lower()
        row = self._rows.get(key)
        if row is None:
            return None
        return _to_domain(key, row, self._extract_date)

    def by_registration(self, registration: str) -> CcarcsRegistration | None:
        """The registration for one mark, with or without its ``C-`` prefix.

        The secondary key. CCARCS joins on the Mode S address, which is the better key and the
        one the router uses first; this exists because a feed occasionally sends a mark with no
        address, and looking one up should not need the caller to know which key this register
        happens to be built on.
        """
        mark = registration.strip().upper().removeprefix("C-")
        icao24 = self._by_registration.get(mark)
        return None if icao24 is None else self.registration(icao24)


def parse_registry(
    layout: IO[bytes],
    current: IO[bytes],
    owners: IO[bytes],
    *,
    extract_date: datetime | None,
) -> CcarcsIndex:
    """Build the index from the three members, dropping and counting everything unmappable.

    The layout member is read first and is not optional: it is the only description of the
    column order these files have, and :func:`_check_layout` turns a silent column shift into a
    loud failure.

    Args:
        layout: Open ``carslayout.txt`` stream.
        current: Open ``carscurr.txt`` stream.
        owners: Open ``carsownr.txt`` stream.
        extract_date: The zip's ``Last-Modified`` as an aware UTC datetime. ``None`` means
            every owner address in this batch is undated and is dropped and counted per
            ADR 008, while the owner names survive.

    Raises:
        SourceError: The layout is unreadable or a column moved, the row ceiling was passed, or
            not one row mapped.
    """
    current_columns, owner_columns = parse_layout(layout)
    _check_layout(current_columns, EXPECTED_CURRENT_COLUMNS, CURRENT_MEMBER)
    marks, owner_drops = parse_owners(owners, owner_columns)

    rows: dict[str, _Row] = {}
    record_drops: Counter[str] = Counter()
    address_drops: Counter[str] = Counter()
    empty = _Mark(owners=(), withheld=0, sole_entity=False)

    for raw in _rows(current, CURRENT_FIELDS):
        icao24 = icao24_from_binary(raw[_MODE_S_BINARY])
        if icao24 is None:
            record_drops["MODE_S_TRANSPONDER_BINARY is not 24 binary characters"] += 1
            continue
        if icao24 in rows:
            # One record per hex is ADR 010's rule and a duplicate here would read downstream
            # as a merge bug rather than as register data. Zero on the live file.
            record_drops["duplicate Mode S address; the first row wins"] += 1
            continue
        row = _store_row(raw, marks.get(raw[_TRIMMED_MARK].strip(), empty))
        try:
            registration = _to_domain(icao24, row, extract_date)
        except ValueError as exc:
            record_drops[_drop_reason(exc)] += 1
            continue
        if registration.owner_name is not None and registration.owner_address is None:
            address_drops[
                "owner address undated: no extract date on the zip"
                if extract_date is None
                else "the register published no address for this owner"
            ] += 1
        rows[icao24] = row
        if len(rows) > MAX_ROWS:
            raise SourceError(SOURCE_NAME, f"{CURRENT_MEMBER} exceeded the {MAX_ROWS} row ceiling")

    if not rows:
        raise SourceError(
            SOURCE_NAME,
            f"no usable rows in {CURRENT_MEMBER} ({sum(record_drops.values())} dropped); "
            "treating as an upstream shape change, not as an empty register",
        )
    tally = RegistryTally(
        registrations=len(rows),
        record_drops=record_drops,
        owner_drops=owner_drops,
        address_drops=address_drops,
    )
    _log.info(
        "%s: kept %d registrations, dropped %d rows, %d owners %r and %d addresses",
        SOURCE_NAME,
        len(rows),
        tally.records_dropped,
        tally.owners_dropped,
        dict(owner_drops),
        tally.addresses_dropped,
    )
    return CcarcsIndex(rows, extract_date=extract_date, tally=tally)


def _drop_reason(exc: ValueError) -> str:
    """One readable reason per dropped row, short enough to be a counter key.

    A pydantic ``ValidationError`` stringifies to several lines with a documentation URL, and
    that as a Counter key gives one bucket per row instead of one per reason.
    """
    if type(exc) is ValueError:
        return str(exc)
    return "row does not satisfy the CcarcsRegistration contract"


def read_archive(path: Path, extract_date: datetime | None) -> CcarcsIndex:
    """Open the zip on disk and parse its three members, streaming all of them.

    Raises:
        SourceError: Not a zip, a member is missing, a member declares more than
            :data:`MAX_MEMBER_BYTES` decompressed, or the parse failed.
    """
    try:
        with zipfile.ZipFile(path) as bundle:
            names = {info.filename.lower(): info.filename for info in bundle.infolist()}
            members = {}
            for wanted in (LAYOUT_MEMBER, CURRENT_MEMBER, OWNER_MEMBER):
                actual = names.get(wanted.lower())
                if actual is None:
                    raise SourceError(SOURCE_NAME, f"{path.name} has no {wanted}")
                declared = bundle.getinfo(actual).file_size
                if declared > MAX_MEMBER_BYTES:
                    raise SourceError(
                        SOURCE_NAME,
                        f"{wanted} declares {declared} bytes, over the "
                        f"{MAX_MEMBER_BYTES} byte decompression ceiling",
                    )
                members[wanted] = actual
            with (
                bundle.open(members[LAYOUT_MEMBER]) as layout,
                bundle.open(members[CURRENT_MEMBER]) as current,
                bundle.open(members[OWNER_MEMBER]) as owners,
            ):
                return parse_registry(layout, current, owners, extract_date=extract_date)
    except (zipfile.BadZipFile, KeyError, OSError) as exc:
        raise SourceError(SOURCE_NAME, f"{path.name} is not readable: {exc!r}") from exc


def apply_to_aircraft(aircraft: Aircraft, registration: CcarcsRegistration) -> Aircraft:
    """Write the register's facts onto a live aircraft, and nothing else.

    Three fields, the same three ``faa_registry.apply_to_aircraft`` writes and for the same
    reasons. ``owner`` and ``registered_country`` are what a register is for, and
    ``registration`` is mapped because a feed record often carries none.

    **No ``type_designator``**: CCARCS publishes no ICAO designator and ``MODEL_NAME`` is
    ``'PA-28-235'``, so writing it into a designator field would declassify every aircraft
    keyed on the designator. **No ``operator``**: a registered owner is not an operator.
    **Nothing touching any privacy flag**: per ADR 009 this path reads no list.

    ``owner`` comes back ``None`` on a Canadian aircraft whose only owners are natural
    persons, which is 21,830 of 34,897 airframes and is the licence working, not a gap.

    Raises:
        pydantic.ValidationError: The register sent something the aircraft contract will not
            take, which the caller counts as unmappable while keeping the feed's own record.
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
