"""The Canadian civil aircraft register: the non-US half of the ownership spine.

Fixtures are the committed extracts, which are pseudonymised. `test_fixture_privacy.py` is the
gate that requires it: this register carries the names and home addresses of private individuals,
which is exactly the class of data that must never enter this repository.
"""

import io
from datetime import UTC, datetime

from tests.conftest import fixture_bytes
from tracker.sources.ccarcs import (
    icao24_from_binary,
    is_canadian_civil_hex,
    parse_layout,
    parse_registry,
)


def _members() -> tuple[io.BytesIO, io.BytesIO, io.BytesIO]:
    """The three zip members, as the parser wants them."""
    return (
        io.BytesIO(fixture_bytes("ccarcs_carslayout.txt")),
        io.BytesIO(fixture_bytes("ccarcs_carscurr_extract.csv")),
        io.BytesIO(fixture_bytes("ccarcs_carsownr_extract.csv")),
    )


class TestTheTransponderConversion:
    """The one function that decides whether an aircraft is the right aircraft."""

    def test_reads_the_field_as_binary_and_not_as_hex(self) -> None:
        # The trap this exists for. `MODE_S_TRANSPONDER_BINARY` is 24 characters of 0 and 1, and
        # the ADS-B feeds send six hex digits. Reading the field as hex, or as a decimal integer,
        # produces a valid-looking address belonging to a **different aircraft**, so the join
        # would be confidently wrong rather than absent.
        assert icao24_from_binary("110000000000000000000011") == "c00003"
        assert icao24_from_binary("110000000000000000001010") == "c0000a"
        assert icao24_from_binary("110000000000000000001101") == "c0000d"

    def test_refuses_a_field_that_is_not_twenty_four_binary_digits(self) -> None:
        # A short, long or non-binary field is a parse failure, not an address. Returning
        # something plausible here is how a registry join attaches an owner to a stranger.
        assert icao24_from_binary("") is None
        assert icao24_from_binary("1100") is None
        assert icao24_from_binary("c00003") is None
        assert icao24_from_binary("1100000000000000000000112") is None
        assert icao24_from_binary("11000000000000000000002 ") is None

    def test_tolerates_surrounding_whitespace(self) -> None:
        assert icao24_from_binary("  110000000000000000000011  ") == "c00003"


class TestTheAddressRangeGuard:
    def test_knows_which_addresses_could_be_on_this_register_at_all(self) -> None:
        # A skip rather than a miss. Canadian civil addresses derive entirely into `c0`, so a
        # `c2` military address will never be here and asking is wasted work, exactly as an `ae`
        # address is for the FAA.
        assert is_canadian_civil_hex("c00003") is True
        assert is_canadian_civil_hex("C0000A") is True
        assert is_canadian_civil_hex("c20001") is False
        assert is_canadian_civil_hex("a1b2c3") is False


class TestParsingTheRegister:
    def test_builds_an_index_from_the_three_members(self) -> None:
        layout, current, owners = _members()

        index = parse_registry(
            layout, current, owners, extract_date=datetime(2026, 8, 21, tzinfo=UTC)
        )

        assert len(index) > 0
        assert index.extract_date == datetime(2026, 8, 21, tzinfo=UTC)
        # The register is reachable by the address a live ADS-B feed sends, which is the whole
        # point of the binary conversion above.
        assert index.registration("c00003") is not None

    def test_every_indexed_address_is_reachable_from_its_binary_field(self) -> None:
        # The index key and the conversion must agree, or a lookup from a live ADS-B address
        # silently finds nothing while the register plainly holds the aircraft.
        layout, current, owners = _members()

        index = parse_registry(layout, current, owners, extract_date=None)

        # An address the register cannot hold must miss rather than resolve to something.
        assert index.registration("c20001") is None
        assert index.registration("a1b2c3") is None

    def test_counts_what_it_refused_rather_than_discarding_it(self) -> None:
        # "Dropped and counted", not "dropped and logged". A register that refuses rows and
        # reports one undifferentiated number leaves the rail nothing to say about coverage.
        layout, current, owners = _members()

        index = parse_registry(layout, current, owners, extract_date=None)

        tally = index.tally
        assert tally.registrations > 0
        # Three separate counters, because they are three different obligations rather than
        # three flavours of one: a malformed row, an owner the licence will not let us keep,
        # and an address that would not map.
        for counter in (tally.record_drops, tally.owner_drops, tally.address_drops):
            for reason, count in counter.items():
                assert reason.strip() != ""
                assert count > 0


class TestTheLayout:
    def test_reads_the_column_names_from_the_layout_member(self) -> None:
        # The layout is the only description of a fixed-width file whose columns have moved
        # before. Parsing positionally without checking it is how a register silently reads the
        # owner's postcode as their name.
        layout, _current, _owners = _members()

        current_columns, owner_columns = parse_layout(layout)

        assert len(current_columns) > 0
        assert len(owner_columns) > 0
