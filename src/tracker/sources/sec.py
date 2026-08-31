"""SEC EDGAR: the only keyless public source that names a person and asserts it.

**Why this source and not a dozen others.** Verified by calling every candidate on 2026-08-23:
FEC answers HTTP 403 without a key, Companies House's REST API answers 401, OpenCorporates
answers 401, and Wikidata is crowd-sourced so ADR 011 never lets it assert alone. EDGAR is
keyless, and a Form 4 is a filing made under penalty of perjury, which is exactly ADR 011's
"primary record ... because the source is the record rather than a report about the record".

What one Form 4 gives, all of it dated and assertable: a named person, that person's own stable
SEC CIK, the issuer, the issuer's CIK and ticker, whether the person is a director, an officer
or a ten percent owner, their title, and the period of report.

**A natural person has a CIK and it is not a company CIK.** ``entityType`` reads ``other`` and
``name`` is written surname first. Anything assuming a CIK identifies an issuer will treat a
person as one.

**Two traps, both measured.**

``filings.recent.primaryDocument`` for a Form 4 points at an **XSL-rendered path**, e.g.
``xslF345X06/form4.xml``. Fetching it returns HTTP 200 and 38,463 bytes of HTML in which every
field name is absent, so a parser built against the documented path finds nothing and reports
the filing as empty rather than erroring. The raw XML is the same filename with the ``xsl*/``
directory removed and returns every field. See :func:`raw_document_url`.

``rptOwnerStreet1`` is the **issuer's** address, because an insider files at the company. A
live filing on 2026-08-20 carried it as ``C/O SPACE EXPLORATION TECHNOLOGIES CORP.``, beginning
with the words "care of". It is not read by this module at all, and
:data:`~tracker.contracts.person.ADDRESS_WARNING` is why.

**This adapter sends its own User-Agent, and it has to.** Measured on 2026-08-23 against both
SEC hosts: a User-Agent containing the substring ``github`` is answered **HTTP 403** by
``www.sec.gov`` and ``data.sec.gov`` alike, whatever else it says.

===================================================  ======
User-Agent                                            status
===================================================  ======
``tracker/0.1 (+https://github.com/x) (a@b.test)``       403
``tracker/0.1 (github) (a@b.test)``                      403
``tracker/0.1 (raw.githubusercontent.com) (a@b.test)``   403
``tracker/0.1 (gitlab.com/x) (a@b.test)``                200
``tracker/0.1 (+https://example.invalid/x) (a@b.test)``  200
``tracker/0.1 (a@b.test)``                               200
===================================================  ======

It is the substring, not the URL and not the parentheses: bare ``github`` is refused and
``gitlab.com`` is not. **This project's own default User-Agent contains
``+https://github.com/local/tracker``**, so a client built on the shared one is refused by the
whole SEC estate, and the failure is a 403 rather than anything that reads like a policy. Left
alone it would have shipped as a layer that simply never worked.

So :func:`user_agent` builds the shape the SEC documents, a name and a contact address and
nothing else, and :class:`SecClient` sets it per request rather than relying on the shared
client's header.

**Access discipline the SEC itself states**: a maximum of 10 requests per second, and a
declared User-Agent carrying a contact address. Undeclared clients get an "Undeclared Automated
Tool" error rather than data. ``www.sec.gov/robots.txt`` reads ``Allow: /Archives/edgar/data``
by name, so the filing documents are permitted; the disallowed ``/Archives`` paths are
``/bin``, ``/etc``, ``/usr``, three ``vprr`` paths and one specific image. ``data.sec.gov``
serves no ``robots.txt`` at all.

**Nothing here is cached.** That is deliberate and it follows the reasoning already recorded
against the adsbdb owner cache: a cache of named people gives a removal under ADR 008 more keys
to chase than the removal knows about, and a restart clearing it is correct behaviour rather
than a cost. Person lookups are demand-driven, so there is no poll to protect against. A test
asserts the consequence rather than the intent: after a real lookup, the person's name appears
nowhere in the disk cache file.
"""

import asyncio
import json
import logging
from collections import Counter
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, timedelta
from typing import Final
from xml.etree import ElementTree

import httpx

from tracker.contracts.evidence import SourceKind
from tracker.contracts.organisation import Organisation
from tracker.contracts.person import Person, Role
from tracker.sources.base import (
    RATE_LIMIT_STATUS_CODES,
    ParsedRecords,
    RateLimitedError,
    retry_after_seconds,
)

_log = logging.getLogger(__name__)

SOURCE_NAME: Final = "sec-edgar"
"""Provenance name on every record this module produces."""

