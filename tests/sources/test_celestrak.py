"""The orbital element adapter: the floor, the cache, the chain, the freshness policy.

No network except the tests marked ``live``, which are deselected by the gate's
``-m "not live"``. Everything else runs against the recorded payloads on disk.

**Most tests here pin the client to one provider on purpose.** ``providers=(CELESTRAK,)``
makes every assertion about the floor, the cache and the hold-off exact: one host, one
request, one reason. The chain itself gets its own section at the bottom, where the ordering,
the failover and the freshness policy are the subject rather than the background.

The floor gets more attention than anything else. CelesTrak firewalls abusive clients without
appeal and there is no way back, so the tests do not merely check that the default happens to
be two hours: they check that no configuration path exists which could lower it.

**Recorded fixtures age, and the freshness policy has an opinion about age**, so a test that
needs a fresh batch against the real clock builds one with :func:`_freshened` rather than
serving a capture that will silently cross :data:`MAX_ELEMENT_AGE_S` a fortnight from now. The
structure stays the recorded one; only ``EPOCH`` moves.
"""

import inspect
import json
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx

from tests.conftest import fixture_bytes, fixture_json
from tracker.cache import FILE_NAME, DiskCache
from tracker.cache import key as cache_key
from tracker.contracts.base import ContractViolationError
from tracker.contracts.satellite import Satellite
from tracker.services.poller import Poller
from tracker.sources.base import SourceError
from tracker.sources.celestrak import (
    CACHE_NAMESPACE,
    CELESTRAK,
    DEGRADED_ELEMENT_AGE_S,
    GP_FORMAT,
    GP_URL,
    MAX_ELEMENT_AGE_S,
    MIN_GROUP_INTERVAL_S,
    MIRROR_STOP_SECONDS,
    POLICY_STOP_SECONDS,
    PROVIDER_CHAIN,
    RETLECTOR,
    SATVISOR,
    SERVER_STOP_SECONDS,
    SOURCE_NAME,
    CelestrakClient,
    CelestrakStoppedError,
    ElementBatch,
    StaleElementsError,
    parse_elements,
)

ISS_FIXTURE = "celestrak_iss_omm.json"
TDRS_FIXTURE = "celestrak_catnr19548_omm_wayback20260310.json"
RETLECTOR_ISS_FIXTURE = "retlector_iss_omm_live.json"
RETLECTOR_ACTIVE_FIXTURE = "retlector_active_omm_slice_live.json"
SATVISOR_FROZEN_FIXTURE = "satvisor_mirror_stale_active_omm_slice_live.json"

ISS_CATALOGUE_NUMBER = 25544
TDRS_CATALOGUE_NUMBER = 19548

ISS_EPOCH = datetime(2026, 8, 19, 12, 48, 46, 640160, tzinfo=UTC)
"""The recorded ISS epoch, read straight out of the fixture and stamped UTC."""

TDRS_EPOCH = datetime(2026, 3, 5, 19, 9, 20, 611872, tzinfo=UTC)

FETCHED_AT = datetime(2026, 8, 20, 9, 0, 0, tzinfo=UTC)
"""A fixed fetch instant, so cadence boundaries are exact rather than approximate."""

TDRS_FETCHED_AT = datetime(2026, 3, 6, 9, 0, 0, tzinfo=UTC)
"""The fetch instant the TDRS 3 capture is parsed against: the day after its own epoch.

The capture is five months old, so parsing it against :data:`FETCHED_AT` would drop every
record as older than :data:`MAX_ELEMENT_AGE_S` and the mapping it exists to prove (a real zero
``BSTAR`` on a geostationary object) would never be reached. A batch fetched in March is what
this fixture is, and dating it honestly is cheaper than exempting it from the age guard.
"""

RETLECTOR_ISS_EPOCH = datetime(2026, 8, 20, 4, 17, 29, 138208, tzinfo=UTC)
"""ReTLEctor's ISS epoch on 2026-08-20: fresher than the CelesTrak capture by 15.5 hours."""

TWO_HOURS_S = 7200.0


class Clock:
    """A hand-driven clock. Cadence floors are measured, never slept through."""

    def __init__(self, start: datetime = FETCHED_AT) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


def _array(*records: dict[str, Any]) -> bytes:
    """Wrap OMM records in the bare JSON array CelesTrak returns."""
    return json.dumps(list(records)).encode()


def _iss_record() -> dict[str, Any]:
    """The recorded ISS element set as a mutable dict, for building variants."""
    record: dict[str, Any] = fixture_json(ISS_FIXTURE)[0]
    return record


def _tdrs_record() -> dict[str, Any]:
    record: dict[str, Any] = fixture_json(TDRS_FIXTURE)[0]
    return record


def _current_tdrs_record() -> dict[str, Any]:
    """The recorded TDRS 3 record, dated into the window a 2026-08-20 fetch can draw.

    It plays "the record that survives" in the drop-and-count tests below, and the
    freshness policy would otherwise drop it for being five months old, which would make
    those tests pass for the wrong reason and then fail for a third one. Structure is the
    capture's; only the epoch moves.
    """
    return _freshened(_tdrs_record(), now=FETCHED_AT, age=timedelta(hours=12))


def _satellites(
    payload: bytes | str,
    *,
    group: str,
    fetched_at: datetime,
    source: str = SOURCE_NAME,
) -> tuple[Satellite, ...]:
    """The kept records of one parse, for the tests whose subject is the mapping.

    :func:`parse_elements` returns a whole batch now, because the drop counts and the median
    epoch age are the freshness signal and throwing them away at the call site was how a
    frozen mirror got to look healthy. The tests about the chain use the batch; the tests about
    one record want one record.
    """
    return parse_elements(payload, group=group, fetched_at=fetched_at, source=source).satellites


def _freshened(record: dict[str, Any], *, now: datetime, age: timedelta) -> dict[str, Any]:
    """The recorded record with its ``EPOCH`` moved to ``age`` before ``now``.

    Only ``EPOCH`` changes, so the payload keeps every quirk of the capture it came from:
    the naive six-decimal timestamp with no offset, the mixed ints and floats, the field
    order. A recorded epoch is a fact about the day it was recorded, and the freshness policy
    is a fact about the fetch, so a test that needs both against the real clock has to move
    one of them. Moving the epoch keeps the structure real, which is the half that matters.
    """
    moved = dict(record)
    moved["EPOCH"] = (now - age).replace(tzinfo=None).isoformat()
    return moved


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    """A real httpx client. respx intercepts at the transport, so nothing leaves the process."""
    async with httpx.AsyncClient() as client:
        yield client


@pytest.fixture
def client(http: httpx.AsyncClient, clock: Clock) -> CelestrakClient:
    return CelestrakClient(http, providers=(CELESTRAK,), clock=clock)


@pytest.fixture
def iss_route() -> Iterator[respx.Route]:
    """One respx route serving the recorded ISS payload for any gp.php request."""
    with respx.mock(assert_all_called=False) as router:
        yield router.get(GP_URL).respond(200, content=fixture_bytes(ISS_FIXTURE))


# ---------------------------------------------------------------- the two-hour floor


def test_the_floor_is_two_hours_and_lives_in_code() -> None:
    """CelesTrak's own published figure for GP data, as a module constant."""
    assert MIN_GROUP_INTERVAL_S == TWO_HOURS_S


def test_configuration_cannot_lower_the_floor() -> None:
    """The point is not that the default is two hours. It is that nothing can change it.

    Three ways a floor normally leaks into configuration, all closed: a constructor
    argument, a writable attribute, and a settings value reaching the poller.
    """
    parameters = set(inspect.signature(CelestrakClient.__init__).parameters)
    cadence_knobs = {
        "interval",
        "interval_seconds",
        "min_interval",
        "min_interval_seconds",
        "poll_seconds",
        "cadence",
        "cadence_seconds",
        "ttl",
        "ttl_seconds",
        "cache_ttl_seconds",
        "floor",
        "floor_seconds",
        "settings",
    }
    assert not parameters & cadence_knobs, "the client must take no cadence argument at all"

    floor = inspect.getattr_static(CelestrakClient, "min_interval_seconds")
    assert isinstance(floor, property)
    assert floor.fset is None, "the floor must have no setter"


def test_a_one_second_configured_interval_is_still_clamped_to_the_floor(
    client: CelestrakClient,
) -> None:
    """A careless ``TRACKER_CELESTRAK_POLL_SECONDS=1`` cannot outrun the adapter's floor."""
    poller = Poller(
        name=SOURCE_NAME,
        layer="satellites",
        poll=_never_called,
        interval_seconds=1.0,
        min_interval_seconds=client.min_interval_seconds,
    )
    assert poller.effective_interval == MIN_GROUP_INTERVAL_S


async def _never_called() -> int:
    raise AssertionError("this poller must not run during the floor test")


async def test_a_second_call_inside_the_window_makes_no_request(
    client: CelestrakClient, iss_route: respx.Route, clock: Clock
) -> None:
    """The cache is what keeps us inside the floor, so it must serve with zero HTTP."""
    first = await client.elements("stations")

    for _ in range(5):
        clock.advance(60.0)
        again = await client.elements("stations")
        assert again == first

    assert iss_route.call_count == 1


async def test_the_floor_opens_exactly_at_two_hours(
    client: CelestrakClient, iss_route: respx.Route, clock: Clock
) -> None:
    """One second short of the floor is a cache hit; the floor itself is a fetch."""
    await client.elements("stations")

    clock.advance(MIN_GROUP_INTERVAL_S - 1.0)
    await client.elements("stations")
    assert iss_route.call_count == 1

    clock.advance(1.0)
    await client.elements("stations")
    assert iss_route.call_count == 2


