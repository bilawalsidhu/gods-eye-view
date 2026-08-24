"""The Portnet vessel registry adapter: the sentinels, the fake call signs and the budget.

Every payload here is the genuine 17-record body from
``meri.digitraffic.fi/api/port-call/v1/vessel-details``, captured 2026-08-20. No network:
respx intercepts at the transport, and ``assert_all_called=True`` means a test that believes
it made a request but did not is a failure rather than a false pass.

Four traps get most of the attention, because every one of them produces a plausible wrong
answer rather than an error.

``?mmsi=0`` answers HTTP 200 with real vessels, because 8 of the 17 records carry ``mmsi: 0``
for "not filed". A caller passing a falsy MMSI would get a real-looking record for a ship it
never asked about, with nothing failing anywhere.

A single space is the missing-value sentinel on ``shipOwner``, on 10 of the 17 records. A
strict ``str`` field takes it happily, so the demo ships owner cards that look blank and are
technically populated.

``radioCallSignType: "FAKE"`` on 4 of the 17 means the provider invented the call sign, and
those four values are the vessel's own name uppercased. ``REAL`` is not sufficient either:
``-``, ``0`` and ``10563`` all arrive marked ``REAL``. A call sign is the join key into ITU
MARS and USCG PSIX, so a synthetic one matches the wrong vessel with full confidence.

And ``0`` or ``0.0`` is the not-available value on every tonnage and every dimension, arriving
as a number rather than a null in the same object as a genuine ``null`` on ``maxSpeed``.
"""

import json
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
import respx

from tests.conftest import fixture_bytes, fixture_json
from tracker.contracts.base import ContractViolationError
from tracker.sources.base import RateLimitedError, SourceError
from tracker.sources.fintraffic import BASE_URL, DIGITRAFFIC_USER_HEADER
from tracker.sources.fintraffic_registry import (
    ATTRIBUTION,
    DEFAULT_CACHE_TTL_SECONDS,
    LICENCE,
    MAX_REQUESTS_PER_MINUTE,
    RATE_WINDOW_SECONDS,
    SOURCE_NAME,
    VESSEL_DETAILS_PATH,
    FintrafficRegistryLookup,
    VesselRegistration,
    normalise_mmsi,
    parse_vessel_details,
)

FIXTURE = "digitraffic_portcall_vessel_details_live.json"
DETAILS_URL = f"{BASE_URL}{VESSEL_DETAILS_PATH}"

RECORD_COUNT = 17
"""Records in the captured body."""

NO_MMSI_COUNT = 8
"""Records carrying ``mmsi: 0``, which is this endpoint's "not filed"."""

MAPPED_COUNT = RECORD_COUNT - NO_MMSI_COUNT

BLANK_OWNER_COUNT = 10
""""Records whose ``shipOwner`` is a single space rather than a null or an empty string."""

FAKE_CALL_SIGN_COUNT = 4
"""``radioCallSignType: "FAKE"``. The four values are the vessel names uppercased."""

TALI_MMSI = "230916000"
"""``Tali``, IMO 9173692, call sign OJIH marked REAL. The first record in the body."""

PLACEHOLDER_MMSI = "999999999"
""""NATO WARSHIP" on the AIS feed. 999 is not an allocated ITU MID, so it is not an identity."""

SAR_AIRCRAFT_MMSI = "111265583"
"""LIFEGUARD 003. The ITU allocates the 111 prefix to search-and-rescue aircraft."""

NOW = datetime(2026, 8, 20, 9, 0, 0, tzinfo=UTC)


class Clock:
    """A clock a test moves by hand, so the TTL and the budget window are asserted."""

    def __init__(self, start: datetime = NOW) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


def _records() -> list[dict[str, Any]]:
    """The captured body as Python objects, for building variants of it."""
    records: list[dict[str, Any]] = fixture_json(FIXTURE)
    return records


def _body(*records: Any) -> bytes:
    """A bare JSON array, which is what this endpoint returns: no envelope, no paging."""
    return json.dumps(list(records)).encode()


def _one(mmsi: str = TALI_MMSI) -> dict[str, Any]:
    """The single record for one MMSI, straight out of the captured body."""
    return next(record for record in _records() if record.get("mmsi") == int(mmsi))


