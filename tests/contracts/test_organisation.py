"""The organisation contract, and why one company is several strings."""

import pytest
from pydantic import ValidationError

from tracker.contracts.organisation import Organisation


def org(**kwargs: object) -> Organisation:
    fields: dict[str, object] = {"organisation_id": "sec-0000320193", "name": "Apple Inc."}
    fields.update(kwargs)
    return Organisation(**fields)  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]


def test_an_organisation_needs_only_an_id_and_a_name() -> None:
    o = org()
    assert o.kind == "organisation"
    assert o.registry_names == ()
    assert o.joins == ()


def test_registry_names_hold_the_strings_the_registers_actually_used() -> None:
    """The SEC indexes parent holding companies; aircraft register to operating subsidiaries."""
    o = org(
        name="American Airlines Group Inc.",
        registry_names=("AMERICAN AIRLINES INC",),
    )
    assert o.name != o.registry_names[0]
    assert "AMERICAN AIRLINES INC" in o.registry_names


def test_a_company_cik_must_be_ten_digits() -> None:
    assert org(sec_cik="0000320193").sec_cik == "0000320193"
    with pytest.raises(ValidationError):
        org(sec_cik="320193")


def test_an_organisation_is_frozen() -> None:
    o = org()
    with pytest.raises(ValidationError):
        o.name = "other"  # type: ignore[misc]  # ty: ignore[invalid-assignment]


def test_an_unknown_field_is_refused() -> None:
    with pytest.raises(ValidationError):
        org(revenue=1)
