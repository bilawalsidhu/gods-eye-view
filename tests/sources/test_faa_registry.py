"""The FAA registry adapter: the octal column, the BOM, the padding and the daily fetch.

No network at all. The recorded 200-row slices of the real ``MASTER.txt`` and ``ACFTREF.txt``
do the work, and the zip container around them is built here rather than committed, for the
same reason ``test_geonames.py`` builds its own: the bytes inside are the verbatim upstream
rows and the container is a standard format, not the provider's data.

The recorded ``faa_master_extract.csv`` was scrubbed to synthetic owner names and addresses
because the real file names real people. Every column, every width, every pad character and
the present-versus-blank pattern of every optional field survives, which is exactly what an
ingest test needs: the structure is real and the names are not. See
``tests/fixtures/README.md``.

Four things get more attention than the rest, because each is a measured trap that produces a
plausible wrong answer rather than an error.

``MODE S CODE`` at index 21 is the same number as ``MODE S CODE HEX`` at index 33 written in
octal, so reading the wrong column yields ``50002263`` where ``A004B3`` was wanted and joins
to nothing, silently and for ever. Asserted here on real rows, both that the two columns are
the same number and that the index keys on the hex one.

A UTF-8 BOM sits on the header line, so a naive read produces a column literally named
``﻿N-NUMBER`` and the header check then fails on a file that is perfectly fine.

Every field is space-padded to a fixed width inside a CSV, and there is no quoting anywhere,
so a name containing a comma reshapes the row and the field-count check is the only thing
that notices.

And the freshness check is a conditional GET, never a HEAD: through cloudscraper a HEAD
answers HTTP 503 with a decoy ``Last-Modified`` of 2013, so a HEAD check reports the source
down every day of the year.
"""

import csv
import io
import os
import zipfile
from collections.abc import Iterator, Mapping, Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from tests.conftest import fixture_bytes, make_aircraft
from tracker.sources.base import SourceError
from tracker.sources.faa_registry import (
    ACFTREF_COLUMNS,
    ACFTREF_MEMBER,
    ARCHIVE_NAME,
    DOWNLOAD_URL,
    MASTER_COLUMNS,
    MASTER_MEMBER,
    MIN_REFRESH_INTERVAL_S,
    OWNER_NAME_MAX_CHARS,
    SOURCE_NAME,
    ArchiveFetch,
    ArchiveResponse,
    FaaRegistration,
    FaaRegistry,
    FaaRegistryIndex,
    OwnerAddress,
    RegistrantType,
    apply_to_aircraft,
    download_archive,
    next_refresh_after,
    parse_acftref,
    parse_extract_date,
    parse_registry,
    read_archive,
)

MASTER_FIXTURE = "faa_master_extract.csv"
"""200 rows of the real ``MASTER.txt``, owner values scrubbed, structure verbatim."""

ACFTREF_FIXTURE = "faa_acftref_extract.csv"
"""200 rows of the real ``ACFTREF.txt``. Carries no owner data, so it was not scrubbed."""

FIXTURE_ROWS = 200
FIXTURE_BLANK_OWNERS = 2
"""Rows with a blank ``NAME``. 49 U.S.C. section 44114(b), withheld upstream, not LADD.

Two here against 4,773 of 316,030 in the real file, which is the same 1.5% rate.
"""

FIXTURE_BLANK_COUNTRIES = 2
"""Rows with a blank ``COUNTRY``, so ``registered_country`` can be ``None`` on a hit."""

BOM = b"\xef\xbb\xbf"

FIRST_HEX = "A004B3"
"""The first row's ``MODE S CODE HEX``, as published: uppercase."""

FIRST_OCTAL = "50002263"
"""The same row's ``MODE S CODE``. The same number in octal, and never read."""

FIRST_N_NUMBER = "100"
"""``N-NUMBER`` as published. No ``N``, so the registration is ``N100``."""

ACFTREF_CODE = "0020901"
"""A real ``ACFTREF.CODE`` from the recorded slice: AAR AIRLIFT GROUP INC, UH-60A."""

NOW = datetime(2026, 8, 20, 9, 0, 0, tzinfo=UTC)
ONE_DAY_S = 86_400.0
LIVE_LAST_MODIFIED = "Wed, 19 Aug 2026 04:57:29 GMT"
"""What ``registry.faa.gov`` actually served on 2026-08-20, verbatim."""

LIVE_EXTRACT_DATE = datetime(2026, 8, 19, 4, 57, 29, tzinfo=UTC)

_MASTER_COLUMN_COUNT = 35
_ACFTREF_COLUMN_COUNT = 14


def _clock() -> datetime:
    return NOW


# ---------------------------------------------------------------- building input


def _lines(name: str) -> list[str]:
    """The recorded file as lines, BOM stripped, so a test can rewrite one row."""
    return fixture_bytes(name).decode("utf-8-sig").splitlines()


def _fields(line: str) -> list[str]:
    """One recorded line split the way the adapter splits it: no quoting anywhere."""
    return next(csv.reader([line]))


def _encode(lines: Sequence[str], *, bom: bool = True) -> bytes:
    """Rebuild a member exactly as the FAA serves one: BOM, CRLF, trailing newline."""
    body = ("\r\n".join(lines) + "\r\n").encode()
    return BOM + body if bom else body


def _master() -> bytes:
    return fixture_bytes(MASTER_FIXTURE)


def _acftref() -> bytes:
    return fixture_bytes(ACFTREF_FIXTURE)


def _variant(*, changes: Mapping[str, str], row: int = 0) -> str:
    """One recorded MASTER row with named columns overwritten, still comma-joined."""
    fields = _fields(_lines(MASTER_FIXTURE)[1 + row])
    for column, value in changes.items():
        fields[MASTER_COLUMNS.index(column)] = value
    return ",".join(fields)


def _master_with(*rows: str, header: str | None = None, bom: bool = True) -> bytes:
    """A MASTER member holding only the rows given, under the real header."""
    lines = _lines(MASTER_FIXTURE)
    return _encode([header if header is not None else lines[0], *rows], bom=bom)


def _acftref_with(*rows: str) -> bytes:
    """An ACFTREF member holding only the rows given, under the real header."""
    lines = _lines(ACFTREF_FIXTURE)
    return _encode([lines[0], *rows])