@pytest.fixture
def payload() -> bytes:
    return fixture_bytes(FIXTURE)


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    """A real client. respx intercepts at the transport, so nothing leaves the process."""
    async with httpx.AsyncClient() as client:
        yield client


@pytest.fixture
def lookup(http: httpx.AsyncClient, clock: Clock) -> FintrafficRegistryLookup:
    return FintrafficRegistryLookup(http, clock=clock)


@pytest.fixture
def no_network() -> Iterator[respx.MockRouter]:
    """Every request would be a failure. A route never called is the assertion."""
    with respx.mock(assert_all_called=False) as router:
        yield router


# ---------------------------------------------------------------- the mmsi=0 trap


def test_the_captured_body_really_carries_records_with_no_mmsi() -> None:
    """If this stops being true, every guard below is testing nothing."""
    blank = [record for record in _records() if record.get("mmsi") == 0]
    assert len(blank) == NO_MMSI_COUNT
    assert len(_records()) == RECORD_COUNT


@pytest.mark.parametrize("raw", ["0", "000000000", "0" * 9])
def test_a_zero_mmsi_is_refused_before_the_request_is_made(
    raw: str, no_network: respx.MockRouter
) -> None:
    """``?mmsi=0`` answers 200 with real ships, so this guard runs before the network."""
    with pytest.raises(ValueError, match="MMSI"):
        normalise_mmsi(raw)
    assert not no_network.calls


@pytest.mark.parametrize(
    "raw",
    ["", "12345678", "1234567890", "23091600a", "  ", "23091600 "],
)
def test_an_mmsi_that_is_not_nine_digits_is_refused(raw: str) -> None:
    with pytest.raises(ValueError, match="not a nine-digit MMSI"):
        normalise_mmsi(raw)


@pytest.mark.parametrize(
    ("raw", "category"),
    [
        (PLACEHOLDER_MMSI, "unallocated"),
        (SAR_AIRCRAFT_MMSI, "sar_aircraft"),
        ("002300000", "coast_station"),
        ("992300000", "navigational_aid"),
    ],
)
def test_a_non_ship_station_mmsi_is_refused_and_says_what_it_was(raw: str, category: str) -> None:
    """MMSI 999999999 returns a record named NATO WARSHIP, so refusing it is the point."""
    with pytest.raises(ValueError, match=category):
        normalise_mmsi(raw)


def test_a_ship_station_mmsi_is_returned_stripped() -> None:
    assert normalise_mmsi(f" {TALI_MMSI} ") == TALI_MMSI


def test_a_record_whose_own_mmsi_is_zero_is_dropped_and_counted(payload: bytes) -> None:
    parsed = parse_vessel_details(payload, retrieved_at=NOW)
    assert len(parsed.records) == MAPPED_COUNT
    assert parsed.dropped == NO_MMSI_COUNT
    assert parsed.drops == {
        "registry record carries no MMSI, so it cannot join to a live vessel": NO_MMSI_COUNT
    }


def test_a_record_whose_mmsi_is_not_a_ship_station_is_dropped_and_counted() -> None:
    record = _one() | {"mmsi": int(PLACEHOLDER_MMSI)}
    parsed = parse_vessel_details(_body(record), retrieved_at=NOW)
    assert not parsed.records
    assert parsed.dropped == 1
    assert next(iter(parsed.drops)).startswith("MMSI is not a ship-station identity")


def test_a_negative_mmsi_is_read_as_absent_like_a_zero() -> None:
    """The sentinel is read as at-or-below, because nothing here is legitimately zero."""
    parsed = parse_vessel_details(_body(_one() | {"mmsi": -1}), retrieved_at=NOW)
    assert not parsed.records
    assert parsed.dropped == 1


def test_an_absent_mmsi_key_is_dropped_like_a_zero() -> None:
    record = {key: value for key, value in _one().items() if key != "mmsi"}
    parsed = parse_vessel_details(_body(record), retrieved_at=NOW)
    assert not parsed.records
    assert parsed.dropped == 1


# ---------------------------------------------------------------- the space sentinel


def test_the_captured_body_really_uses_a_single_space_for_a_missing_owner() -> None:
    blank = [
        record
        for record in _records()
        if (record.get("vesselSystem") or {}).get("shipOwner") == " "
    ]
    assert len(blank) == BLANK_OWNER_COUNT


