"""The ITU MID table: the committed CSV, its parsing traps and the provenance check.

No network anywhere in this module, and none in the tests either: ``itu.py`` never fetches
anything. The table ships as a committed CSV read once per process, per its own docstring,
because a card render must not cost an HTTP request. What is tested here is the parser's own
traps (a cell holding several MIDs, one MID allocated to more than one flag state, a
hyphenated administration name that must not be mis-split on the ``" - "`` territory
separator) and the malformed-file paths ``_read_table`` raises on rather than drops and
counts, because a bad row in a file this repo ships itself is our bug, not upstream noise.

The provenance test is the one that matters most. It reads the real committed
``src/tracker/sources/itu_mid_table.csv`` and asserts it matches
``tests/fixtures/itu_mid_table_live.json``, the recorded 2026-08-19 scrape, row for row. That
is the whole basis for trusting the file: proof it is the ITU's table and not something
somebody typed by hand.

``tests/fixtures/itu_mars_*`` are not read here. ``itu.py``'s own docstring says MARS is
deliberately not built: the ship-station search and detail pages are refused on the ITU's own
redistribution terms, so nothing in this module ever touches them and there is nothing to test.
"""

import json
from collections.abc import Iterator
from importlib.resources import files as real_files
from importlib.resources.abc import Traversable
from pathlib import Path
from types import MappingProxyType

import pytest

from tests.conftest import fixture_bytes
from tracker.contracts.vessel import AIS_MID_MAX, AIS_MID_MIN
from tracker.sources import itu


@pytest.fixture(autouse=True)
def _cleared_cache() -> Iterator[None]:
    """``flag_allocations`` is cached at module scope for the life of the process.

    Left alone, whichever test in this file ran first would freeze the table for every test
    after it, including the ones that deliberately install a broken one and expect a raise.
    """
    itu.flag_allocations.cache_clear()
    yield
    itu.flag_allocations.cache_clear()


def _install_table(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, body: str) -> None:
    """Point ``_read_table`` at a throwaway CSV instead of the packaged one."""
    (tmp_path / itu.TABLE_FILE_NAME).write_text(body, encoding="utf-8")
    monkeypatch.setattr("tracker.sources.itu.files", lambda _package: tmp_path)


# ---------------------------------------------------------------- provenance


def test_the_committed_csv_matches_the_recorded_scrape_row_for_row() -> None:
    """Proof the committed table is the ITU's own, not something typed by hand.

    The recorded capture uses ``mid_cell``, the committed CSV uses ``mids``: same two
    columns, same 249 rows, same order.
    """
    capture = json.loads(fixture_bytes("itu_mid_table_live.json"))
    committed = itu._read_table()

    assert capture["row_count"] == itu.EXPECTED_ROW_COUNT
    assert capture["distinct_mid_count"] == itu.EXPECTED_MID_COUNT
    assert len(capture["rows"]) == capture["row_count"]

    expanded = [(mid, state.name) for mid, state in committed]
    recorded = [
        (mid, itu._parse_allocated_to(row["allocated_to"]).name)
        for row in capture["rows"]
        for mid in row["mid_cell"].split()
    ]
    assert expanded == recorded


def test_the_committed_file_is_alongside_the_module() -> None:
    """The CSV travels with the package rather than living somewhere path-relative."""
    assert (Path(itu.__file__).parent / itu.TABLE_FILE_NAME).is_file()


# ---------------------------------------------------------------- the column mapping traps


def test_a_cell_holding_several_mids_expands_to_one_pair_per_mid() -> None:
    """``232 233 234 235`` is one United Kingdom row and must become four MIDs."""
    uk = itu.flag_allocation("232")
    assert uk is not None
    assert uk.flag_state is not None
    assert uk.flag_state.administration == "United Kingdom of Great Britain and Northern Ireland"
    for mid in ("233", "234", "235"):
        allocation = itu.flag_allocation(mid)
        assert allocation is not None
        assert allocation.flag_states == uk.flag_states, f"MID {mid} should share the UK row"


def test_a_mid_allocated_to_three_territories_carries_all_three() -> None:
    """MID 306: Bonaire, Curaçao and Sint Maarten, all Dutch, none of them the whole answer."""
    allocation = itu.flag_allocation("306")
    assert allocation is not None
    assert [state.territory for state in allocation.flag_states] == [
        "Bonaire, Sint Eustatius and Saba",
        "Curaçao",
        "Sint Maarten (Dutch part)",
    ]
    assert allocation.flag_state is None, "three states means no single answer"
    assert allocation.administration == "Netherlands (Kingdom of the)", (
        "a real narrowing: not one flag, but one sovereign state"
    )


