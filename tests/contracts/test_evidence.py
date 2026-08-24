"""The evidence contract: what a claim must carry, and what may assert alone."""

from datetime import date

import pytest
from pydantic import ValidationError

from tracker.contracts.evidence import Claim, Join, SourceKind

AS_OF = date(2026, 8, 11)


def claim(**kwargs: object) -> Claim:
    fields: dict[str, object] = {
        "value": "SVP, GC and Secretary",
        "as_of": AS_OF,
        "source": "sec-edgar",
        "origin_key": "0001140361-26-165249",
        "kind": SourceKind.PRIMARY,
        "confidence": 0.95,
    }
    fields.update(kwargs)
    return Claim(**fields)  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]


def test_a_primary_record_asserts_alone() -> None:
    """ADR 011: the source is the record rather than a report about the record."""
    assert claim(kind=SourceKind.PRIMARY).asserts_alone is True


@pytest.mark.parametrize("kind", [SourceKind.REPORT, SourceKind.CROWD])
def test_nothing_else_asserts_alone(kind: SourceKind) -> None:
    assert claim(kind=kind).asserts_alone is False


def test_a_claim_without_a_date_does_not_exist() -> None:
    """ADR 006 drops an undated entry at the adapter. The contract enforces it here."""
    with pytest.raises(ValidationError):
        Claim(  # type: ignore[call-arg]  # ty: ignore[missing-argument]
            value="x", source="s", origin_key="k", kind=SourceKind.PRIMARY, confidence=1.0
        )


def test_a_claim_without_an_origin_key_does_not_exist() -> None:
    """Without it, two adapters reading one filing inflate every confidence that rests on it."""
    with pytest.raises(ValidationError):
        claim(origin_key="")


def test_confidence_is_bounded() -> None:
    with pytest.raises(ValidationError):
        claim(confidence=1.1)
    with pytest.raises(ValidationError):
        claim(confidence=-0.1)


def test_a_claim_is_frozen() -> None:
    c = claim()
    with pytest.raises(ValidationError):
        c.value = "other"  # type: ignore[misc]  # ty: ignore[invalid-assignment]


def test_derived_and_pii_default_to_false() -> None:
    c = claim()
    assert c.derived is False
    assert c.pii is False


def test_a_join_is_never_inferred_by_default() -> None:
    """ADR 012: an owned aircraft being airborne is a fact; 'the owner is aboard' is not.

    This build never sets it true. The field exists so a later one cannot make that claim
    without saying so.
    """
    j = Join(
        target_id="sec-0000320193",
        target_kind="organisation",
        basis="exact normalised name match against the SEC company index",
        as_of=AS_OF,
        source="spine",
        origin_key="faa-2026-08-22",
        confidence=0.95,
    )
    assert j.inferred is False


def test_a_join_must_say_what_is_on_the_other_end() -> None:
    kind: object = "spaceship"
    with pytest.raises(ValidationError):
        Join(
            target_id="x",
            target_kind=kind,  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]
            basis="b",
            as_of=AS_OF,
            source="s",
            origin_key="k",
            confidence=0.5,
        )


def test_a_join_must_say_how_it_was_made() -> None:
    """The basis is what a viewer reads when they ask why two records are connected."""
    with pytest.raises(ValidationError):
        Join(
            target_id="x",
            target_kind="organisation",
            basis="",
            as_of=AS_OF,
            source="s",
            origin_key="k",
            confidence=0.5,
        )