def test_a_single_space_owner_maps_to_none_rather_than_a_blank_looking_string() -> None:
    record = _one()
    record["vesselSystem"]["shipOwner"] = " "
    parsed = parse_vessel_details(_body(record), retrieved_at=NOW)
    assert parsed.records[0].owner is None


def test_an_owner_that_is_filed_survives_verbatim(payload: bytes) -> None:
    parsed = parse_vessel_details(payload, retrieved_at=NOW)
    owners = {record.owner for record in parsed.records if record.owner}
    assert "ESL Shipping Oy" in owners
    assert "Finnlines Plc, Ship Management" in owners
    assert " " not in owners


def test_an_empty_string_and_a_null_both_read_as_absent() -> None:
    record = _one()
    record["vesselSystem"]["shipOwner"] = ""
    record["vesselRegistration"]["portOfRegistry"] = None
    parsed = parse_vessel_details(_body(record), retrieved_at=NOW)
    assert parsed.records[0].owner is None
    assert parsed.records[0].port_of_registry is None


def test_over_long_text_is_clipped_rather_than_losing_the_record() -> None:
    """A registry name is a display field here, unlike the FAA address, which is a match key."""
    record = _one()
    record["name"] = "A" * 200
    parsed = parse_vessel_details(_body(record), retrieved_at=NOW)
    name = parsed.records[0].name
    assert name is not None
    assert len(name) == 60


def test_the_ship_telephone_and_email_are_never_ingested(payload: bytes) -> None:
    """Contact data under ADR 008 needs a PII marker, a suppression path and a removal
    path, and none of those can be added without a contract change this module is not
    making. The recorded body holds two real Finnish mobile numbers."""
    parsed = parse_vessel_details(payload, retrieved_at=NOW)
    serialised = "".join(record.model_dump_json() for record in parsed.records)
    for record in _records():
        telephone = (record.get("vesselSystem") or {}).get("shipTelephone1")
        if telephone and telephone.strip():
            assert telephone.strip() not in serialised
    assert "shipTelephone1" not in serialised
    assert "shipEmail" not in serialised


# ---------------------------------------------------------------- the call sign


def test_the_captured_body_really_marks_four_call_signs_fake() -> None:
    fake = [record for record in _records() if record.get("radioCallSignType") == "FAKE"]
    assert len(fake) == FAKE_CALL_SIGN_COUNT
    assert {record["radioCallSign"] for record in fake} == {
        "KIKKAX",
        "NIINA2",
        "BOTNIA",
        "SCG4",
    }


def test_a_fake_call_sign_is_refused_and_costs_the_field_not_the_record() -> None:
    record = _one() | {"radioCallSign": "BOTNIA", "radioCallSignType": "FAKE"}
    parsed = parse_vessel_details(_body(record), retrieved_at=NOW)
    assert parsed.records[0].call_sign is None
    assert not parsed.drops


@pytest.mark.parametrize("raw", ["-", "0", "10563"])
def test_a_real_marked_call_sign_that_fails_the_shape_test_is_refused(raw: str) -> None:
    """All three arrive marked ``REAL`` on the live endpoint, and none is a call sign."""
    record = _one() | {"radioCallSign": raw, "radioCallSignType": "REAL"}
    parsed = parse_vessel_details(_body(record), retrieved_at=NOW)
    assert parsed.records[0].call_sign is None


def test_a_real_call_sign_survives_and_is_case_preserved() -> None:
    parsed = parse_vessel_details(_body(_one()), retrieved_at=NOW)
    assert parsed.records[0].call_sign == "OJIH"


@pytest.mark.parametrize("kind", [None, "", "  ", "real", "Fake", "unknown"])
def test_the_call_sign_type_is_compared_case_folded_and_a_missing_type_refuses(
    kind: str | None,
) -> None:
    record = _one() | {"radioCallSign": "OJIH", "radioCallSignType": kind}
    parsed = parse_vessel_details(_body(record), retrieved_at=NOW)
    expected = "OJIH" if (kind or "").strip().upper() == "REAL" else None
    assert parsed.records[0].call_sign == expected


def test_a_missing_call_sign_is_none_without_consulting_the_type() -> None:
    record = _one() | {"radioCallSign": " ", "radioCallSignType": "REAL"}
    parsed = parse_vessel_details(_body(record), retrieved_at=NOW)
    assert parsed.records[0].call_sign is None


