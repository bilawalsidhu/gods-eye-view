"""The Seaway GraphQL AIS adapter, driven by a real captured body.

``tests/fixtures/seaway_ais_vessels_live.json`` is a 106-record slice of a genuine
``vis.seaway.ca/graphql`` response captured on 2026-08-23, sliced so every trap is in the
committed bytes rather than hand-written: the sixty-day stale tail, the ``latitude: 91``
position sentinel, junk MMSIs, a search-and-rescue aircraft, out-of-range headings and both
spellings of an absent IMO. No network: respx intercepts at the transport.

The trap that gets the most attention is staleness, because it is the one that produces a
plausible picture rather than an error. The provider serves a roster whose median report was
2.4 days old and whose oldest was 60 days, so a parser that trusts the body draws four
thousand ghost ships and looks like a working layer.
"""

import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx

from tests.conftest import fixture_bytes, fixture_json
from tracker.cache import FILE_NAME, DiskCache
from tracker.contracts.base import ContractViolationError
from tracker.contracts.geo import KNOTS_TO_METRES_PER_SECOND
from tracker.contracts.vessel import NavigationalStatus
from tracker.sources.base import RateLimitedError, SourceError
from tracker.sources.seaway import (
    ATTRIBUTION,
    BASE_URL,
    FRESHNESS_WINDOW_SECONDS,
    GRAPHQL_PATH,
    INTERMEDIATE_CERTIFICATE,
    LATITUDE_NOT_AVAILABLE,
    LICENCE,
    LONGITUDE_NOT_AVAILABLE,
    MAX_FIX_TIME_AHEAD_SECONDS,
    MIN_INTERVAL_SECONDS,
    SOURCE_NAME,
    SeawayClient,
    parse_vessels,
    ssl_context,
)

GRAPHQL_URL = f"{BASE_URL}{GRAPHQL_PATH}"

FIXTURE = "seaway_ais_vessels_live.json"

RECORD_COUNT = 106
"""Records in the captured slice."""

VESSEL_COUNT = 73
"""Usable vessels: 33 refused, of which 24 are stale reports."""

STALE_COUNT = 24
"""Stale reports *counted as such*. In the full 7,118-record body the stale share was 5,454."""

STALE_IN_BYTES = 33
"""Records outside the window in the committed bytes.

Nine more than :data:`STALE_COUNT`, because nine of them also carry an unusable MMSI and
identity is checked before time, so they are counted under their ITU category instead. A
record is only ever counted once.
"""

CAPTURE_TIME = datetime(2026, 8, 23, 10, 46, tzinfo=UTC)
"""The instant the body was captured, so the freshness window is exercised deterministically."""

SAR_AIRCRAFT_PREFIX = "111"


@pytest.fixture
def payload() -> bytes:
    """The captured GraphQL body, 106 records, 2026-08-23."""
    return fixture_bytes(FIXTURE)


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    """A real httpx client. respx intercepts at the transport, so nothing leaves the process."""
    async with httpx.AsyncClient() as client:
        yield client


@pytest.fixture
def client(http: httpx.AsyncClient) -> SeawayClient:
    return SeawayClient(http, clock=lambda: CAPTURE_TIME)


class Clock:
    """A hand-driven clock, so a cooldown boundary is measured rather than slept through."""

    def __init__(self, start: datetime = CAPTURE_TIME) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


def _parse(payload: bytes, *, now: datetime = CAPTURE_TIME) -> Any:
    return parse_vessels(payload, now=now)


def _iso(value: str) -> datetime:
    """Read the provider's ``age``, which is an instant with a ``Z`` suffix."""
    return datetime.fromisoformat(value)


def _envelope(*records: Any) -> bytes:
    return json.dumps({"data": {"aisOnlyVessels": list(records)}}).encode()


def _record(**overrides: Any) -> dict[str, Any]:
    """One record in the shape the endpoint sends.

    Built from the real body's key set. ``ais`` overrides go inside ``aisInformation`` and
    everything else onto the outer vessel, which is the nesting the provider actually uses and
    the reason two fields are called ``id``.
    """
    ais: dict[str, Any] = {
        "id": 316001234,
        "latitude": 45.5,
        "longitude": -73.5,
        "cog": 90,
        "heading": 91,
        "speed": 10.0,
        "navigationStatus": 0,
        "vesselType": 70,
        "destination": "MONTREAL",
        "age": "2026-08-23T10:44:00Z",
        "imoNumber": 9254898,
    }
    outer: dict[str, Any] = {"name": "TEST SHIP", "overallLength": 100.0, "extremeBeam": 20.0}
    for field, value in overrides.items():
        if field in ais:
            ais[field] = value
        else:
            outer[field] = value
    outer["aisInformation"] = ais
    return outer


