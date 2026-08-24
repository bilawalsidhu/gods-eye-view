"""A person, assembled from primary filings and almost nothing else.

**Read this before adding a field.** Measured on 2026-08-23 against every keyless public
source this project can reach, almost every person-level claim collapses to a single origin,
and that origin is either a regulatory filing, which ADR 011 lets assert alone, or a
crowd-sourced database, which it never lets assert alone. There is no middle. So this contract
holds a small assertable core and a large amount of deliberately empty space, and the empty
space is the honest finding rather than unfinished work.

What actually fills:

- **Name, role and organisation, from SEC Forms 3, 4 and 5.** A filing made under penalty of
  perjury naming a director or officer and the issuer they file against. Primary, dated,
  assertable.
- **Name, month and year of birth, nationality and country of residence, from the Companies
  House PSC snapshot.** A registry extract. Primary, assertable.

What never fills, with the measurement:

- **Wealth tier and net worth.** All of Wikidata holds 2,076 humans with a net worth
  statement. 58% of a 900-row sample cite no source at all, the largest reference host among
  the rest is a national archive of historical estate records, and the dated figures cluster on
  2018 and 2021 with four from 2026. Wikidata is crowd-sourced so it cannot assert alone, and
  there is no second origin to corroborate it with. See :data:`WEALTH_TIER_REASON`.
- **Personal email, personal phone, home address.** 1,497 humans in the whole of Wikidata carry
  any phone number and those are switchboards. See :data:`ADDRESS_WARNING` for why the two
  address fields that do exist in public filings must never be mapped here.

**A name is never a match key for a person.** 23 registered aircraft owners that looked like
natural people were searched against Wikidata: two returned any candidate at all and both were
wrong, one matching three researchers and a Waffen-SS tank commander. Identifiers are the keys.
"""

from datetime import date
from typing import Literal

from pydantic import Field, model_validator

from tracker.contracts.base import StrictModel
from tracker.contracts.evidence import Claim, Join

PERSON_NAME_MAX_CHARS = 200

WEALTH_TIER_REASON = "Wealth tier not established: no keyless public source publishes one."
"""What the card says where a tier would go, so a blank does not read as an oversight.

Deliberately short. It renders on a card over the globe and the long version, with the 2,076
statements and the Swedish National Archives, belongs in ``docs/data-sources.md``.
"""

ADDRESS_WARNING = (
    "Address in a filing is the company's, not the person's, and is never a residence."
)
"""The rule for the two address fields public filings actually carry.

SEC ``rptOwnerStreet1`` is the issuer's address, because an insider files at the company. A
live Form 4 read on 2026-08-23 carried it literally as ``C/O SPACE EXPLORATION TECHNOLOGIES
CORP.``, beginning with the words "care of". The Companies House PSC ``address`` is the
statutory service address, with the residential one suppressed upstream by the registrar.

Mapping either to :attr:`Person.addresses` would attach a corporate address to a named
individual as their home, and it is the sort of error no test catches because both fields
contain a perfectly well-formed address. So neither is ingested here at all.
"""


class DateOfBirth(StrictModel):
    """A date of birth at whatever precision the source actually had.

    **Not a ``date``, and that is the point.** Wikidata's ``wdt:P569`` silently widens a
    year-only date of birth to 1 January, which then reads as a real day and will either
    falsely match another person born on 1 January or falsely fail to match the right one. The
    Companies House PSC snapshot gives month and year only, by design, and never a day: a real
    record reads ``{"month": 2, "year": 1947}``.

    Holding the precision explicitly means a comparator can only ever compare at the coarser of
    two precisions, which is the correct behaviour and is impossible if the value has already
    been widened to a day.
    """

    year: int = Field(ge=1800, le=2100)
    month: int | None = Field(default=None, ge=1, le=12)
    day: int | None = Field(default=None, ge=1, le=31)

    @model_validator(mode="after")
    def _day_needs_a_month(self) -> "DateOfBirth":
        if self.day is not None and self.month is None:
            msg = "a day of birth without a month is not a precision any source produces"
            raise ValueError(msg)
        return self

    @property
    def precision(self) -> Literal["year", "month", "day"]:
        """The coarsest unit this value is actually good to."""
        if self.day is not None:
            return "day"
        return "month" if self.month is not None else "year"