# ---------------------------------------------------------------- the zero sentinel


def test_a_zero_dimension_is_not_a_measurement() -> None:
    record = _one()
    record["vesselDimensions"] |= {
        "overallLength": 0.0,
        "length": 0.0,
        "breadth": 0.0,
        "draught": 0.0,
        "grossTonnage": 0,
        "netTonnage": 0,
        "deathWeight": 0,
    }
    mapped = parse_vessel_details(_body(record), retrieved_at=NOW).records[0]
    assert mapped.length_m is None
    assert mapped.beam_m is None
    assert mapped.draught_m is None
    assert mapped.gross_tonnage is None
    assert mapped.net_tonnage is None
    assert mapped.deadweight_t is None


def test_a_null_dimension_reads_the_same_way_as_a_zero_one() -> None:
    """Zero and null in one object, meaning the same thing. ``maxSpeed`` is null on all 17."""
    record = _one()
    record["vesselDimensions"] |= {
        "overallLength": None,
        "length": None,
        "breadth": None,
        "draught": None,
        "grossTonnage": None,
    }
    mapped = parse_vessel_details(_body(record), retrieved_at=NOW).records[0]
    assert mapped.length_m is None
    assert mapped.beam_m is None
    assert mapped.gross_tonnage is None


def test_the_real_dimensions_are_metres_here_and_not_decimetres() -> None:
    """``draught`` is 8.15 metres here and 49 decimetres on ``/api/ais/v1/vessels``."""
    mapped = parse_vessel_details(_body(_one()), retrieved_at=NOW).records[0]
    assert mapped.draught_m == 8.15
    assert mapped.beam_m == 21.6
    assert mapped.gross_tonnage == 10098
    assert mapped.net_tonnage == 4642
    assert mapped.deadweight_t == 13340


def test_overall_length_leads_and_length_is_the_fallback() -> None:
    """``overallLength`` is the figure a berth cares about and it is absent more often."""
    record = _one()
    assert record["vesselDimensions"]["overallLength"] == 137.1
    assert parse_vessel_details(_body(record), retrieved_at=NOW).records[0].length_m == 137.1

    record["vesselDimensions"]["overallLength"] = 0.0
    fallback = parse_vessel_details(_body(record), retrieved_at=NOW).records[0]
    assert fallback.length_m == 130.05


def test_a_dimension_over_the_contract_bound_loses_the_record_and_is_counted() -> None:
    """A bound rather than a limit: it is here to catch a unit change."""
    record = _one()
    record["vesselDimensions"]["breadth"] = 500.0
    parsed = parse_vessel_details(_body(record), retrieved_at=NOW)
    assert not parsed.records
    assert parsed.drops == {"failed the vessel registration contract": 1}


# ---------------------------------------------------------------- the rest of the mapping


def test_the_vessel_type_code_is_portnets_vocabulary_and_never_the_ais_one() -> None:
    """Code 50 is a container ship here and a pilot vessel in AIS ship-type coding."""
    record = _one()
    record["vesselConstruction"] |= {"vesselTypeCode": 50, "vesselTypeName": "Container ship"}
    mapped = parse_vessel_details(_body(record), retrieved_at=NOW).records[0]
    assert mapped.vessel_type_code == 50
    assert mapped.vessel_type_name == "Container ship"
    assert not hasattr(mapped, "ship_type")


def test_a_zero_vessel_type_code_reads_as_absent() -> None:
    record = _one()
    record["vesselConstruction"]["vesselTypeCode"] = 0
    mapped = parse_vessel_details(_body(record), retrieved_at=NOW).records[0]
    assert mapped.vessel_type_code is None


def test_the_flag_is_upper_cased_to_an_iso_alpha_two() -> None:
    record = _one()
    record["vesselRegistration"]["nationality"] = "fi"
    mapped = parse_vessel_details(_body(record), retrieved_at=NOW).records[0]
    assert mapped.flag_iso == "FI"


def test_a_missing_flag_is_none_rather_than_a_default() -> None:
    record = _one()
    record["vesselRegistration"]["nationality"] = " "
    mapped = parse_vessel_details(_body(record), retrieved_at=NOW).records[0]
    assert mapped.flag_iso is None