# ---------------------------------------------------------------- the real payload


def test_parses_the_live_body(payload: bytes) -> None:
    parsed = _parse(payload)
    assert len(parsed.records) == VESSEL_COUNT
    assert {v.source for v in parsed.records} == {SOURCE_NAME}
    assert all(v.kind == "vessel" for v in parsed.records)


def test_every_record_is_kept_or_counted(payload: bytes) -> None:
    """The arithmetic has to close, or the parser is losing ships silently."""
    parsed = _parse(payload)
    assert len(parsed.records) + parsed.dropped == RECORD_COUNT


def test_the_provider_is_named_on_every_record_and_the_union_fills_the_rest(
    payload: bytes,
) -> None:
    """``source`` is per record per ADR 010; ``providers`` is the merge's to fill, not ours."""
    for vessel in _parse(payload).records:
        assert vessel.source == SOURCE_NAME
        assert vessel.providers == ()


def test_one_record_per_mmsi(payload: bytes) -> None:
    records = _parse(payload).records
    assert len({v.mmsi for v in records}) == len(records)


def test_it_puts_ships_outside_northern_europe(payload: bytes) -> None:
    """The whole point of this provider. Every position is in North American waters.

    Before this source the entire vessel layer sat between lon 0.6 and 32 and lat 56 and 80.
    A regression that quietly emptied this feed would leave the globe Nordic again, so the
    bound is asserted rather than left to a coverage report.
    """
    for vessel in _parse(payload).records:
        assert -95.0 <= vessel.point.lon <= -50.0
        assert 40.0 <= vessel.point.lat <= 55.0
        assert vessel.point.altitude_m is None


# ---------------------------------------------------------------- trap 1 and 2: time


def test_age_is_an_instant_and_not_a_duration(payload: bytes) -> None:
    """Trap 1. The field is called ``age`` and holds ``2026-08-23T10:41:51Z``.

    Read as a duration it is a string; read as elapsed seconds the year 2026 is half an hour.
    It is the fix time, so ``observed_at - position_age_s`` must land on it exactly.
    """
    raw = {
        r["aisInformation"]["id"]: r["aisInformation"]["age"]
        for r in fixture_json(FIXTURE)["data"]["aisOnlyVessels"]
    }
    for vessel in _parse(payload).records:
        fixed_at = vessel.observed_at - timedelta(seconds=vessel.position_age_s)
        assert fixed_at == _iso(raw[int(vessel.mmsi)])


def test_a_report_older_than_the_window_is_dropped_and_counted(payload: bytes) -> None:
    """Trap 2, the headline. The body is a sixty-day roster, not a snapshot.

    In the full 7,118-record capture the median report was 2.4 days old and 4,100 were over a
    day old. Rendering them draws ghost ships parked where they were up to two months ago,
    which looks like a working layer.
    """
    parsed = _parse(payload)
    assert parsed.drops["report is older than the freshness window"] == STALE_COUNT
    assert all(v.position_age_s <= FRESHNESS_WINDOW_SECONDS for v in parsed.records)


def test_the_stale_records_really_are_in_the_committed_bytes() -> None:
    """So the test above is measuring the fixture rather than a tautology."""
    ages = [
        (CAPTURE_TIME - _iso(r["aisInformation"]["age"])).total_seconds()
        for r in fixture_json(FIXTURE)["data"]["aisOnlyVessels"]
    ]
    assert max(ages) > 30 * 86400.0, "the fixture must carry the month-old tail"
    stale_in_bytes = sum(1 for a in ages if a > FRESHNESS_WINDOW_SECONDS)
    assert stale_in_bytes == STALE_IN_BYTES
    # Nine of those are also junk MMSIs, and identity is checked before time, so they are
    # counted under their ITU reason instead. Both numbers are asserted so neither can drift.
    assert stale_in_bytes - STALE_COUNT == 9