async def test_the_floor_is_per_group_not_global(
    client: CelestrakClient, iss_route: respx.Route
) -> None:
    """Two different groups are two different requests; a repeat of either is not."""
    await client.elements("stations")
    await client.elements("visual")
    assert iss_route.call_count == 2

    await client.elements("stations")
    await client.elements("visual")
    assert iss_route.call_count == 2


async def test_the_floor_counts_requests_not_successes(
    client: CelestrakClient, clock: Clock
) -> None:
    """A failed fetch has still cost CelesTrak a request, so it starts the clock too.

    Without this, an upstream serving broken payloads would be hammered every poll.
    """
    with respx.mock(assert_all_called=True) as router:
        route = router.get(GP_URL).respond(200, content=b"")
        with pytest.raises(ContractViolationError):
            await client.elements("stations")

        clock.advance(60.0)
        with pytest.raises(SourceError) as failure:
            await client.elements("stations")

        assert route.call_count == 1
        assert "floor holds" in str(failure.value)


# ---------------------------------------------------------------- the request itself


async def test_format_is_passed_explicitly_because_the_default_became_csv(
    client: CelestrakClient, iss_route: respx.Route
) -> None:
    """``FORMAT`` defaults to CSV as of 2026-05-09, so it is never left off the query."""
    await client.elements("stations")

    url = iss_route.calls[0].request.url
    assert url.params["FORMAT"] == GP_FORMAT == "JSON"
    assert url.params["GROUP"] == "stations"


def test_the_endpoint_is_the_exact_host_their_policy_requires() -> None:
    """Anything but ``https://celestrak.org`` is a 301, and a 301 latches this feed off."""
    assert GP_URL == "https://celestrak.org/NORAD/elements/gp.php"
    assert "www." not in GP_URL
    assert GP_URL.startswith("https://")


async def test_redirects_are_not_followed(client: CelestrakClient) -> None:
    """A 301 means the URL is wrong. Following it would hide a policy warning."""
    with respx.mock(assert_all_called=False) as router:
        moved = router.get(GP_URL).respond(
            301, headers={"location": "https://www.celestrak.org/NORAD/elements/gp.php"}
        )
        elsewhere = router.get("https://www.celestrak.org/NORAD/elements/gp.php").respond(
            200, content=fixture_bytes(ISS_FIXTURE)
        )

        with pytest.raises(CelestrakStoppedError):
            await client.elements("stations")

        assert moved.call_count == 1
        assert elsewhere.call_count == 0, "the redirect target must never be fetched"


# ---------------------------------------------------------------- the stop-on-non-200 latch


@pytest.mark.parametrize("status", [301, 403, 404, 429, 500, 503])
async def test_any_non_200_stops_the_feed_for_the_process(
    client: CelestrakClient, status: int
) -> None:
    """Their policy: stop querying on any non-200 or the IP goes to the firewall.

    A backoff-and-retry, which is right for adsb.lol, is the wrong pattern here. So the
    second call must not reach the network at all.
    """
    with respx.mock(assert_all_called=True) as router:
        route = router.get(GP_URL).respond(status)

        with pytest.raises(CelestrakStoppedError) as first:
            await client.elements("stations")
        assert first.value.status_code == status

        with pytest.raises(CelestrakStoppedError):
            await client.elements("stations")

        assert route.call_count == 1, "a latched feed must issue no further requests"


async def test_the_latch_covers_every_group(client: CelestrakClient) -> None:
    """A 403 on one group is a block on us, not on that group."""
    with respx.mock(assert_all_called=True) as router:
        route = router.get(GP_URL).respond(403)
        with pytest.raises(CelestrakStoppedError):
            await client.elements("stations")
        with pytest.raises(CelestrakStoppedError):
            await client.elements("active")
        assert route.call_count == 1


async def test_a_latched_feed_reports_the_reason_with_the_status(
    client: CelestrakClient,
) -> None:
    """The layer degrades with a reason, the same route a missing key takes."""
    with respx.mock(assert_all_called=True) as router:
        router.get(GP_URL).respond(403)
        with pytest.raises(CelestrakStoppedError):
            await client.elements("stations")

    reason = client.unavailable_reason
    assert reason is not None
    assert "403" in reason
    assert "will not be asked again" in reason
    held = client.provider_status()[0].reason
    assert held is not None
    assert held in reason, "the layer's reason names the provider and then quotes its own"


# ---------------------------------------------------------------- unreachable, which is today


async def test_an_unreachable_host_is_unavailable_with_a_reason_and_does_not_latch(
    client: CelestrakClient, clock: Clock
) -> None:
    """A dead TCP port is their outage, not a policy block, so it must not latch.

    CelesTrak's firewalling returns an HTTP response. On 2026-08-20 both 443 and 80 were
    dead with ``connect=0.000000``, which is an outage, and a permanent latch on that would
    keep the layer dark long after the site came back.
    """
    with respx.mock(assert_all_called=True) as router:
        router.get(GP_URL).mock(side_effect=httpx.ConnectError("[Errno 61] Connection refused"))
        with pytest.raises(SourceError) as failure:
            await client.elements("stations")

    assert not isinstance(failure.value, CelestrakStoppedError)
    reason = client.unavailable_reason
    assert reason is not None
    assert "unreachable" in reason
    assert "ConnectError" in reason

    # Once the floor has passed, a retry is allowed: nothing is latched.
    clock.advance(MIN_GROUP_INTERVAL_S)
    with respx.mock(assert_all_called=True) as router:
        router.get(GP_URL).respond(200, content=fixture_bytes(ISS_FIXTURE))
        recovered = await client.elements("stations")

    assert len(recovered) == 1
    assert client.unavailable_reason is None


async def test_a_timeout_gives_a_reason_a_person_can_read(client: CelestrakClient) -> None:
    """A connect timeout carries no message, so the reason has to come from its type.

    Seen live on 2026-08-20: this string read ``unreachable: ConnectTimeout: ``, and it is
    what ``/api/health``, ``/api/capabilities`` and the layer rail put in front of a user.
    """
    with respx.mock(assert_all_called=True) as router:
        router.get(GP_URL).mock(side_effect=httpx.ConnectTimeout(""))
        with pytest.raises(SourceError):
            await client.elements("stations")

    reason = client.unavailable_reason
    assert reason is not None
    assert reason.endswith("unreachable: ConnectTimeout")
    assert not reason.endswith(":"), "the type name carries the reason when the message is empty"


def test_a_feed_that_has_never_answered_is_not_healthy(client: CelestrakClient) -> None:
    """Never-fetched is unavailable, not an empty layer that looks like a working one."""
    assert client.unavailable_reason == ("the orbital element providers have not been queried yet")
    assert client.cached_elements() == ()
    assert client.cached_at("stations") is None


# ---------------------------------------------------------------- the OMM mapping


def test_parses_the_recorded_iss_element_set() -> None:
    """Every field, against the payload as recorded. No hand-written record here."""
    satellites = _satellites(fixture_bytes(ISS_FIXTURE), group="stations", fetched_at=FETCHED_AT)
    assert len(satellites) == 1
    iss = satellites[0]

    assert iss.kind == "satellite"
    assert iss.norad_cat_id == ISS_CATALOGUE_NUMBER
    assert iss.object_name == "ISS (ZARYA)"
    assert iss.object_id == "1998-067A"
    assert iss.classification_type == "U"
    assert iss.epoch == ISS_EPOCH
    assert iss.mean_motion == pytest.approx(15.4951252)
    assert iss.eccentricity == pytest.approx(0.00076648)
    assert iss.inclination_deg == pytest.approx(51.6332)
    assert iss.ra_of_asc_node_deg == pytest.approx(346.5707)
    assert iss.arg_of_pericenter_deg == pytest.approx(63.0282)
    assert iss.mean_anomaly_deg == pytest.approx(297.1489)
    assert iss.bstar == pytest.approx(0.00020501314)
    assert iss.mean_motion_dot == pytest.approx(0.00011071)
    assert iss.mean_motion_ddot == 0.0
    assert iss.ephemeris_type == 0
    assert iss.element_set_no == 999
    assert iss.rev_at_epoch == 58157
    assert iss.group == "stations"
    assert iss.fetched_at == FETCHED_AT
    assert iss.source == SOURCE_NAME
    assert iss.label == "ISS (ZARYA)"


def test_parses_the_recorded_geostationary_element_set() -> None:
    """TDRS 3: a zero B* and a negative first derivative, both real values."""
    satellites = _satellites(fixture_bytes(TDRS_FIXTURE), group="geo", fetched_at=TDRS_FETCHED_AT)
    tdrs = satellites[0]

    assert tdrs.norad_cat_id == TDRS_CATALOGUE_NUMBER
    assert tdrs.object_name == "TDRS 3"
    assert tdrs.epoch == TDRS_EPOCH
    assert tdrs.bstar == 0.0, "zero drag on a geostationary object is a value, not a gap"
    assert tdrs.mean_motion_dot == pytest.approx(-3.03e-6)
    assert tdrs.mean_motion == pytest.approx(1.00259845)
    assert tdrs.group == "geo"


def test_the_naive_epoch_gets_utc_attached_in_the_adapter() -> None:
    """CelesTrak sends ``EPOCH`` naive. It is UTC by specification, stamped here.

    The raw fixture value is asserted to be naive first, so this cannot pass by accident on
    a payload that already carried an offset.
    """
    raw_epoch = _iss_record()["EPOCH"]
    assert raw_epoch == "2026-08-19T12:48:46.640160"
    assert not raw_epoch.endswith("Z")
    assert "+" not in raw_epoch

    iss = _satellites(fixture_bytes(ISS_FIXTURE), group="stations", fetched_at=FETCHED_AT)[0]
    assert iss.epoch.tzinfo is not None
    assert iss.epoch.utcoffset() == timedelta(0)
    assert iss.epoch == ISS_EPOCH
    assert iss.epoch.microsecond == 640160, "microsecond precision survives the mapping"


