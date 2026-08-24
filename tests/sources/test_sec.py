"""The SEC adapter, against the scrubbed recordings in ``tests/fixtures``.

Those fixtures carry synthetic personal names, synthetic personal CIKs in a 999900x block and
addresses in an unassigned ZIP block, while keeping the real issuer names and issuer CIKs,
because a company is not a natural person. Nothing here re-records from the live API.
"""

import json
from datetime import UTC, date, datetime

import httpx
import pytest
import respx

from tests.conftest import fixture_bytes
from tracker.cache import DiskCache
from tracker.contracts.evidence import SourceKind
from tracker.sources import sec
from tracker.sources.base import RateLimitedError

OFFICER = "sec_edgar_form4_officer_live.xml"
DIRECTOR = "sec_edgar_form4_director_live.xml"
SUBMISSIONS = "sec_edgar_submissions_person_live.json"
TICKERS = "sec_edgar_company_tickers_live.json"
ACCESSION = "0001140361-26-165249"


# ---------------------------------------------------------------- urls and identifiers


def test_a_cik_is_padded_the_way_a_filing_writes_it() -> None:
    assert sec.pad_cik(320193) == "0000320193"
    assert sec.pad_cik("320193") == "0000320193"
    assert sec.pad_cik("0000320193") == "0000320193"


def test_the_submissions_url_is_the_same_shape_for_a_person_and_a_company() -> None:
    """A natural person has a CIK and the API does not distinguish it in the path."""
    assert sec.submissions_url(9999001).endswith("/submissions/CIK0009999001.json")
    assert sec.submissions_url(320193).endswith("/submissions/CIK0000320193.json")


def test_the_rendered_xsl_path_is_stripped_to_reach_the_actual_filing() -> None:
    """primaryDocument points at an XSL-rendered page in which every field name is absent."""
    url = sec.raw_document_url(9999001, ACCESSION, "xslF345X06/form4.xml")
    assert "xslF345X06" not in url
    assert url.endswith("/Archives/edgar/data/9999001/000114036126165249/form4.xml")


def test_a_document_already_at_the_raw_path_is_left_alone() -> None:
    url = sec.raw_document_url(9999001, ACCESSION, "form4.xml")
    assert url.endswith("/form4.xml")


def test_a_nested_path_that_is_not_an_xsl_directory_is_left_alone() -> None:
    url = sec.raw_document_url(9999001, ACCESSION, "somewhere/form4.xml")
    assert url.endswith("/somewhere/form4.xml")


# ---------------------------------------------------------------- parsing real filings


def test_an_officer_filing_yields_the_person_the_issuer_and_the_role() -> None:
    parsed = sec.parse_ownership_filing(fixture_bytes(OFFICER), accession=ACCESSION)
    assert parsed.dropped == 0
    assert len(parsed.records) == 1
    person, organisation = parsed.records[0]

    assert person.sec_cik == "0009999001"
    assert person.person_id == "sec-0009999001"
    assert organisation.name == "Apple Inc."
    assert organisation.sec_cik == "0000320193"
    assert organisation.ticker == "AAPL"

    role = person.roles[0]
    assert role.is_officer is True
    assert role.is_director is False
    assert role.title == "SVP, GC and Secretary"
    assert role.as_of == date(2026, 8, 11)
    assert role.origin_key == ACCESSION
    assert role.source == sec.SOURCE_NAME


def test_a_director_filing_carries_the_flag_and_no_title() -> None:
    parsed = sec.parse_ownership_filing(fixture_bytes(DIRECTOR), accession="0009999002-26-1")
    assert len(parsed.records) == 1
    person, _ = parsed.records[0]
    role = person.roles[0]
    assert role.is_director is True
    assert role.is_officer is False
    assert role.title is None


def test_the_filing_address_never_becomes_a_persons_address() -> None:
    """rptOwnerStreet1 is the issuer's address. A live one read literally "C/O [company]".

    The behaviour asserted here is that it is not carried at all, rather than that some
    particular string is absent.
    """
    assert b"Street1" in fixture_bytes(OFFICER) or b"street1" in fixture_bytes(OFFICER)
    parsed = sec.parse_ownership_filing(fixture_bytes(OFFICER), accession=ACCESSION)
    person, _ = parsed.records[0]
    assert person.addresses == ()
    assert person.emails == ()
    assert person.phones == ()
    assert person.has_pii is False


def test_a_filing_never_supplies_a_wealth_tier() -> None:
    parsed = sec.parse_ownership_filing(fixture_bytes(OFFICER), accession=ACCESSION)
    person, _ = parsed.records[0]
    assert person.wealth_tier is None


def test_a_filing_is_a_primary_record() -> None:
    """It is the only reason this project can assert anything about a person at all."""
    assert sec.SOURCE_KIND is SourceKind.PRIMARY