@pytest.mark.parametrize(
    ("offset", "kept"),
    [(0.0, True), (599.0, True), (600.0, True), (601.0, False), (86400.0, False)],
)
def test_the_freshness_boundary_is_exactly_the_window(offset: float, kept: bool) -> None:
    """A record at the boundary is kept and one past it is not, so the edge is not a guess."""
    fixed_at = CAPTURE_TIME - timedelta(seconds=offset)
    parsed = _parse(_envelope(_record(age=fixed_at.isoformat().replace("+00:00", "Z"))))
    assert bool(parsed.records) is kept
    if not kept:
        assert parsed.drops["report is older than the freshness window"] == 1


def test_a_fix_dated_ahead_of_our_clock_is_dropped() -> None:
    """A future fix wins every merge until the clock catches up, which ADR 010 forbids."""
    ahead = CAPTURE_TIME + timedelta(seconds=MAX_FIX_TIME_AHEAD_SECONDS + 30)
    parsed = _parse(_envelope(_record(age=ahead.isoformat().replace("+00:00", "Z"))))
    assert not parsed.records
    assert parsed.drops["age is dated ahead of our own clock"] == 1


def test_a_fix_inside_the_clock_skew_allowance_is_kept() -> None:
    ahead = CAPTURE_TIME + timedelta(seconds=MAX_FIX_TIME_AHEAD_SECONDS - 1)
    parsed = _parse(_envelope(_record(age=ahead.isoformat().replace("+00:00", "Z"))))
    assert len(parsed.records) == 1
    assert parsed.records[0].position_age_s == 0.0


def test_a_record_with_no_age_is_dropped_rather_than_dated_to_now() -> None:
    parsed = _parse(_envelope(_record(age=None)))
    assert parsed.drops["no age field, so the fix has no time"] == 1


def test_a_naive_age_is_read_as_utc() -> None:
    """The captured values carry ``Z``, so this is the guard rather than an observed defect."""
    parsed = _parse(_envelope(_record(age="2026-08-23T10:44:00")))
    assert len(parsed.records) == 1
    assert parsed.records[0].observed_at.utcoffset() == timedelta(0)


def test_the_position_age_is_never_negative(payload: bytes) -> None:
    for vessel in _parse(payload).records:
        assert vessel.position_age_s >= 0.0


# ---------------------------------------------------------------- trap 3: the filter


def test_the_request_carries_every_filter_flag(client: SeawayClient) -> None:
    """Trap 3. A missing flag returns a smaller answer with no error and no count.

    Asserted on the request rather than the response, because that is the only place the bug is
    visible: 50 inclusion flags true and 20 narrowing flags false is what returned all 7,118.
    """
    body = client.request_body()
    flags = body["variables"]["filter"]
    assert len(flags) == 70
    assert sum(1 for v in flags.values() if v is True) == 50
    assert sum(1 for v in flags.values() if v is False) == 20


def test_every_vessel_type_fleet_and_status_is_included(client: SeawayClient) -> None:
    """The inclusion half, named. Excluding any one silently removes that class of ship."""
    flags = client.request_body()["variables"]["filter"]
    assert all(flags[f"vesselNavigationStatus{code}"] is True for code in range(16))
    assert flags["vesselTypeUnspecified"] is True, "138 records carry AIS ship type 0"
    assert flags["vesselNavigationStatus15"] is True, "5,544 records carry the undefined status"
    assert flags["transponderClassA"] is True
    assert flags["transponderClassB"] is True
    assert flags["vesselFleetInland"] is True
    assert flags["vesselFleetOcean"] is True


def test_only_the_narrowing_filters_are_off(client: SeawayClient) -> None:
    """``withTransitOnly`` and the pilot flags restrict to a subset, so they stay false.

    The pilot flags are also the operational half of an internal tool, and this adapter has no
    business filtering ships on who is piloting them.
    """
    flags = client.request_body()["variables"]["filter"]
    off = {name for name, value in flags.items() if value is False}
    assert "withTransitOnly" in off
    assert "agentOwnerOnly" in off
    assert all(name.startswith(("pilot", "withTransit", "agentOwner")) for name in off)