def test_a_flag_that_is_not_two_letters_loses_the_record_and_is_counted() -> None:
    record = _one()
    record["vesselRegistration"]["nationality"] = "F1"
    parsed = parse_vessel_details(_body(record), retrieved_at=NOW)
    assert not parsed.records
    assert parsed.drops == {"failed the vessel registration contract": 1}


def test_the_port_of_registry_is_free_text_and_is_never_parsed() -> None:
    """One live record carries ``9147605``, which is that vessel's own IMO in the wrong
    column. Kept verbatim as text so nothing joins on it."""
    record = _one()
    record["vesselRegistration"]["portOfRegistry"] = "9147605"
    mapped = parse_vessel_details(_body(record), retrieved_at=NOW).records[0]
    assert mapped.port_of_registry == "9147605"
    assert mapped.imo == 9173692


@pytest.mark.parametrize("raw", [None, 0, 999_999, 10_000_000, 1_095_363])
def test_an_imo_outside_seven_digits_reads_as_absent(raw: int | None) -> None:
    """``1095363`` is a real live value: seven digits, and not an IMO number.

    There is no check-digit test here, so it is carried as an unvalidated identifier that
    passes the range test. Anything outside the range is dropped to ``None``.
    """
    record = _one() | {"imoLloyds": raw}
    mapped = parse_vessel_details(_body(record), retrieved_at=NOW).records[0]
    assert mapped.imo == (raw if raw == 1_095_363 else None)


def test_a_record_with_no_update_timestamp_is_dropped_and_counted() -> None:
    """ADR 008 drops an undated attribute rather than asserting it."""
    record = _one() | {"updateTimestamp": None}
    parsed = parse_vessel_details(_body(record), retrieved_at=NOW)
    assert not parsed.records
    assert parsed.drops == {"no updateTimestamp, so the registry facts carry no date": 1}


def test_the_update_timestamp_arrives_aware_so_nothing_attaches_utc() -> None:
    """Unusual for a registry, and worth saying: the FAA and CASA bulk files are naive."""
    mapped = parse_vessel_details(_body(_one()), retrieved_at=NOW).records[0]
    assert mapped.updated_at == datetime(2026, 8, 3, 5, 16, 4, tzinfo=UTC)
    assert mapped.retrieved_at == NOW
    assert mapped.updated_at != mapped.retrieved_at


def test_the_register_that_holds_the_record_comes_off_the_payload(payload: bytes) -> None:
    parsed = parse_vessel_details(payload, retrieved_at=NOW)
    assert {record.registry for record in parsed.records} == {"Portnet"}
    assert {record.source for record in parsed.records} == {SOURCE_NAME}


def test_a_missing_data_source_falls_back_to_the_source_name() -> None:
    record = _one() | {"dataSource": " "}
    mapped = parse_vessel_details(_body(record), retrieved_at=NOW).records[0]
    assert mapped.registry == SOURCE_NAME


def test_a_record_with_every_sub_object_absent_still_maps() -> None:
    """A registry entry with nothing but an MMSI and a date is still an ownership claim."""
    record = {
        "mmsi": int(TALI_MMSI),
        "updateTimestamp": "2026-08-03T05:16:04.000Z",
        "dataSource": "Portnet",
    }
    mapped = parse_vessel_details(_body(record), retrieved_at=NOW).records[0]
    assert mapped.mmsi == TALI_MMSI
    assert mapped.owner is None
    assert mapped.flag_iso is None
    assert mapped.length_m is None
    assert mapped.vessel_type_code is None


def test_an_unknown_upstream_key_is_ignored_rather_than_failing_the_wire_layer() -> None:
    """Permissive at the wire layer, strict at the domain layer."""
    record = _one() | {"somethingNew": {"nested": [1, 2, 3]}}
    parsed = parse_vessel_details(_body(record), retrieved_at=NOW)
    assert parsed.records[0].mmsi == TALI_MMSI


def test_one_malformed_record_costs_one_vessel_and_never_the_answer() -> None:
    """8 of 17 records have no MMSI and would take the other 9 with them."""
    parsed = parse_vessel_details(_body("not an object", _one()), retrieved_at=NOW)
    assert len(parsed.records) == 1
    assert parsed.drops == {"record does not match the shape this endpoint sends": 1}


def test_a_body_that_is_not_an_array_is_a_contract_violation() -> None:
    with pytest.raises(ContractViolationError):
        parse_vessel_details(b'{"vessels": []}', retrieved_at=NOW)


