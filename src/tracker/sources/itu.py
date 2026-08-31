"""The ITU MID table: the first three digits of an MMSI to a flag state, with no network call.

**Phase 2 deferred this here and this closes it.** ``contracts/vessel.py`` already carries
:data:`~tracker.contracts.vessel.AIS_MID_MIN`, :data:`~tracker.contracts.vessel.AIS_MID_MAX`,
:func:`~tracker.contracts.vessel.mmsi_category` and
:attr:`~tracker.contracts.vessel.Vessel.flag_mid`, so a vessel already knows its MID and
already refuses an MMSI whose MID the ITU never allocated. What it could not do was name the
country, so the card reads ``not resolved (MMSI MID 230)``. This module is the missing half
and nothing here re-implements the categorisation.

**The table is committed as data and is never fetched at runtime.** 292 MIDs across 249 rows,
7.5KB, and allocations change about never. A runtime fetch would put an HTTP request on a card
render, which is the one thing a flag lookup must not cost. Same treatment as the GeoNames
city dump: a static file refreshed by hand, not a poller.

Provenance, and it is the whole basis of the file:

- Source: ``https://www.itu.int/gladapp/Allocation/MIDs``, which is the iframe target behind
  the human page at ``itu.int/en/ITU-R/terrestrial/fmd/Pages/mid.aspx``. The landing page is
  a SharePoint shell with no table in it, so it is the wrong URL to cite.
- Retrieved 2026-08-19, keyless, one GET, HTTP 200, 119,621 bytes of HTML. Re-confirmed
  reachable and unchanged in shape on 2026-08-20.
- ``sources/itu_mid_table.csv`` is that table's two columns, verbatim, with ``mids`` holding
  the cell as published. ``tests/sources/test_itu.py`` asserts it matches the recorded
  capture in ``tests/fixtures/itu_mid_table_live.json`` row for row, so the committed data is
  provably the ITU's and not something somebody typed.
- Licence: the ITU terms of use permit "personal, educational, or non-commercial purposes
  provided that you acknowledge the source" and prohibit distribution, derivative works and
  commercial use "without obtaining prior written permission from ITU". So this needs
  attribution and it is a commercial-deployment blocker, in the same pile as ADS-B Exchange
  rather than in the resolved one. The same list is also published in ITU-R M.585.

Two traps in the published table, both of which a first parse gets wrong:

- **One cell can hold several MIDs**, space separated: ``232 233 234 235`` is the United
  Kingdom. 25 rows are like that, including France, Spain, Greece, the Netherlands and
  Denmark, so a parser demanding exactly three digits per cell silently drops 68 MIDs and the
  biggest flags in the file with them.
- **A MID does not uniquely determine a flag.** MID 306 appears on three rows, for Bonaire,
  Curaçao and Sint Maarten. See :class:`FlagAllocation` for how that is modelled and why.

**ITU MARS is deliberately not built here, and it is not a reachability problem.** The ship
station search at ``itu.int/mmsapp/ShipStation/list`` answers HTTP 200 keyless, verified again
on 2026-08-20, and its detail page carries the registered owner, gross tonnage and person
capacity. It is refused on licence: the ITU terms above prohibit distribution and commercial
use without written permission, and serving MARS fields into a browser is distribution.
``AGENTS.md`` says plainly not to scrape a source whose terms prohibit redistribution. The MID
table sits under the same terms and is here anyway because 292 rows of country names cannot
be avoided by any other route, whereas the owner and tonnage fields arrive licence-clean from
Fintraffic under CC BY 4.0. See ``sources/fintraffic_registry.py``.
"""

import csv
from dataclasses import dataclass
from functools import cache
from importlib.resources import files
from types import MappingProxyType
from typing import Final

from tracker.contracts.vessel import AIS_MID_MAX, AIS_MID_MIN

SOURCE_NAME: Final = "itu-mid"
"""Provenance name for a flag resolved off this table."""

TABLE_URL: Final = "https://www.itu.int/gladapp/Allocation/MIDs"
"""Where the committed table came from. Not the ``mid.aspx`` page, which only iframes it."""

TABLE_RETRIEVED: Final = "2026-08-19"
"""When the committed table was captured. It is the as-of date of every flag it resolves."""