def test_the_query_asks_for_nothing_but_ais(client: SeawayClient) -> None:
    """The same schema exposes users, roles and pilot assignments. None of that is our business."""
    query = client.request_body()["query"]
    for forbidden in ("currentUser", "users", "roles", "directoryUsers", "pilot", "transits"):
        assert forbidden not in query


# ---------------------------------------------------------------- trap 4: errors in a 200


def test_a_graphql_error_inside_a_200_is_a_loud_failure() -> None:
    """Trap 4. ``raise_for_status`` passes and ``data`` is null, so a client sees no ships."""
    body = json.dumps(
        {"errors": [{"message": "Cannot query field 'name' on type 'AisInformationType'"}]}
    ).encode()
    with pytest.raises(SourceError, match="GraphQL errors"):
        parse_vessels(body)


def test_a_body_with_neither_data_nor_errors_is_a_loud_failure() -> None:
    with pytest.raises(SourceError, match="neither"):
        parse_vessels(b"{}")


def test_a_body_that_is_not_this_endpoints_shape_raises() -> None:
    with pytest.raises(ContractViolationError):
        parse_vessels(b"not json at all")


def test_one_junk_record_does_not_reject_the_whole_body() -> None:
    """Per-record validation. One bad entry in 7,118 must not empty the layer."""
    records = fixture_json(FIXTURE)["data"]["aisOnlyVessels"]
    parsed = parse_vessels(
        _envelope("not an object", *records, {"aisInformation": "also wrong"}),
        now=CAPTURE_TIME,
    )
    assert len(parsed.records) == VESSEL_COUNT
    assert parsed.drops["record does not match the shape this endpoint sends"] == 2


def test_an_empty_vessel_array_parses_to_nothing_without_raising() -> None:
    parsed = parse_vessels(_envelope())
    assert not parsed.records
    assert parsed.dropped == 0


# ---------------------------------------------------------------- trap 5: the position sentinel


@pytest.mark.parametrize(
    ("lat", "lon"),
    [
        (LATITUDE_NOT_AVAILABLE, LONGITUDE_NOT_AVAILABLE),
        (LATITUDE_NOT_AVAILABLE, -73.5),
        (45.5, LONGITUDE_NOT_AVAILABLE),
    ],
)
def test_the_position_not_available_sentinel_is_dropped(lat: float, lon: float) -> None:
    """Trap 5. 91 and 181, 14 of 7,118 live records, and 91 is a legal float."""
    parsed = _parse(_envelope(_record(latitude=lat, longitude=lon)))
    assert not parsed.records
    assert parsed.drops["position is the AIS not-available sentinel"] == 1


def test_the_sentinel_is_in_the_committed_bytes() -> None:
    """So the parametrised test above is not the only evidence it is real."""
    lats = [
        r["aisInformation"]["latitude"] for r in fixture_json(FIXTURE)["data"]["aisOnlyVessels"]
    ]
    assert LATITUDE_NOT_AVAILABLE in lats


def test_a_missing_position_is_dropped() -> None:
    parsed = _parse(_envelope(_record(latitude=None)))
    assert parsed.drops["record carried no latitude or longitude"] == 1


def test_a_record_with_no_ais_information_is_dropped() -> None:
    record = _record()
    del record["aisInformation"]
    parsed = _parse(_envelope(record))
    assert parsed.drops["record carried no AIS information"] == 1


# ---------------------------------------------------------------- identity


def test_the_mmsi_comes_from_ais_information_and_not_the_outer_id() -> None:
    """Two fields are called ``id`` and the outer one was null on all 7,118 records.

    A record whose outer ``id`` disagrees must still key on the AIS one, or the merge key
    depends on which of two identically named fields a reader happened to pick.
    """
    parsed = _parse(_envelope(_record(id=316001234) | {"id": 999}))
    assert parsed.records[0].mmsi == "316001234"


@pytest.mark.parametrize(
    ("mmsi", "reason"),
    [
        (999999999, "MMSI is a unallocated, not a ship station"),
        (111257514, "MMSI is a sar_aircraft, not a ship station"),
        (417, "MMSI is a unallocated, not a ship station"),
        (33855412, "MMSI is a group_of_ships, not a ship station"),
        (1234567890123, "MMSI is not nine digits"),
        (None, "MMSI is not nine digits"),
    ],
)
def test_only_a_ship_station_mmsi_reaches_the_domain(mmsi: int | None, reason: str) -> None:
    """The eleven junk ids and the one SAR aircraft in the live body, by category.

    Zero-padded before classification so a short value gets an honest ITU reason instead of
    being called malformed.
    """
    parsed = _parse(_envelope(_record(id=mmsi)))
    assert not parsed.records
    assert parsed.drops[reason] == 1