def _acftref_row(code: str, **changes: str) -> str:
    """The recorded UH-60A row, recoded and optionally edited."""
    fields = _fields(_lines(ACFTREF_FIXTURE)[1])
    fields[ACFTREF_COLUMNS.index("CODE")] = code
    for column, value in changes.items():
        fields[ACFTREF_COLUMNS.index(column)] = value
    return ",".join(fields)


def _zip(master: bytes, acftref: bytes, *, omit_acftref: bool = False) -> bytes:
    """Wrap the two members in the same multi-member zip the FAA serves."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr(MASTER_MEMBER, master)
        if not omit_acftref:
            bundle.writestr(ACFTREF_MEMBER, acftref)
    return buffer.getvalue()


def _index(
    master: bytes, acftref: bytes, *, extract_date: datetime | None = LIVE_EXTRACT_DATE
) -> FaaRegistryIndex:
    """Parse two members straight from bytes, the way ``read_archive`` does from a zip."""
    with io.BytesIO(master) as one, io.BytesIO(acftref) as two:
        return parse_registry(one, two, extract_date=extract_date)


def _seed(cache_dir: Path, archive: bytes, *, age_s: float, header: str | None = None) -> Path:
    """Put a zip on disk as if it had been fetched ``age_s`` ago."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / ARCHIVE_NAME
    path.write_bytes(archive)
    stamp = (NOW - timedelta(seconds=age_s)).timestamp()
    os.utime(path, (stamp, stamp))
    if header is not None:
        path.with_suffix(path.suffix + ".last-modified").write_text(header, encoding="utf-8")
    return path


@pytest.fixture
def whole_index() -> FaaRegistryIndex:
    """The full 200-row recorded slice, parsed once."""
    return _index(_master(), _acftref())


# ---------------------------------------------------------------- the octal column


def test_mode_s_code_is_the_same_number_as_mode_s_code_hex_in_octal() -> None:
    """The trap itself, asserted on the real rows rather than described in a comment.

    Both columns are on every row and they agree on every row, so a parser reading index 21
    produces a number that looks like an identifier and matches nothing at all.
    """
    lines = _lines(MASTER_FIXTURE)[1:]
    octal_index = MASTER_COLUMNS.index("MODE S CODE")
    hex_index = MASTER_COLUMNS.index("MODE S CODE HEX")
    assert octal_index == 21
    assert hex_index == 33

    pairs = [
        (_fields(line)[octal_index].strip(), _fields(line)[hex_index].strip()) for line in lines
    ]
    assert len(pairs) == FIXTURE_ROWS
    for octal, hexadecimal in pairs:
        assert int(octal.strip(), 8) == int(hexadecimal.strip(), 16)

    assert pairs[0] == (FIRST_OCTAL, FIRST_HEX)


def test_index_keys_on_the_hex_column_and_never_on_the_octal_one(
    whole_index: FaaRegistryIndex,
) -> None:
    assert whole_index.registration(FIRST_HEX) is not None
    assert whole_index.registration(FIRST_OCTAL) is None


def test_hex_is_folded_to_lowercase_because_the_feeds_are_lowercase(
    whole_index: FaaRegistryIndex,
) -> None:
    """The FAA publishes ``A004B3``; adsb.lol sends ``a004b3``. Both must resolve."""
    upper = whole_index.registration(FIRST_HEX)
    lower = whole_index.registration(FIRST_HEX.lower())
    assert upper is not None
    assert upper == lower
    assert upper.icao24 == FIRST_HEX.lower()


def test_lookup_tolerates_the_padding_the_feed_never_strips(whole_index: FaaRegistryIndex) -> None:
    assert whole_index.registration(f"  {FIRST_HEX}  ") is not None


def test_lookup_misses_are_normal_and_are_not_an_error(whole_index: FaaRegistryIndex) -> None:
    """315 of 326 A-prefix hexes in the live captures miss, and every miss was military."""
    assert whole_index.registration("adf7c8") is None


# ---------------------------------------------------------------- the file's shape


def test_the_recorded_master_really_carries_a_utf8_bom() -> None:
    """If this ever stops being true the BOM test below is testing nothing."""
    assert _master().startswith(BOM)
    assert _acftref().startswith(BOM)


def test_a_naive_utf8_read_produces_a_column_named_with_the_bom() -> None:
    """The failure the ``utf-8-sig`` in the adapter exists to prevent."""
    naive = _master().decode("utf-8").splitlines()[0].split(",")[0]
    assert naive == "﻿N-NUMBER"
    assert naive != "N-NUMBER"


def test_the_bom_is_stripped_so_the_header_check_passes(whole_index: FaaRegistryIndex) -> None:
    assert len(whole_index) == FIXTURE_ROWS - FIXTURE_BLANK_OWNERS


def test_a_member_with_no_bom_parses_the_same_way() -> None:
    """``utf-8-sig`` tolerates its absence, so a re-encoded file is not a shape change."""
    index = _index(_encode(_lines(MASTER_FIXTURE), bom=False), _acftref())
    assert len(index) == FIXTURE_ROWS - FIXTURE_BLANK_OWNERS


def test_the_trailing_comma_creates_a_thirty_fifth_column_that_is_not_a_field() -> None:
    assert len(MASTER_COLUMNS) == _MASTER_COLUMN_COUNT
    assert MASTER_COLUMNS[-1] == ""
    assert len(ACFTREF_COLUMNS) == _ACFTREF_COLUMN_COUNT
    assert ACFTREF_COLUMNS[-1] == ""
    assert len(_fields(_lines(MASTER_FIXTURE)[0])) == _MASTER_COLUMN_COUNT


def test_the_real_header_carries_a_leading_space_on_kit_model() -> None:
    """Which is why the header comparison strips every cell before comparing."""
    raw = _fields(_lines(MASTER_FIXTURE)[0])
    assert raw[32] == " KIT MODEL"
    assert MASTER_COLUMNS[32] == "KIT MODEL"


def test_every_field_is_space_padded_and_everything_is_stripped(
    whole_index: FaaRegistryIndex,
) -> None:
    raw = _fields(_lines(MASTER_FIXTURE)[1])
    assert raw[MASTER_COLUMNS.index("NAME")].endswith(" ")
    assert raw[MASTER_COLUMNS.index("N-NUMBER")] == "100  "

    kept = whole_index.registration(FIRST_HEX)
    assert kept is not None
    assert kept.owner_name == kept.owner_name.strip()
    assert kept.registration == "N100"
    assert kept.owner_address is not None
    assert kept.owner_address.city == "KETCHUM"