ATTRIBUTION: Final = "Maritime Identification Digits: ITU (itu.int), retrieved 2026-08-19"
"""Attribution the ITU terms require wherever a resolved flag state is shown."""

LICENCE: Final = "ITU terms of use: non-commercial with attribution"
"""Commercial deployment needs prior written ITU permission. Recorded, not resolved."""

TABLE_FILE_NAME: Final = "itu_mid_table.csv"
"""The committed table, alongside this module so it travels with the package."""

MID_DIGITS: Final = 3
"""A MID is three digits. The first digit runs 2 to 7, so 8xx and 9xx are never a MID."""

TERRITORY_SEPARATOR: Final = " - "
"""How the ITU writes a territory onto an administration, e.g. ``Portugal - Azores``.

Spaces on both sides, which is what makes the split safe: the only hyphenated names in the
file are ``Guinea-Bissau (Republic of)`` and ``Timor-Leste (Democratic Republic of)`` and
neither has spaces around its hyphen. 43 of 249 rows carry a territory and none carries two
separators.
"""

EXPECTED_MID_COUNT: Final = 292
"""Distinct MIDs in the committed table. Asserted on load, so a truncated file is loud."""

EXPECTED_ROW_COUNT: Final = 249
"""Rows in the committed table, which is fewer than the MIDs because cells hold several."""


@dataclass(frozen=True, slots=True)
class FlagState:
    """One ITU allocation, split into the administration and the territory it names.

    The split is the useful part. ``United Kingdom of Great Britain and Northern Ireland -
    Bermuda`` means a Bermuda-flagged ship notified by the United Kingdom, and those are
    different facts about different things: MMSI 310627000 is QUEEN MARY 2, whose flag is
    Bermuda while ITU MARS shows her Administration as ``G`` for the United Kingdom. A reader
    who takes the administration for the flag turns every Red Ensign yacht British.
    """

    administration: str
    """The ITU member, long form as published, e.g. ``Portugal``."""

    territory: str | None = None
    """The territory within it, e.g. ``Azores``. ``None`` on a mainland allocation."""

    @property
    def name(self) -> str:
        """The allocation exactly as the ITU publishes it, territory included."""
        if self.territory is None:
            return self.administration
        return f"{self.administration}{TERRITORY_SEPARATOR}{self.territory}"


@dataclass(frozen=True, slots=True)
class FlagAllocation:
    """Every flag state one MID can mean. Never empty.

    **A tuple rather than one string, because a MID is not a country.** MID 306 is allocated
    three times over, to Bonaire, Curaçao and Sint Maarten, so a contract holding a single
    flag string would have to pick one and would be wrong twice. Modelled as the set the MID
    narrows to, with two properties that say how far the narrowing got:

    - :attr:`flag_state` is the answer when there is exactly one, which is 291 of the 292
      allocated MIDs. The ITU table is a primary published record, so under ADR 011 it may
      assert on its own and no corroboration is needed to name the flag.
    - :attr:`administration` is the answer when the territories differ but the sovereign
      state does not, which is what 306 actually is: the ship is Dutch, and which of the
      three Caribbean registries she sits on is not established. That is a real narrowing and
      it is worth showing, rather than throwing the whole answer away.

    Neither property invents anything. Where both come back ``None`` the honest card text is
    still the MID, exactly as it reads today.
    """

    mid: str
    """The three digits, as they appear in an MMSI."""

    flag_states: tuple[FlagState, ...]
    """Every allocation of this MID, in published order. At least one, usually exactly one."""

    @property
    def flag_state(self) -> FlagState | None:
        """The flag state when this MID has exactly one. ``None`` when it covers several."""
        if len(self.flag_states) == 1:
            return self.flag_states[0]
        return None

    @property
    def administration(self) -> str | None:
        """The ITU member behind every allocation of this MID, when they all agree.

        ``None`` only if one MID were ever allocated across two sovereign states, which the
        2026-08-19 table does not do.
        """
        administrations = {state.administration for state in self.flag_states}
        if len(administrations) == 1:
            return self.flag_states[0].administration
        return None