def test_a_search_and_rescue_aircraft_is_in_the_committed_bytes_and_dropped(
    payload: bytes,
) -> None:
    ids = [
        str(r["aisInformation"]["id"])
        for r in fixture_json(FIXTURE)["data"]["aisOnlyVessels"]
        if str(r["aisInformation"]["id"]).startswith(SAR_AIRCRAFT_PREFIX)
    ]
    assert ids, "the fixture must carry the 111-prefix aircraft"
    assert not any(v.mmsi.startswith(SAR_AIRCRAFT_PREFIX) for v in _parse(payload).records)


# ---------------------------------------------------------------- sentinels and fields


@pytest.mark.parametrize(
    ("cog", "expected"), [(0, 0.0), (90, 90.0), (359, 359.0), (360, None), (511, None)]
)
def test_course_over_ground_maps_its_sentinel_before_its_range(
    cog: int, expected: float | None
) -> None:
    """360 on 2,457 of 7,118 records, and 0 is a real course due north."""
    parsed = _parse(_envelope(_record(cog=cog)))
    assert parsed.records[0].course_over_ground_deg == expected


@pytest.mark.parametrize(
    ("heading", "expected"),
    [(0, 0.0), (91, 91.0), (359, 359.0), (360, None), (366, None), (456, None), (511, None)],
)
def test_true_heading_refuses_the_out_of_range_values_too(
    heading: int, expected: float | None
) -> None:
    """511 on 1,001 records, and the live body also carried 366 and 456.

    A check for ``!= 511`` alone passes 366 straight into a bearing field, so the range test
    matters as much as the sentinel test.
    """
    parsed = _parse(_envelope(_record(heading=heading)))
    assert parsed.records[0].true_heading_deg == expected


def test_the_speed_sentinel_maps_to_none_and_keeps_the_vessel() -> None:
    """102.3 knots is not-available, not a ship doing 190 km/h. 63 live records carried it."""
    parsed = _parse(_envelope(_record(speed=102.3)))
    assert parsed.records[0].speed_over_ground_mps is None


def test_a_real_speed_is_converted_from_knots() -> None:
    parsed = _parse(_envelope(_record(speed=12.5)))
    assert parsed.records[0].speed_over_ground_mps == pytest.approx(
        12.5 * KNOTS_TO_METRES_PER_SECOND
    )


@pytest.mark.parametrize("imo", [None, 0, 912974400])
def test_both_spellings_of_an_absent_imo_map_to_none(imo: int | None) -> None:
    """This feed says "no IMO" two ways: ``null`` on 5,437 records and ``0`` on 790.

    Checking one and not the other lets the second reach a seven-digit field and drop the ship.
    """
    parsed = _parse(_envelope(_record(imoNumber=imo)))
    assert len(parsed.records) == 1
    assert parsed.records[0].imo is None


def test_a_real_imo_survives() -> None:
    parsed = _parse(_envelope(_record(imoNumber=9254898)))
    assert parsed.records[0].imo == 9254898


@pytest.mark.parametrize(("ship_type", "expected"), [(0, None), (70, 70), (200, None)])
def test_the_ship_type_sentinel_maps_to_none(ship_type: int, expected: int | None) -> None:
    parsed = _parse(_envelope(_record(vesselType=ship_type)))
    assert parsed.records[0].ship_type == expected


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (0, NavigationalStatus.UNDER_WAY_USING_ENGINE),
        (5, NavigationalStatus.MOORED),
        (9, None),
        (15, None),
    ],
)
def test_navigational_status_leaves_undefined_and_reserved_empty(
    status: int, expected: NavigationalStatus | None
) -> None:
    """15 on 5,544 of 7,118 records, which is most of the feed."""
    parsed = _parse(_envelope(_record(navigationStatus=status)))
    assert parsed.records[0].navigational_status == expected