def test_an_empty_array_is_a_clean_miss_and_not_a_failure() -> None:
    parsed = parse_vessel_details(b"[]", retrieved_at=NOW)
    assert not parsed.records
    assert not parsed.drops


def test_the_licence_constants_are_re_exported_from_the_position_adapter() -> None:
    """Both adapters on this host owe the same attribution, and it belongs to the provider
    rather than to an endpoint."""
    assert LICENCE == "CC BY 4.0"
    assert "digitraffic" in ATTRIBUTION
    assert SOURCE_NAME == "digitraffic-port-call"


# ---------------------------------------------------------------- the lookup


def _route(router: respx.Router, mmsi: str, body: bytes, status: int = 200) -> None:
    router.get(DETAILS_URL, params={"mmsi": mmsi}).respond(status, content=body)


@respx.mock(assert_all_called=True)
async def test_a_lookup_asks_for_one_mmsi_and_sends_the_gzip_header(
    respx_mock: respx.Router, lookup: FintrafficRegistryLookup
) -> None:
    """``Accept-Encoding: gzip`` is mandatory on this host and the failure is a 406."""
    _route(respx_mock, TALI_MMSI, _body(_one()))
    found = await lookup.vessel(TALI_MMSI)

    assert found is not None
    assert found.mmsi == TALI_MMSI
    assert found.owner == "ESL Shipping Oy"
    request = respx_mock.calls[-1].request
    assert request.headers["Accept-Encoding"] == "gzip"
    assert request.url.params["mmsi"] == TALI_MMSI
    assert DIGITRAFFIC_USER_HEADER not in request.headers


@respx.mock(assert_all_called=True)
async def test_a_digitraffic_user_is_sent_when_one_is_configured(
    respx_mock: respx.Router, http: httpx.AsyncClient, clock: Clock
) -> None:
    _route(respx_mock, TALI_MMSI, _body(_one()))
    lookup = FintrafficRegistryLookup(http, digitraffic_user="  tracker-demo  ", clock=clock)
    await lookup.vessel(TALI_MMSI)
    assert respx_mock.calls[-1].request.headers[DIGITRAFFIC_USER_HEADER] == "tracker-demo"


@respx.mock(assert_all_called=True)
async def test_a_base_url_with_a_trailing_slash_does_not_double_it(
    respx_mock: respx.Router, http: httpx.AsyncClient, clock: Clock
) -> None:
    _route(respx_mock, TALI_MMSI, _body(_one()))
    lookup = FintrafficRegistryLookup(http, base_url=f"{BASE_URL}/", clock=clock)
    await lookup.vessel(TALI_MMSI)
    assert str(respx_mock.calls[-1].request.url).startswith(DETAILS_URL)


@respx.mock(assert_all_called=True)
async def test_a_second_lookup_inside_the_ttl_is_answered_from_cache(
    respx_mock: respx.Router, lookup: FintrafficRegistryLookup, clock: Clock
) -> None:
    _route(respx_mock, TALI_MMSI, _body(_one()))
    first = await lookup.vessel(TALI_MMSI)
    clock.advance(DEFAULT_CACHE_TTL_SECONDS - 1)
    second = await lookup.vessel(TALI_MMSI)

    assert first == second
    assert len(respx_mock.calls) == 1


@respx.mock(assert_all_called=True)
async def test_a_lookup_past_the_ttl_asks_again(
    respx_mock: respx.Router, lookup: FintrafficRegistryLookup, clock: Clock
) -> None:
    """The registry moves in months, so a day is the TTL. Past it, we ask."""
    _route(respx_mock, TALI_MMSI, _body(_one()))
    await lookup.vessel(TALI_MMSI)
    clock.advance(DEFAULT_CACHE_TTL_SECONDS)
    await lookup.vessel(TALI_MMSI)
    assert len(respx_mock.calls) == 2


@respx.mock(assert_all_called=True)
async def test_a_miss_is_an_empty_array_and_is_cached_like_a_hit(
    respx_mock: respx.Router, lookup: FintrafficRegistryLookup
) -> None:
    """Portnet covers vessels calling at Finnish ports and nothing else, so a miss is the
    normal case and re-asking for every card open would spend the budget on nothing."""
    _route(respx_mock, TALI_MMSI, b"[]")
    assert await lookup.vessel(TALI_MMSI) is None
    assert await lookup.vessel(TALI_MMSI) is None
    assert len(respx_mock.calls) == 1