def _parse_allocated_to(raw: str) -> FlagState:
    """Split one ``Allocated to`` cell into an administration and an optional territory."""
    administration, separator, territory = raw.partition(TERRITORY_SEPARATOR)
    if not separator:
        return FlagState(administration=raw.strip())
    return FlagState(administration=administration.strip(), territory=territory.strip())


def _read_table() -> list[tuple[str, FlagState]]:
    """Read the committed CSV into (MID, flag state) pairs, expanding multi-MID cells.

    Raises:
        ValueError: A row is malformed or a MID falls outside the allocated range. This file
            ships with the package, so a bad row is our own bug and is raised rather than
            counted: there is no upstream here to have sent us junk.
    """
    text = (files("tracker.sources") / TABLE_FILE_NAME).read_text(encoding="utf-8")
    pairs: list[tuple[str, FlagState]] = []
    rows = 0
    for row in csv.DictReader(text.splitlines()):
        rows += 1
        allocated_to = (row.get("allocated_to") or "").strip()
        mids = (row.get("mids") or "").split()
        if not allocated_to or not mids:
            msg = f"{TABLE_FILE_NAME} row {rows} has no MID or no allocation: {row!r}"
            raise ValueError(msg)
        state = _parse_allocated_to(allocated_to)
        for mid in mids:
            if len(mid) != MID_DIGITS or not mid.isdigit():
                msg = f"{TABLE_FILE_NAME} row {rows} has a non-MID token {mid!r}"
                raise ValueError(msg)
            if not AIS_MID_MIN <= int(mid) <= AIS_MID_MAX:
                msg = (
                    f"{TABLE_FILE_NAME} row {rows} MID {mid} is outside the allocated "
                    f"range {AIS_MID_MIN} to {AIS_MID_MAX}"
                )
                raise ValueError(msg)
            pairs.append((mid, state))
    if rows != EXPECTED_ROW_COUNT:
        msg = f"{TABLE_FILE_NAME} has {rows} rows, expected {EXPECTED_ROW_COUNT}"
        raise ValueError(msg)
    return pairs


@cache
def flag_allocations() -> MappingProxyType[str, FlagAllocation]:
    """The whole table, MID to allocation, read once and then held.

    Read-only and cached for the life of the process: 292 entries built from a 7.5KB file, so
    the load is not worth measuring and the immutability is worth having, since a caller that
    mutated this would corrupt every later lookup.

    Public because the browser needs the table rather than one row at a time. A card resolves
    the flag of whatever vessel it is showing, so shipping 292 rows once beats an endpoint per
    MID, and this is the shape that serialises.

    Raises:
        ValueError: The committed table is malformed. See :func:`_read_table`.
    """
    grouped: dict[str, list[FlagState]] = {}
    for mid, state in _read_table():
        grouped.setdefault(mid, []).append(state)
    if len(grouped) != EXPECTED_MID_COUNT:
        msg = f"{TABLE_FILE_NAME} holds {len(grouped)} MIDs, expected {EXPECTED_MID_COUNT}"
        raise ValueError(msg)
    return MappingProxyType(
        {mid: FlagAllocation(mid=mid, flag_states=tuple(states)) for mid, states in grouped.items()}
    )


def flag_allocation(mid: str) -> FlagAllocation | None:
    """Resolve one MID to its flag state or states.

    Args:
        mid: Three digits, which is what :attr:`~tracker.contracts.vessel.Vessel.flag_mid`
            returns.

    Returns:
        The allocation, or ``None`` when the ITU has never allocated this MID. ``None`` is a
        real answer rather than a fault: the live AIS feed carries MMSI 999999999 named NATO
        WARSHIP, and 999 is not a MID. The vessel contract already refuses that MMSI, so a
        ``None`` here means the table and the contract disagree about the allocated range and
        is worth a look.

    Raises:
        ValueError: ``mid`` is not three digits. A nine-digit MMSI passed here by mistake
            would otherwise resolve to ``None`` and read as an unallocated flag.
    """
    if len(mid) != MID_DIGITS or not mid.isdigit():
        msg = f"{mid!r} is not a three-digit ITU MID"
        raise ValueError(msg)
    return flag_allocations().get(mid)