def test_n_number_carries_no_n_prefix_on_any_row(whole_index: FaaRegistryIndex) -> None:
    """Zero of 20,000 real rows start with an N, so the prefix is restored here."""
    column = MASTER_COLUMNS.index("N-NUMBER")
    published = [_fields(line)[column].strip() for line in _lines(MASTER_FIXTURE)[1:]]
    assert not [value for value in published if value.upper().startswith("N")]
    assert FIRST_N_NUMBER in published

    kept = whole_index.registration(FIRST_HEX)
    assert kept is not None
    assert kept.registration == f"N{FIRST_N_NUMBER}"


def test_a_header_that_changed_shape_is_fatal_rather_than_a_silent_remap() -> None:
    header = ",".join(MASTER_COLUMNS[:-1])
    with pytest.raises(SourceError, match="header changed"):
        _index(_master_with(_variant(changes={}), header=header), _acftref())


def test_an_acftref_header_that_changed_shape_is_fatal_too() -> None:
    with (
        pytest.raises(SourceError, match=f"{ACFTREF_MEMBER} header changed"),
        io.BytesIO(_encode(["CODE,MFR", "0020901,X"])) as member,
    ):
        parse_acftref(member)


def test_a_field_over_the_csv_size_limit_is_reported_as_unreadable() -> None:
    """``csv`` raises on the header read, and that must not surface as a bare ``csv.Error``."""
    with pytest.raises(SourceError, match="not readable as CSV"):
        _index(_encode(["a" * (csv.field_size_limit() + 1)]), _acftref())


# ---------------------------------------------------------------- no quoting


def test_a_comma_in_a_name_reshapes_the_row_undetectably() -> None:
    """There is no quoting anywhere in this file, so the field count is the only guard."""
    row = _variant(changes={"NAME": "SMITH, JOHN A"})
    assert len(_fields(row)) == _MASTER_COLUMN_COUNT + 1


def test_a_reshaped_row_is_dropped_and_counted_by_field_count() -> None:
    """One corrupted row costs one airframe and never the file."""
    good = _variant(changes={}, row=1)
    bad = _variant(changes={"NAME": "SMITH, JOHN A"})
    index = _index(_master_with(good, bad), _acftref())
    assert len(index) == 1
    assert index.tally.record_drops == {"row has 36 fields, expected 35": 1}


def test_a_file_of_nothing_but_reshaped_rows_is_a_shape_change() -> None:
    with pytest.raises(SourceError, match="no usable rows"):
        _index(_master_with(_variant(changes={"NAME": "SMITH, JOHN A"})), _acftref())


# ---------------------------------------------------------------- dates


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        (LIVE_LAST_MODIFIED, LIVE_EXTRACT_DATE),
        ("Wed, 19 Aug 2026 04:57:29 -0000", LIVE_EXTRACT_DATE),
        ("Wed, 19 Aug 2026 06:57:29 +0200", LIVE_EXTRACT_DATE),
    ],
)
def test_the_extract_date_comes_off_the_last_modified_header(
    header: str, expected: datetime
) -> None:
    """RFC 7231 fixdate, explicitly GMT. A ``-0000`` offset parses naive and gets UTC."""
    parsed = parse_extract_date(header)
    assert parsed == expected
    assert parsed is not None
    assert parsed.tzinfo is not None


@pytest.mark.parametrize("header", [None, "", "not a date at all", "Wed, 99 Xxx 2026"])
def test_an_unusable_last_modified_leaves_the_extract_date_unknown(header: str | None) -> None:
    assert parse_extract_date(header) is None


def test_a_registry_date_is_bare_yyyymmdd_and_gets_utc_attached(
    whole_index: FaaRegistryIndex,
) -> None:
    """``20050506`` with no separator and no zone. Midnight UTC on the stated day."""
    kept = whole_index.registration(FIRST_HEX)
    assert kept is not None
    assert kept.cert_issue_date == datetime(2005, 5, 6, tzinfo=UTC)
    assert kept.cert_issue_date is not None
    assert kept.cert_issue_date.tzinfo is not None


@pytest.mark.parametrize("raw", ["", "2005050", "20261340", "notadate"])
def test_an_unparseable_registry_date_reads_as_absent_rather_than_raising(raw: str) -> None:
    """``AIR WORTH DATE`` is blank on plenty of rows and a blank date loses no airframe."""
    index = _index(_master_with(_variant(changes={"CERT ISSUE DATE": raw})), _acftref())
    kept = index.registration(FIRST_HEX)
    assert kept is not None
    assert kept.cert_issue_date is None


def test_the_extract_date_is_not_taken_from_a_zip_entry_mtime(tmp_path: Path) -> None:
    """Zip mtimes are naive local US central, so they are never read."""
    path = tmp_path / ARCHIVE_NAME
    path.write_bytes(_zip(_master(), _acftref()))
    index = read_archive(path, None)
    assert index.extract_date is None


# ---------------------------------------------------------------- the withheld owners


def test_a_blank_owner_name_is_dropped_and_counted_as_44114b_and_not_ladd(
    whole_index: FaaRegistryIndex,
) -> None:
    """4,773 of 316,030 real rows, withheld upstream before we fetched anything."""
    assert whole_index.tally.records_dropped == FIXTURE_BLANK_OWNERS
    reason = next(iter(whole_index.tally.record_drops))
    assert "44114(b)" in reason
    assert "LADD" not in reason
    assert whole_index.tally.record_drops[reason] == FIXTURE_BLANK_OWNERS


def test_a_blank_street_costs_the_address_and_never_the_registration() -> None:
    """The owner name is worth more than one attribute on it."""
    row = _variant(changes={"STREET": " " * 33, "STREET2": " " * 33})
    index = _index(_master_with(row), _acftref())
    kept = index.registration(FIRST_HEX)
    assert kept is not None
    assert kept.owner_name
    assert kept.owner_address is not None
    assert kept.owner_address.street is None
    assert kept.owner_address.city == "KETCHUM"


