"""Joining an asset registrant to a filing entity, strictly, and never to a person.

This is the matching rule, and it is the place this project becomes harmful if it is loose.
Everything here was measured against the whole of both registers on 2026-08-23: 316,110 FAA
registrations and 7,998 SEC companies.

**Rule one: a natural person is never name-matched.** 23 registered aircraft owners that looked
like natural people were searched against Wikidata. Two returned any candidate at all, 8.7%,
and **both were wrong**: one private owner matched three researchers and a Waffen-SS tank
commander. There is no threshold that fixes that, because the failure is not a low score, it is
a confident match to a different human being. :func:`match_registrant` refuses outright when the
registrant is a person, and the refusal is counted.

**Rule two: normalisation folds case, punctuation and ``&``, and stops there.** Measured over
the SEC index: with that normalisation alone, 7,997 distinct names and **one** collision between
two CIKs, 0.02% of rows. Add legal-suffix stripping and it becomes 13 collisions over 26 rows,
0.25%, and the collisions are real companies merging into each other: ``GRAHAM`` swallows both
Graham Holdings Co and GRAHAM CORP, ``GOLD`` swallows Gold.com Inc and NV Gold Corp, ``BLUE OWL
CAPITAL`` swallows Blue Owl Capital Inc and Blue Owl Capital Corp. So suffix stripping is not
part of the assertable rule.

**Rule three: there are two tiers, because the registers genuinely disagree about which legal
entity owns an aircraft.** The SEC indexes parent holding companies; aircraft are registered to
operating subsidiaries. ``AMERICAN AIRLINES GROUP INC.`` is in the SEC index and ``AMERICAN
AIRLINES INC`` is not. Delta is the exception, being its own registrant in both.

=======  =============================================  ======  =========  ==========
tier     rule                                           names   aircraft   ambiguous
=======  =============================================  ======  =========  ==========
assert   exact normalised match, unique CIK                110      2,533           0
possible legal suffixes stripped, unique CIK                64      2,814           3
=======  =============================================  ======  =========  ==========

Tier one produced **zero ambiguous matches across all 78,140 organisation registrant names**,
which is the measured false-positive rate of the assertable rule and is why it may assert.

Tier two is worth more aircraft than tier one and is not assertable: it correctly links United
Airlines Inc to United Airlines Holdings (1,201 aircraft) and American Airlines Inc to American
Airlines Group (987), and it also produces ``KESTREL INC`` to ``Kestrel Group Ltd``, which is a
guess. So it renders as a possible match with its score, is excluded from every aggregate, and
is never asserted, exactly as ADR 011 requires.

Together the two tiers reach 5,347 of 316,110 aircraft, **1.69%**. That is small and it is
honest: the other 98% are registered to individuals or to single-purpose companies with no
public filing history, which is what the arrangement is for.
"""

import re
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date
from typing import Final, Literal

from tracker.contracts.evidence import Join
from tracker.contracts.organisation import Organisation

SOURCE_NAME: Final = "spine"

ASSERT_CONFIDENCE: Final = 0.95
"""An exact normalised match against a primary index, with no ambiguity anywhere in it."""

POSSIBLE_CONFIDENCE: Final = 0.60
"""A suffix-stripped match. Plausible, unproven, and never shown as fact."""

ASSERT_THRESHOLD: Final = 0.90
"""At or above this a join is asserted. Below it, and above zero, it is a possible match.

Only :data:`ASSERT_CONFIDENCE` clears it, which is deliberate: this rule produces two outcomes
and inventing a gradient between them would be dressing a binary decision up as a score.
"""

RegistrantKind = Literal["person", "organisation", "unknown"]
"""What the asset register says the registrant is.

``unknown`` is refused like a person. The FAA types 1,246 rows with an empty registrant type
and six rows typed Individual carry company names such as ``SOUTHWEST AIRLINES CO``, so the
type column is not perfectly reliable in either direction and the safe reading of an absent
value is the one that matches nothing.
"""

_LEGAL_SUFFIX: Final = (
    r"(?:INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|LLC|PLC|LP|HOLDINGS?|GROUP|THE)"
)