# ---------------------------------------------------------------- refusals, each counted


def test_a_document_over_the_parse_cap_is_dropped_not_parsed() -> None:
    parsed = sec.parse_ownership_filing(b"<x/>" * sec.MAX_DOCUMENT_BYTES, accession=ACCESSION)
    assert parsed.records == ()
    assert parsed.drops[sec.DROP_TOO_LARGE] == 1


def test_a_body_that_is_not_xml_is_dropped_not_raised() -> None:
    parsed = sec.parse_ownership_filing(b"<!doctype html><html>nope", accession=ACCESSION)
    assert parsed.records == ()
    assert parsed.drops[sec.DROP_UNPARSEABLE] == 1


def test_a_filing_with_no_issuer_is_dropped() -> None:
    parsed = sec.parse_ownership_filing(
        b"<ownershipDocument><periodOfReport>2026-08-11</periodOfReport></ownershipDocument>",
        accession=ACCESSION,
    )
    assert parsed.drops[sec.DROP_NO_ISSUER] == 1


def test_a_filing_with_no_period_of_report_is_dropped() -> None:
    body = (
        b"<ownershipDocument><issuer><issuerName>X</issuerName>"
        b"<issuerCik>0000000001</issuerCik></issuer></ownershipDocument>"
    )
    assert sec.parse_ownership_filing(body, accession=ACCESSION).drops[sec.DROP_NO_PERIOD] == 1


def test_a_filing_with_an_unparseable_period_is_dropped() -> None:
    body = (
        b"<ownershipDocument><issuer><issuerName>X</issuerName>"
        b"<issuerCik>0000000001</issuerCik></issuer>"
        b"<periodOfReport>not-a-date</periodOfReport></ownershipDocument>"
    )
    assert sec.parse_ownership_filing(body, accession=ACCESSION).drops[sec.DROP_NO_PERIOD] == 1


def test_a_filing_naming_no_reporting_owner_is_dropped() -> None:
    body = (
        b"<ownershipDocument><issuer><issuerName>X</issuerName>"
        b"<issuerCik>0000000001</issuerCik></issuer>"
        b"<periodOfReport>2026-08-11</periodOfReport></ownershipDocument>"
    )
    assert sec.parse_ownership_filing(body, accession=ACCESSION).drops[sec.DROP_NO_OWNER] == 1


def test_a_reporting_owner_with_no_cik_is_dropped_and_counted() -> None:
    body = (
        b"<ownershipDocument><issuer><issuerName>X</issuerName>"
        b"<issuerCik>0000000001</issuerCik></issuer>"
        b"<periodOfReport>2026-08-11</periodOfReport>"
        b"<reportingOwner><reportingOwnerId><rptOwnerName>A Name</rptOwnerName>"
        b"</reportingOwnerId></reportingOwner></ownershipDocument>"
    )
    parsed = sec.parse_ownership_filing(body, accession=ACCESSION)
    assert parsed.records == ()
    assert parsed.drops[sec.DROP_NO_OWNER] == 1


def test_a_filing_naming_two_owners_yields_two_people() -> None:
    """One filing may name several reporting owners, and each is a person."""
    body = (
        b"<ownershipDocument><issuer><issuerName>X</issuerName>"
        b"<issuerCik>0000000001</issuerCik></issuer>"
        b"<periodOfReport>2026-08-11</periodOfReport>"
        b"<reportingOwner><reportingOwnerId><rptOwnerName>One</rptOwnerName>"
        b"<rptOwnerCik>0009999001</rptOwnerCik></reportingOwnerId></reportingOwner>"
        b"<reportingOwner><reportingOwnerId><rptOwnerName>Two</rptOwnerName>"
        b"<rptOwnerCik>0009999002</rptOwnerCik></reportingOwnerId></reportingOwner>"
        b"</ownershipDocument>"
    )
    parsed = sec.parse_ownership_filing(body, accession=ACCESSION)
    assert len(parsed.records) == 2
    assert {p.sec_cik for p, _ in parsed.records} == {"0009999001", "0009999002"}


# ---------------------------------------------------------------- the indexes


def test_the_company_index_collapses_a_company_with_several_tickers() -> None:
    """10,403 rows resolved to 7,998 CIKs live, because one company may have several tickers."""
    companies = sec.parse_company_index(fixture_bytes(TICKERS))
    assert companies
    assert len({c.sec_cik for c in companies}) == len(companies)
    apple = [c for c in companies if c.sec_cik == "0000320193"]
    assert len(apple) == 1
    assert apple[0].ticker == "AAPL"