def test_a_row_with_no_address_at_all_keeps_the_owner_and_counts_the_address() -> None:
    blanks = {
        "STREET": " ",
        "STREET2": " ",
        "CITY": " ",
        "STATE": " ",
        "ZIP CODE": " ",
        "COUNTRY": " ",
    }
    index = _index(_master_with(_variant(changes=blanks)), _acftref())
    kept = index.registration(FIRST_HEX)
    assert kept is not None
    assert kept.owner_address is None
    assert index.tally.addresses_dropped == 1
    assert index.tally.address_drops == {"the registry published no address for this owner": 1}


def test_no_extract_date_drops_every_address_and_keeps_every_owner() -> None:
    """ADR 008 will not hold an undated attribute, and 316,030 owners beat one field."""
    index = _index(_master(), _acftref(), extract_date=None)
    assert len(index) == FIXTURE_ROWS - FIXTURE_BLANK_OWNERS
    assert index.tally.addresses_dropped == FIXTURE_ROWS - FIXTURE_BLANK_OWNERS
    assert index.tally.address_drops == {
        "owner address undated: no extract date on the zip": FIXTURE_ROWS - FIXTURE_BLANK_OWNERS
    }
    kept = index.registration(FIRST_HEX)
    assert kept is not None
    assert kept.owner_name
    assert kept.owner_address is None
    assert kept.extract_date is None


def test_an_owner_name_over_the_contract_width_is_dropped_rather_than_clipped() -> None:
    """A clipped owner is a different owner, and the owner is the point of this file."""
    row = _variant(changes={"NAME": "A" * (OWNER_NAME_MAX_CHARS + 1)})
    index = _index(_master_with(row, _variant(changes={}, row=1)), _acftref())
    assert index.registration(FIRST_HEX) is None
    assert index.tally.records_dropped == 1


def test_an_over_long_street_is_dropped_rather_than_clipped() -> None:
    """A clipped street is a different address, and the address is a match key."""
    index = _index(_master_with(_variant(changes={"STREET": "A" * 61})), _acftref())
    kept = index.registration(FIRST_HEX)
    assert kept is not None
    assert kept.owner_address is not None
    assert kept.owner_address.street is None


def test_a_blank_n_number_is_dropped_and_counted() -> None:
    index = _index(
        _master_with(_variant(changes={"N-NUMBER": "     "}), _variant(changes={}, row=1)),
        _acftref(),
    )
    assert index.registration(FIRST_HEX) is None
    assert index.tally.record_drops == {"N-NUMBER is blank": 1}


def test_a_value_the_contract_refuses_is_counted_under_one_readable_reason() -> None:
    """A pydantic ``ValidationError`` stringifies to several lines and a URL.

    As a Counter key that gives one bucket per row instead of one per reason, which is how
    "dropped and counted" turns into noise nobody reads.
    """
    row = _variant(changes={"STATE": "TOOLONG", "YEAR MFR": "1899"})
    index = _index(_master_with(row, _variant(changes={}, row=1)), _acftref())
    assert index.registration(FIRST_HEX) is None
    assert index.tally.record_drops == {"row does not satisfy the FaaRegistration contract": 1}


# ---------------------------------------------------------------- the join key


@pytest.mark.parametrize("raw", ["", "A004B", "A004B33", "ZZZZZZ", "  "])
def test_an_unusable_mode_s_hex_is_dropped_and_counted(raw: str) -> None:
    index = _index(
        _master_with(_variant(changes={"MODE S CODE HEX": raw}), _variant(changes={}, row=1)),
        _acftref(),
    )
    assert len(index) == 1
    assert index.tally.record_drops == {
        "MODE S CODE HEX is not a six-digit hex address": 1,
    }


def test_two_rows_on_one_hex_keep_the_first_and_count_the_second() -> None:
    """ADR 010 asserts one record per hex, so a registry duplicate must not reach the merge."""
    first = _variant(changes={"NAME": "FIRST OWNER"})
    second = _variant(changes={"NAME": "SECOND OWNER"})
    index = _index(_master_with(first, second), _acftref())
    kept = index.registration(FIRST_HEX)
    assert kept is not None
    assert kept.owner_name == "FIRST OWNER"
    assert index.tally.record_drops == {"duplicate Mode S hex; the first row wins": 1}


def test_a_file_where_nothing_maps_is_an_upstream_shape_change_not_an_empty_register() -> None:
    with pytest.raises(SourceError, match="no usable rows"):
        _index(_master_with(_variant(changes={"MODE S CODE HEX": "ZZZZZZ"})), _acftref())


