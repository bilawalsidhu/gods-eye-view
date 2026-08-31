"""The ownership spine wired into the application: FAA register, SEC index, and the join."""

import asyncio
import io
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
import respx

from tests.conftest import fixture_bytes, make_aircraft
from tracker.api.routes_entities import (
    NOT_ON_REGISTER,
    OFFICERS_BASIS,
    AircraftDetail,
    AircraftOwnership,
    _fetch_officers,
    _officers,
    get_aircraft,
)
from tracker.api.routes_meta import _ownership_reason
from tracker.api.state import AppState
from tracker.app import (
    SEC_INDEX_CACHE_KEY,
    _refresh_ownership_forever,
    build_state,
    refresh_ownership,
)
from tracker.cache import DiskCache
from tracker.config import Settings
from tracker.contracts.geo import Point
from tracker.contracts.organisation import Organisation
from tracker.contracts.person import Person
from tracker.contracts.social import SocialPost
from tracker.services import spine
from tracker.services.suppression import SuppressionStore
from tracker.sources import sec
from tracker.sources.faa_registry import FaaRegistryIndex, parse_registry

EXTRACT = datetime(2026, 8, 22, 4, 57, 31, tzinfo=UTC)
COMPANY = "ELLINGWHARF GROUP LIMITED"
COMPANY_HEX = "a00725"
PERSON_HEX = "a004b3"

OFFICER = "sec_edgar_form4_officer_live.xml"
SUBMISSIONS = "sec_edgar_submissions_person_live.json"

SOCIAL_POST = SocialPost(
    source="mastodon",
    post_id="test-1",
    url="https://example.invalid/1",
    author_handle="@someone@example.invalid",
    posted_at=datetime(2026, 8, 23, 12, 0, tzinfo=UTC),
    text="a post",
    point=Point(lon=-0.12, lat=51.5),
    location_basis="derived",
    location_phrase="London",
    place_name="London",
    retrieved_at=datetime(2026, 8, 23, 12, 1, tzinfo=UTC),
)

INDEX_PAYLOAD = (
    b'{"0": {"cik_str": 9000001, "ticker": "EGL", "title": "Ellingwharf Group Limited"},'
    b' "1": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."}}'
)


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(timeout=5.0) as client:
        yield client


def _settings(**overrides: object) -> Settings:
    base: dict[str, object] = {"contact_email": "someone@example.invalid"}
    base.update(overrides)
    return Settings(**base)  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]


def registry_index(*, extract_date: datetime | None = EXTRACT) -> FaaRegistryIndex:
    """The real scrubbed register extract, 200 rows, built exactly as the adapter builds it."""
    with (
        io.BytesIO(fixture_bytes("faa_master_extract.csv")) as master,
        io.BytesIO(fixture_bytes("faa_acftref_extract.csv")) as acftref,
    ):
        return parse_registry(master, acftref, extract_date=extract_date)


def wire(
    state: AppState,
    monkeypatch: pytest.MonkeyPatch,
    index: FaaRegistryIndex | None = None,
    error: Exception | None = None,
) -> FaaRegistryIndex:
    """Stand in for the 73MB download. The adapter's own tests cover the fetch itself."""
    built = index if index is not None else registry_index()

    async def load() -> FaaRegistryIndex:
        if error is not None:
            raise error
        return built

    monkeypatch.setattr(state.faa, "load", load)
    return built


# ---------------------------------------------------------------- construction


def test_build_state_holds_the_register_and_the_filing_client(http: httpx.AsyncClient) -> None:
    state = build_state(_settings(), http)
    assert state.faa is not None
    assert isinstance(state.sec, sec.SecClient)
    assert state.company_index is None
    assert state.ownership is None
    assert state.ownership_error is None


def test_building_state_downloads_nothing(http: httpx.AsyncClient) -> None:
    """The register is 73MB. A constructor that fetches it is a constructor nobody can test."""
    with respx.mock(assert_all_called=False) as router:
        build_state(_settings(), http)
        assert not router.calls


# ---------------------------------------------------------------- the refresh