def test_an_administration_and_its_territory_are_different_facts() -> None:
    """MID 310: QUEEN MARY 2's flag is Bermuda, notified by the United Kingdom.

    A reader who takes the administration for the flag turns every Red Ensign yacht British.
    """
    allocation = itu.flag_allocation("310")
    assert allocation is not None
    flag_state = allocation.flag_state
    assert flag_state is not None
    assert flag_state.administration == "United Kingdom of Great Britain and Northern Ireland"
    assert flag_state.territory == "Bermuda"
    assert flag_state.name == "United Kingdom of Great Britain and Northern Ireland - Bermuda"


def test_the_only_two_hyphenated_names_are_not_mis_split() -> None:
    """Neither hyphen has spaces around it, so the ``" - "`` territory split must not fire."""
    guinea_bissau = itu.flag_allocation("630")
    timor_leste = itu.flag_allocation("550")
    assert guinea_bissau is not None
    assert timor_leste is not None
    assert guinea_bissau.flag_state == itu.FlagState(administration="Guinea-Bissau (Republic of)")
    assert timor_leste.flag_state == itu.FlagState(
        administration="Timor-Leste (Democratic Republic of)"
    )


def test_forty_three_rows_carry_a_territory() -> None:
    """The count the module's own comment gives, so a table edit that changes it is loud."""
    territories = [
        state
        for allocation in itu.flag_allocations().values()
        for state in allocation.flag_states
        if state.territory is not None
    ]
    assert len(territories) == 43


# ---------------------------------------------------------------- _parse_allocated_to


def test_a_cell_with_no_separator_has_no_territory() -> None:
    assert itu._parse_allocated_to("Austria") == itu.FlagState(administration="Austria")


def test_a_cell_with_the_separator_splits_into_administration_and_territory() -> None:
    assert itu._parse_allocated_to("Portugal - Azores") == itu.FlagState(
        administration="Portugal", territory="Azores"
    )


def test_surrounding_whitespace_is_stripped_on_both_sides_of_the_separator() -> None:
    assert itu._parse_allocated_to("  Portugal   -   Azores  ") == itu.FlagState(
        administration="Portugal", territory="Azores"
    )


# ---------------------------------------------------------------- FlagState.name


def test_flag_state_name_is_the_administration_alone_with_no_territory() -> None:
    assert itu.FlagState(administration="Austria").name == "Austria"


def test_flag_state_name_joins_administration_and_territory() -> None:
    state = itu.FlagState(administration="Portugal", territory="Azores")
    assert state.name == "Portugal - Azores"


# ---------------------------------------------------------------- FlagAllocation properties


def test_flag_state_is_the_single_answer_when_there_is_exactly_one() -> None:
    allocation = itu.FlagAllocation(
        mid="201", flag_states=(itu.FlagState(administration="Albania (Republic of)"),)
    )
    assert allocation.flag_state == itu.FlagState(administration="Albania (Republic of)")


def test_flag_state_is_none_when_the_mid_covers_several() -> None:
    allocation = itu.FlagAllocation(
        mid="306",
        flag_states=(
            itu.FlagState(administration="Netherlands (Kingdom of the)", territory="Bonaire"),
            itu.FlagState(administration="Netherlands (Kingdom of the)", territory="Curaçao"),
        ),
    )
    assert allocation.flag_state is None


def test_administration_agrees_across_differing_territories_of_one_sovereign_state() -> None:
    allocation = itu.FlagAllocation(
        mid="306",
        flag_states=(
            itu.FlagState(administration="Netherlands (Kingdom of the)", territory="Bonaire"),
            itu.FlagState(administration="Netherlands (Kingdom of the)", territory="Curaçao"),
        ),
    )
    assert allocation.administration == "Netherlands (Kingdom of the)"


def test_administration_is_none_across_two_sovereign_states() -> None:
    """The 2026-08-19 table never does this. The property still has to handle it."""
    allocation = itu.FlagAllocation(
        mid="000",
        flag_states=(
            itu.FlagState(administration="Portugal"),
            itu.FlagState(administration="Spain"),
        ),
    )
    assert allocation.administration is None


# ---------------------------------------------------------------- flag_allocation


def test_an_unallocated_mid_inside_the_range_resolves_to_none() -> None:
    """217 is a genuine gap: three digits, in range, and the ITU has never allocated it."""
    assert AIS_MID_MIN <= 217 <= AIS_MID_MAX
    assert itu.flag_allocation("217") is None