def test_the_row_ceiling_bounds_the_index(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("tracker.sources.faa_registry.MAX_ROWS", 1)
    with pytest.raises(SourceError, match="row ceiling"):
        _index(_master(), _acftref())


# ---------------------------------------------------------------- the ACFTREF join


def test_acftref_carries_a_model_and_never_an_icao_type_designator() -> None:
    """``MODEL`` is ``UH-60A`` or ``767-322``. ``B763`` is nowhere in this file."""
    with io.BytesIO(_acftref()) as member:
        table = parse_acftref(member)
    assert table[ACFTREF_CODE].model == "UH-60A"
    assert table[ACFTREF_CODE].manufacturer == "AAR AIRLIFT GROUP INC"
    # The structural claim: there is no designator column anywhere in this file, so 'B763'
    # is not derivable from it and nothing here may be written into type_designator.
    assert "TYPE-ACFT" in ACFTREF_COLUMNS
    assert not [name for name in ACFTREF_COLUMNS if "ICAO" in name or "DESIGNATOR" in name]


def test_the_joined_row_carries_make_model_seats_engines_and_weight_class() -> None:
    row = _variant(changes={"MFR MDL CODE": ACFTREF_CODE})
    index = _index(_master_with(row), _acftref())
    kept = index.registration(FIRST_HEX)
    assert kept is not None
    assert kept.manufacturer == "AAR AIRLIFT GROUP INC"
    assert kept.model == "UH-60A"
    assert kept.engines == 2
    assert kept.seats == 15
    assert kept.weight_class == "CLASS 3"


def test_a_zero_cruise_speed_means_unknown_rather_than_stationary() -> None:
    """``SPEED`` is ``0000`` on most rows, and a zero-knot cruise is not a measurement."""
    row = _variant(changes={"MFR MDL CODE": ACFTREF_CODE})
    slow = _index(_master_with(row), _acftref())
    kept = slow.registration(FIRST_HEX)
    assert kept is not None
    assert kept.cruise_speed_kt is None

    fast = _index(_master_with(row), _acftref_with(_acftref_row(ACFTREF_CODE, SPEED="0250")))
    joined = fast.registration(FIRST_HEX)
    assert joined is not None
    assert joined.cruise_speed_kt == 250


def test_a_master_row_whose_code_is_absent_keeps_the_owner_and_loses_the_airframe() -> None:
    """The two recorded slices were cut independently and share no codes, so this is the case
    every fixture row exercises."""
    index = _index(_master(), _acftref())
    kept = index.registration(FIRST_HEX)
    assert kept is not None
    assert kept.manufacturer is None
    assert kept.model is None
    assert kept.seats is None
    assert kept.engines is None
    assert kept.weight_class is None
    assert kept.cruise_speed_kt is None


def test_a_reshaped_acftref_row_is_skipped_without_losing_the_table() -> None:
    short = ",".join(_fields(_lines(ACFTREF_FIXTURE)[1])[:-1])
    with io.BytesIO(_acftref_with(short, _acftref_row("9999999"))) as member:
        table = parse_acftref(member)
    assert "9999999" in table
    assert ACFTREF_CODE not in table


def test_an_unparseable_year_reads_as_absent() -> None:
    index = _index(_master_with(_variant(changes={"YEAR MFR": "19X0"})), _acftref())
    kept = index.registration(FIRST_HEX)
    assert kept is not None
    assert kept.year_manufactured is None


# ---------------------------------------------------------------- the registrant


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("1", RegistrantType.INDIVIDUAL),
        ("2", RegistrantType.PARTNERSHIP),
        ("3", RegistrantType.CORPORATION),
        ("4", RegistrantType.CO_OWNED),
        ("5", RegistrantType.GOVERNMENT),
        ("7", RegistrantType.LLC),
        ("8", RegistrantType.NON_CITIZEN_CORPORATION),
        ("9", RegistrantType.NON_CITIZEN_CO_OWNED),
        ("6", RegistrantType.UNKNOWN),
        (" ", RegistrantType.UNKNOWN),
    ],
)
def test_the_registrant_type_code_maps_and_an_unknown_code_loses_no_record(
    code: str, expected: RegistrantType
) -> None:
    """There is no code 6, and a blank code is not a reason to drop an ownership record."""
    index = _index(_master_with(_variant(changes={"TYPE REGISTRANT": code})), _acftref())
    kept = index.registration(FIRST_HEX)
    assert kept is not None
    assert kept.owner_type is expected


def test_co_owners_come_off_the_other_names_columns_with_blanks_removed() -> None:
    changes = {"OTHER NAMES(1)": "SECOND OWNER", "OTHER NAMES(3)": "THIRD OWNER"}
    index = _index(_master_with(_variant(changes=changes)), _acftref())
    kept = index.registration(FIRST_HEX)
    assert kept is not None
    assert kept.co_owner_names == ("SECOND OWNER", "THIRD OWNER")


def test_the_address_is_dated_sourced_and_marked_pii(whole_index: FaaRegistryIndex) -> None:
    """ADR 008: it is ingested deliberately, and the PII marker is what lets it be
    suppressed for the NoContactData and NoPII packages."""
    kept = whole_index.registration(FIRST_HEX)
    assert kept is not None
    address = kept.owner_address
    assert address is not None
    assert address.as_of == LIVE_EXTRACT_DATE
    assert address.source == SOURCE_NAME
    assert address.pii is True
    assert kept.extract_date == LIVE_EXTRACT_DATE
    assert kept.source == SOURCE_NAME


def test_an_address_cannot_exist_undated_in_the_domain() -> None:
    with pytest.raises(ValueError, match="as_of"):
        OwnerAddress(city="KETCHUM")  # type: ignore[call-arg]  # ty: ignore[missing-argument]


def test_the_zip_code_is_kept_verbatim_because_it_is_a_match_key(
    whole_index: FaaRegistryIndex,
) -> None:
    kept = whole_index.registration(FIRST_HEX)
    assert kept is not None
    assert kept.owner_address is not None
    assert kept.owner_address.postal_code == "005407840"


def test_country_is_blank_on_some_rows_so_it_cannot_default_to_us() -> None:
    column = MASTER_COLUMNS.index("COUNTRY")
    blanks = [line for line in _lines(MASTER_FIXTURE)[1:] if not _fields(line)[column].strip()]
    assert len(blanks) == FIXTURE_BLANK_COUNTRIES

    index = _index(_master_with(_variant(changes={"COUNTRY": "  "})), _acftref())
    kept = index.registration(FIRST_HEX)
    assert kept is not None
    assert kept.owner_address is not None
    assert kept.owner_address.country is None


def test_the_status_code_travels_so_a_lapsed_registration_can_be_told_apart(
    whole_index: FaaRegistryIndex,
) -> None:
    kept = whole_index.registration(FIRST_HEX)
    assert kept is not None
    assert kept.status_code == "V"


# ---------------------------------------------------------------- the merge


def test_apply_to_aircraft_writes_owner_country_and_registration() -> None:
    aircraft = make_aircraft(icao24=FIRST_HEX.lower())
    registration = FaaRegistration(
        icao24=FIRST_HEX.lower(),
        registration="N100",
        owner_name="FASK QUIN B",
        owner_address=OwnerAddress(country="US", as_of=LIVE_EXTRACT_DATE),
    )
    merged = apply_to_aircraft(aircraft, registration)
    assert merged.owner == "FASK QUIN B"
    assert merged.registered_country == "US"
    assert merged.registration == "N100"


def test_apply_to_aircraft_never_writes_a_type_designator_or_an_operator() -> None:
    """ACFTREF's ``MODEL`` is not an ICAO designator, and a registrant is not an operator."""
    aircraft = make_aircraft(icao24=FIRST_HEX.lower())
    registration = FaaRegistration(
        icao24=FIRST_HEX.lower(),
        registration="N100",
        owner_name="FASK QUIN B",
        model="767-322",
    )
    merged = apply_to_aircraft(aircraft, registration)
    assert merged.type_designator is None
    assert merged.operator is None
    assert merged.registered_country is None