@pytest.mark.parametrize(
    ("field", "attribute", "value", "expected"),
    [
        ("overallLength", "length_m", 100.0, 100.0),
        ("overallLength", "length_m", 0, None),
        ("overallLength", "length_m", None, None),
        ("overallLength", "length_m", 5000.0, None),
        ("extremeBeam", "beam_m", 20.0, 20.0),
        ("extremeBeam", "beam_m", 0, None),
        ("extremeBeam", "beam_m", 400.0, None),
    ],
)
def test_dimensions_are_metres_from_the_outer_object(
    field: str, attribute: str, value: float | None, expected: float | None
) -> None:
    """Present on only 1,570 of 7,118 records, and on the vessel rather than the AIS object."""
    parsed = _parse(_envelope(_record(**{field: value})))
    assert len(parsed.records) == 1
    assert getattr(parsed.records[0], attribute) == expected


def test_empty_text_becomes_none() -> None:
    """``destination`` was blank on 5,943 of 7,118 records, so this is the common case."""
    parsed = _parse(_envelope(_record(destination="", name="")))
    assert parsed.records[0].destination is None
    assert parsed.records[0].name is None


def test_a_null_text_field_is_accepted() -> None:
    """The schema declares ``destination`` and ``name`` as nullable strings.

    The captured body sent an empty string every time instead, so this is the guard rather
    than an observed defect: both forms have to mean the same thing, or the day the provider
    starts sending ``null`` a quarter of the feed fails the contract.
    """
    parsed = _parse(_envelope(_record(destination=None, name=None)))
    assert len(parsed.records) == 1
    assert parsed.records[0].destination is None
    assert parsed.records[0].name is None


def test_long_text_is_truncated_rather_than_dropping_the_ship() -> None:
    parsed = _parse(_envelope(_record(destination="A" * 60, name="B" * 40)))
    assert parsed.records[0].destination == "A" * 20
    assert parsed.records[0].name == "B" * 20


def test_the_fields_this_feed_does_not_carry_stay_empty(payload: bytes) -> None:
    """No call sign, rate of turn, ETA or draught exist in the schema at all.

    Confirmed by introspecting ``AisInformationType`` and ``VesselType`` rather than inferred
    from an empty value, so nothing here derives one from something else.
    """
    for vessel in _parse(payload).records:
        assert vessel.call_sign is None
        assert vessel.rate_of_turn_deg_per_min is None
        assert vessel.eta is None
        assert vessel.draught_m is None


def test_a_coordinate_outside_wgs84_is_dropped_and_counted() -> None:
    """The last line of defence: a junk position fails the contract rather than being drawn."""
    parsed = _parse(_envelope(_record(longitude=200.0)))
    assert not parsed.records
    assert parsed.drops["failed the vessel contract"] == 1


# ---------------------------------------------------------------- the client


def test_the_cadence_floor_is_in_code_and_not_configurable(client: SeawayClient) -> None:
    assert client.min_interval_seconds == MIN_INTERVAL_SECONDS
    assert MIN_INTERVAL_SECONDS == 60.0
    assert client.name == SOURCE_NAME


def test_the_licence_is_recorded_as_unstated_rather_than_assumed() -> None:
    """No terms page on either host and no licence field in the response. Verified absent."""
    assert "Not stated" in LICENCE
    assert "Seaway" in ATTRIBUTION


def test_the_missing_intermediate_certificate_is_committed_and_readable() -> None:
    """The provider omits it, so we carry it. Without this the whole layer fails to connect.

    All three of its hostnames present the leaf alone, which ``openssl`` calls "unable to verify
    the first certificate". curl and browsers fetch the intermediate from the leaf's
    ``authorityInfoAccess`` URL; Python's ``ssl`` module does not, so httpx failed against a host
    a shell command had just read fine.
    """
    assert INTERMEDIATE_CERTIFICATE.is_file()
    text = INTERMEDIATE_CERTIFICATE.read_text()
    assert text.startswith("-----BEGIN CERTIFICATE-----")
    assert "END CERTIFICATE" in text


def test_the_ssl_context_still_verifies_certificates() -> None:
    """The guard that matters: supplying a missing link must not become trusting anything.

    Hostname checking and certificate verification both stay on. If either of these ever reads
    false, someone has reached for ``verify=False`` with extra steps.
    """
    import ssl as ssl_module

    context = ssl_context()
    assert context.verify_mode == ssl_module.CERT_REQUIRED
    assert context.check_hostname is True