def test_an_epoch_arriving_with_an_offset_is_converted_not_relabelled() -> None:
    """If CelesTrak ever starts sending an offset, the instant must not shift."""
    record = _iss_record()
    record["EPOCH"] = "2026-08-19T14:48:46.640160+02:00"
    satellite = _satellites(_array(record), group="stations", fetched_at=FETCHED_AT)[0]
    assert satellite.epoch == ISS_EPOCH


def test_a_multi_record_array_maps_every_record() -> None:
    """A group query is an array. Both recorded records, in one response."""
    satellites = _satellites(
        _array(_iss_record(), _current_tdrs_record()), group="stations", fetched_at=FETCHED_AT
    )
    assert [s.norad_cat_id for s in satellites] == [
        ISS_CATALOGUE_NUMBER,
        TDRS_CATALOGUE_NUMBER,
    ]


def test_a_six_digit_catalogue_number_maps() -> None:
    """CelesTrak ran out of 5-digit numbers on 2026-07-11; new objects are 100000+.

    An adapter that assumed five digits would silently drop everything catalogued since.
    """
    record = _iss_record()
    record["NORAD_CAT_ID"] = 100147
    satellite = _satellites(_array(record), group="active", fetched_at=FETCHED_AT)[0]
    assert satellite.norad_cat_id == 100147


def test_an_analyst_object_with_no_name_or_designator_maps() -> None:
    """80000-series analyst objects carry neither ``OBJECT_NAME`` nor ``OBJECT_ID``."""
    record = _iss_record()
    record["NORAD_CAT_ID"] = 80001
    del record["OBJECT_NAME"]
    del record["OBJECT_ID"]

    satellite = _satellites(_array(record), group="analyst", fetched_at=FETCHED_AT)[0]
    assert satellite.object_name is None
    assert satellite.object_id is None
    assert satellite.label == "80001"


def test_a_blank_name_becomes_none_rather_than_an_empty_string() -> None:
    """TLE output space-pads names, so a blank must not survive as a display value."""
    record = _iss_record()
    record["OBJECT_NAME"] = "   "
    record["OBJECT_ID"] = ""
    satellite = _satellites(_array(record), group="stations", fetched_at=FETCHED_AT)[0]
    assert satellite.object_name is None
    assert satellite.object_id is None


# ---------------------------------------------------------------- dropped and counted


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("ECCENTRICITY", 1.5),
        ("ECCENTRICITY", -0.1),
        ("MEAN_MOTION", 0.0),
        ("MEAN_MOTION", -15.0),
        ("INCLINATION", 200.0),
        ("RA_OF_ASC_NODE", 400.0),
        ("MEAN_ANOMALY", -1.0),
        ("NORAD_CAT_ID", 0),
        ("CLASSIFICATION_TYPE", "Z"),
        ("EPOCH", "not a timestamp"),
        ("MEAN_MOTION", "not a number"),
        ("MEAN_MOTION", float("inf")),
        ("MEAN_MOTION", "1e400"),
        ("BSTAR", float("nan")),
        ("BSTAR", float("-inf")),
        ("MEAN_MOTION_DOT", float("nan")),
        ("MEAN_MOTION_DDOT", float("inf")),
    ],
)
def test_an_unpropagatable_record_is_dropped_and_the_good_one_survives(
    field: str, value: Any
) -> None:
    """One corrupt element set must never empty the layer.

    Eccentricity outside 0 to 1 is ``SatRecError`` 1 and a mean motion at or below zero is
    ``SatRecError`` 2: element sets SGP4 cannot propagate, so they are refused here rather
    than drawn as a satellite underground. A non-finite value is refused for the same
    reason plus a second one: ``inf`` satisfies ``gt=0.0``, and both ``inf`` and ``nan``
    serialise to JSON ``null``, so accepting one publishes a response our own contract
    rejects. ``"1e400"`` is the string form, which a Space-Track-shaped payload can send.
    """
    bad = _iss_record()
    bad[field] = value
    bad["NORAD_CAT_ID"] = bad["NORAD_CAT_ID"] if field == "NORAD_CAT_ID" else 99999

    satellites = _satellites(
        _array(bad, _current_tdrs_record()), group="stations", fetched_at=FETCHED_AT
    )
    assert [s.norad_cat_id for s in satellites] == [TDRS_CATALOGUE_NUMBER]


@pytest.mark.parametrize(
    "missing",
    [
        "EPOCH",
        "NORAD_CAT_ID",
        "MEAN_MOTION",
        "ECCENTRICITY",
        "BSTAR",
        "CLASSIFICATION_TYPE",
        "REV_AT_EPOCH",
    ],
)
def test_a_missing_required_keyword_drops_the_record_rather_than_defaulting_it(
    missing: str,
) -> None:
    """A defaulted ``BSTAR`` would be a fabricated drag term. Absence is not zero."""
    record = _iss_record()
    del record[missing]
    satellites = _satellites(
        _array(record, _current_tdrs_record()), group="stations", fetched_at=FETCHED_AT
    )
    assert [s.norad_cat_id for s in satellites] == [TDRS_CATALOGUE_NUMBER]


def test_a_non_object_element_is_dropped() -> None:
    """A stray string or null in the array is one dropped record, not a dead layer."""
    satellites = _satellites(
        json.dumps([None, "junk", 7, _iss_record()]).encode(),
        group="stations",
        fetched_at=FETCHED_AT,
    )
    assert [s.norad_cat_id for s in satellites] == [ISS_CATALOGUE_NUMBER]


def test_unknown_keywords_are_ignored_not_rejected() -> None:
    """The wire model is permissive: a new OMM keyword must not blank the layer."""
    record = _iss_record()
    record["CENTER_NAME"] = "EARTH"
    record["REF_FRAME"] = "TEME"
    record["TIME_SYSTEM"] = "UTC"
    record["MEAN_ELEMENT_THEORY"] = "SGP4"

    satellites = _satellites(_array(record), group="stations", fetched_at=FETCHED_AT)
    assert satellites[0].norad_cat_id == ISS_CATALOGUE_NUMBER


def test_numeric_strings_parse_so_a_space_track_payload_would_map() -> None:
    """CelesTrak sends numbers, Space-Track sends the same fields as strings."""
    record = {key: str(value) for key, value in _iss_record().items()}
    satellites = _satellites(_array(record), group="stations", fetched_at=FETCHED_AT)
    assert satellites[0].mean_motion == pytest.approx(15.4951252)


# ---------------------------------------------------------------- a 200 that is not data


@pytest.mark.parametrize(
    ("body", "why"),
    [
        (b"", "empty body, the AISHub failure shape"),
        (b"   ", "whitespace only"),
        (b"[]", "empty array"),
        (b"{}", "an object, not an array"),
        (b"<html><body>maintenance</body></html>", "an error page behind a 200"),
        (
            b"OBJECT_NAME,OBJECT_ID,EPOCH\nISS (ZARYA),1998-067A,2026-08-19T12:48:46\n",
            "CSV, which is what a dropped FORMAT returns",
        ),
    ],
)
def test_a_200_that_is_not_an_omm_array_is_a_contract_violation(body: bytes, why: str) -> None:
    """Counted as a failure, never accepted as data. ``why`` documents the shape."""
    assert why
    with pytest.raises(ContractViolationError):
        _satellites(body, group="stations", fetched_at=FETCHED_AT)


def test_an_array_whose_records_all_fail_is_a_contract_violation() -> None:
    """One dropped OMM keyword upstream must not read as an empty sky.

    Individual bad records are dropped and counted, but a 200 where **nothing** maps means
    the provider changed shape. Returning an empty tuple there is the same outcome
    ``_require_omm_array`` refuses for an empty array: a blank layer behind a healthy poll.
    """
    broken = _iss_record()
    del broken["MEAN_MOTION"]

    with pytest.raises(ContractViolationError) as caught:
        _satellites(_array(*[broken] * 30), group="stations", fetched_at=FETCHED_AT)

    assert "30" in str(caught.value)


async def test_an_all_dropped_refresh_never_empties_the_cache(
    client: CelestrakClient, clock: Clock
) -> None:
    """The recorded blocker: a 200 of unmappable records must not blank the layer.

    CelesTrak is unreachable as this is written, so the cache is the only thing between the
    globe and an empty satellite layer.
    """
    with respx.mock(assert_all_called=True) as router:
        router.get(GP_URL).respond(200, content=fixture_bytes(ISS_FIXTURE))
        await client.elements("stations")

    good = client.cached_elements()
    assert len(good) == 1

    broken = _iss_record()
    del broken["MEAN_MOTION"]
    clock.advance(MIN_GROUP_INTERVAL_S)
    with respx.mock(assert_all_called=True) as router:
        router.get(GP_URL).respond(200, content=_array(*[broken] * 30))
        with pytest.raises(ContractViolationError):
            await client.elements("stations")

    assert client.cached_elements() == good
    assert client.cached_at("stations") == FETCHED_AT


def test_a_cache_holding_no_element_sets_reports_unavailable(client: CelestrakClient) -> None:
    """Availability is about cached satellites, not about cache keys.

    ``if self._cache:`` is truthy for a dict of empty groups, which published
    ``available=True`` over a layer with nothing to draw.
    """
    client._cache["stations"] = ElementBatch(
        provider=SOURCE_NAME,
        group="stations",
        fetched_at=FETCHED_AT,
        satellites=(),
        dropped_unmappable=0,
        dropped_stale=0,
    )

    assert client.cached_elements() == ()
    reason = client.unavailable_reason
    assert reason is not None
    assert "have not been queried yet" in reason