def test_apply_to_aircraft_touches_no_ladd_or_privacy_flag() -> None:
    """ADR 009: a LADD-listed aircraft resolves like any other and this path reads no list."""
    aircraft = make_aircraft(icao24=FIRST_HEX.lower())
    registration = FaaRegistration(
        icao24=FIRST_HEX.lower(), registration="N100", owner_name="FASK QUIN B"
    )
    merged = apply_to_aircraft(aircraft, registration)
    assert merged.on_ladd == aircraft.on_ladd
    assert merged.uses_privacy_address == aircraft.uses_privacy_address
    assert merged.is_military == aircraft.is_military


# ---------------------------------------------------------------- the archive on disk


def test_read_archive_parses_both_members_out_of_the_zip(tmp_path: Path) -> None:
    path = tmp_path / ARCHIVE_NAME
    path.write_bytes(_zip(_master(), _acftref()))
    index = read_archive(path, LIVE_EXTRACT_DATE)
    assert len(index) == FIXTURE_ROWS - FIXTURE_BLANK_OWNERS
    assert index.extract_date == LIVE_EXTRACT_DATE


def test_a_member_over_the_decompression_ceiling_is_refused_early(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("tracker.sources.faa_registry.MAX_MEMBER_BYTES", 10)
    path = tmp_path / ARCHIVE_NAME
    path.write_bytes(_zip(_master(), _acftref()))
    with pytest.raises(SourceError, match="decompression ceiling"):
        read_archive(path, LIVE_EXTRACT_DATE)


def test_a_body_that_is_not_a_zip_is_reported_rather_than_raising_badzipfile(
    tmp_path: Path,
) -> None:
    """A CDN error page served with HTTP 200 arrives here, and it is not a zip."""
    path = tmp_path / ARCHIVE_NAME
    path.write_bytes(b"<html><body>Access Denied</body></html>")
    with pytest.raises(SourceError, match="not readable"):
        read_archive(path, LIVE_EXTRACT_DATE)


def test_a_zip_missing_a_member_is_reported(tmp_path: Path) -> None:
    path = tmp_path / ARCHIVE_NAME
    path.write_bytes(_zip(_master(), _acftref(), omit_acftref=True))
    with pytest.raises(SourceError, match="not readable"):
        read_archive(path, LIVE_EXTRACT_DATE)


def test_a_path_that_is_not_a_file_is_reported(tmp_path: Path) -> None:
    with pytest.raises(SourceError, match="not readable"):
        read_archive(tmp_path, LIVE_EXTRACT_DATE)


# ---------------------------------------------------------------- the conditional GET


class _Recorder:
    """A stand-in :data:`ArchiveFetch`. Records the calls and writes what it is told to."""

    def __init__(self, *responses: ArchiveResponse, body: bytes | None = None) -> None:
        self._responses = list(responses)
        self._body = body
        self.calls: list[tuple[str, dict[str, str]]] = []

    def __call__(self, url: str, headers: Mapping[str, str], destination: Path) -> ArchiveResponse:
        self.calls.append((url, dict(headers)))
        response = self._responses.pop(0)
        if response.status_code == 200 and self._body is not None:
            destination.write_bytes(self._body)
        return response


class _Boom:
    """A fetch that fails the way cloudscraper does: an exception with no message."""

    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, url: str, headers: Mapping[str, str], destination: Path) -> ArchiveResponse:
        self.calls += 1
        raise TimeoutError


def _registry(cache_dir: Path, fetch: ArchiveFetch) -> FaaRegistry:
    return FaaRegistry(cache_dir=cache_dir, fetch=fetch, clock=_clock)


async def test_the_first_load_sends_no_validator_and_installs_what_arrives(
    tmp_path: Path,
) -> None:
    archive = _zip(_master(), _acftref())
    fetch = _Recorder(
        ArchiveResponse(status_code=200, last_modified=LIVE_LAST_MODIFIED), body=archive
    )
    registry = _registry(tmp_path, fetch)
    index = await registry.load()

    assert fetch.calls == [(DOWNLOAD_URL, {})]
    assert len(index) == FIXTURE_ROWS - FIXTURE_BLANK_OWNERS
    assert index.extract_date == LIVE_EXTRACT_DATE
    assert registry.last_error is None
    assert (tmp_path / ARCHIVE_NAME).read_bytes() == archive
    assert (tmp_path / f"{ARCHIVE_NAME}.last-modified").read_text() == LIVE_LAST_MODIFIED


async def test_a_second_load_outside_the_day_sends_if_modified_since(tmp_path: Path) -> None:
    archive = _zip(_master(), _acftref())
    _seed(tmp_path, archive, age_s=ONE_DAY_S + 1, header=LIVE_LAST_MODIFIED)
    fetch = _Recorder(ArchiveResponse(status_code=304))
    registry = _registry(tmp_path, fetch)
    index = await registry.load()

    assert fetch.calls == [(DOWNLOAD_URL, {"If-Modified-Since": LIVE_LAST_MODIFIED})]
    assert len(index) == FIXTURE_ROWS - FIXTURE_BLANK_OWNERS
    assert registry.last_error is None


async def test_a_304_restamps_the_disk_copy_so_the_day_starts_again(tmp_path: Path) -> None:
    """A 304 is a confirmation: the zip we hold is the zip the FAA has."""
    archive = _zip(_master(), _acftref())
    _seed(tmp_path, archive, age_s=ONE_DAY_S + 1, header=LIVE_LAST_MODIFIED)
    registry = _registry(tmp_path, _Recorder(ArchiveResponse(status_code=304)))
    await registry.load()
    refreshed = registry.refreshed_at
    assert refreshed is not None
    assert refreshed > NOW - timedelta(seconds=MIN_REFRESH_INTERVAL_S)


async def test_a_load_inside_the_day_touches_no_socket_at_all(tmp_path: Path) -> None:
    archive = _zip(_master(), _acftref())
    _seed(tmp_path, archive, age_s=ONE_DAY_S - 1, header=LIVE_LAST_MODIFIED)
    fetch = _Recorder()
    registry = _registry(tmp_path, fetch)

    first = await registry.load()
    second = await registry.load()

    assert fetch.calls == []
    assert first is second
    assert first.extract_date == LIVE_EXTRACT_DATE


