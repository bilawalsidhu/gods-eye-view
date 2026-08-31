"""One claim about one thing, with the date, the source and the origin that produced it.

ADR 011 and ADR 015 both turn on this record. ADR 011 makes confidence a function of
independent corroboration and judges independence **at the origin**; ADR 015 asks for one
evidence contract whatever the modality. Neither works if an attribute is a bare value, so
every enriched attribute on a person or an organisation is a :class:`Claim`.

**The origin key is the whole game, and it is the easiest thing here to get wrong.** Two
adapters that both read one SEC filing are one source, not two. A Wikidata statement whose
reference is the Wikipedia article that cites the same press release is one source. Counting
them twice inflates every confidence number that rests on corroboration, which is the exact
failure ADR 011 exists to prevent and the same shape as R1 in ``docs/pending-decisions.md``,
where two ADS-B aggregators repeating one transponder broadcast were taken for two sources.

**Why the kind matters more than the score.** ADR 011 lets a primary record cross the
assertion threshold alone, "because the source is the record rather than a report about the
record", and forbids a single crowd-sourced source from ever crossing it. Measured on
2026-08-23, that distinction is not academic: it is the only thing that lets this project
assert anything at all about a person. Almost every person-level claim reachable from keyless
public data collapses to one origin, and that origin is either a filing, which may assert, or
Wikidata, which may not. There is no middle.

The measurements behind that, all taken on 2026-08-23:

- SEC Form 4 and the issuer's own proxy statement are **one** origin. Both are the issuer
  filing about itself.
- Wikidata and Wikipedia are **one** origin in practice. The article is usually the
  statement's reference.
- Of 900 Wikidata net-worth statements sampled, **58% cite no source at all**, and the largest
  single reference host among the rest is a national archive of historical estate records.
"""

from datetime import date
from enum import StrEnum
from typing import Literal

from pydantic import Field

from tracker.contracts.base import StrictModel


class SourceKind(StrEnum):
    """What sort of thing said this, which is what decides whether it may assert alone."""

    PRIMARY = "primary"
    """A filing, a registry extract, a company's own statement of its officers.

    May cross the assertion threshold on its own, per ADR 011, because the source is the
    record rather than a report about the record.
    """

    REPORT = "report"
    """A news article or any other account of a record. Never asserts alone.

    Two outlets carrying one wire story are one origin, so two reports are not corroboration
    unless their origins are shown to differ.
    """

    CROWD = "crowd"
    """Wikidata, a wiki, a scraped page, anything user-maintained. Never asserts alone."""


class Claim(StrictModel):
    """One attribute value, and everything needed to decide whether to believe it.

    Frozen and strict like every other contract here. A claim with no date does not exist:
    ADR 006 drops an undated entry at the adapter and counts it, and that rule is enforced by
    ``as_of`` being required rather than by a check somewhere downstream.
    """

    value: str = Field(
        min_length=1,
        max_length=500,
        description="What is claimed, as the source said it. Never normalised for display, "
        "because ADR 011 forbids corroboration narrowing a value beyond what the strongest "
        "single source actually said.",
    )
    as_of: date = Field(
        description="The source's own date, never the date of the run that read it. A Form 4 "
        "is dated to its period of report, a registry extract to its extract date. ADR 015 "
        "says the same thing about media: the timestamp comes from the thing, not the fetch.",
    )
    source: str = Field(
        min_length=1,
        max_length=80,
        description="The adapter's name for where this came from, e.g. ``sec-form4``.",
    )
    origin_key: str = Field(
        min_length=1,
        max_length=200,
        description="What makes two claims the same source. An SEC accession number, a "
        "registry snapshot date plus record id, a Wikidata reference URL. Two claims sharing "
        "an origin key are one source however many adapters produced them, and corroboration "
        "counts them once.",
    )
    kind: SourceKind = Field(
        description="Primary, report or crowd. Only primary may assert alone.",
    )
    confidence: float = Field(
        ge=0.0,
        le=1.0,
        description="How strongly this is believed. Decomposable by whatever produced it: a "
        "card saying 'possible match, 0.62' is useless, one saying which fields agreed is the "
        "product.",
    )
    derived: bool = Field(
        default=False,
        description="True when produced by joining sources rather than read from one, per "
        "ADR 006. The label reaches the card and the API.",
    )
    pii: bool = Field(
        default=False,
        description="True for contact attributes, so a profile can be served with them "
        "suppressed. ADR 008 sells that exclusion as NoContactData and NoPII, so it is a "
        "demo feature rather than plumbing.",
    )

    @property
    def asserts_alone(self) -> bool:
        """Whether this claim may be shown as fact with nothing corroborating it.

        Only a primary record. This is ADR 011's rule expressed once, here, rather than
        re-derived by every caller that has to decide what a card says.
        """
        return self.kind is SourceKind.PRIMARY


class Join(StrictModel):
    """One link between two records we hold, and how good it is.

    Separate from :class:`Claim` because a join is about two things rather than one, and
    because ADR 007 requires a join to carry its source, its confidence and its as-of date
    onto the card. The ``basis`` field is what stops a card implying more than was measured.
    """

    target_id: str = Field(min_length=1, max_length=120)
    target_kind: Literal["person", "organisation", "aircraft", "vessel"] = Field(
        description="What is on the other end. Kept explicit so a card never has to guess.",
    )
    basis: str = Field(
        min_length=1,
        max_length=200,
        description="How the link was made, in the adapter's own words, e.g. 'exact "
        "normalised name match against the SEC company index'. This is what a viewer reads "
        "when they ask why two records are connected.",
    )
    as_of: date
    source: str = Field(min_length=1, max_length=80)
    origin_key: str = Field(min_length=1, max_length=200)
    confidence: float = Field(ge=0.0, le=1.0)
    inferred: bool = Field(
        default=False,
        description="True when this link is an inference rather than something a source "
        "stated. ADR 012 is explicit: an owned aircraft being airborne is a fact about the "
        "aircraft, and 'the owner is aboard' is a different claim. This build never sets "
        "this true, and the field exists so that a later one cannot make that claim silently.",
    )