UNAVAILABLE_REASON: Final = (
    "Set TRACKER_CONTACT_EMAIL. The SEC refuses an undeclared client and returns an error."
)
"""Why the filings are off, in 88 characters.

Names the variable because setting it enables the filings, which is the test this project
applies to any reason that asks for one. **It gates the filings and nothing else**: the FAA
register needs no contact address and stays on without it, so a deployment with none shows a
registered owner for every N-register aircraft and is missing only the join and the officers.
"""

SOURCE_KIND: Final = SourceKind.PRIMARY
"""A filing is the record, not a report about it, so ADR 011 lets it assert alone."""

ATTRIBUTION: Final = "Filings: U.S. Securities and Exchange Commission (sec.gov)"
"""EDGAR is a work of the US government and is not under copyright. Credit is courtesy."""

DATA_BASE_URL: Final = "https://data.sec.gov"
WWW_BASE_URL: Final = "https://www.sec.gov"

COMPANY_INDEX_PATH: Final = "/files/company_tickers.json"
"""7,997 listed companies, name to CIK to ticker. 796,148 bytes on 2026-08-23."""

USER_AGENT_PRODUCT: Final = "tracker/0.1"
"""The product half of the User-Agent. Deliberately carries no URL: see the module docstring."""


def user_agent(contact_email: str) -> str:
    """The User-Agent the SEC asks for: a name and a contact address.

    Its own sample reads ``Sample Company Name AdminContact@<sample company domain>.com``, so
    this matches that shape rather than the RFC-style one the rest of this project uses. An
    empty contact address produces a User-Agent the SEC refuses, which is correct: the layer
    is off without one and nothing should be sent.
    """
    return f"{USER_AGENT_PRODUCT} {contact_email}".strip()


MIN_REQUEST_INTERVAL_SECONDS: Final = 0.1
"""The SEC states a maximum of 10 requests per second. This is that figure, as an interval.

A floor rather than a target: the whole spine is demand-driven, so nothing here polls.
"""

MAX_DOCUMENT_BYTES: Final = 4_000_000
"""Refuse to parse an XML document larger than this.

Forms 3, 4 and 5 are small: the largest seen was 43,971 bytes. The cap is four megabytes, two
orders of magnitude of headroom, and it exists because ``xml.etree`` expands internal entities
and a size check is the cheap mitigation for that. A document over the cap is a drop, counted.
"""

OWNERSHIP_FORMS: Final = frozenset({"3", "4", "5", "3/A", "4/A", "5/A"})
"""The forms that name an insider. Everything else on a person's CIK is ignored."""

CIK_DIGITS: Final = 10

DROP_NOT_OWNERSHIP: Final = "not an ownership form"
DROP_NO_ISSUER: Final = "filing names no issuer"
DROP_NO_OWNER: Final = "filing names no reporting owner"
DROP_NO_PERIOD: Final = "filing carries no period of report"
DROP_TOO_LARGE: Final = "document larger than the parse cap"
DROP_UNPARSEABLE: Final = "document is not a parseable ownership filing"
"""Drop reasons in this adapter's own words, served per source on ``/api/layers``."""


def _utc_now() -> datetime:
    return datetime.now(UTC)


def pad_cik(cik: str | int) -> str:
    """Zero-pad a CIK to the ten digits the SEC writes in a filing."""
    return str(int(cik)).zfill(CIK_DIGITS)


def submissions_url(cik: str | int) -> str:
    """Where the submissions index for one CIK lives. Works for a person and a company alike."""
    return f"{DATA_BASE_URL}/submissions/CIK{pad_cik(cik)}.json"


def raw_document_url(cik: str | int, accession: str, primary_document: str) -> str:
    """The filing's own XML, not the rendered page the SEC's index points at.

    ``primaryDocument`` reads ``xslF345X06/form4.xml``. That path returns HTTP 200 and an
    XSL-rendered HTML page in which every field name is absent, so a parser reading it finds
    nothing and reports the filing as empty. Dropping the ``xsl*/`` directory gives the raw
    XML at the same filename.
    """
    document = primary_document
    if "/" in document:
        head, _, tail = document.rpartition("/")
        if head.lower().startswith("xsl"):
            document = tail
    return f"{WWW_BASE_URL}/Archives/edgar/data/{int(cik)}/{accession.replace('-', '')}/{document}"


def _text(node: ElementTree.Element | None) -> str | None:
    """A stripped element value, or ``None`` for an absent or empty element."""
    if node is None or node.text is None:
        return None
    value = node.text.strip()
    return value or None


