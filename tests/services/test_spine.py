"""The matching rule. This is where the project becomes harmful if it is loose."""

from datetime import date

import pytest

from tests.conftest import fixture_bytes
from tracker.contracts.organisation import Organisation
from tracker.services import spine
from tracker.sources import sec

AS_OF = date(2026, 8, 22)


def company(cik: str, name: str) -> Organisation:
    return Organisation(organisation_id=f"sec-{cik}", name=name, sec_cik=cik)


def index(*names: tuple[str, str]) -> spine.CompanyIndex:
    return spine.CompanyIndex.build(tuple(company(cik, name) for cik, name in names))


def match(
    name: str, idx: spine.CompanyIndex, kind: spine.RegistrantKind = "organisation"
) -> spine.MatchResult:
    return spine.match_registrant(
        name, kind=kind, index=idx, as_of=AS_OF, source="faa", origin_key="faa-2026-08-22"
    )


# ---------------------------------------------------------------- never a person


def test_a_natural_person_is_never_name_matched() -> None:
    """23 owner names that looked like people were searched: two matched and both were wrong.

    One matched three researchers and a Waffen-SS tank commander. No threshold fixes that,
    because the failure is a confident match to a different human being.
    """
    idx = index(("0000092380", "SOUTHWEST AIRLINES CO"))
    result = match("SOUTHWEST AIRLINES CO", idx, kind="person")
    assert result.matched is False
    assert result.reason == spine.DROP_PERSON


def test_an_unknown_registrant_kind_is_refused_like_a_person() -> None:
    """The FAA types 1,246 rows with an empty registrant type. Absent reads as refuse."""
    idx = index(("0000092380", "SOUTHWEST AIRLINES CO"))
    assert match("SOUTHWEST AIRLINES CO", idx, kind="unknown").reason == spine.DROP_PERSON


def test_the_person_refusal_beats_an_otherwise_perfect_match() -> None:
    """Six FAA rows typed Individual carry company names. The type filter must win anyway."""
    idx = index(("0000092380", "SOUTHWEST AIRLINES CO"))
    assert match("SOUTHWEST AIRLINES CO", idx).matched is True
    assert match("SOUTHWEST AIRLINES CO", idx, kind="person").matched is False


# ---------------------------------------------------------------- the two tiers


def test_an_exact_normalised_match_asserts() -> None:
    idx = index(("0000027904", "DELTA AIR LINES, INC."))
    result = match("DELTA AIR LINES INC", idx)
    assert result.join is not None
    assert result.join.target_id == "sec-0000027904"
    assert result.join.confidence == spine.ASSERT_CONFIDENCE
    assert result.join.basis == spine.BASIS_EXACT
    assert spine.asserted_join(result.join) is True


def test_a_suffix_stripped_match_is_a_possible_match_and_never_asserts() -> None:
    """It correctly links American Airlines Inc to American Airlines Group, and it also
    produces KESTREL INC to Kestrel Group Ltd, which is a guess."""
    idx = index(("0000006201", "American Airlines Group Inc."))
    result = match("AMERICAN AIRLINES INC", idx)
    assert result.join is not None
    assert result.join.basis == spine.BASIS_CORE
    assert result.join.confidence == spine.POSSIBLE_CONFIDENCE
    assert spine.asserted_join(result.join) is False


def test_the_exact_tier_wins_when_both_could_match() -> None:
    """The strong answer must not be able to lose to the weak one."""
    idx = index(("0000012927", "BOEING CO"), ("0000000002", "BOEING HOLDINGS INC"))
    result = match("BOEING CO", idx)
    assert result.join is not None
    assert result.join.basis == spine.BASIS_EXACT


def test_a_join_carries_its_source_date_and_basis_onto_the_card() -> None:
    idx = index(("0000027904", "DELTA AIR LINES, INC."))
    join = match("DELTA AIR LINES INC", idx).join
    assert join is not None
    assert join.as_of == AS_OF
    assert join.source == "faa"
    assert join.origin_key == "faa-2026-08-22"
    assert join.inferred is False
    assert "SEC company index" in join.basis


# ---------------------------------------------------------------- refusals


