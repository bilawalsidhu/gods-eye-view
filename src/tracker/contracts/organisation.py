"""An organisation, and the strings it appears under in asset registries.

**The registry name and the filing name are different strings for the same company, and that
is the whole difficulty of this contract.** Measured against the real registers on 2026-08-23:
the SEC's company index holds parent holding companies while aircraft are registered to
operating subsidiaries. ``AMERICAN AIRLINES GROUP INC.`` is in the SEC index and
``AMERICAN AIRLINES INC`` is not; ``ALASKA AIR GROUP, INC.`` is there and
``ALASKA AIRLINES INC`` is not; ``UNITED AIRLINES HOLDINGS, INC.`` is there and
``UNITED AIRLINES, INC.`` is not. Delta is the exception that proves it: ``DELTA AIR LINES,
INC.`` is itself the SEC registrant, and it is also the name on 1,114 FAA registrations.

So :attr:`Organisation.registry_names` exists because one organisation is several strings, and
the join has to be made against whichever string the register actually used.

**What the exact-match rule actually buys, measured across the whole FAA register**: 78,140
distinct organisation registrant names, of which **110 match exactly one SEC company**,
covering **2,535 of 316,110 aircraft, 0.80%**. That is small and it is real: Delta 1,114,
Southwest 730, JetBlue 261, Boeing 214, then corporate flight departments, Walmart 7,
Las Vegas Sands 6, Textron 5, PNC 4, PACCAR 4. The corporate jets are in the tail and they are
the interesting part.
"""

from pydantic import Field

from tracker.contracts.base import StrictModel
from tracker.contracts.evidence import Join

ORG_NAME_MAX_CHARS = 200
"""Longest organisation name carried. FAA caps its own ``NAME`` column below this."""


class Organisation(StrictModel):
    """A company, government body or other entity that files, registers or owns things."""

    kind: str = Field(default="organisation", frozen=True, max_length=20)

    organisation_id: str = Field(
        min_length=1,
        max_length=64,
        description="Our own stable key. ``sec-{cik}`` where the SEC knows it, otherwise "
        "``faa-{normalised name}``, so an organisation reached only through an asset registry "
        "still has an identity.",
    )
    name: str = Field(
        min_length=1,
        max_length=ORG_NAME_MAX_CHARS,
        description="The name as the strongest source gives it, not normalised for matching.",
    )

    sec_cik: str | None = Field(
        default=None,
        pattern=r"^\d{10}$",
        description="Zero-padded to ten digits, as the SEC writes it in a filing. Present only "
        "when a primary filing established it, so it is an assertable identifier rather than a "
        "guess.",
    )
    ticker: str | None = Field(default=None, max_length=16)
    wikidata_qid: str | None = Field(
        default=None,
        pattern=r"^Q\d+$",
        description="Crowd-sourced, so it never asserts anything on its own. Carried for "
        "candidate generation and for a portrait under ADR 013, nothing more.",
    )

    registry_names: tuple[str, ...] = Field(
        default=(),
        max_length=50,
        description="Every string this organisation appears under in an asset register, as "
        "that register wrote it. This is what an owner-name match actually joins to.",
    )

    joins: tuple[Join, ...] = Field(
        default=(),
        max_length=500,
        description="Links to assets and people, each with its own basis, date and confidence. "
        "A join below the assertion threshold stays here and renders as a possible match.",
    )