@respx.mock(assert_all_called=True)
async def test_a_failed_lookup_is_never_cached(
    respx_mock: respx.Router, lookup: FintrafficRegistryLookup
) -> None:
    """ "We asked and got nothing" and "we could not ask" have to stay distinguishable."""
    respx_mock.get(DETAILS_URL, params={"mmsi": TALI_MMSI}).mock(
        side_effect=[httpx.Response(500), httpx.Response(200, content=_body(_one()))]
    )
    with pytest.raises(httpx.HTTPStatusError):
        await lookup.vessel(TALI_MMSI)
    found = await lookup.vessel(TALI_MMSI)
    assert found is not None
    assert len(respx_mock.calls) == 2


@respx.mock(assert_all_called=True)
async def test_a_406_names_the_only_thing_it_can_mean(
    respx_mock: respx.Router, lookup: FintrafficRegistryLookup
) -> None:
    _route(respx_mock, TALI_MMSI, b"gzip encoding is required", status=406)
    with pytest.raises(SourceError, match="HTTP 406"):
        await lookup.vessel(TALI_MMSI)


@pytest.mark.parametrize("status", [429, 420])
@respx.mock(assert_all_called=True)
async def test_a_throttle_from_the_provider_is_raised_with_its_own_retry_after(
    respx_mock: respx.Router, lookup: FintrafficRegistryLookup, status: int
) -> None:
    respx_mock.get(DETAILS_URL, params={"mmsi": TALI_MMSI}).respond(
        status, headers={"Retry-After": "45"}, content=b""
    )
    with pytest.raises(RateLimitedError) as caught:
        await lookup.vessel(TALI_MMSI)
    assert caught.value.retry_after_seconds == 45.0


async def test_our_own_budget_is_spent_before_the_network_is_touched(
    lookup: FintrafficRegistryLookup, no_network: respx.MockRouter, clock: Clock
) -> None:
    """A third of the provider's cap, because the cap is per IP and the position poller is
    on the same one. A 429 earned here would land on the layer people are looking at."""
    route = no_network.get(DETAILS_URL).respond(200, content=b"[]")
    for index in range(MAX_REQUESTS_PER_MINUTE):
        await lookup.vessel(f"2309160{index:02d}")
        clock.advance(1.0)

    assert route.call_count == MAX_REQUESTS_PER_MINUTE
    with pytest.raises(RateLimitedError) as caught:
        await lookup.vessel("230999999")
    assert caught.value.retry_after_seconds == RATE_WINDOW_SECONDS
    assert route.call_count == MAX_REQUESTS_PER_MINUTE


async def test_the_budget_window_slides_rather_than_resetting(
    lookup: FintrafficRegistryLookup, no_network: respx.MockRouter, clock: Clock
) -> None:
    route = no_network.get(DETAILS_URL).respond(200, content=b"[]")
    for index in range(MAX_REQUESTS_PER_MINUTE):
        await lookup.vessel(f"2309160{index:02d}")

    clock.advance(RATE_WINDOW_SECONDS + 1)
    await lookup.vessel("230999999")
    assert route.call_count == MAX_REQUESTS_PER_MINUTE + 1


# ---------------------------------------------------------------- refusing to guess


@respx.mock(assert_all_called=True)
async def test_two_vessels_on_one_mmsi_are_refused_rather_than_guessed_between(
    respx_mock: respx.Router, lookup: FintrafficRegistryLookup
) -> None:
    """An identity we cannot establish is not asserted."""
    other = _one() | {"name": "Other", "vesselId": 9999}
    _route(respx_mock, TALI_MMSI, _body(_one(), other))
    assert await lookup.vessel(TALI_MMSI) is None
    assert lookup.drops == {"one MMSI answered with more than one vessel": 2}


@respx.mock(assert_all_called=True)
async def test_an_answer_for_a_different_mmsi_is_refused_and_counted(
    respx_mock: respx.Router, lookup: FintrafficRegistryLookup
) -> None:
    """This endpoint's filter failing is not theoretical: ``bbox`` is accepted and silently
    ignored on the AIS endpoint of the same host, and ``?mmsi=0`` returns ships."""
    _route(respx_mock, TALI_MMSI, _body(_one("230961000")))
    assert await lookup.vessel(TALI_MMSI) is None
    assert lookup.drops == {"answer is for a different MMSI than the one requested": 1}