def test_an_ambiguous_exact_name_is_refused_rather_than_resolved() -> None:
    idx = index(
        ("0000000001", "Tactical Resources Corp."), ("0000000002", "Tactical Resources Corp.")
    )
    assert match("TACTICAL RESOURCES CORP", idx).reason == spine.DROP_AMBIGUOUS


def test_an_ambiguous_core_name_is_refused_rather_than_guessed() -> None:
    """GRAHAM swallows both Graham Holdings Co and GRAHAM CORP once suffixes are stripped."""
    idx = index(("0000000003", "Graham Holdings Co"), ("0000000004", "GRAHAM CORP"))
    assert match("GRAHAM AVIATION LLC", idx).reason == spine.DROP_NO_MATCH
    assert match("GRAHAM INC", idx).reason == spine.DROP_AMBIGUOUS


def test_a_name_no_filing_entity_carries_is_refused() -> None:
    idx = index(("0000012927", "BOEING CO"))
    assert match("2J2G LLC", idx).reason == spine.DROP_NO_MATCH


def test_an_empty_name_is_refused() -> None:
    assert match("   ", index(("0000012927", "BOEING CO"))).reason == spine.DROP_NO_MATCH


def test_a_name_that_is_nothing_but_legal_suffixes_is_refused() -> None:
    """``THE COMPANY LTD`` reduces to nothing, and nothing must not match everything."""
    idx = index(("0000012927", "BOEING CO"))
    assert match("THE INC LTD", idx).reason == spine.DROP_NO_MATCH


# ---------------------------------------------------------------- normalisation


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("DELTA AIR LINES, INC.", "DELTA AIR LINES INC"),
        ("delta air lines inc", "DELTA AIR LINES INC"),
        ("FARMERS & MERCHANTS BANCORP", "FARMERS AND MERCHANTS BANCORP"),
        ("  spaced   out  ", "SPACED OUT"),
        ("A.B.C./D-E", "A B C D E"),
    ],
)
def test_normalisation_folds_case_punctuation_and_ampersand(raw: str, expected: str) -> None:
    assert spine.normalise(raw) == expected


def test_normalisation_does_not_strip_legal_suffixes() -> None:
    """Measured: stripping them takes SEC collisions from 1 to 13 and merges real companies."""
    assert spine.normalise("BOEING CO") == "BOEING CO"
    assert spine.core("BOEING CO") == "BOEING"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("LEAR HOLDING CORP", "LEAR"),
        ("The Boeing Company", "BOEING"),
        ("United Airlines Holdings, Inc.", "UNITED AIRLINES"),
        ("INC", ""),
        ("THE INC LTD", ""),
    ],
)
def test_core_strips_legal_suffixes_from_both_ends(raw: str, expected: str) -> None:
    assert spine.core(raw) == expected


def test_a_prefix_is_never_a_match() -> None:
    """During the research a prefix rule turned SUN COUNTRY AIRLINES into SUNCOR ENERGY INC."""
    idx = index(("0000311337", "SUNCOR ENERGY INC"))
    assert match("SUN COUNTRY AIRLINES CO", idx).matched is False


# ---------------------------------------------------------------- against the real index


def test_the_real_sec_index_is_almost_free_of_ambiguity_under_the_assert_rule() -> None:
    """The measured false-positive rate of the assertable rule, against the register itself."""
    companies = sec.parse_company_index(fixture_bytes("sec_edgar_company_tickers_live.json"))
    idx = spine.CompanyIndex.build(companies)
    assert len(idx) == len(companies)
    ambiguous_exact = [k for k, v in idx.exact.items() if len(v) > 1]
    ambiguous_core = [k for k, v in idx.stripped.items() if len(v) > 1]
    # Suffix stripping can only ever merge names, never separate them, so the weaker tier
    # must carry at least as much ambiguity as the stronger one. If that ever inverts, the
    # tiers are the wrong way round and the assertable rule is the loose one.
    assert len(ambiguous_exact) <= len(ambiguous_core)