def _flag(parent: ElementTree.Element, tag: str) -> bool:
    """Read one of the filing's own booleans. Absent means false, which is how they are filed."""
    raw = _text(parent.find(tag))
    return raw is not None and raw.strip().lower() in {"1", "true"}


def _filing_header(root: ElementTree.Element) -> tuple[Organisation, date] | str:
    """The issuer and the period of report, or the drop reason that stopped us.

    Returning the reason rather than ``None`` is what lets the caller count refusals by cause,
    the same shape ``sources/adsb.py`` already uses for its two aircraft refusals.
    """
    issuer = root.find("issuer")
    name = _text(issuer.find("issuerName")) if issuer is not None else None
    cik = _text(issuer.find("issuerCik")) if issuer is not None else None
    if not name or not cik or issuer is None:
        return DROP_NO_ISSUER
    period_raw = _text(root.find("periodOfReport"))
    if not period_raw:
        return DROP_NO_PERIOD
    try:
        period = date.fromisoformat(period_raw)
    except ValueError:
        return DROP_NO_PERIOD
    return (
        Organisation(
            organisation_id=f"sec-{pad_cik(cik)}",
            name=name,
            sec_cik=pad_cik(cik),
            ticker=_text(issuer.find("issuerTradingSymbol")),
        ),
        period,
    )


def parse_ownership_filing(
    payload: bytes | str, *, accession: str
) -> ParsedRecords[tuple[Person, Organisation]]:
    """Parse one Form 3, 4 or 5 into the person, the issuer and the role between them.

    Returns a pair per reporting owner, because one filing may name several. Everything is
    dropped and counted rather than defaulted: a filing with no issuer, no owner or no period
    is not a partial record, it is a record that cannot be believed.
    """
    drops: Counter[str] = Counter()
    root = _parse_document(payload, drops=drops)
    if root is None:
        return ParsedRecords(records=(), drops=drops)

    header = _filing_header(root)
    if isinstance(header, str):
        drops[header] += 1
        return ParsedRecords(records=(), drops=drops)
    organisation, period = header

    pairs: list[tuple[Person, Organisation]] = []
    owners = root.findall("reportingOwner")
    if not owners:
        drops[DROP_NO_OWNER] += 1
    for owner in owners:
        person = _owner_to_person(
            owner, organisation=organisation, period=period, accession=accession
        )
        if person is None:
            drops[DROP_NO_OWNER] += 1
        else:
            pairs.append((person, organisation))
    return ParsedRecords(records=tuple(pairs), drops=drops)


def _parse_document(payload: bytes | str, *, drops: Counter[str]) -> ElementTree.Element | None:
    """Parse the XML, or count why not. Size-capped before parsing, never after."""
    if len(payload) > MAX_DOCUMENT_BYTES:
        drops[DROP_TOO_LARGE] += 1
        return None
    try:
        return ElementTree.fromstring(payload)  # noqa: S314 - size-capped, from sec.gov only
    except ElementTree.ParseError:
        drops[DROP_UNPARSEABLE] += 1
        return None


def _owner_to_person(
    owner: ElementTree.Element,
    *,
    organisation: Organisation,
    period: date,
    accession: str,
) -> Person | None:
    """One ``reportingOwner`` block to a person and their role, or ``None`` if unusable.

    ``reportingOwnerAddress`` is deliberately not read. It is the issuer's address, and the
    person contract has no field it could go in.
    """
    ident = owner.find("reportingOwnerId")
    name = _text(ident.find("rptOwnerName")) if ident is not None else None
    cik = _text(ident.find("rptOwnerCik")) if ident is not None else None
    if not name or not cik:
        return None

    relationship = owner.find("reportingOwnerRelationship")
    role = Role(
        organisation_id=organisation.organisation_id,
        organisation_name=organisation.name,
        title=_text(relationship.find("officerTitle")) if relationship is not None else None,
        is_director=relationship is not None and _flag(relationship, "isDirector"),
        is_officer=relationship is not None and _flag(relationship, "isOfficer"),
        is_ten_percent_owner=(
            relationship is not None and _flag(relationship, "isTenPercentOwner")
        ),
        as_of=period,
        source=SOURCE_NAME,
        origin_key=accession,
    )
    return Person(
        person_id=f"sec-{pad_cik(cik)}",
        name=name,
        sec_cik=pad_cik(cik),
        roles=(role,),
    )