async def test_a_restart_inside_the_day_reindexes_the_disk_copy(tmp_path: Path) -> None:
    """The zip on disk is the current extract by definition, so no request goes out."""
    archive = _zip(_master(), _acftref())
    _seed(tmp_path, archive, age_s=60.0, header=LIVE_LAST_MODIFIED)
    fetch = _Recorder()
    registry = _registry(tmp_path, fetch)
    assert registry.index is None

    index = await registry.load()
    assert fetch.calls == []
    assert index.extract_date == LIVE_EXTRACT_DATE
    assert registry.index is index


async def test_an_unreachable_host_serves_the_disk_copy_and_records_the_reason(
    tmp_path: Path,
) -> None:
    """``TimeoutError`` stringifies to nothing, so the reason must name the type."""
    _seed(tmp_path, _zip(_master(), _acftref()), age_s=ONE_DAY_S + 1, header=LIVE_LAST_MODIFIED)
    registry = _registry(tmp_path, _Boom())
    index = await registry.load()

    assert len(index) == FIXTURE_ROWS - FIXTURE_BLANK_OWNERS
    assert registry.last_error == "unreachable: TimeoutError"


async def test_a_failed_refresh_keeps_the_index_already_in_hand(tmp_path: Path) -> None:
    archive = _zip(_master(), _acftref())
    _seed(tmp_path, archive, age_s=ONE_DAY_S + 1, header=LIVE_LAST_MODIFIED)
    registry = _registry(tmp_path, _Recorder(ArchiveResponse(status_code=503)))
    first = await registry._reindex()
    second = await registry.load()

    assert second is first
    assert registry.last_error == "HTTP 503 for the zip"


async def test_a_non_200_with_no_disk_copy_is_a_hard_failure(tmp_path: Path) -> None:
    registry = _registry(tmp_path, _Recorder(ArchiveResponse(status_code=503)))
    with pytest.raises(SourceError, match="HTTP 503"):
        await registry.load()
    assert registry.last_error == "HTTP 503 for the zip"


async def test_a_304_for_a_zip_we_no_longer_hold_is_unusable(tmp_path: Path) -> None:
    """We sent no validator, so a 304 here means the cache and the disk disagree."""
    (tmp_path / f"{ARCHIVE_NAME}.last-modified").write_text(LIVE_LAST_MODIFIED)
    registry = _registry(tmp_path, _Recorder(ArchiveResponse(status_code=304)))
    with pytest.raises(SourceError, match="HTTP 304 but no cached zip"):
        await registry.load()


async def test_a_200_carrying_a_cdn_error_page_never_replaces_the_disk_copy(
    tmp_path: Path,
) -> None:
    """Validated before it is installed, never after.

    Installing first would destroy the working register, take a fresh mtime, and the daily
    floor would then short-circuit onto the poison for a day with no further request.
    """
    good = _zip(_master(), _acftref())
    path = _seed(tmp_path, good, age_s=ONE_DAY_S + 1, header=LIVE_LAST_MODIFIED)
    fetch = _Recorder(
        ArchiveResponse(status_code=200, last_modified="Thu, 20 Aug 2026 04:58:00 GMT"),
        body=b"<html>Access Denied</html>",
    )
    registry = _registry(tmp_path, fetch)
    index = await registry.load()

    assert path.read_bytes() == good
    assert len(index) == FIXTURE_ROWS - FIXTURE_BLANK_OWNERS
    assert registry.last_error is not None
    assert registry.last_error.startswith("HTTP 200 but")


async def test_a_200_with_no_last_modified_lands_the_owners_and_drops_the_addresses(
    tmp_path: Path,
) -> None:
    """Phase 5 acceptance 2, and the path that decides it."""
    fetch = _Recorder(
        ArchiveResponse(status_code=200, last_modified=None),
        body=_zip(_master(), _acftref()),
    )
    registry = _registry(tmp_path, fetch)
    index = await registry.load()

    assert index.extract_date is None
    assert index.tally.addresses_dropped == FIXTURE_ROWS - FIXTURE_BLANK_OWNERS
    assert not (tmp_path / f"{ARCHIVE_NAME}.last-modified").exists()


async def test_a_stale_validator_is_cleared_when_the_new_response_carries_none(
    tmp_path: Path,
) -> None:
    header_path = tmp_path / f"{ARCHIVE_NAME}.last-modified"
    _seed(tmp_path, _zip(_master(), _acftref()), age_s=ONE_DAY_S + 1, header=LIVE_LAST_MODIFIED)
    assert header_path.exists()

    fetch = _Recorder(
        ArchiveResponse(status_code=200, last_modified=None), body=_zip(_master(), _acftref())
    )
    await _registry(tmp_path, fetch).load()
    assert not header_path.exists()