async def test_a_bad_payload_never_empties_the_cache(client: CelestrakClient, clock: Clock) -> None:
    """A failed refresh leaves the last good element sets in place."""
    with respx.mock(assert_all_called=True) as router:
        router.get(GP_URL).respond(200, content=fixture_bytes(ISS_FIXTURE))
        await client.elements("stations")

    good = client.cached_elements()
    assert len(good) == 1

    clock.advance(MIN_GROUP_INTERVAL_S)
    with respx.mock(assert_all_called=True) as router:
        router.get(GP_URL).respond(200, content=b"[]")
        with pytest.raises(ContractViolationError):
            await client.elements("stations")

    assert client.cached_elements() == good
    assert client.cached_at("stations") == FETCHED_AT


# ---------------------------------------------------------------- the cached-elements view


async def test_cached_elements_holds_one_record_per_catalogue_number(
    client: CelestrakClient,
) -> None:
    """``stations`` is a subset of ``active``, so the same object arrives twice.

    Two records for one object would be propagated and drawn twice, which is the phantom
    duplicate the store's catalogue-number key exists to prevent.
    """
    with respx.mock(assert_all_called=True) as router:
        router.get(GP_URL, params={"GROUP": "stations"}).respond(
            200, content=fixture_bytes(ISS_FIXTURE)
        )
        stale = _iss_record()
        stale["EPOCH"] = "2026-08-12T00:00:00.000000"
        router.get(GP_URL, params={"GROUP": "active"}).respond(200, content=_array(stale))

        await client.elements("stations")
        await client.elements("active")

    cached = client.cached_elements()
    assert len(cached) == 1
    assert cached[0].epoch == ISS_EPOCH, "the freshest epoch wins, and nothing is blended"
    assert cached[0].group == "stations"


async def test_cached_elements_keeps_a_newer_epoch_from_a_second_group(
    client: CelestrakClient,
) -> None:
    """Order of arrival must not decide which element set is served."""
    with respx.mock(assert_all_called=True) as router:
        stale = _iss_record()
        stale["EPOCH"] = "2026-08-12T00:00:00.000000"
        router.get(GP_URL, params={"GROUP": "active"}).respond(200, content=_array(stale))
        router.get(GP_URL, params={"GROUP": "stations"}).respond(
            200, content=fixture_bytes(ISS_FIXTURE)
        )

        await client.elements("active")
        await client.elements("stations")

    cached = client.cached_elements()
    assert len(cached) == 1
    assert cached[0].epoch == ISS_EPOCH


async def test_cached_at_reports_the_fetch_instant_not_the_epoch(
    client: CelestrakClient, iss_route: respx.Route
) -> None:
    """How current our copy is, which is a different question from the orbit's epoch."""
    await client.elements("stations")
    assert client.cached_at("stations") == FETCHED_AT
    assert client.cached_at("active") is None
    assert client.cached_elements()[0].epoch == ISS_EPOCH


def test_the_client_names_itself_for_health_output(client: CelestrakClient) -> None:
    assert client.name == SOURCE_NAME == "celestrak"


# ---------------------------------------------------------------- staleness, from the contract


def test_a_week_old_element_set_reads_as_stale() -> None:
    """Three and a half days is CelesTrak's own ``OLDEST`` threshold, not ours.

    Propagating the real ISS element set 365 days past its epoch still reports error 0 and a
    plausible 402 km altitude, so a clean propagator result is not evidence of a usable
    position. Age is.
    """
    iss = _satellites(fixture_bytes(ISS_FIXTURE), group="stations", fetched_at=FETCHED_AT)[0]
    assert not iss.is_stale_at(ISS_EPOCH + timedelta(days=3))
    assert iss.is_stale_at(ISS_EPOCH + timedelta(days=4))
    assert iss.epoch_age_s(ISS_EPOCH + timedelta(hours=1)) == pytest.approx(3600.0)


def test_the_recorded_geostationary_set_is_long_stale_against_today() -> None:
    """The TDRS 3 capture is five months old, and the guard says so."""
    tdrs = _satellites(fixture_bytes(TDRS_FIXTURE), group="geo", fetched_at=TDRS_FETCHED_AT)[0]
    assert tdrs.is_stale_at(FETCHED_AT)


async def test_the_default_clock_is_real_utc_time(http: httpx.AsyncClient) -> None:
    """With no clock injected the floor runs on real UTC, not on a test double.

    The payload is freshened rather than served as recorded, because this is the one test here
    that runs against the wall clock and the recorded epoch would cross
    :data:`MAX_ELEMENT_AGE_S` a fortnight after the capture was taken.
    """
    client = CelestrakClient(http, providers=(CELESTRAK,))
    fresh = _array(_freshened(_iss_record(), now=datetime.now(UTC), age=timedelta(hours=1)))
    with respx.mock(assert_all_called=True) as router:
        router.get(GP_URL).respond(200, content=fresh)
        satellites = await client.elements("stations")

    fetched_at = client.cached_at("stations")
    assert fetched_at is not None
    assert fetched_at.utcoffset() == timedelta(0)
    assert satellites[0].fetched_at.utcoffset() == timedelta(0)


# ---------------------------------------------------------------- the live check


@pytest.mark.live
async def test_live_stations_group_returns_omm_json() -> None:
    """The real endpoint, for when CelesTrak answers again. Deselected by the gate.

    One request, one group, ``FORMAT`` explicit, redirects not followed, and it stops on the
    first non-200 like everything else here. Run it with ``uv run pytest -m live``, and not
    more than once per two hours.
    """
    async with httpx.AsyncClient(timeout=30.0) as http:
        client = CelestrakClient(http, providers=(CELESTRAK,))
        satellites: tuple[Satellite, ...] = await client.elements("stations")

    assert satellites, "the stations group is never empty"
    assert any(s.norad_cat_id == ISS_CATALOGUE_NUMBER for s in satellites)
    assert all(s.epoch.tzinfo is not None for s in satellites)
    assert all(s.source == SOURCE_NAME for s in satellites)
    assert client.unavailable_reason is None


# ---------------------------------------------------------------- surviving a restart