def parse_company_index(payload: bytes | str) -> tuple[Organisation, ...]:
    """Turn ``company_tickers.json`` into organisations.

    The file is a JSON object keyed by row number rather than an array, and one company may
    appear on several rows because it has several tickers: 10,403 rows resolved to 7,998 CIKs
    on 2026-08-23. Rows are collapsed on CIK, keeping the first ticker seen.
    """
    raw = json.loads(payload)
    seen: dict[str, Organisation] = {}
    for row in raw.values():
        cik = pad_cik(row["cik_str"])
        if cik in seen:
            continue
        seen[cik] = Organisation(
            organisation_id=f"sec-{cik}",
            name=str(row["title"]),
            sec_cik=cik,
            ticker=str(row["ticker"]) or None,
        )
    return tuple(seen.values())


def ownership_filings(payload: bytes | str) -> tuple[tuple[str, str], ...]:
    """Accession numbers and primary documents for the ownership forms on one CIK.

    Reads ``filings.recent``, which the SEC serves as parallel arrays rather than as records,
    so the indices have to line up. Non-ownership forms are skipped here rather than fetched
    and discarded, because every skipped form is a request the SEC does not have to serve.
    """
    raw = json.loads(payload)
    recent = raw.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    accessions = recent.get("accessionNumber", [])
    documents = recent.get("primaryDocument", [])
    out: list[tuple[str, str]] = []
    for form, accession, document in zip(forms, accessions, documents, strict=False):
        if form in OWNERSHIP_FORMS and accession and document:
            out.append((accession, document))
    return tuple(out)


class SecClient:
    """Fetches from EDGAR at the rate the SEC asks for, and caches nothing.

    The rate floor is in-process because it is a per-second figure and the whole spine is
    demand-driven: nothing here polls, so there is no restart burst for a disk-persisted floor
    to protect against, which is the opposite of the CelesTrak case.

    **Caching nothing is the deliberate part.** See the module docstring: a cache of named
    people is a cache a removal has to reach, and the one existing cache of that shape in this
    package is in memory for exactly that reason.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        contact_email: str,
        clock: Callable[[], datetime] = _utc_now,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._headers = {"User-Agent": user_agent(contact_email)}
        self._client = client
        self._clock = clock
        self._sleep = sleep
        self._not_before: datetime | None = None

    async def _wait_turn(self) -> None:
        """Hold the SEC's stated 10-requests-per-second ceiling, before the request.

        Checked before rather than after, for the reason already recorded against adsb.lol: a
        provider that has to refuse a call has already been called. The clock and the sleep are
        both injected so the floor is asserted in a test rather than slept through.
        """
        now = self._clock()
        if self._not_before is not None and now < self._not_before:
            await self._sleep((self._not_before - now).total_seconds())
        self._not_before = self._clock() + timedelta(seconds=MIN_REQUEST_INTERVAL_SECONDS)

    async def _get(self, url: str) -> httpx.Response:
        await self._wait_turn()
        # The header is set here rather than on the shared client because the shared one
        # carries a URL the SEC refuses. See the module docstring.
        response = await self._client.get(url, headers=self._headers)
        if response.status_code in RATE_LIMIT_STATUS_CODES:
            raise RateLimitedError(SOURCE_NAME, response.status_code, retry_after_seconds(response))
        response.raise_for_status()
        return response

    async def company_index_payload(self) -> bytes:
        """The raw company index body, so a caller can cache it before parsing.

        Separate from :meth:`company_index` because the index is 796,148 bytes of companies,
        which is exactly the sort of thing to keep on disk between restarts. Companies are not
        natural people, so unlike everything else this adapter touches it may be cached.
        """
        response = await self._get(f"{WWW_BASE_URL}{COMPANY_INDEX_PATH}")
        return response.content

    async def company_index(self) -> tuple[Organisation, ...]:
        """Every listed company the SEC indexes, one request."""
        return parse_company_index(await self.company_index_payload())

    async def ownership_for(
        self, cik: str | int, *, limit: int = 5
    ) -> ParsedRecords[tuple[Person, Organisation]]:
        """The most recent ownership filings on one CIK, parsed.

        ``limit`` is small on purpose. One filing establishes the person, the issuer and the
        role; the rest are transactions, and this build makes no claim about transactions.
        """
        index = await self._get(submissions_url(cik))
        filings = ownership_filings(index.content)[:limit]
        records: list[tuple[Person, Organisation]] = []
        drops: Counter[str] = Counter()
        for accession, document in filings:
            response = await self._get(raw_document_url(cik, accession, document))
            parsed = parse_ownership_filing(response.content, accession=accession)
            records.extend(parsed.records)
            drops.update(parsed.drops)
        return ParsedRecords(records=tuple(records), drops=drops)