_NON_ALNUM: Final = re.compile(r"[^A-Z0-9 ]+")
_SPACES: Final = re.compile(r"\s+")
_SUFFIX_TAIL: Final = re.compile(rf"(?:^|\s+){_LEGAL_SUFFIX}$")
_SUFFIX_HEAD: Final = re.compile(rf"^{_LEGAL_SUFFIX}\s+")

BASIS_EXACT: Final = "exact normalised name match against the SEC company index"
BASIS_CORE: Final = "name match after stripping legal suffixes, parent company not confirmed"

DROP_PERSON: Final = "registrant is a natural person; names are never matched"
DROP_AMBIGUOUS: Final = "name claimed by more than one filing entity"
DROP_NO_MATCH: Final = "no filing entity of that name"


def normalise(name: str) -> str:
    """Fold case, ``&`` and punctuation. Nothing else, for the reason in the module docstring."""
    folded = name.upper().replace("&", " AND ")
    return _SPACES.sub(" ", _NON_ALNUM.sub(" ", folded)).strip()


def core(name: str) -> str:
    """:func:`normalise`, then strip legal suffixes from both ends until nothing changes.

    Only ever used for the possible-match tier. ``LEAR HOLDING CORP`` and ``LEAR CORP`` both
    reduce to ``LEAR``, which is usually the same company and is not proof that it is.
    """
    value = normalise(name)
    previous = ""
    while previous != value:
        previous = value
        value = _SUFFIX_HEAD.sub("", _SUFFIX_TAIL.sub("", value).strip()).strip()
    return value


@dataclass(frozen=True, slots=True)
class CompanyIndex:
    """The SEC company index, keyed both ways, with ambiguity kept rather than resolved.

    A name claimed by more than one CIK is held as the set of CIKs and refused at match time.
    Picking one would be the same class of error as a prefix match, which is how ``SUN COUNTRY
    AIRLINES`` became ``SUNCOR ENERGY INC`` during the research behind this module.
    """

    exact: dict[str, tuple[str, ...]]
    stripped: dict[str, tuple[str, ...]]
    by_id: dict[str, Organisation]

    @classmethod
    def build(cls, companies: tuple[Organisation, ...]) -> "CompanyIndex":
        """Index every company by both keys. One pass, no network."""
        exact: dict[str, list[str]] = {}
        stripped: dict[str, list[str]] = {}
        by_id: dict[str, Organisation] = {}
        for company in companies:
            by_id[company.organisation_id] = company
            exact.setdefault(normalise(company.name), []).append(company.organisation_id)
            key = core(company.name)
            if key:
                stripped.setdefault(key, []).append(company.organisation_id)
        return cls(
            exact={k: tuple(sorted(set(v))) for k, v in exact.items()},
            stripped={k: tuple(sorted(set(v))) for k, v in stripped.items()},
            by_id=by_id,
        )

    def __len__(self) -> int:
        return len(self.by_id)


@dataclass(frozen=True, slots=True)
class MatchResult:
    """What a match attempt produced: a join, or the reason there is not one."""

    join: Join | None
    reason: str | None

    @property
    def matched(self) -> bool:
        """True when there is a join, whether or not it clears the assertion threshold."""
        return self.join is not None


def _lookup(registrant_name: str, index: CompanyIndex) -> tuple[str, str, float] | str:
    """Try both tiers in order. Returns the winning match, or the reason there is not one.

    Exact first, always. A name that matches exactly is never also offered its suffix-stripped
    neighbour, because the strong answer must not be able to lose to the weak one.
    """
    key = normalise(registrant_name)
    if not key:
        return DROP_NO_MATCH

    hits = index.exact.get(key, ())
    if len(hits) == 1:
        return (hits[0], BASIS_EXACT, ASSERT_CONFIDENCE)
    if len(hits) > 1:
        return DROP_AMBIGUOUS

    stripped_key = core(registrant_name)
    if not stripped_key:
        return DROP_NO_MATCH
    near = index.stripped.get(stripped_key, ())
    if len(near) == 1:
        return (near[0], BASIS_CORE, POSSIBLE_CONFIDENCE)
    return DROP_AMBIGUOUS if near else DROP_NO_MATCH