@respx.mock(assert_all_called=True)
async def test_the_parse_drops_are_carried_onto_the_cumulative_count(
    respx_mock: respx.Router, lookup: FintrafficRegistryLookup, payload: bytes
) -> None:
    """Dropped and counted has to mean counted where a person can read it, and one
    ``ParsedRecords`` describes one answer that its caller throws away."""
    _route(respx_mock, TALI_MMSI, payload)
    assert await lookup.vessel(TALI_MMSI) is None
    assert lookup.drops["registry record carries no MMSI, so it cannot join to a live vessel"] == (
        NO_MMSI_COUNT
    )
    assert lookup.drops["one MMSI answered with more than one vessel"] == MAPPED_COUNT


def test_the_drop_counter_is_a_copy_so_a_reader_cannot_reset_it(
    lookup: FintrafficRegistryLookup,
) -> None:
    counter = lookup.drops
    counter["invented"] += 1
    assert "invented" not in lookup.drops


def test_the_provider_name_travels_on_the_lookup(lookup: FintrafficRegistryLookup) -> None:
    assert lookup.name == SOURCE_NAME


# ---------------------------------------------------------------- the removal hook


@respx.mock(assert_all_called=True)
async def test_forget_empties_the_cache_for_one_vessel(
    respx_mock: respx.Router, lookup: FintrafficRegistryLookup
) -> None:
    """ADR 008 removal: ``owner`` on a privately registered vessel is a named individual,
    and the TTL is a day, so a removal that could not reach this cache would report success
    while the deleted name kept being served."""
    respx_mock.get(DETAILS_URL, params={"mmsi": TALI_MMSI}).mock(
        side_effect=[
            httpx.Response(200, content=_body(_one())),
            httpx.Response(200, content=_body(_one())),
        ]
    )
    await lookup.vessel(TALI_MMSI)
    assert lookup.forget(TALI_MMSI) == 1
    await lookup.vessel(TALI_MMSI)
    assert len(respx_mock.calls) == 2


def test_forget_reports_zero_when_nothing_was_held(
    lookup: FintrafficRegistryLookup,
) -> None:
    assert lookup.forget(TALI_MMSI) == 0


def test_forget_aimed_at_junk_is_loud_rather_than_a_silent_success(
    lookup: FintrafficRegistryLookup,
) -> None:
    with pytest.raises(ValueError, match="MMSI"):
        lookup.forget(PLACEHOLDER_MMSI)


@respx.mock(assert_all_called=True)
async def test_no_owner_name_survives_in_the_cache_after_a_forget(
    respx_mock: respx.Router, lookup: FintrafficRegistryLookup
) -> None:
    """The consequence asserted rather than the intent."""
    _route(respx_mock, TALI_MMSI, _body(_one()))
    found = await lookup.vessel(TALI_MMSI)
    assert found is not None
    assert found.owner == "ESL Shipping Oy"

    lookup.forget(TALI_MMSI)
    assert "ESL Shipping Oy" not in repr(vars(lookup))


# ---------------------------------------------------------------- the default clock


@respx.mock(assert_all_called=True)
async def test_the_default_clock_is_the_wall_clock(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """Nothing here injects a clock in the product, so the default has to work."""
    _route(respx_mock, TALI_MMSI, _body(_one()))
    lookup = FintrafficRegistryLookup(http)
    found = await lookup.vessel(TALI_MMSI)
    assert found is not None
    assert found.retrieved_at <= datetime.now(UTC)


def test_the_registration_contract_is_frozen_and_forbids_extra_fields() -> None:
    record = VesselRegistration(
        mmsi=TALI_MMSI,
        registry="Portnet",
        updated_at=NOW,
        retrieved_at=NOW,
    )
    with pytest.raises(ValueError, match="frozen"):
        record.mmsi = "230961000"  # type: ignore[misc]  # ty: ignore[invalid-assignment]
    with pytest.raises(ValueError, match="Extra inputs"):
        VesselRegistration(
            mmsi=TALI_MMSI,
            registry="Portnet",
            updated_at=NOW,
            retrieved_at=NOW,
            telephone="0400-142311",  # type: ignore[call-arg]  # ty: ignore[unknown-argument]
        )
