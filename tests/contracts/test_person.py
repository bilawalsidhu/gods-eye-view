"""The person contract: the small assertable core, and the deliberately empty rest."""

from datetime import date

import pytest
from pydantic import ValidationError

from tracker.contracts.person import ADDRESS_WARNING, WEALTH_TIER_REASON, DateOfBirth, Person, Role

AS_OF = date(2026, 8, 11)


def role(**kwargs: object) -> Role:
    fields: dict[str, object] = {
        "organisation_id": "sec-0000320193",
        "organisation_name": "Apple Inc.",
        "title": "SVP, GC and Secretary",
        "is_officer": True,
        "as_of": AS_OF,
        "source": "sec-edgar",
        "origin_key": "0001140361-26-165249",
    }
    fields.update(kwargs)
    return Role(**fields)  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]


def person(**kwargs: object) -> Person:
    fields: dict[str, object] = {
        "person_id": "sec-0009999001",
        "name": "Undersby Quillon",
        "sec_cik": "0009999001",
        "roles": (role(),),
    }
    fields.update(kwargs)
    return Person(**fields)  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]


def test_a_person_needs_an_id_and_a_name_and_nothing_else() -> None:
    p = Person(person_id="sec-0009999001", name="Undersby Quillon")
    assert p.kind == "person"
    assert p.roles == ()
    assert p.wealth_tier is None


def test_the_wealth_tier_is_none_and_the_product_says_why() -> None:
    """2,076 net-worth statements exist in all of Wikidata, 58% of them unsourced."""
    assert person().wealth_tier is None
    assert WEALTH_TIER_REASON
    assert "not established" in WEALTH_TIER_REASON


def test_contact_attributes_are_empty_because_public_sources_do_not_have_them() -> None:
    p = person()
    assert p.emails == ()
    assert p.phones == ()
    assert p.addresses == ()
    assert p.has_pii is False


def test_the_address_rule_is_stated_rather_than_left_to_a_reviewer() -> None:
    """SEC gives the issuer's address; Companies House gives a statutory service address."""
    assert "never a residence" in ADDRESS_WARNING


def test_a_person_is_frozen() -> None:
    p = person()
    with pytest.raises(ValidationError):
        p.name = "someone else"  # type: ignore[misc]  # ty: ignore[invalid-assignment]


def test_an_unknown_field_is_refused() -> None:
    with pytest.raises(ValidationError):
        person(net_worth_usd=1)


def test_a_personal_cik_must_be_ten_digits_like_a_filing_writes_it() -> None:
    assert person(sec_cik="0009999001").sec_cik == "0009999001"
    with pytest.raises(ValidationError):
        person(sec_cik="9999001")


def test_a_wikidata_qid_is_shaped_but_never_asserts() -> None:
    assert person(wikidata_qid="Q317521").wikidata_qid == "Q317521"
    with pytest.raises(ValidationError):
        person(wikidata_qid="317521")


# ---------------------------------------------------------------- date of birth precision


def test_a_year_only_date_of_birth_stays_a_year() -> None:
    """Wikidata's wdt: widens this to 1 January, which then reads as a real day."""
    dob = DateOfBirth(year=1947)
    assert dob.precision == "year"
    assert dob.month is None
    assert dob.day is None


def test_the_psc_month_and_year_shape_is_representable() -> None:
    """A real PSC record reads {"month": 2, "year": 1947}. It never carries a day."""
    dob = DateOfBirth(year=1947, month=2)
    assert dob.precision == "month"


def test_a_full_date_of_birth_is_representable() -> None:
    assert DateOfBirth(year=1971, month=6, day=28).precision == "day"


def test_a_day_without_a_month_is_not_a_precision_any_source_produces() -> None:
    with pytest.raises(ValidationError):
        DateOfBirth(year=1971, day=28)


@pytest.mark.parametrize(("year", "month"), [(1500, None), (2200, None), (1971, 13), (1971, 0)])
def test_an_impossible_date_of_birth_is_refused(year: int, month: int | None) -> None:
    with pytest.raises(ValidationError):
        DateOfBirth(year=year, month=month)


# ---------------------------------------------------------------- roles


def test_a_role_carries_the_filings_own_flags_not_a_derived_seniority() -> None:
    r = role(is_director=True, is_officer=False, title=None)
    assert r.is_director is True
    assert r.is_officer is False
    assert r.is_ten_percent_owner is False
    assert r.title is None


def test_a_role_without_a_date_is_refused() -> None:
    with pytest.raises(ValidationError):
        role(as_of=None)


def test_a_role_without_an_origin_key_is_refused() -> None:
    """Two adapters reading one filing must be countable as one source."""
    with pytest.raises(ValidationError):
        role(origin_key="")


def test_the_name_keeps_the_surname_first_form_the_filing_used() -> None:
    """Reordering guesses which token is the surname, and a middle initial defeats the guess."""
    assert person(name="ELLERSMARCH PEVEREL D").name == "ELLERSMARCH PEVEREL D"