def match_registrant(
    registrant_name: str,
    *,
    kind: RegistrantKind,
    index: CompanyIndex,
    as_of: date,
    source: str,
    origin_key: str,
) -> MatchResult:
    """Match one asset registrant to a filing entity, or say why not.

    ``as_of`` is the asset register's own extract date, not today. ``origin_key`` is that
    register's identity for the record, so a claim reaching the resolver from two adapters
    reading one register counts once.
    """
    if kind != "organisation":
        return MatchResult(join=None, reason=DROP_PERSON)
    found = _lookup(registrant_name, index)
    if isinstance(found, str):
        return MatchResult(join=None, reason=found)
    organisation_id, basis, confidence = found
    return MatchResult(
        join=_join(organisation_id, basis, confidence, as_of, source, origin_key),
        reason=None,
    )


def _join(
    organisation_id: str,
    basis: str,
    confidence: float,
    as_of: date,
    source: str,
    origin_key: str,
) -> Join:
    return Join(
        target_id=organisation_id,
        target_kind="organisation",
        basis=basis,
        as_of=as_of,
        source=source,
        origin_key=origin_key,
        confidence=confidence,
    )


def asserted_join(join: Join) -> bool:
    """Whether this join may be shown as fact rather than as a possible match.

    One place, so a card, an aggregate and an API response cannot disagree about it.
    """
    return join.confidence >= ASSERT_THRESHOLD


REGISTRANT_KINDS: Final[Mapping[str, RegistrantKind]] = {
    "individual": "person",
    "co_owned": "person",
    "non_citizen_co_owned": "person",
    "partnership": "organisation",
    "corporation": "organisation",
    "government": "organisation",
    "llc": "organisation",
    "non_citizen_corporation": "organisation",
}
"""``TYPE REGISTRANT`` mapped to whether a name may be matched at all.

Keyed on the string value of :class:`~tracker.sources.faa_registry.RegistrantType` rather than
on the enum, so this service does not import an adapter. A test asserts every member of that
enum appears here, so a new registrant type fails loudly rather than silently reading as
``unknown``.

**Co-owned counts as a person**, both the citizen and the non-citizen form. A co-owned
registration is two or more parties and at least one is usually a natural person, so matching
its name risks exactly the harm the person rule exists to prevent. 25,843 registrations are
co-owned and 17 are non-citizen co-owned.
"""


def registrant_kind(owner_type: str) -> RegistrantKind:
    """What the register says the registrant is, defaulting to ``unknown`` and so to a refusal."""
    return REGISTRANT_KINDS.get(owner_type, "unknown")


@dataclass(frozen=True, slots=True)
class SpineSummary:
    """What one pass over a set of registrants produced, in a shape the API can serve."""

    asserted: int
    possible: int
    refused: Counter[str]
    organisation_ids: tuple[str, ...]

    @property
    def joined(self) -> int:
        """Every join, at either confidence. Never use this as an aggregate on its own."""
        return self.asserted + self.possible


def summarise(
    registrants: Iterable[tuple[str, RegistrantKind]],
    *,
    index: CompanyIndex,
    as_of: date,
    source: str,
    origin_key: str,
) -> SpineSummary:
    """Match a set of registrants and count the outcome by cause.

    Takes name and kind pairs rather than registrations, so this service stays free of any
    particular asset register: the Canadian and Australian extracts already in the tree have
    the same two facts under different column names.

    ``asserted`` and ``possible`` are counted apart and never summed into a headline, because
    ADR 011 excludes a possible match from every aggregate.
    """
    asserted = possible = 0
    refused: Counter[str] = Counter()
    organisations: set[str] = set()
    for name, kind in registrants:
        result = match_registrant(
            name, kind=kind, index=index, as_of=as_of, source=source, origin_key=origin_key
        )
        if result.join is None:
            refused[result.reason or DROP_NO_MATCH] += 1
            continue
        organisations.add(result.join.target_id)
        if asserted_join(result.join):
            asserted += 1
        else:
            possible += 1
    return SpineSummary(
        asserted=asserted,
        possible=possible,
        refused=refused,
        organisation_ids=tuple(sorted(organisations)),
    )