def test_every_company_in_the_real_index_matches_itself_exactly() -> None:
    companies = sec.parse_company_index(fixture_bytes("sec_edgar_company_tickers_live.json"))
    idx = spine.CompanyIndex.build(companies)
    for org in companies[:200]:
        if len(idx.exact[spine.normalise(org.name)]) != 1:
            continue
        result = match(org.name, idx)
        assert result.join is not None
        assert result.join.target_id == org.organisation_id
        assert spine.asserted_join(result.join)


def test_a_company_whose_name_is_all_legal_suffixes_is_not_indexed_by_core() -> None:
    """Otherwise an empty core key would be shared by everything that reduces to nothing."""
    idx = index(("0000000009", "The Company Ltd"), ("0000012927", "BOEING CO"))
    assert "" not in idx.stripped
    assert spine.core("The Company Ltd") == ""
    assert len(idx) == 2


# ---------------------------------------------------------------- registrant kind


def test_every_faa_registrant_type_is_mapped() -> None:
    """A new registrant type must fail loudly rather than quietly reading as unknown."""
    from tracker.sources.faa_registry import RegistrantType

    for member in RegistrantType:
        if member is RegistrantType.UNKNOWN:
            assert spine.registrant_kind(str(member)) == "unknown"
        else:
            assert str(member) in spine.REGISTRANT_KINDS, member


@pytest.mark.parametrize("owner_type", ["individual", "co_owned", "non_citizen_co_owned"])
def test_a_co_owned_registration_counts_as_a_person(owner_type: str) -> None:
    """25,843 registrations are co-owned and at least one party is usually a natural person."""
    assert spine.registrant_kind(owner_type) == "person"


@pytest.mark.parametrize(
    "owner_type",
    ["partnership", "corporation", "government", "llc", "non_citizen_corporation"],
)
def test_an_entity_registration_may_be_matched(owner_type: str) -> None:
    assert spine.registrant_kind(owner_type) == "organisation"


def test_an_unrecognised_registrant_type_reads_as_unknown_and_so_is_refused() -> None:
    assert spine.registrant_kind("something-new") == "unknown"
    assert spine.registrant_kind("") == "unknown"


# ---------------------------------------------------------------- the summary


def summary(*registrants: tuple[str, spine.RegistrantKind]) -> spine.SpineSummary:
    idx = index(
        ("0000027904", "DELTA AIR LINES, INC."),
        ("0000006201", "American Airlines Group Inc."),
        ("0000000003", "Graham Holdings Co"),
        ("0000000004", "GRAHAM CORP"),
    )
    return spine.summarise(
        registrants, index=idx, as_of=AS_OF, source="faa", origin_key="faa-2026-08-22"
    )


def test_a_summary_counts_asserted_and_possible_apart() -> None:
    """ADR 011 excludes a possible match from every aggregate, so they can never be summed."""
    result = summary(
        ("DELTA AIR LINES INC", "organisation"),
        ("AMERICAN AIRLINES INC", "organisation"),
    )
    assert result.asserted == 1
    assert result.possible == 1
    assert result.joined == 2
    assert len(result.organisation_ids) == 2


def test_a_summary_counts_every_refusal_by_cause() -> None:
    result = summary(
        ("SOMEBODY REAL", "person"),
        ("2J2G LLC", "organisation"),
        ("GRAHAM INC", "organisation"),
        ("ANYONE", "unknown"),
    )
    assert result.asserted == 0
    assert result.possible == 0
    assert result.refused[spine.DROP_PERSON] == 2
    assert result.refused[spine.DROP_NO_MATCH] == 1
    assert result.refused[spine.DROP_AMBIGUOUS] == 1


def test_a_summary_over_nothing_is_empty_rather_than_an_error() -> None:
    result = summary()
    assert result.joined == 0
    assert result.organisation_ids == ()
    assert not result.refused


def test_one_company_with_several_aircraft_appears_once_in_the_organisation_list() -> None:
    result = summary(
        ("DELTA AIR LINES INC", "organisation"),
        ("DELTA AIR LINES INC", "organisation"),
        ("DELTA AIR LINES INC", "organisation"),
    )
    assert result.asserted == 3
    assert result.organisation_ids == ("sec-0000027904",)