async def test_an_uncacheable_download_still_serves_this_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The index is already built, so only the next restart pays."""
    fetch = _Recorder(
        ArchiveResponse(status_code=200, last_modified=LIVE_LAST_MODIFIED),
        body=_zip(_master(), _acftref()),
    )

    def _refuse(self: Path, target: Path) -> Path:
        raise OSError("read-only file system")

    monkeypatch.setattr(Path, "replace", _refuse)
    registry = _registry(tmp_path, fetch)
    index = await registry.load()
    assert len(index) == FIXTURE_ROWS - FIXTURE_BLANK_OWNERS
    assert registry.last_error is None


async def test_a_restamp_that_fails_does_not_lose_the_304(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(tmp_path, _zip(_master(), _acftref()), age_s=ONE_DAY_S + 1, header=LIVE_LAST_MODIFIED)

    def _refuse(self: Path, **kwargs: object) -> None:
        raise OSError("read-only file system")

    monkeypatch.setattr(Path, "touch", _refuse)
    registry = _registry(tmp_path, _Recorder(ArchiveResponse(status_code=304)))
    index = await registry.load()
    assert len(index) == FIXTURE_ROWS - FIXTURE_BLANK_OWNERS


async def test_a_failed_refresh_onto_an_unreadable_disk_copy_reports_both_reasons(
    tmp_path: Path,
) -> None:
    _seed(tmp_path, b"<html>not a zip</html>", age_s=ONE_DAY_S + 1, header=LIVE_LAST_MODIFIED)
    registry = _registry(tmp_path, _Boom())
    with pytest.raises(SourceError, match="unreachable: TimeoutError; and"):
        await registry.load()
    assert registry.last_error is not None
    assert "not readable" in registry.last_error


async def test_a_304_onto_an_unreadable_disk_copy_records_why(tmp_path: Path) -> None:
    """Without this the reason is thrown away and the layer says it was never read."""
    _seed(tmp_path, b"<html>not a zip</html>", age_s=ONE_DAY_S + 1, header=LIVE_LAST_MODIFIED)
    registry = _registry(tmp_path, _Recorder(ArchiveResponse(status_code=304)))
    with pytest.raises(SourceError, match="not readable"):
        await registry.load()
    assert registry.last_error is not None
    assert "not readable" in registry.last_error


async def test_a_lookup_before_the_first_load_raises_rather_than_claiming_a_miss(
    tmp_path: Path,
) -> None:
    """``None`` would say the FAA holds no such airframe when nobody has looked."""
    registry = _registry(tmp_path, _Recorder())
    with pytest.raises(SourceError, match="not been loaded"):
        await registry.aircraft(FIRST_HEX)


async def test_a_lookup_after_load_resolves_an_owner_with_no_request(tmp_path: Path) -> None:
    """Phase 5 acceptance 1, made structural: the index holds no client."""
    fetch = _Recorder(
        ArchiveResponse(status_code=200, last_modified=LIVE_LAST_MODIFIED),
        body=_zip(_master(), _acftref()),
    )
    registry = _registry(tmp_path, fetch)
    await registry.load()

    found = await registry.aircraft(FIRST_HEX.lower())
    assert found is not None
    assert found.owner_name
    assert await registry.aircraft("adf7c8") is None
    assert len(fetch.calls) == 1


def test_refreshed_at_is_none_when_there_is_no_disk_copy(tmp_path: Path) -> None:
    assert _registry(tmp_path, _Recorder()).refreshed_at is None


async def test_a_whitespace_only_validator_file_reads_as_no_validator(
    tmp_path: Path,
) -> None:
    """Echoing back a blank ``If-Modified-Since`` would be a malformed conditional request."""
    _seed(tmp_path, _zip(_master(), _acftref()), age_s=ONE_DAY_S + 1, header="   ")
    fetch = _Recorder(
        ArchiveResponse(status_code=200, last_modified=LIVE_LAST_MODIFIED),
        body=_zip(_master(), _acftref()),
    )
    await _registry(tmp_path, fetch).load()
    assert fetch.calls == [(DOWNLOAD_URL, {})]


async def test_a_disk_copy_with_no_validator_sends_no_conditional_header(
    tmp_path: Path,
) -> None:
    _seed(tmp_path, _zip(_master(), _acftref()), age_s=ONE_DAY_S + 1)
    fetch = _Recorder(
        ArchiveResponse(status_code=200, last_modified=LIVE_LAST_MODIFIED),
        body=_zip(_master(), _acftref()),
    )
    await _registry(tmp_path, fetch).load()
    assert fetch.calls == [(DOWNLOAD_URL, {})]


async def test_the_default_clock_is_the_wall_clock(tmp_path: Path) -> None:
    """Nothing injects a clock in the product, so the default has to hold the floor.

    The zip is written with its real mtime rather than a seeded one, so the age the default
    clock computes is genuinely near zero on any day this runs.
    """
    fetch = _Recorder()
    (tmp_path / ARCHIVE_NAME).write_bytes(_zip(_master(), _acftref()))
    (tmp_path / f"{ARCHIVE_NAME}.last-modified").write_text(LIVE_LAST_MODIFIED)
    registry = FaaRegistry(cache_dir=tmp_path, fetch=fetch)
    index = await registry.load()

    assert fetch.calls == []
    assert len(index) == FIXTURE_ROWS - FIXTURE_BLANK_OWNERS


def test_the_daily_floor_has_one_implementation_and_it_is_a_day() -> None:
    assert MIN_REFRESH_INTERVAL_S == ONE_DAY_S
    assert next_refresh_after(NOW) == NOW + timedelta(seconds=ONE_DAY_S)


# ---------------------------------------------------------------- cloudscraper


class _FakeResponse:
    def __init__(self, status_code: int, *, headers: Mapping[str, str], body: bytes) -> None:
        self.status_code = status_code
        self.headers = dict(headers)
        self._body = body

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def iter_content(self, chunk_size: int) -> Iterator[bytes]:
        for start in range(0, len(self._body), chunk_size):
            yield self._body[start : start + chunk_size]


class _FakeScraper:
    """Stands in for a cloudscraper session, and refuses to have a ``head`` called."""

    def __init__(self, response: _FakeResponse) -> None:
        self._response = response
        self.gets: list[tuple[str, dict[str, str], bool]] = []

    def get(
        self, url: str, *, headers: Mapping[str, str], timeout: tuple[float, float], stream: bool
    ) -> _FakeResponse:
        self.gets.append((url, dict(headers), stream))
        return self._response

    def head(self, *args: object, **kwargs: object) -> None:
        raise AssertionError("the freshness check is a conditional GET, never a HEAD")


def test_download_archive_streams_a_200_to_disk_with_a_get(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """GET and never HEAD: through cloudscraper a HEAD answers 503 with a 2013 decoy date."""
    body = _zip(_master(), _acftref())
    scraper = _FakeScraper(
        _FakeResponse(200, headers={"Last-Modified": LIVE_LAST_MODIFIED}, body=body)
    )
    monkeypatch.setattr("tracker.sources.faa_registry.cloudscraper.create_scraper", lambda: scraper)
    destination = tmp_path / "part"
    response = download_archive(
        DOWNLOAD_URL, {"If-Modified-Since": LIVE_LAST_MODIFIED}, destination
    )

    assert response == ArchiveResponse(status_code=200, last_modified=LIVE_LAST_MODIFIED)
    assert destination.read_bytes() == body
    assert scraper.gets == [(DOWNLOAD_URL, {"If-Modified-Since": LIVE_LAST_MODIFIED}, True)]


def test_download_archive_writes_nothing_on_a_304(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A real 304 through cloudscraper carries zero bytes, measured 2026-08-20."""
    scraper = _FakeScraper(
        _FakeResponse(304, headers={"Last-Modified": LIVE_LAST_MODIFIED}, body=b"")
    )
    monkeypatch.setattr("tracker.sources.faa_registry.cloudscraper.create_scraper", lambda: scraper)
    destination = tmp_path / "part"
    response = download_archive(DOWNLOAD_URL, {}, destination)

    assert response.status_code == 304
    assert not destination.exists()