@respx.mock(assert_all_called=True)
async def test_a_refresh_joins_the_aircraft_in_view(
    respx_mock: respx.Router,
    http: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    respx_mock.get(url__regex=r".*company_tickers\.json").mock(
        return_value=httpx.Response(200, content=INDEX_PAYLOAD)
    )
    state = build_state(_settings(), http)
    wire(state, monkeypatch)
    state.aircraft.upsert(COMPANY_HEX, make_aircraft(icao24=COMPANY_HEX))
    state.aircraft.upsert(PERSON_HEX, make_aircraft(icao24=PERSON_HEX))

    joined = await refresh_ownership(state)

    assert joined == 1
    assert state.ownership is not None
    assert state.ownership.asserted == 1
    assert state.ownership.possible == 0
    assert state.ownership.organisation_ids == ("sec-0009000001",)
    assert state.ownership_error is None


@respx.mock(assert_all_called=True)
async def test_an_aircraft_registered_to_a_person_is_refused_and_counted(
    respx_mock: respx.Router,
    http: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """98 of the 200 rows in the extract are registered to individuals."""
    respx_mock.get(url__regex=r".*company_tickers\.json").mock(
        return_value=httpx.Response(200, content=INDEX_PAYLOAD)
    )
    state = build_state(_settings(), http)
    wire(state, monkeypatch)
    state.aircraft.upsert(PERSON_HEX, make_aircraft(icao24=PERSON_HEX))

    await refresh_ownership(state)

    assert state.ownership is not None
    assert state.ownership.joined == 0
    assert state.ownership.refused[spine.DROP_PERSON] == 1


@respx.mock(assert_all_called=True)
async def test_an_aircraft_the_register_does_not_hold_is_skipped_not_refused(
    respx_mock: respx.Router,
    http: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """US military aircraft are not on the civil register, which is normal rather than a drop."""
    respx_mock.get(url__regex=r".*company_tickers\.json").mock(
        return_value=httpx.Response(200, content=INDEX_PAYLOAD)
    )
    state = build_state(_settings(), http)
    wire(state, monkeypatch)
    state.military.upsert("ae1234", make_aircraft(icao24="ae1234"))

    await refresh_ownership(state)

    assert state.ownership is not None
    assert state.ownership.joined == 0
    assert not state.ownership.refused


@respx.mock(assert_all_called=True)
async def test_the_join_is_dated_to_the_registers_extract_not_to_today(
    respx_mock: respx.Router,
    http: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ADR 006 dates an entry to its source. Stamping it with the run would invent a date."""
    respx_mock.get(url__regex=r".*company_tickers\.json").mock(
        return_value=httpx.Response(200, content=INDEX_PAYLOAD)
    )
    state = build_state(_settings(), http)
    wire(state, monkeypatch)
    state.aircraft.upsert(COMPANY_HEX, make_aircraft(icao24=COMPANY_HEX))
    index = state.company_index

    await refresh_ownership(state)

    assert index is None
    assert state.company_index is not None
    result = spine.match_registrant(
        COMPANY,
        kind="organisation",
        index=state.company_index,
        as_of=EXTRACT.date(),
        source="faa",
        origin_key="faa-2026-08-22",
    )
    assert result.join is not None
    assert result.join.as_of == EXTRACT.date()


@respx.mock(assert_all_called=True)
async def test_a_register_with_no_extract_date_joins_nothing(
    respx_mock: respx.Router,
    http: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Nothing to date a join to, and ADR 006 drops an undated entry rather than stamping it."""
    respx_mock.get(url__regex=r".*company_tickers\.json").mock(
        return_value=httpx.Response(200, content=INDEX_PAYLOAD)
    )
    state = build_state(_settings(), http)
    wire(state, monkeypatch, registry_index(extract_date=None))
    state.aircraft.upsert(COMPANY_HEX, make_aircraft(icao24=COMPANY_HEX))

    joined = await refresh_ownership(state)

    assert joined == 0
    assert state.ownership is None
    assert state.ownership_error == "register carries no extract date"


@respx.mock(assert_all_called=True)
async def test_a_failed_refresh_keeps_what_was_already_joined(
    respx_mock: respx.Router,
    http: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An hours-old register beats none: aircraft ownership does not change over lunch."""
    respx_mock.get(url__regex=r".*company_tickers\.json").mock(
        return_value=httpx.Response(200, content=INDEX_PAYLOAD)
    )
    state = build_state(_settings(), http)
    wire(state, monkeypatch)
    state.aircraft.upsert(COMPANY_HEX, make_aircraft(icao24=COMPANY_HEX))
    await refresh_ownership(state)
    held = state.ownership

    wire(state, monkeypatch, error=httpx.ConnectTimeout(""))
    joined = await refresh_ownership(state)

    assert joined == 1
    assert state.ownership is held
    assert state.ownership_error == "ConnectTimeout"


@respx.mock(assert_all_called=False)
async def test_a_refresh_that_has_never_succeeded_reports_zero(
    respx_mock: respx.Router,
    http: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The register is loaded first now, so a register failure never reaches the SEC."""
    route = respx_mock.get(url__regex=r".*company_tickers\.json").mock(
        return_value=httpx.Response(200, content=INDEX_PAYLOAD)
    )
    state = build_state(_settings(), http)
    wire(state, monkeypatch, error=httpx.ConnectTimeout(""))

    assert await refresh_ownership(state) == 0
    assert state.ownership is None
    assert state.ownership_error
    assert route.call_count == 0, "a failed register must not spend an SEC request"


# ---------------------------------------------------------------- the company index cache


@respx.mock(assert_all_called=True)
async def test_the_company_index_is_fetched_once_and_then_read_from_disk(
    respx_mock: respx.Router,
    http: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """796KB of listed-company names. Companies are not people, so this one may be cached."""
    route = respx_mock.get(url__regex=r".*company_tickers\.json").mock(
        return_value=httpx.Response(200, content=INDEX_PAYLOAD)
    )
    state = build_state(_settings(), http)
    wire(state, monkeypatch)

    await refresh_ownership(state)
    await refresh_ownership(state)

    assert route.call_count == 1
    assert state.cache.get(SEC_INDEX_CACHE_KEY) is not None


@respx.mock(assert_all_called=True)
async def test_the_cached_company_index_survives_a_restart(
    respx_mock: respx.Router,
    http: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    route = respx_mock.get(url__regex=r".*company_tickers\.json").mock(
        return_value=httpx.Response(200, content=INDEX_PAYLOAD)
    )
    first = build_state(_settings(), http)
    wire(first, monkeypatch)
    await refresh_ownership(first)

    restarted = build_state(_settings(), http)
    wire(restarted, monkeypatch)
    await refresh_ownership(restarted)

    assert route.call_count == 1
    assert restarted.company_index is not None


@respx.mock(assert_all_called=True)
async def test_no_aircraft_owner_name_reaches_the_disk_cache(
    respx_mock: respx.Router,
    http: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """98 of the 200 register rows name a natural person. None of them may be written down.

    The company index is cached and the register is not, and this is the line between them.
    """
    respx_mock.get(url__regex=r".*company_tickers\.json").mock(
        return_value=httpx.Response(200, content=INDEX_PAYLOAD)
    )
    state = build_state(_settings(), http)
    built = wire(state, monkeypatch)
    state.aircraft.upsert(PERSON_HEX, make_aircraft(icao24=PERSON_HEX))

    await refresh_ownership(state)

    person = built.registration(PERSON_HEX)
    assert person is not None
    blob = state.cache.path.read_bytes()
    assert person.owner_name.encode() not in blob
    # Tokens of three characters or more. A single-letter middle initial matches a SQLite
    # header byte by chance, which would make this test fail for a reason that is not the one
    # it is asking about.
    for token in person.owner_name.split():
        if len(token) >= 3:
            assert token.encode() not in blob


# ---------------------------------------------------------------- the contact address


async def test_no_contact_address_still_loads_the_register(
    http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The register needs no contact address. Only the filings do.

    This is the bug that shipped: one condition gated both, so a deployment with no contact
    address showed no registered owner for any aircraft when it could have shown one for every
    N-register airframe on the globe.
    """
    state = build_state(Settings(contact_email=""), http)
    built = wire(state, monkeypatch)
    state.faa._index = built
    state.aircraft.upsert(COMPANY_HEX, make_aircraft(icao24=COMPANY_HEX))

    with respx.mock(assert_all_called=False) as router:
        joined = await refresh_ownership(state)

    assert joined == 0
    assert not router.calls, "the SEC refuses an undeclared client, so nothing is sent"
    assert state.ownership is None
    assert not state.settings.filings_available
    assert state.faa.index is not None, "the register loaded regardless"


async def test_without_a_contact_address_a_card_still_shows_the_registered_owner(
    http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Degraded, not absent. The owner, the kind and the extract date all reach the card."""
    state = build_state(Settings(contact_email=""), http)
    _ready_register_only(state, monkeypatch)
    state.aircraft.upsert(COMPANY_HEX, make_aircraft(icao24=COMPANY_HEX))

    detail = await _detail(state, COMPANY_HEX)

    assert detail is not None
    block = detail.ownership
    assert block is not None
    assert block.registrant == COMPANY
    assert block.registrant_kind == "organisation"
    assert block.as_of == EXTRACT.date()
    assert block.join is None
    assert block.officers == ()
    assert "TRACKER_CONTACT_EMAIL" in (block.refused_reason or "")


# ---------------------------------------------------------------- the read path


async def _detail(state: AppState, icao24: str) -> AircraftDetail | None:
    """The detail route's own function, against state we control."""
    return await get_aircraft(state, icao24)


def _ready_register_only(state: AppState, monkeypatch: pytest.MonkeyPatch) -> FaaRegistryIndex:
    """The register loaded and no company index, which is the no-contact-address state."""
    built = wire(state, monkeypatch)
    state.faa._index = built
    return built


def _ready(state: AppState, monkeypatch: pytest.MonkeyPatch) -> FaaRegistryIndex:
    built = wire(state, monkeypatch)
    state.faa._index = built
    state.company_index = spine.CompanyIndex.build(sec.parse_company_index(INDEX_PAYLOAD))
    return built


@respx.mock(assert_all_called=False)
async def test_an_aircraft_not_on_the_civil_register_carries_no_ownership_block(
    respx_mock: respx.Router, http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """About one live aircraft in five, and it is the ordinary case rather than a failure."""
    state = build_state(_settings(), http)
    _ready(state, monkeypatch)
    state.aircraft.upsert("ae1234", make_aircraft(icao24="ae1234"))

    detail = await _detail(state, "ae1234")

    assert detail is not None
    block = detail.ownership
    assert block is not None, "null now means an outage and nothing else"
    assert block.registrant is None
    assert block.as_of == EXTRACT.date(), "a dated, sourced negative claim"
    assert block.refused_reason == NOT_ON_REGISTER


@respx.mock(assert_all_called=False)
async def test_an_aircraft_registered_to_a_person_carries_the_refusal_not_a_match(
    respx_mock: respx.Router, http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    state = build_state(_settings(), http)
    _ready(state, monkeypatch)
    state.aircraft.upsert(PERSON_HEX, make_aircraft(icao24=PERSON_HEX))

    detail = await _detail(state, PERSON_HEX)

    assert detail is not None
    block = detail.ownership
    assert block is not None
    assert block.registrant_kind == "person"
    assert block.asserted is False
    assert block.join is None
    assert block.organisation is None
    assert block.officers == ()
    assert block.refused_reason == spine.DROP_PERSON


@respx.mock(assert_all_called=True)
async def test_an_asserted_join_carries_its_basis_source_confidence_and_date(
    respx_mock: respx.Router, http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """None of it is summarised away: the basis is the whole difference between the tiers."""
    respx_mock.get(url__regex=r".*data\.sec\.gov/submissions/.*").mock(
        return_value=httpx.Response(200, content=fixture_bytes(SUBMISSIONS))
    )
    respx_mock.get(url__regex=r".*/Archives/edgar/data/.*").mock(
        return_value=httpx.Response(200, content=fixture_bytes(OFFICER))
    )
    state = build_state(_settings(), http)
    _ready(state, monkeypatch)
    state.aircraft.upsert(COMPANY_HEX, make_aircraft(icao24=COMPANY_HEX))

    detail = await _detail(state, COMPANY_HEX)

    assert detail is not None
    block = detail.ownership
    assert block is not None
    assert block.registrant == COMPANY
    assert block.asset_register == "faa"
    assert block.as_of == EXTRACT.date()
    assert block.asserted is True
    assert block.join is not None
    assert block.join.basis == spine.BASIS_EXACT
    assert block.join.confidence == spine.ASSERT_CONFIDENCE
    assert block.join.source == "faa"
    assert block.join.origin_key == "faa-2026-08-22"
    assert block.join.as_of == EXTRACT.date()
    assert block.join.inferred is False
    assert block.organisation is not None
    assert block.organisation.sec_cik == "0009000001"


@respx.mock(assert_all_called=True)
async def test_the_officers_come_back_from_primary_filings(
    respx_mock: respx.Router, http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    respx_mock.get(url__regex=r".*data\.sec\.gov/submissions/.*").mock(
        return_value=httpx.Response(200, content=fixture_bytes(SUBMISSIONS))
    )
    respx_mock.get(url__regex=r".*/Archives/edgar/data/.*").mock(
        return_value=httpx.Response(200, content=fixture_bytes(OFFICER))
    )
    state = build_state(_settings(), http)
    _ready(state, monkeypatch)
    state.aircraft.upsert(COMPANY_HEX, make_aircraft(icao24=COMPANY_HEX))

    detail = await _detail(state, COMPANY_HEX)

    assert detail is not None
    block = detail.ownership
    assert block is not None
    assert block.officers
    assert block.officers_basis == OFFICERS_BASIS
    officer = block.officers[0]
    assert officer.roles[0].source == "sec-edgar"
    assert officer.roles[0].origin_key
    assert officer.roles[0].as_of


@respx.mock(assert_all_called=True)
async def test_an_officer_carries_no_contact_data_and_an_empty_wealth_tier(
    respx_mock: respx.Router, http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Empty with a stated reason reads as a finding; absent reads as an oversight."""
    respx_mock.get(url__regex=r".*data\.sec\.gov/submissions/.*").mock(
        return_value=httpx.Response(200, content=fixture_bytes(SUBMISSIONS))
    )
    respx_mock.get(url__regex=r".*/Archives/edgar/data/.*").mock(
        return_value=httpx.Response(200, content=fixture_bytes(OFFICER))
    )
    state = build_state(_settings(), http)
    _ready(state, monkeypatch)
    state.aircraft.upsert(COMPANY_HEX, make_aircraft(icao24=COMPANY_HEX))

    detail = await _detail(state, COMPANY_HEX)

    assert detail is not None
    block = detail.ownership
    assert block is not None
    assert block.wealth_tier_reason
    for officer in block.officers:
        assert officer.wealth_tier is None
        assert officer.emails == ()
        assert officer.phones == ()
        assert officer.addresses == ()
        assert officer.has_pii is False


@respx.mock(assert_all_called=True)
async def test_a_failed_filing_lookup_degrades_to_the_join_alone(
    respx_mock: respx.Router, http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A card losing its officers is a smaller loss than a card losing the aircraft."""
    respx_mock.get(url__regex=r".*data\.sec\.gov/submissions/.*").mock(
        return_value=httpx.Response(503)
    )
    state = build_state(_settings(), http)
    _ready(state, monkeypatch)
    state.aircraft.upsert(COMPANY_HEX, make_aircraft(icao24=COMPANY_HEX))

    detail = await _detail(state, COMPANY_HEX)

    assert detail is not None
    block = detail.ownership
    assert block is not None
    assert block.asserted is True
    assert block.join is not None
    assert block.officers == ()
    assert block.officers_basis is None
    assert block.degraded_reason


@respx.mock(assert_all_called=False)
async def test_the_block_says_so_when_the_company_index_has_not_loaded(
    respx_mock: respx.Router, http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    state = build_state(_settings(), http)
    wire(state, monkeypatch)
    state.faa._index = registry_index()
    state.aircraft.upsert(COMPANY_HEX, make_aircraft(icao24=COMPANY_HEX))

    detail = await _detail(state, COMPANY_HEX)

    assert detail is not None
    assert detail.ownership is not None
    assert "TRACKER_CONTACT_EMAIL" in (detail.ownership.refused_reason or "")


async def test_no_ownership_block_before_the_register_has_loaded(http: httpx.AsyncClient) -> None:
    state = build_state(_settings(), http)
    state.aircraft.upsert(COMPANY_HEX, make_aircraft(icao24=COMPANY_HEX))

    detail = await _detail(state, COMPANY_HEX)

    assert detail is not None
    assert detail.ownership is None, "no register loaded at all is the one null case"


def test_the_client_never_has_to_apply_a_threshold_itself() -> None:
    """``asserted`` is the decision and ``spine.asserted_join`` is the only place it is made."""
    fields = AircraftOwnership.model_fields
    assert "asserted" in fields
    assert fields["asserted"].annotation is bool


def _store(tmp_path: Path) -> SuppressionStore:
    return SuppressionStore(DiskCache(tmp_path), tmp_path)


def test_the_officer_candidate_set_is_built_in_one_place(tmp_path: Path) -> None:
    """ADR 008 excludes a suppressed person from the candidate set rather than the output.

    The exclusion lives in ``_officers`` and nowhere else, so this asserts the set is both
    deduplicated and filtered there rather than by whatever happens to consume it.
    """
    person = Person(person_id="sec-0009999001", name="A Name", sec_cik="0009999001")
    org = Organisation(organisation_id="sec-0000320193", name="Apple Inc.")
    store = _store(tmp_path)
    assert _officers(((person, org), (person, org)), store=store) == (person,)
    assert _officers((), store=store) == ()


def test_a_suppressed_person_is_never_generated_as_a_candidate(tmp_path: Path) -> None:
    """Not filtered afterwards. By the time a filter runs the person has been scored, counted
    in an aggregate and put in a payload something might log."""
    kept = Person(person_id="sec-0009999001", name="Kept", sec_cik="0009999001")
    gone = Person(person_id="sec-0009999002", name="Gone", sec_cik="0009999002")
    org = Organisation(organisation_id="sec-0000320193", name="Apple Inc.")
    store = _store(tmp_path)
    store.suppress(gone.person_id, "requested_by_subject")

    officers = _officers(((kept, org), (gone, org)), store=store)

    assert officers == (kept,)
    assert store.is_suppressed(gone.person_id)


@respx.mock(assert_all_called=True)
async def test_a_suppressed_officer_never_reaches_the_card(
    respx_mock: respx.Router, http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End to end: the route, not just the helper."""
    respx_mock.get(url__regex=r".*data\.sec\.gov/submissions/.*").mock(
        return_value=httpx.Response(200, content=fixture_bytes(SUBMISSIONS))
    )
    respx_mock.get(url__regex=r".*/Archives/edgar/data/.*").mock(
        return_value=httpx.Response(200, content=fixture_bytes(OFFICER))
    )
    state = build_state(_settings(), http)
    _ready(state, monkeypatch)
    state.aircraft.upsert(COMPANY_HEX, make_aircraft(icao24=COMPANY_HEX))

    before = await _detail(state, COMPANY_HEX)
    assert before is not None
    assert before.ownership is not None
    assert before.ownership.officers
    target = before.ownership.officers[0]

    state.suppression.suppress(target.person_id, "requested_by_subject")
    after = await _detail(state, COMPANY_HEX)

    assert after is not None
    assert after.ownership is not None
    assert target.person_id not in {p.person_id for p in after.ownership.officers}


def test_the_suppression_key_cannot_be_reversed_from_the_cache_file(tmp_path: Path) -> None:
    """A person_id is ``sec-{cik}``, a CIK is ten digits, and EDGAR publishes all 800,000.

    An unkeyed digest of one is reversible in seconds by anyone who obtains the file, which is
    why the store keys on an HMAC. This asserts the identifier itself never lands in the file.
    """
    store = _store(tmp_path)
    store.suppress("sec-0009999001", "requested_by_subject")
    blob = (tmp_path / "upstream.sqlite3").read_bytes()
    assert b"sec-0009999001" not in blob
    assert b"0009999001" not in blob


@respx.mock(assert_all_called=False)
async def test_an_organisation_with_no_cik_yields_no_officers_and_no_error(
    respx_mock: respx.Router, http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Nothing to look up is not a degraded state, so nothing is reported as one."""
    state = build_state(_settings(), http)
    _ready(state, monkeypatch)

    officers, degraded = await _fetch_officers(
        state, Organisation(organisation_id="faa-x", name="A Company")
    )

    assert officers == ()
    assert degraded is None


@respx.mock(assert_all_called=True)
async def test_a_failed_company_index_fetch_keeps_what_was_already_joined(
    respx_mock: respx.Router, http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The register succeeded and the SEC did not. That is a degraded layer, not a dead one."""
    respx_mock.get(url__regex=r".*company_tickers\.json").mock(side_effect=httpx.ConnectTimeout(""))
    state = build_state(_settings(), http)
    _ready_register_only(state, monkeypatch)

    joined = await refresh_ownership(state)

    assert joined == 0
    assert state.ownership_error == "ConnectTimeout"
    assert state.faa.index is not None, "the register still loaded"


async def test_the_refresh_loop_runs_a_pass_then_waits(
    http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """It refreshes immediately so the join fills in a moment after start-up, then sleeps."""
    state = build_state(_settings(), http)
    wire(state, monkeypatch, error=httpx.ConnectTimeout(""))
    slept: list[float] = []

    async def record(seconds: float) -> None:
        slept.append(seconds)
        raise asyncio.CancelledError

    monkeypatch.setattr(asyncio, "sleep", record)
    with pytest.raises(asyncio.CancelledError):
        await _refresh_ownership_forever(state)

    assert slept == [state.settings.ownership_refresh_seconds]


def test_the_layer_reason_reports_the_register_once_it_has_loaded(
    http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Before it loads the reason says so; after, it carries whatever the last refresh found."""
    state = build_state(_settings(), http)
    assert "register" in (_ownership_reason(state) or "").lower()

    _ready_register_only(state, monkeypatch)
    assert _ownership_reason(state) is None

    state.ownership_error = "ConnectTimeout"
    assert _ownership_reason(state) == "ConnectTimeout"


def test_the_removal_reaches_every_cache_that_could_serve_a_name(
    http: httpx.AsyncClient,
) -> None:
    """Three caches, and the social page is the one a removal is most likely to miss.

    It holds a Mastodon author handle and a Commons licence author, so it is real personal
    data. It has to be the instance the routes serve from: a second copy would let the removal
    report a cache it never reached, which is worse than not claiming it.
    """
    state = build_state(_settings(), http)

    assert state.removals.reaches == (
        "media proxy",
        "adsbdb owner cache",
        "social derived page",
    )


def test_the_swept_social_page_is_the_one_the_routes_serve_from(
    http: httpx.AsyncClient,
) -> None:
    """Asserted by identity rather than by type, because a second copy is the whole failure."""
    state = build_state(_settings(), http)
    # Annotated wide rather than as a one-tuple, or mypy narrows the attribute and decides
    # the emptiness check below can never be true.
    held: tuple[SocialPost, ...] = (SOCIAL_POST,)
    state.social.derived = held

    outcome = state.removals.remove("sec-0009999001", "requested_by_subject")

    assert len(state.social.derived) == 0
    assert dict(outcome.swept)["social derived page"] == 1