def test_the_nato_warship_placeholder_mid_resolves_to_none_not_an_error() -> None:
    """MMSI 999999999 is a live placeholder (NATO WARSHIP). 999 is not a MID, and that is a
    real answer, not a fault: the vessel contract already refuses that MMSI on its own terms.
    """
    assert itu.flag_allocation("999") is None


@pytest.mark.parametrize("mid", ["1", "12", "1234", "20", ""])
def test_a_mid_of_the_wrong_length_is_rejected(mid: str) -> None:
    with pytest.raises(ValueError, match="not a three-digit ITU MID"):
        itu.flag_allocation(mid)


def test_a_non_digit_mid_is_rejected() -> None:
    with pytest.raises(ValueError, match="not a three-digit ITU MID"):
        itu.flag_allocation("2 1")


# ---------------------------------------------------------------- flag_allocations


def test_the_real_table_has_292_mids_across_249_rows() -> None:
    assert itu.EXPECTED_MID_COUNT == 292
    assert itu.EXPECTED_ROW_COUNT == 249
    assert len(itu.flag_allocations()) == itu.EXPECTED_MID_COUNT


def test_the_table_is_read_only() -> None:
    allocations = itu.flag_allocations()
    assert isinstance(allocations, MappingProxyType)
    with pytest.raises(TypeError):
        allocations["201"] = None  # type: ignore[index]  # ty: ignore[invalid-assignment]


def test_the_table_is_cached_and_the_file_is_read_only_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def counting_files(package: str) -> Traversable:
        calls.append(package)
        return real_files(package)

    monkeypatch.setattr("tracker.sources.itu.files", counting_files)

    first = itu.flag_allocations()
    second = itu.flag_allocations()

    assert first is second
    assert calls == ["tracker.sources"]


# ---------------------------------------------------------------- malformed committed file


def test_a_row_missing_its_mid_is_a_bug_and_raises(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Our own file, not upstream noise: raised, never dropped and counted."""
    _install_table(monkeypatch, tmp_path, "mids,allocated_to\n,Nowhere\n")
    with pytest.raises(ValueError, match="row 1 has no MID or no allocation"):
        itu._read_table()


def test_a_row_missing_its_allocation_is_a_bug_and_raises(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _install_table(monkeypatch, tmp_path, "mids,allocated_to\n201,\n")
    with pytest.raises(ValueError, match="row 1 has no MID or no allocation"):
        itu._read_table()


def test_a_token_that_is_not_three_digits_raises(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _install_table(monkeypatch, tmp_path, "mids,allocated_to\n12,Nowhere\n")
    with pytest.raises(ValueError, match="row 1 has a non-MID token '12'"):
        itu._read_table()


def test_a_non_digit_token_raises(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _install_table(monkeypatch, tmp_path, "mids,allocated_to\nabc,Nowhere\n")
    with pytest.raises(ValueError, match="row 1 has a non-MID token 'abc'"):
        itu._read_table()


def test_a_mid_outside_the_allocated_range_raises(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _install_table(monkeypatch, tmp_path, "mids,allocated_to\n100,Nowhere\n")
    with pytest.raises(ValueError, match=r"outside the allocated range 201 to 775"):
        itu._read_table()


def test_a_row_count_that_does_not_match_the_expectation_raises(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """One perfectly well-formed row, but the file is supposed to hold 249 of them."""
    _install_table(monkeypatch, tmp_path, "mids,allocated_to\n201,Nowhere\n")
    with pytest.raises(ValueError, match="has 1 rows, expected 249"):
        itu._read_table()


def test_a_mid_count_that_does_not_match_the_expectation_raises(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Rows can satisfy ``EXPECTED_ROW_COUNT`` and still not add up to 292 distinct MIDs."""
    monkeypatch.setattr(itu, "EXPECTED_ROW_COUNT", 1)
    _install_table(monkeypatch, tmp_path, "mids,allocated_to\n201,Nowhere\n")
    with pytest.raises(ValueError, match="holds 1 MIDs, expected 292"):
        itu.flag_allocations()


# ---------------------------------------------------------------- provenance strings


def test_the_module_names_the_licence_restriction_and_the_mars_refusal() -> None:
    """Reversing either decision must be a grep, not an excavation."""
    source = Path(itu.__file__).read_text(encoding="utf-8")
    assert "non-commercial" in itu.LICENCE
    assert "MARS is deliberately not built" in source
    assert "prohibit distribution" in source