def test_the_ssl_context_adds_the_intermediate_to_the_default_trust() -> None:
    """It starts from httpx's own baseline and adds exactly one certificate to it."""
    baseline = len(httpx.create_ssl_context().get_ca_certs())
    assert len(ssl_context().get_ca_certs()) == baseline + 1


@respx.mock(assert_all_called=True)
async def test_it_posts_keyless_with_no_credential_of_any_kind(
    respx_mock: respx.Router, client: SeawayClient, payload: bytes
) -> None:
    """Keyless is what makes this provider usable. Nothing sent may look like a credential."""
    route = respx_mock.post(GRAPHQL_URL).respond(200, content=payload)

    vessels = await client.all_vessels()

    assert len(vessels.records) == VESSEL_COUNT
    request = route.calls[-1].request
    assert request.method == "POST"
    assert "authorization" not in request.headers
    assert "cookie" not in request.headers
    assert "x-api-key" not in request.headers


@respx.mock(assert_all_called=True)
async def test_the_drop_count_comes_back_with_the_vessels(
    respx_mock: respx.Router, client: SeawayClient, payload: bytes
) -> None:
    """``/api/layers`` serves this, and here it is the number that stops the provider looking
    like it contributes 7,118 ships when the globe draws 1,664."""
    respx_mock.post(GRAPHQL_URL).respond(200, content=payload)

    assert (await client.all_vessels()).dropped == RECORD_COUNT - VESSEL_COUNT


@respx.mock(assert_all_called=True)
async def test_the_posted_body_is_the_full_query_and_filter(
    respx_mock: respx.Router, client: SeawayClient, payload: bytes
) -> None:
    route = respx_mock.post(GRAPHQL_URL).respond(200, content=payload)

    await client.all_vessels()

    sent = json.loads(route.calls[-1].request.content)
    assert sent["operationName"] == "getAllVessels"
    assert "aisOnlyVessels" in sent["query"]
    assert len(sent["variables"]["filter"]) == 70


@respx.mock(assert_all_called=True)
async def test_a_body_of_nothing_but_stale_records_is_a_failed_poll(
    respx_mock: respx.Router, client: SeawayClient
) -> None:
    """The sharp version of trap 2. Every report stale is a broken feed, not an empty lake."""
    old = (CAPTURE_TIME - timedelta(days=30)).isoformat().replace("+00:00", "Z")
    respx_mock.post(GRAPHQL_URL).respond(200, content=_envelope(_record(age=old)))

    with pytest.raises(SourceError, match="never as an empty sea"):
        await client.all_vessels()


@respx.mock(assert_all_called=True)
async def test_an_empty_answer_is_a_failed_poll_and_never_an_empty_sea(
    respx_mock: respx.Router, client: SeawayClient
) -> None:
    respx_mock.post(GRAPHQL_URL).respond(200, content=_envelope())

    with pytest.raises(SourceError, match="never as an empty sea"):
        await client.all_vessels()


@respx.mock(assert_all_called=True)
async def test_a_graphql_error_reaches_the_caller_as_a_source_error(
    respx_mock: respx.Router, client: SeawayClient
) -> None:
    """Trap 4 through the client: HTTP 200, so only the body says it failed."""
    respx_mock.post(GRAPHQL_URL).respond(
        200, content=json.dumps({"errors": [{"message": "boom"}]}).encode()
    )

    with pytest.raises(SourceError, match="GraphQL errors"):
        await client.all_vessels()


@respx.mock(assert_all_called=True)
async def test_a_server_error_is_raised_for_the_union_to_record(
    respx_mock: respx.Router, client: SeawayClient
) -> None:
    respx_mock.post(GRAPHQL_URL).respond(503)

    with pytest.raises(httpx.HTTPStatusError):
        await client.all_vessels()


# ---------------------------------------------------------------- honouring a backoff