async def test_a_fresh_client_serves_the_cached_group_without_a_request(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """The restart proof, and the strongest rate case in the tree.

    CelesTrak firewalls abusive clients permanently and asks for one download per two-hour
    publication. Stopping and starting the app used to be a fresh request per group every
    time, however often it happened. Here the second client is a different object over the
    same cache file, and it opens no socket at all.
    """
    cache = DiskCache(tmp_path, clock=clock)
    with respx.mock(assert_all_called=True) as router:
        route = router.get(GP_URL).respond(200, content=fixture_bytes(ISS_FIXTURE))
        first = await CelestrakClient(
            http, providers=(CELESTRAK,), clock=clock, cache=cache
        ).elements("stations")
        assert route.call_count == 1

    clock.advance(60.0)
    with respx.mock(assert_all_called=False) as router:
        blocked = router.get(GP_URL).respond(200, content=fixture_bytes(ISS_FIXTURE))
        restarted = await CelestrakClient(
            http, providers=(CELESTRAK,), clock=clock, cache=cache
        ).elements("stations")

    assert blocked.call_count == 0
    assert [s.norad_cat_id for s in restarted] == [s.norad_cat_id for s in first]


async def test_the_two_hour_floor_holds_across_a_restart(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """The floor is persisted before the socket opens, so a failed fetch still spends it.

    A restart loop after a failure is the case that gets an address firewalled, and it is the
    one where nothing is cached to serve. So this must raise rather than fetch.
    """
    cache = DiskCache(tmp_path, clock=clock)
    with respx.mock(assert_all_called=True) as router:
        router.get(GP_URL).mock(side_effect=httpx.ConnectTimeout("dead"))
        with pytest.raises(SourceError):
            await CelestrakClient(http, providers=(CELESTRAK,), clock=clock, cache=cache).elements(
                "stations"
            )

    with respx.mock(assert_all_called=False) as router:
        blocked = router.get(GP_URL).respond(200, content=fixture_bytes(ISS_FIXTURE))
        with pytest.raises(SourceError, match="two-hour floor holds"):
            await CelestrakClient(http, providers=(CELESTRAK,), clock=clock, cache=cache).elements(
                "stations"
            )

    assert blocked.call_count == 0


async def test_the_floor_opens_after_two_hours_for_a_fresh_client(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """The floor delays and never latches, so a persisted one cannot dark the layer for good."""
    cache = DiskCache(tmp_path, clock=clock)
    with respx.mock(assert_all_called=True) as router:
        router.get(GP_URL).respond(200, content=fixture_bytes(ISS_FIXTURE))
        await CelestrakClient(http, providers=(CELESTRAK,), clock=clock, cache=cache).elements(
            "stations"
        )

    clock.advance(MIN_GROUP_INTERVAL_S + 1.0)
    with respx.mock(assert_all_called=True) as router:
        route = router.get(GP_URL).respond(200, content=fixture_bytes(ISS_FIXTURE))
        await CelestrakClient(http, providers=(CELESTRAK,), clock=clock, cache=cache).elements(
            "stations"
        )

    assert route.call_count == 1


async def test_one_group_does_not_spend_anothers_floor(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """The persisted key is per group, matching the in-memory behaviour it replaces."""
    cache = DiskCache(tmp_path, clock=clock)
    with respx.mock(assert_all_called=True) as router:
        route = router.get(GP_URL).respond(200, content=fixture_bytes(ISS_FIXTURE))
        client = CelestrakClient(http, providers=(CELESTRAK,), clock=clock, cache=cache)
        await client.elements("stations")
        await CelestrakClient(http, providers=(CELESTRAK,), clock=clock, cache=cache).elements(
            "active"
        )

    assert route.call_count == 2


async def test_a_client_with_no_cache_writes_nothing(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """The persistence is opt-in, so the adapter still works with no cache at all."""
    with respx.mock(assert_all_called=True) as router:
        router.get(GP_URL).respond(200, content=fixture_bytes(ISS_FIXTURE))
        await CelestrakClient(http, providers=(CELESTRAK,), clock=clock).elements("stations")

    assert not (tmp_path / FILE_NAME).exists()


async def test_an_unreadable_cached_group_is_dropped_rather_than_kept(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """A cached shape we cannot read is our own bug or a hand-edited file, never the provider's.

    Kept, it would fail every read for as long as the floor held and then again on the next
    restart. Dropped, the next poll past the floor fetches cleanly. The floor still holds
    here, so this poll gets nothing: refusing to spend a request the floor has already
    counted is the whole point of the floor.
    """
    cache = DiskCache(tmp_path, clock=clock)
    cache.set_time(cache_key(CACHE_NAMESPACE, "attempted", "stations"), clock.now)
    cache.set(cache_key(CACHE_NAMESPACE, "elements", "stations"), '{"nonsense": true}')

    with respx.mock(assert_all_called=False) as router:
        blocked = router.get(GP_URL).respond(200, content=fixture_bytes(ISS_FIXTURE))
        with pytest.raises(SourceError, match="nothing cached to serve"):
            await CelestrakClient(http, providers=(CELESTRAK,), clock=clock, cache=cache).elements(
                "stations"
            )

    assert blocked.call_count == 0
    assert cache.get(cache_key(CACHE_NAMESPACE, "elements", "stations")) is None


async def test_a_stop_expires_for_a_client_with_no_cache_too(
    http: httpx.AsyncClient, clock: Clock
) -> None:
    """The expiry is the client's behaviour, not the cache's. Both paths clear the same way."""
    with respx.mock(assert_all_called=True) as router:
        router.get(GP_URL).respond(503)
        client = CelestrakClient(http, providers=(CELESTRAK,), clock=clock)
        with pytest.raises(CelestrakStoppedError):
            await client.elements("stations")
        assert client.stopped_reason is not None

    clock.advance(SERVER_STOP_SECONDS + 1.0)

    assert client.stopped_reason is None


# ---------------------------------------------------------------- the stop, and its expiry


def test_a_server_error_and_a_policy_refusal_hold_for_different_lengths() -> None:
    """A 5xx says nothing about our client. A 403 says our client is wrong.

    The two-hour figure is taken from the floor rather than written out again, so "a server
    error costs one refresh" cannot drift away from what a refresh is.
    """
    assert SERVER_STOP_SECONDS == MIN_GROUP_INTERVAL_S
    assert POLICY_STOP_SECONDS == 24.0 * 60.0 * 60.0
    assert POLICY_STOP_SECONDS > SERVER_STOP_SECONDS


async def test_a_stop_survives_a_restart(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """The point of persisting it: a restart loop after a 403 is how an address is firewalled."""
    cache = DiskCache(tmp_path, clock=clock)
    with respx.mock(assert_all_called=True) as router:
        router.get(GP_URL).respond(403)
        with pytest.raises(CelestrakStoppedError):
            await CelestrakClient(http, providers=(CELESTRAK,), clock=clock, cache=cache).elements(
                "stations"
            )

    restarted = CelestrakClient(http, providers=(CELESTRAK,), clock=clock, cache=cache)

    reason = restarted.unavailable_reason
    assert reason is not None
    assert "403" in reason
    with respx.mock(assert_all_called=False) as router:
        blocked = router.get(GP_URL).respond(200, content=fixture_bytes(ISS_FIXTURE))
        with pytest.raises(CelestrakStoppedError):
            await restarted.elements("stations")
    assert blocked.call_count == 0


async def test_a_server_error_stop_expires_after_one_publication_cycle(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """A transient 503 must not dark the layer for ever. That objection was correct.

    This is the answer to it: the stop is bounded by cause, so one bad response from their
    server costs one refresh rather than the life of the deployment.
    """
    cache = DiskCache(tmp_path, clock=clock)
    with respx.mock(assert_all_called=True) as router:
        router.get(GP_URL).respond(503)
        with pytest.raises(CelestrakStoppedError):
            await CelestrakClient(http, providers=(CELESTRAK,), clock=clock, cache=cache).elements(
                "stations"
            )

    clock.advance(SERVER_STOP_SECONDS + 1.0)
    with respx.mock(assert_all_called=True) as router:
        route = router.get(GP_URL).respond(200, content=fixture_bytes(ISS_FIXTURE))
        found = await CelestrakClient(
            http, providers=(CELESTRAK,), clock=clock, cache=cache
        ).elements("stations")

    assert route.call_count == 1
    assert found[0].norad_cat_id == ISS_CATALOGUE_NUMBER


async def test_a_policy_stop_still_holds_after_one_publication_cycle(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """A 403 is not a server hiccup, so it does not lift on the server-error schedule."""
    cache = DiskCache(tmp_path, clock=clock)
    with respx.mock(assert_all_called=True) as router:
        router.get(GP_URL).respond(403)
        with pytest.raises(CelestrakStoppedError):
            await CelestrakClient(http, providers=(CELESTRAK,), clock=clock, cache=cache).elements(
                "stations"
            )

    clock.advance(SERVER_STOP_SECONDS + 1.0)

    assert (
        CelestrakClient(http, providers=(CELESTRAK,), clock=clock, cache=cache).stopped_reason
        is not None
    )


async def test_a_policy_stop_expires_after_a_day(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """No stop is permanent. A day of a dark layer is a cost; for ever is a bug."""
    cache = DiskCache(tmp_path, clock=clock)
    with respx.mock(assert_all_called=True) as router:
        router.get(GP_URL).respond(403)
        with pytest.raises(CelestrakStoppedError):
            await CelestrakClient(http, providers=(CELESTRAK,), clock=clock, cache=cache).elements(
                "stations"
            )

    clock.advance(POLICY_STOP_SECONDS + 1.0)

    assert (
        CelestrakClient(http, providers=(CELESTRAK,), clock=clock, cache=cache).stopped_reason
        is None
    )


async def test_an_expired_stop_clears_itself_from_disk(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """Read once, gone. A stale row that outlived its cause is not kept around to be re-read."""
    cache = DiskCache(tmp_path, clock=clock)
    with respx.mock(assert_all_called=True) as router:
        router.get(GP_URL).respond(403)
        client = CelestrakClient(http, providers=(CELESTRAK,), clock=clock, cache=cache)
        with pytest.raises(CelestrakStoppedError):
            await client.elements("stations")
    assert cache.get(cache_key(CACHE_NAMESPACE, "stopped", CELESTRAK.name)) is not None

    clock.advance(POLICY_STOP_SECONDS + 1.0)
    assert client.stopped_reason is None

    assert cache.get(cache_key(CACHE_NAMESPACE, "stopped", CELESTRAK.name)) is None


async def test_the_stop_expires_the_same_way_inside_one_process(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """A long-running process and a restarted one must not disagree about the same failure.

    Before this, the in-memory latch was for the life of the process. If only the disk copy
    expired, restarting would be the way to recover from a 503 and staying up would not, which
    is the sort of difference nobody discovers until it matters.
    """
    with respx.mock(assert_all_called=True) as router:
        router.get(GP_URL).respond(503)
        client = CelestrakClient(
            http, providers=(CELESTRAK,), clock=clock, cache=DiskCache(tmp_path, clock=clock)
        )
        with pytest.raises(CelestrakStoppedError):
            await client.elements("stations")
        assert client.stopped_reason is not None

    clock.advance(SERVER_STOP_SECONDS + 1.0)

    assert client.stopped_reason is None


async def test_an_unreadable_stored_stop_is_discarded(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """A corrupt stop must not dark the layer, and must not raise on construction either."""
    cache = DiskCache(tmp_path, clock=clock)
    cache.set(cache_key(CACHE_NAMESPACE, "stopped", CELESTRAK.name), "not json at all")

    assert (
        CelestrakClient(http, providers=(CELESTRAK,), clock=clock, cache=cache).stopped_reason
        is None
    )
    assert cache.get(cache_key(CACHE_NAMESPACE, "stopped", CELESTRAK.name)) is None


async def test_a_corrupt_stored_floor_does_not_lift_the_guard(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """The failure direction that matters, asserted rather than described.

    ``DiskCache.get_time`` reports an unreadable value as absent, which for a floor would mean
    "never asked", which spends a request against the one provider here that firewalls
    permanently. So a row that will not parse counts as asked just now instead.
    """
    cache = DiskCache(tmp_path, clock=clock)
    cache.set(cache_key(CACHE_NAMESPACE, "attempted", "stations"), "not a timestamp")

    with respx.mock(assert_all_called=False) as router:
        blocked = router.get(GP_URL).respond(200, content=fixture_bytes(ISS_FIXTURE))
        with pytest.raises(SourceError, match="nothing cached to serve"):
            await CelestrakClient(http, providers=(CELESTRAK,), clock=clock, cache=cache).elements(
                "stations"
            )

    assert blocked.call_count == 0


async def test_a_corrupt_stored_floor_is_healed_so_it_cannot_become_a_blackout(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """Leaning safe must not lean for ever. Left corrupt, the row would refuse every call.

    The row is rewritten as it is read, so the floor runs two hours from that moment and the
    refresh after it is ordinary. One missed refresh is the whole cost.
    """
    cache = DiskCache(tmp_path, clock=clock)
    key = cache_key(CACHE_NAMESPACE, "attempted", "stations")
    cache.set(key, "not a timestamp")

    with respx.mock(assert_all_called=False) as router:
        router.get(GP_URL).respond(200, content=fixture_bytes(ISS_FIXTURE))
        with pytest.raises(SourceError):
            await CelestrakClient(http, providers=(CELESTRAK,), clock=clock, cache=cache).elements(
                "stations"
            )

    assert cache.get_time(key) == clock.now

    clock.advance(MIN_GROUP_INTERVAL_S + 1.0)
    with respx.mock(assert_all_called=True) as router:
        route = router.get(GP_URL).respond(200, content=fixture_bytes(ISS_FIXTURE))
        found = await CelestrakClient(
            http, providers=(CELESTRAK,), clock=clock, cache=cache
        ).elements("stations")

    assert route.call_count == 1
    assert found[0].norad_cat_id == ISS_CATALOGUE_NUMBER


# ---------------------------------------------------------------- the provider chain
#
# Everything above pins the client to one provider so the floor, the cache and the hold-off
# are exact. Everything below is about the chain itself: what order it asks in, what happens
# when a host dies, and how a provider that keeps answering with last month's elements is
# caught rather than trusted.

RETLECTOR_STATIONS = "https://retlector.eu/stations/json"
SATVISOR_STATIONS = (
    "https://raw.githubusercontent.com/satvisorcom/satvisor-data/master"
    "/celestrak/json/stations.json"
)


@pytest.fixture
def chain(http: httpx.AsyncClient, clock: Clock) -> CelestrakClient:
    """A client on the real chain, for the tests whose subject is the failover."""
    return CelestrakClient(http, clock=clock)


def _batch_body(*ages: timedelta, now: datetime = FETCHED_AT) -> bytes:
    """One OMM array of ISS-derived records, one per age, each its own catalogue number.

    Built from the recorded record so the shape stays real, with only ``EPOCH`` and
    ``NORAD_CAT_ID`` moved. Distinct catalogue numbers matter because
    :meth:`CelestrakClient.cached_elements` deduplicates on that key, so records sharing one
    would collapse and a count assertion would pass for the wrong reason.
    """
    return _array(
        *(
            {**_freshened(_iss_record(), now=now, age=age), "NORAD_CAT_ID": 90000 + index}
            for index, age in enumerate(ages)
        )
    )


def test_the_chain_is_the_two_republishers_then_the_origin() -> None:
    """The ordering is the decision, so it is asserted rather than left to a comment.

    ReTLEctor first: measured freshest, and the only keyless host serving the OMM contract
    with 6-digit catalogue numbers in it. satvisor second: a different host on a different
    network serving the same bytes. CelesTrak last: the origin, and the one refusing us.
    """
    assert PROVIDER_CHAIN == (RETLECTOR, SATVISOR, CELESTRAK)
    assert [provider.name for provider in PROVIDER_CHAIN] == [
        "retlector",
        "satvisor",
        "celestrak",
    ]
    assert PROVIDER_CHAIN[-1] is CELESTRAK, "the blocked origin is asked last or not at all"


def test_every_provider_is_one_origin_so_nothing_here_corroborates_anything() -> None:
    """ADR 011's independence test, asserted where it would otherwise be miscounted.

    Three hosts, one orbit determination. Two of them agreeing is the same file fetched twice,
    which is exactly the error ``docs/pending-decisions.md`` flags against ADR 010 for ADS-B.
    """
    assert {provider.origin for provider in PROVIDER_CHAIN} == {SOURCE_NAME}


def test_only_celestrak_stops_on_a_non_200() -> None:
    """The strict policy belongs to the provider that published it, and to nobody else."""
    assert CELESTRAK.stop_on_non_200 is True
    assert RETLECTOR.stop_on_non_200 is False
    assert SATVISOR.stop_on_non_200 is False


def test_no_provider_can_be_asked_faster_than_celestraks_own_figure() -> None:
    """One floor covers the chain, so a republisher's looser cap cannot raise the rate."""
    assert all(p.min_interval_seconds == MIN_GROUP_INTERVAL_S for p in PROVIDER_CHAIN)


def test_each_url_template_takes_exactly_the_group() -> None:
    """A template with a second field would fail at the call site rather than at import."""
    assert RETLECTOR.url("stations") == RETLECTOR_STATIONS
    assert SATVISOR.url("stations") == SATVISOR_STATIONS
    assert CELESTRAK.url("stations") == f"{GP_URL}?GROUP=stations&FORMAT={GP_FORMAT}"
    for provider in PROVIDER_CHAIN:
        assert provider.url_template.count("{") == 1
        assert provider.url("active").startswith("https://")


def test_every_provider_carries_attribution_a_card_can_render() -> None:
    """Attribution is a licence condition on several sources here, so it is not optional."""
    for provider in PROVIDER_CHAIN:
        assert "CelesTrak" in provider.attribution, provider.name
        assert provider.attribution_url.startswith("https://"), provider.name


def test_the_client_exposes_the_chain_it_will_ask(chain: CelestrakClient) -> None:
    assert chain.providers == PROVIDER_CHAIN


async def test_a_healthy_primary_answers_and_the_rest_is_never_touched(
    chain: CelestrakClient,
) -> None:
    """The point of ordering by freshness: on a good cycle the chain costs one request."""
    with respx.mock(assert_all_called=False) as router:
        primary = router.get(RETLECTOR_STATIONS).respond(
            200, content=_batch_body(timedelta(hours=6))
        )
        fallback = router.get(SATVISOR_STATIONS).respond(
            200, content=_batch_body(timedelta(hours=1))
        )
        origin = router.get(GP_URL).respond(200, content=fixture_bytes(ISS_FIXTURE))

        satellites = await chain.elements("stations")

    assert primary.call_count == 1
    assert fallback.call_count == 0, "a fresh primary ends the walk"
    assert origin.call_count == 0, "the blocked origin costs nothing on a healthy cycle"
    assert satellites[0].source == RETLECTOR.name
    assert chain.cached_provider("stations") == RETLECTOR.name


async def test_a_dead_primary_fails_over_to_the_fallback(chain: CelestrakClient) -> None:
    """A one-person host with no SLA is the risk the fallback exists for."""
    with respx.mock(assert_all_called=False) as router:
        router.get(RETLECTOR_STATIONS).mock(side_effect=httpx.ConnectTimeout(""))
        fallback = router.get(SATVISOR_STATIONS).respond(
            200, content=_batch_body(timedelta(hours=4))
        )
        origin = router.get(GP_URL).respond(200, content=fixture_bytes(ISS_FIXTURE))

        satellites = await chain.elements("stations")

    assert fallback.call_count == 1
    assert origin.call_count == 0
    assert satellites[0].source == SATVISOR.name
    assert chain.unavailable_reason is None, "one dead host is a failover, not an outage"


async def test_both_republishers_dying_reaches_the_origin_last(chain: CelestrakClient) -> None:
    """CelesTrak is still in the chain, and this is the only case that pays its timeout."""
    with respx.mock(assert_all_called=True) as router:
        router.get(RETLECTOR_STATIONS).mock(side_effect=httpx.ConnectTimeout(""))
        router.get(SATVISOR_STATIONS).respond(404)
        origin = router.get(GP_URL).respond(200, content=_batch_body(timedelta(hours=20)))

        satellites = await chain.elements("stations")

    assert origin.call_count == 1
    assert satellites[0].source == SOURCE_NAME


async def test_every_provider_failing_names_every_reason(chain: CelestrakClient) -> None:
    """Three hosts down for three reasons is one error carrying all three."""
    with respx.mock(assert_all_called=True) as router:
        router.get(RETLECTOR_STATIONS).mock(side_effect=httpx.ConnectTimeout(""))
        router.get(SATVISOR_STATIONS).respond(500)
        router.get(GP_URL).respond(200, content=b"[]")

        with pytest.raises(SourceError) as caught:
            await chain.elements("stations")

    detail = str(caught.value)
    assert "retlector" in detail
    assert "satvisor" in detail
    assert "unreachable" in detail
    assert "500" in detail
    assert "empty" in detail


async def test_one_provider_holding_off_never_holds_off_another(chain: CelestrakClient) -> None:
    """The bug this replaced: one refusal used to dark the whole layer."""
    with respx.mock(assert_all_called=True) as router:
        router.get(RETLECTOR_STATIONS).respond(403)
        router.get(SATVISOR_STATIONS).respond(200, content=_batch_body(timedelta(hours=3)))

        await chain.elements("stations")

    held = {status.name: status.reason for status in chain.provider_status()}
    assert held["retlector"] is not None
    assert "403" in held["retlector"]
    assert held["satvisor"] is None
    assert chain.stopped_reason is None, "one held-off row is a failover, not a stopped feed"


async def test_a_republisher_non_200_costs_one_cycle_and_not_a_day(
    http: httpx.AsyncClient, clock: Clock
) -> None:
    """A one-person proxy 404ing a group must not dark a fallback for twenty-four hours.

    CelesTrak's day-long hold-off is proportionate to a stated firewall policy. Applying it to
    a mirror would leave the layer resting on a single host over a typo, which is the position
    this chain exists to get out of.
    """
    assert MIRROR_STOP_SECONDS == MIN_GROUP_INTERVAL_S
    assert MIRROR_STOP_SECONDS < POLICY_STOP_SECONDS

    client = CelestrakClient(http, providers=(SATVISOR,), clock=clock)
    with respx.mock(assert_all_called=True) as router:
        router.get(SATVISOR_STATIONS).respond(404)
        with pytest.raises(CelestrakStoppedError):
            await client.elements("stations")

    assert client.stopped_reason is not None
    clock.advance(MIRROR_STOP_SECONDS + 1.0)
    assert client.stopped_reason is None


async def test_a_throttled_republisher_honours_its_own_figure(
    http: httpx.AsyncClient, clock: Clock
) -> None:
    """ReTLEctor publishes 60 requests per 60 seconds and says so on the wire.

    A provider that tells us how long to wait is the one source of truth for that number, so
    the header wins over any constant here. Contrast the CelesTrak branch above, where a 429 is
    still a policy stop because their policy says stop on any non-200.
    """
    client = CelestrakClient(http, providers=(RETLECTOR,), clock=clock)
    with respx.mock(assert_all_called=True) as router:
        router.get(RETLECTOR_STATIONS).respond(429, headers={"Retry-After": "90"})
        with pytest.raises(CelestrakStoppedError):
            await client.elements("stations")

    reason = client.stopped_reason
    assert reason is not None
    assert "throttling" in reason
    assert "90s" in reason

    clock.advance(89.0)
    assert client.stopped_reason is not None
    clock.advance(2.0)
    assert client.stopped_reason is None


async def test_provider_status_lists_the_whole_chain_in_order(chain: CelestrakClient) -> None:
    """What ``/api/layers`` needs: the providers a layer rests on, and what stands in the way."""
    statuses = chain.provider_status()

    assert [status.name for status in statuses] == [p.name for p in PROVIDER_CHAIN]
    assert all(status.reason is None for status in statuses)
    assert all(status.held_off_until is None for status in statuses)
    assert all(status.origin == SOURCE_NAME for status in statuses)
    assert all(status.attribution_url.startswith("https://") for status in statuses)


async def test_provider_status_names_an_unreachable_provider(chain: CelestrakClient) -> None:
    """A firewall drop carries no HTTP response, so it is a reason without a hold-off."""
    with respx.mock(assert_all_called=True) as router:
        router.get(RETLECTOR_STATIONS).mock(side_effect=httpx.ConnectTimeout(""))
        router.get(SATVISOR_STATIONS).respond(200, content=_batch_body(timedelta(hours=2)))

        await chain.elements("stations")

    primary = chain.provider_status()[0]
    assert primary.reason is not None
    assert "unreachable" in primary.reason
    assert primary.held_off_until is None, "a dead socket is not a refusal we can read"


# ---------------------------------------------------------------- the freshness policy


def test_the_two_freshness_thresholds_are_named_constants_with_a_gap() -> None:
    """Drawn-but-degraded and refused-outright are different answers, so two numbers."""
    assert DEGRADED_ELEMENT_AGE_S == 3.5 * 24 * 60 * 60
    assert MAX_ELEMENT_AGE_S == 14.0 * 24 * 60 * 60
    assert DEGRADED_ELEMENT_AGE_S < MAX_ELEMENT_AGE_S


def test_the_degraded_threshold_is_celestraks_own_oldest_flag() -> None:
    """Reused from the contract rather than invented, so "stale" is one fact in the tree."""
    from tracker.contracts.satellite import STALE_EPOCH_AGE_S

    assert DEGRADED_ELEMENT_AGE_S == STALE_EPOCH_AGE_S


def test_an_element_set_past_the_maximum_age_is_dropped_and_counted() -> None:
    """A fortnight-old element set is tens of kilometres out, so it is not drawn."""
    batch = parse_elements(
        _batch_body(timedelta(hours=6), timedelta(days=15)),
        group="stations",
        fetched_at=FETCHED_AT,
    )

    assert len(batch.satellites) == 1
    assert batch.dropped_stale == 1
    assert batch.dropped_unmappable == 0
    assert "dropped as older than 14d" in batch.summary


def test_the_boundary_is_exactly_fourteen_days() -> None:
    """Asserted rather than approximated, so a later tweak cannot drift it silently."""
    inside = parse_elements(
        _batch_body(timedelta(seconds=MAX_ELEMENT_AGE_S)), group="g", fetched_at=FETCHED_AT
    )
    assert inside.dropped_stale == 0

    with pytest.raises(StaleElementsError):
        parse_elements(
            _batch_body(timedelta(seconds=MAX_ELEMENT_AGE_S + 1.0)),
            group="g",
            fetched_at=FETCHED_AT,
        )


def test_the_recorded_frozen_mirror_is_refused_outright() -> None:
    """The real failure this policy exists for, against the real captured payload.

    ``satvisor/celestrak/json/active.json`` answered HTTP 200 on 2026-08-20 with 14,875 records
    at a median epoch age of 147 days. The 120-record slice on disk runs 142 to 153 days old, so
    every one of them fails the age test and the batch is refused with a reason naming the age.
    """
    with pytest.raises(StaleElementsError) as caught:
        parse_elements(
            fixture_bytes(SATVISOR_FROZEN_FIXTURE),
            group="active",
            fetched_at=FETCHED_AT,
            source=SATVISOR.name,
        )

    error = caught.value
    assert error.dropped == 120
    assert error.newest_epoch < FETCHED_AT - timedelta(days=140)
    assert "frozen copy" in error.detail
    assert "14 days" in error.detail


def test_a_frozen_batch_is_told_apart_from_a_shape_change() -> None:
    """Both empty the batch, and they send a person to completely different places."""
    broken = _iss_record()
    del broken["MEAN_MOTION"]

    with pytest.raises(ContractViolationError):
        parse_elements(_array(broken), group="g", fetched_at=FETCHED_AT)
    with pytest.raises(StaleElementsError):
        parse_elements(_batch_body(timedelta(days=30)), group="g", fetched_at=FETCHED_AT)


async def test_a_frozen_primary_falls_through_to_a_fresh_fallback(
    chain: CelestrakClient,
) -> None:
    """The whole point: a mirror serving last month must not blank or mislead the layer."""
    with respx.mock(assert_all_called=True) as router:
        router.get(RETLECTOR_STATIONS).respond(200, content=fixture_bytes(SATVISOR_FROZEN_FIXTURE))
        router.get(SATVISOR_STATIONS).respond(200, content=_batch_body(timedelta(hours=8)))

        satellites = await chain.elements("stations")

    assert satellites[0].source == SATVISOR.name
    assert chain.degraded_reason is None


async def test_every_provider_frozen_raises_the_freshest_frozen_reason(
    chain: CelestrakClient,
) -> None:
    """Three frozen mirrors is one reason, and it names the best of them, not the worst."""
    with respx.mock(assert_all_called=True) as router:
        router.get(RETLECTOR_STATIONS).respond(200, content=_batch_body(timedelta(days=40)))
        router.get(SATVISOR_STATIONS).respond(200, content=_batch_body(timedelta(days=20)))
        router.get(GP_URL).respond(200, content=_batch_body(timedelta(days=60)))

        with pytest.raises(StaleElementsError) as caught:
            await chain.elements("stations")

    age = FETCHED_AT - caught.value.newest_epoch
    assert age == timedelta(days=20), "the freshest frozen copy is the honest number to report"


async def test_a_degraded_batch_is_drawn_but_says_so(chain: CelestrakClient) -> None:
    """Between 3.5 and 14 days a pin is useful. Presenting it as current would not be."""
    with respx.mock(assert_all_called=True) as router:
        router.get(RETLECTOR_STATIONS).respond(200, content=_batch_body(timedelta(days=5)))
        router.get(SATVISOR_STATIONS).respond(200, content=_batch_body(timedelta(days=6)))
        router.get(GP_URL).respond(200, content=_batch_body(timedelta(days=7)))

        satellites = await chain.elements("stations")

    assert satellites, "degraded is drawn, not dropped"
    reason = chain.degraded_reason
    assert reason is not None
    assert "degraded" in reason
    assert "not current" in reason
    assert chain.unavailable_reason is None, "a layer with something to draw is available"


async def test_a_degraded_primary_does_not_end_the_walk(chain: CelestrakClient) -> None:
    """ "Prefer the fresher provider" is only a real choice when the first answer is stale.

    So a degraded batch costs one extra request and buys the fresher copy where one exists,
    while a fresh batch short-circuits and the fallback is never touched.
    """
    with respx.mock(assert_all_called=True) as router:
        router.get(RETLECTOR_STATIONS).respond(200, content=_batch_body(timedelta(days=9)))
        fallback = router.get(SATVISOR_STATIONS).respond(
            200, content=_batch_body(timedelta(hours=5))
        )

        satellites = await chain.elements("stations")

    assert fallback.call_count == 1
    assert satellites[0].source == SATVISOR.name
    assert chain.degraded_reason is None, "the fresher copy replaced the degraded one"


async def test_the_freshest_degraded_copy_wins_when_none_is_fresh(
    chain: CelestrakClient,
) -> None:
    """Every provider degraded still resolves to the newest orbit determination on offer."""
    with respx.mock(assert_all_called=True) as router:
        router.get(RETLECTOR_STATIONS).respond(200, content=_batch_body(timedelta(days=10)))
        router.get(SATVISOR_STATIONS).respond(200, content=_batch_body(timedelta(days=4)))
        router.get(GP_URL).respond(200, content=_batch_body(timedelta(days=12)))

        satellites = await chain.elements("stations")

    assert satellites[0].source == SATVISOR.name
    assert satellites[0].epoch == FETCHED_AT - timedelta(days=4)


def test_the_median_not_the_newest_decides_degradation() -> None:
    """One current element set in a frozen file must not clear the whole batch.

    Which is exactly the shape a half-refreshed mirror takes, so the statistic matters.
    """
    batch = parse_elements(
        _batch_body(timedelta(hours=1), timedelta(days=6), timedelta(days=7)),
        group="stations",
        fetched_at=FETCHED_AT,
    )

    assert batch.newest_epoch == FETCHED_AT - timedelta(hours=1)
    assert batch.degraded is True
    assert batch.median_age_s == pytest.approx(timedelta(days=6).total_seconds())


def test_freshness_reads_the_body_and_never_a_mirrors_metadata() -> None:
    """The rule the frozen mirror wrote: age comes off the epochs, from nothing else."""
    batch = parse_elements(
        _batch_body(timedelta(hours=2), timedelta(hours=4), timedelta(hours=30)),
        group="stations",
        fetched_at=FETCHED_AT,
        source=RETLECTOR.name,
    )

    assert batch.provider == RETLECTOR.name
    assert batch.newest_epoch == FETCHED_AT - timedelta(hours=2)
    assert batch.median_age_s == pytest.approx(4 * 3600.0)
    assert batch.degraded is False
    assert "median epoch age 4.0h" in batch.summary
    assert "3 element sets" in batch.summary


async def test_the_freshness_report_names_the_group_and_the_provider(
    chain: CelestrakClient,
) -> None:
    """``/api/layers`` needs the age of what is drawn, per group, not one number for the lot."""
    with respx.mock(assert_all_called=True) as router:
        router.get(RETLECTOR_STATIONS).respond(200, content=_batch_body(timedelta(hours=3)))
        router.get("https://retlector.eu/active/json").respond(
            200, content=_batch_body(timedelta(hours=9))
        )

        await chain.elements("stations")
        await chain.elements("active")

    reports = chain.freshness()
    assert [report.group for report in reports] == ["active", "stations"]
    assert {report.provider for report in reports} == {RETLECTOR.name}
    assert reports[1].median_age_s == pytest.approx(3 * 3600.0)


async def test_the_freshness_report_survives_a_restart(
    http: httpx.AsyncClient, clock: Clock, tmp_path: Path
) -> None:
    """A restarted process has to be able to say how old what it is serving is, and from where."""
    cache = DiskCache(tmp_path, clock=clock)
    with respx.mock(assert_all_called=True) as router:
        router.get(RETLECTOR_STATIONS).respond(
            200, content=_batch_body(timedelta(hours=6), timedelta(days=20))
        )
        await CelestrakClient(http, clock=clock, cache=cache).elements("stations")

    restarted = CelestrakClient(http, clock=clock, cache=cache)
    assert restarted.cached_provider("stations") == RETLECTOR.name

    report = restarted.freshness()[0]
    assert report.provider == RETLECTOR.name
    assert report.dropped_stale == 1
    assert report.median_age_s == pytest.approx(6 * 3600.0)


def test_a_batch_with_both_kinds_of_drop_reports_both(chain: CelestrakClient) -> None:
    """Unmappable and too-old are counted apart, or a frozen mirror hides in parser noise."""
    broken = _iss_record()
    del broken["BSTAR"]
    body = json.loads(_batch_body(timedelta(hours=4), timedelta(days=30)))
    body.append(broken)

    batch = parse_elements(json.dumps(body).encode(), group="stations", fetched_at=FETCHED_AT)

    assert len(batch.satellites) == 1
    assert batch.dropped_stale == 1
    assert batch.dropped_unmappable == 1
    assert "dropped as unmappable" in batch.summary
    assert "dropped as older than 14d" in batch.summary


# ---------------------------------------------------------------- the recorded ReTLEctor payloads


def test_the_recorded_retlector_iss_record_maps_like_a_celestrak_one() -> None:
    """Byte-for-byte the same contract, which is the whole reason this chain is possible."""
    satellites = _satellites(
        fixture_bytes(RETLECTOR_ISS_FIXTURE),
        group="stations",
        fetched_at=RETLECTOR_ISS_EPOCH + timedelta(hours=1),
        source=RETLECTOR.name,
    )

    assert len(satellites) == 1
    iss = satellites[0]
    assert iss.norad_cat_id == ISS_CATALOGUE_NUMBER
    assert iss.object_name == "ISS (ZARYA)"
    assert iss.object_id == "1998-067A"
    assert iss.epoch == RETLECTOR_ISS_EPOCH
    assert iss.source == RETLECTOR.name
    assert iss.epoch > ISS_EPOCH, "ReTLEctor was fresher than the CelesTrak capture"


def test_the_recorded_retlector_iss_record_matches_the_celestrak_keys() -> None:
    """Same 17 keywords, same order. A field added or renamed here would be a real change."""
    assert list(fixture_json(RETLECTOR_ISS_FIXTURE)[0]) == list(fixture_json(ISS_FIXTURE)[0])


def test_the_recorded_active_slice_survives_mixed_int_and_float_numerics() -> None:
    """The measured trap: one response sends ints and floats on the same OMM keyword.

    Across ReTLEctor's 16,399 active objects, ``MEAN_MOTION_DDOT`` arrived as an int on 16,302
    and a float on 97. A ``strict=True`` float field would drop those records for nothing, so
    the wire model is non-strict and this asserts it against the real slice.
    """
    records = fixture_json(RETLECTOR_ACTIVE_FIXTURE)
    kinds = {field: {type(row[field]).__name__ for row in records} for field in records[0]}
    assert kinds["MEAN_MOTION_DDOT"] == {"int", "float"}
    assert kinds["BSTAR"] == {"int", "float"}

    batch = parse_elements(
        fixture_bytes(RETLECTOR_ACTIVE_FIXTURE),
        group="active",
        fetched_at=FETCHED_AT,
        source=RETLECTOR.name,
    )
    assert batch.dropped_unmappable == 0, "no record is lost to a type the provider chose"
    assert len(batch.satellites) == len(records) - batch.dropped_stale


def test_the_recorded_active_slice_drops_only_what_is_too_old() -> None:
    """Exactly one of the 656 records is older than a fortnight at the fixed fetch instant."""
    batch = parse_elements(
        fixture_bytes(RETLECTOR_ACTIVE_FIXTURE),
        group="active",
        fetched_at=FETCHED_AT,
        source=RETLECTOR.name,
    )

    assert len(batch.satellites) == 655
    assert batch.dropped_stale == 1
    assert batch.degraded is False
    assert all(
        satellite.epoch_age_s(FETCHED_AT) <= MAX_ELEMENT_AGE_S for satellite in batch.satellites
    )


def test_the_recorded_active_slice_carries_the_modern_catalogue() -> None:
    """13 six-digit numbers and 130 ten-character designators, both unrepresentable in TLE.

    The 6-digit numbers are why the JSON path is not optional: CelesTrak exhausted the 5-digit
    catalogue on 2026-07-11 and the TLE format has no sixth column. The 10-character
    ``OBJECT_ID`` is the second half of the same trap, since a regex expecting
    ``YYYY-NNN[A-Z]`` drops every one of them.
    """
    batch = parse_elements(
        fixture_bytes(RETLECTOR_ACTIVE_FIXTURE),
        group="active",
        fetched_at=FETCHED_AT,
        source=RETLECTOR.name,
    )

    six_digit = [s for s in batch.satellites if s.norad_cat_id >= 100_000]
    long_designators = [s for s in batch.satellites if s.object_id and len(s.object_id) == 10]
    assert len(six_digit) == 13
    assert len(long_designators) == 130


def test_the_serialised_epoch_carries_a_z_because_json2satrec_appends_one() -> None:
    """The trap that empties the layer with nothing thrown, asserted at this adapter's output.

    ``json2satrec`` appends a ``Z`` when the string lacks one, so a ``+00:00`` suffix becomes
    ``+00:00Z``, ``new Date()`` rejects it, and every satellite comes back ``NaN``. The
    contract test asserts the serialiser; this asserts that what this adapter hands it still
    goes through the serialiser rather than round-tripping some other way.
    """
    iss = _satellites(
        fixture_bytes(RETLECTOR_ISS_FIXTURE),
        group="stations",
        fetched_at=RETLECTOR_ISS_EPOCH + timedelta(hours=1),
        source=RETLECTOR.name,
    )[0]

    payload = json.loads(iss.model_dump_json())
    assert payload["epoch"] == "2026-08-20T04:17:29.138208Z"
    assert "+00:00" not in payload["epoch"]


# ---------------------------------------------------------------- the live chain


@pytest.mark.live
async def test_live_the_primary_serves_the_iss_and_it_propagates_sanely() -> None:
    """The end-to-end proof: a real fetch, the real parser, the real contract.

    Run with ``uv run pytest -m live``. One request, well inside ReTLEctor's 60-per-60-seconds.
    """
    async with httpx.AsyncClient(timeout=30.0) as http:
        client = CelestrakClient(http, providers=(RETLECTOR,))
        satellites = await client.elements("stations")

    by_number = {satellite.norad_cat_id: satellite for satellite in satellites}
    assert ISS_CATALOGUE_NUMBER in by_number
    iss = by_number[ISS_CATALOGUE_NUMBER]

    assert iss.source == RETLECTOR.name
    assert iss.epoch.tzinfo is not None
    assert iss.epoch_age_s(datetime.now(UTC)) < MAX_ELEMENT_AGE_S
    assert 15.0 < iss.mean_motion < 16.0, "the ISS orbits about 15.5 times a day"
    assert 51.0 < iss.inclination_deg < 52.0, "the ISS inclination is 51.6 degrees"
    assert json.loads(iss.model_dump_json())["epoch"].endswith("Z")

    report = client.freshness()[0]
    assert report.degraded is False, "ReTLEctor's groups refresh every 4 to 12 hours"


@pytest.mark.live
async def test_live_the_fallback_serves_the_same_contract() -> None:
    """The fallback has to be real, not aspirational, so it is fetched too.

    ``stations`` rather than ``active`` on purpose: this mirror's biggest files are frozen and
    the freshness guard refuses them, which is the behaviour the non-live tests above assert.
    """
    async with httpx.AsyncClient(timeout=30.0) as http:
        client = CelestrakClient(http, providers=(SATVISOR,))
        satellites = await client.elements("stations")

    assert any(s.norad_cat_id == ISS_CATALOGUE_NUMBER for s in satellites)
    assert all(s.source == SATVISOR.name for s in satellites)


@pytest.mark.live
async def test_live_the_frozen_mirror_group_is_refused_rather_than_drawn() -> None:
    """The measured failure, against the live host. ``active.json`` was 147 days stale."""
    async with httpx.AsyncClient(timeout=60.0) as http:
        client = CelestrakClient(http, providers=(SATVISOR,))
        with pytest.raises(StaleElementsError):
            await client.elements("active")


@pytest.mark.live
async def test_live_celestrak_still_refuses_this_network() -> None:
    """Kept as a live check, because the day this fails is the day the block lifted.

    It asserts a refusal rather than an outage: a firewall drop or a reset, never a 200.
    """
    async with httpx.AsyncClient(timeout=35.0) as http:
        client = CelestrakClient(http, providers=(CELESTRAK,))
        with pytest.raises((SourceError, CelestrakStoppedError)):
            await client.elements("stations")

    reason = client.unavailable_reason
    assert reason is not None
    assert reason.strip()