class Role(StrictModel):
    """One person's stated relationship to one organisation, from a filing.

    Every field here comes off a Form 3, 4 or 5 or a PSC record. Nothing is inferred, and the
    booleans are the filing's own flags rather than something derived from a job title.
    """

    organisation_id: str = Field(min_length=1, max_length=64)
    organisation_name: str = Field(min_length=1, max_length=200)
    title: str | None = Field(
        default=None,
        max_length=200,
        description="``officerTitle`` as filed, e.g. 'SVP, GC and Secretary'. Absent on a "
        "director-only filing, which is normal rather than missing data.",
    )
    is_director: bool = False
    is_officer: bool = False
    is_ten_percent_owner: bool = False
    as_of: date = Field(
        description="``periodOfReport`` from the filing, or ``notified_on`` from a PSC record. "
        "The source's own date.",
    )
    source: str = Field(min_length=1, max_length=80)
    origin_key: str = Field(
        min_length=1,
        max_length=200,
        description="Accession number for an SEC filing. Two adapters reading one filing share "
        "this and count as one source.",
    )


class Person(StrictModel):
    """A natural person. Small assertable core, large honest emptiness.

    Frozen and strict like every other contract here, and with one addition that matters more
    than the rest: nothing on this record may be filled by inference. ADR 008 is explicit that
    where a field is empty it is empty, with no default, approximation or inference.
    """

    kind: str = Field(default="person", frozen=True, max_length=20)

    person_id: str = Field(
        min_length=1,
        max_length=64,
        description="Our own stable key, derived from the strongest identifier available: "
        "``sec-{cik}`` or ``psc-{company}-{id}``. Never derived from a name.",
    )
    name: str = Field(
        min_length=1,
        max_length=PERSON_NAME_MAX_CHARS,
        description="As the filing wrote it. SEC writes an insider surname first, 'Undersby "
        "Quillon', and that form is kept rather than reordered, because reordering guesses "
        "which token is the surname and a middle initial defeats the guess.",
    )

    sec_cik: str | None = Field(
        default=None,
        pattern=r"^\d{10}$",
        description="A natural person has their own SEC CIK and it is not a company CIK: the "
        "submissions API returns ``entityType: other`` with a surname-first name. It is the "
        "stable identifier that makes this whole path work.",
    )
    companies_house_psc_id: str | None = Field(default=None, max_length=120)
    wikidata_qid: str | None = Field(
        default=None,
        pattern=r"^Q\d+$",
        description="Crowd-sourced. Never asserts, never a match key, carried for candidate "
        "generation and for a reference portrait under ADR 013.",
    )

    date_of_birth: DateOfBirth | None = None
    nationality: str | None = Field(default=None, max_length=80)
    country_of_residence: str | None = Field(
        default=None,
        max_length=80,
        description="A country, from a PSC record. This is not a residence and must never be "
        "widened into one: the PSC statutory address is a service address.",
    )

    roles: tuple[Role, ...] = Field(default=(), max_length=200)
    claims: tuple[Claim, ...] = Field(
        default=(),
        max_length=500,
        description="Everything softer than a role: dates, places, handles. Each carries its "
        "own origin key, and anything not from a primary record renders as a possible match.",
    )
    joins: tuple[Join, ...] = Field(
        default=(),
        max_length=200,
        description="Links to organisations and assets. A join to an asset is a fact about "
        "ownership, never about where this person is.",
    )

    emails: tuple[str, ...] = Field(
        default=(),
        max_length=20,
        description="PII. Empty, because no keyless public source supplies a personal email.",
    )
    phones: tuple[str, ...] = Field(
        default=(),
        max_length=20,
        description="PII. Empty. 1,497 humans in the whole of Wikidata carry any phone number "
        "and those are institutional switchboards.",
    )
    addresses: tuple[Claim, ...] = Field(
        default=(),
        max_length=50,
        description="PII, and empty. See :data:`ADDRESS_WARNING`: the two address fields "
        "public filings carry are the company's and the registrar's, never the person's.",
    )

    wealth_tier: Literal["UHNW", "VHNW", "HNW", "Likely UHNW", "Likely VHNW"] | None = Field(
        default=None,
        description="Always None in this build. The field exists so the product can say the "
        "tier is not established rather than leaving a blank, and so that nothing may quietly "
        "start inferring one from an asset. See :data:`WEALTH_TIER_REASON`.",
    )

    @property
    def has_pii(self) -> bool:
        """Whether suppressing contact data would change what this profile shows.

        Serves the ``NoContactData`` and ``NoPII`` package behaviour ADR 008 asks to be
        demonstrated. On this build it is false for every profile, which is itself the answer.
        """
        return bool(self.emails or self.phones or self.addresses)