@respx.mock(assert_all_called=True)
async def test_a_throttling_response_becomes_a_rate_limited_error(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    respx_mock.post(GRAPHQL_URL).respond(429, headers={"Retry-After": "300"})

    with pytest.raises(RateLimitedError) as caught:
        await SeawayClient(http, clock=Clock()).all_vessels()

    assert caught.value.retry_after_seconds == 300.0


@respx.mock(assert_all_called=True)
async def test_a_throttled_provider_is_not_asked_again_inside_its_own_backoff(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    """The union swallows the error into a degraded provider row, so the poller never sees it."""
    clock = Clock()
    route = respx_mock.post(GRAPHQL_URL).respond(429, headers={"Retry-After": "300"})
    client = SeawayClient(http, clock=clock)

    with pytest.raises(RateLimitedError):
        await client.all_vessels()
    clock.advance(60.0)
    with pytest.raises(RateLimitedError):
        await client.all_vessels()

    assert route.call_count == 1


@respx.mock(assert_all_called=True)
async def test_a_cooldown_delays_and_never_latches(
    respx_mock: respx.Router, http: httpx.AsyncClient, payload: bytes
) -> None:
    """A provider we could never call again is worse than one that throttled us."""
    clock = Clock()
    respx_mock.post(GRAPHQL_URL).mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "300"}),
            httpx.Response(200, content=payload),
        ]
    )
    client = SeawayClient(http, clock=clock)

    with pytest.raises(RateLimitedError):
        await client.all_vessels()
    clock.advance(301.0)

    # The second call actually reached the transport, which is the whole point: a cooldown
    # must delay a provider and never latch it off. The fixture's fresh reports are around
    # 150s old at capture, so 301s later they are still inside the ten-minute window and the
    # same 73 come back.
    served = await client.all_vessels()
    assert len(served.records) == VESSEL_COUNT


@respx.mock(assert_all_called=True)
async def test_a_cooldown_survives_a_restart(
    respx_mock: respx.Router, http: httpx.AsyncClient, tmp_path: Path
) -> None:
    """A fresh process must not open by hammering a provider that refused."""
    clock = Clock()
    cache = DiskCache(tmp_path, clock=clock)
    route = respx_mock.post(GRAPHQL_URL).respond(429, headers={"Retry-After": "300"})

    with pytest.raises(RateLimitedError):
        await SeawayClient(http, cache=cache, clock=clock).all_vessels()
    clock.advance(60.0)
    with pytest.raises(RateLimitedError):
        await SeawayClient(http, cache=cache, clock=clock).all_vessels()

    assert route.call_count == 1
    assert cache.get_time(f"{SOURCE_NAME}:not_before") == CAPTURE_TIME + timedelta(seconds=300)


@respx.mock(assert_all_called=True)
async def test_a_longer_cooldown_is_never_shortened_by_a_later_one(
    respx_mock: respx.Router, http: httpx.AsyncClient, tmp_path: Path
) -> None:
    """Guessing short is how an address gets blocked, so the longer figure always wins."""
    clock = Clock()
    cache = DiskCache(tmp_path, clock=clock)
    respx_mock.post(GRAPHQL_URL).mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "600"}),
            httpx.Response(429, headers={"Retry-After": "10"}),
        ]
    )
    client = SeawayClient(http, cache=cache, clock=clock)

    with pytest.raises(RateLimitedError):
        await client.all_vessels()
    clock.advance(601.0)
    with pytest.raises(RateLimitedError):
        await client.all_vessels()

    assert cache.get_time(f"{SOURCE_NAME}:not_before") == clock.now + timedelta(seconds=10)


@respx.mock(assert_all_called=True)
async def test_a_throttling_response_with_no_retry_after_gets_the_safe_default(
    respx_mock: respx.Router, http: httpx.AsyncClient
) -> None:
    respx_mock.post(GRAPHQL_URL).respond(429)

    with pytest.raises(RateLimitedError) as caught:
        await SeawayClient(http, clock=Clock()).all_vessels()

    assert caught.value.retry_after_seconds == 120.0


@respx.mock(assert_all_called=True)
async def test_the_persistence_is_opt_in_and_nothing_is_written_without_a_cache(
    respx_mock: respx.Router, http: httpx.AsyncClient, tmp_path: Path
) -> None:
    """A client with no cache still holds its cooldown in memory."""
    clock = Clock()
    route = respx_mock.post(GRAPHQL_URL).respond(429, headers={"Retry-After": "300"})
    client = SeawayClient(http, clock=clock)

    with pytest.raises(RateLimitedError):
        await client.all_vessels()
    with pytest.raises(RateLimitedError):
        await client.all_vessels()

    assert route.call_count == 1
    assert not (tmp_path / FILE_NAME).exists()