def test_only_ownership_forms_are_taken_from_a_submissions_index() -> None:
    """Every skipped form is a request the SEC does not have to serve."""
    raw = json.loads(fixture_bytes(SUBMISSIONS))
    forms = raw["filings"]["recent"]["form"]
    expected = sum(1 for f in forms if f in sec.OWNERSHIP_FORMS)

    filings = sec.ownership_filings(fixture_bytes(SUBMISSIONS))

    assert filings
    assert len(filings) == expected
    assert expected < len(forms), "the fixture must contain a non-ownership form to prove this"
    assert all(accession and document for accession, document in filings)


def test_every_xsl_directory_variant_is_stripped() -> None:
    """The fixture carries both xslF345X06 and xslF345X03, so the prefix is what matters."""
    for document in ("xslF345X06/form4.xml", "xslF345X03/dp144543_4.xml"):
        assert "xsl" not in sec.raw_document_url(1, ACCESSION, document).rsplit("/", 1)[-1]


def test_a_submissions_index_with_no_filings_yields_nothing() -> None:
    assert sec.ownership_filings(b'{"filings": {"recent": {}}}') == ()


# ---------------------------------------------------------------- the client


@respx.mock(assert_all_called=True)
async def test_the_client_reads_a_company_index(respx_mock: respx.Router) -> None:
    respx_mock.get(f"{sec.WWW_BASE_URL}{sec.COMPANY_INDEX_PATH}").mock(
        return_value=httpx.Response(200, content=fixture_bytes(TICKERS))
    )
    async with httpx.AsyncClient(timeout=5.0) as http:
        companies = await sec.SecClient(http, contact_email="a@b.invalid").company_index()
    assert companies


@respx.mock(assert_all_called=True)
async def test_the_client_walks_a_person_to_their_filings(respx_mock: respx.Router) -> None:
    respx_mock.get(sec.submissions_url(9999001)).mock(
        return_value=httpx.Response(200, content=fixture_bytes(SUBMISSIONS))
    )
    respx_mock.get(url__regex=r".*/Archives/edgar/data/.*").mock(
        return_value=httpx.Response(200, content=fixture_bytes(OFFICER))
    )
    async with httpx.AsyncClient(timeout=5.0) as http:
        parsed = await sec.SecClient(http, contact_email="a@b.invalid").ownership_for(
            9999001, limit=2
        )
    assert parsed.records
    person, organisation = parsed.records[0]
    assert person.roles[0].is_officer is True
    assert organisation.name == "Apple Inc."


@respx.mock(assert_all_called=True)
async def test_a_throttling_response_is_raised_rather_than_parsed(
    respx_mock: respx.Router,
) -> None:
    """The SEC states a maximum of 10 requests per second and monitors it."""
    respx_mock.get(f"{sec.WWW_BASE_URL}{sec.COMPANY_INDEX_PATH}").mock(
        return_value=httpx.Response(429, headers={"Retry-After": "60"})
    )
    async with httpx.AsyncClient(timeout=5.0) as http:
        with pytest.raises(RateLimitedError):
            await sec.SecClient(http, contact_email="a@b.invalid").company_index()


@respx.mock(assert_all_called=True)
async def test_a_server_error_is_raised_rather_than_swallowed(respx_mock: respx.Router) -> None:
    respx_mock.get(f"{sec.WWW_BASE_URL}{sec.COMPANY_INDEX_PATH}").mock(
        return_value=httpx.Response(500)
    )
    async with httpx.AsyncClient(timeout=5.0) as http:
        with pytest.raises(httpx.HTTPStatusError):
            await sec.SecClient(http, contact_email="a@b.invalid").company_index()


@respx.mock(assert_all_called=True)
async def test_a_persons_name_is_never_written_to_the_disk_cache(
    respx_mock: respx.Router, tmp_path_factory: pytest.TempPathFactory
) -> None:
    """The consequence, asserted rather than the intent.

    ADR 008 makes removal immediate with no queue and no human step. A cache of named people
    gives that removal more keys to chase than it knows about, which is why the one existing
    cache of that shape in this package is in memory. This adapter caches nothing at all, and
    this test is what stops someone adding one.
    """
    respx_mock.get(sec.submissions_url(9999001)).mock(
        return_value=httpx.Response(200, content=fixture_bytes(SUBMISSIONS))
    )
    respx_mock.get(url__regex=r".*/Archives/edgar/data/.*").mock(
        return_value=httpx.Response(200, content=fixture_bytes(OFFICER))
    )
    directory = tmp_path_factory.mktemp("cache")
    cache = DiskCache(directory)
    cache.set("unrelated", "value")

    async with httpx.AsyncClient(timeout=5.0) as http:
        parsed = await sec.SecClient(http, contact_email="a@b.invalid").ownership_for(
            9999001, limit=1
        )

    person, _ = parsed.records[0]
    blob = cache.path.read_bytes()
    assert person.name.encode() not in blob
    # Tokens of three characters or more. A single-letter middle initial matches a SQLite
    # header byte by chance, which would make this test fail for a reason that is not the one
    # it is asking about.
    for token in person.name.split():
        if len(token) >= 3:
            assert token.encode() not in blob
    assert person.sec_cik is not None
    assert person.sec_cik.encode() not in blob


@respx.mock(assert_all_called=True)
async def test_the_stated_ten_per_second_ceiling_is_held_before_the_request(
    respx_mock: respx.Router,
) -> None:
    """The SEC states a maximum access rate and says it is carefully monitored.

    Checked before the call rather than after it, so a provider that would have to refuse is
    not called at all.
    """
    respx_mock.get(sec.submissions_url(9999001)).mock(
        return_value=httpx.Response(200, content=fixture_bytes(SUBMISSIONS))
    )
    respx_mock.get(url__regex=r".*/Archives/edgar/data/.*").mock(
        return_value=httpx.Response(200, content=fixture_bytes(OFFICER))
    )
    now = datetime(2026, 8, 23, 12, 0, tzinfo=UTC)
    slept: list[float] = []

    async def record(seconds: float) -> None:
        slept.append(seconds)

    async with httpx.AsyncClient(timeout=5.0) as http:
        client = sec.SecClient(http, contact_email="a@b.invalid", clock=lambda: now, sleep=record)
        await client.ownership_for(9999001, limit=2)

    # The clock never advances, so every request after the first has to wait the full interval.
    assert slept
    assert all(s == pytest.approx(sec.MIN_REQUEST_INTERVAL_SECONDS) for s in slept)


@respx.mock(assert_all_called=True)
async def test_a_request_after_the_interval_has_passed_does_not_wait(
    respx_mock: respx.Router,
) -> None:
    respx_mock.get(f"{sec.WWW_BASE_URL}{sec.COMPANY_INDEX_PATH}").mock(
        return_value=httpx.Response(200, content=fixture_bytes(TICKERS))
    )
    ticks = iter(
        [
            datetime(2026, 8, 23, 12, 0, 0, tzinfo=UTC),
            datetime(2026, 8, 23, 12, 0, 0, tzinfo=UTC),
            datetime(2026, 8, 23, 12, 0, 5, tzinfo=UTC),
            datetime(2026, 8, 23, 12, 0, 5, tzinfo=UTC),
        ]
    )
    slept: list[float] = []

    async def record(seconds: float) -> None:
        slept.append(seconds)

    async with httpx.AsyncClient(timeout=5.0) as http:
        client = sec.SecClient(
            http, contact_email="a@b.invalid", clock=lambda: next(ticks), sleep=record
        )
        await client.company_index()
        await client.company_index()

    assert slept == []


def test_a_company_appearing_twice_is_collapsed_on_its_cik() -> None:
    """10,403 rows resolved to 7,998 CIKs live, because a company may have several tickers."""
    payload = json.dumps(
        {
            "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
            "1": {"cik_str": 320193, "ticker": "AAPL.X", "title": "Apple Inc."},
        }
    ).encode()
    companies = sec.parse_company_index(payload)
    assert len(companies) == 1
    assert companies[0].ticker == "AAPL"


# ---------------------------------------------------------------- the User-Agent


def test_the_user_agent_is_the_shape_the_sec_documents() -> None:
    """Its own sample is a name and a contact address, not the RFC-style one used elsewhere."""
    assert sec.user_agent("a@b.invalid") == "tracker/0.1 a@b.invalid"


def test_the_user_agent_carries_no_url() -> None:
    """A User-Agent containing the substring "github" is answered HTTP 403 by both SEC hosts.

    Measured on 2026-08-23. It is the substring rather than the URL: bare ``github`` is
    refused and ``gitlab.com`` is not. This project's shared User-Agent contains
    ``+https://github.com/local/tracker``, so a client using it is refused by the whole SEC
    estate, and the failure reads as a 403 rather than as anything about policy.
    """
    agent = sec.user_agent("a@b.invalid")
    assert "github" not in agent
    assert "http" not in agent


@respx.mock(assert_all_called=True)
async def test_the_clients_own_user_agent_overrides_the_shared_one(
    respx_mock: respx.Router,
) -> None:
    sent: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200, content=fixture_bytes(TICKERS))

    respx_mock.get(f"{sec.WWW_BASE_URL}{sec.COMPANY_INDEX_PATH}").mock(side_effect=record)
    shared = "tracker/0.1 (+https://github.com/local/tracker) (a@b.invalid)"
    async with httpx.AsyncClient(timeout=5.0, headers={"User-Agent": shared}) as http:
        await sec.SecClient(http, contact_email="a@b.invalid").company_index()

    assert sent[0].headers["user-agent"] == sec.user_agent("a@b.invalid")
    assert "github" not in sent[0].headers["user-agent"]
