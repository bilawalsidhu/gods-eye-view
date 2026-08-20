"""The CelesTrak adapter: the two-hour floor, the cache, the latch and the OMM mapping.

No network except the one test marked ``live``, which is deselected by the gate's
``-m "not live"``. Everything else runs against the recorded payloads on disk, because
CelesTrak was unreachable when this was written (TCP 443 and 80 both dead from two
independent networks on 2026-08-20, ``connect=0.000000``, with the site serving a week
earlier).

The floor gets more attention than anything else here. CelesTrak firewalls abusive clients
without appeal and there is no way back, so the tests do not merely check that the default
happens to be two hours: they check that no configuration path exists which could lower it.
"""

import inspect
import json
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
import respx

from tests.conftest import fixture_bytes, fixture_json
from tracker.contracts.base import ContractViolationError
from tracker.contracts.satellite import Satellite
from tracker.services.poller import Poller
from tracker.sources.base import SourceError
from tracker.sources.celestrak import (
    GP_FORMAT,
    GP_URL,
    MIN_GROUP_INTERVAL_S,
    SOURCE_NAME,
    CelestrakClient,
    CelestrakStoppedError,
    _CachedGroup,
    parse_elements,
)

ISS_FIXTURE = "celestrak_iss_omm.json"
TDRS_FIXTURE = "celestrak_catnr19548_omm_wayback20260310.json"

ISS_CATALOGUE_NUMBER = 25544
TDRS_CATALOGUE_NUMBER = 19548

ISS_EPOCH = datetime(2026, 8, 19, 12, 48, 46, 640160, tzinfo=UTC)
"""The recorded ISS epoch, read straight out of the fixture and stamped UTC."""

TDRS_EPOCH = datetime(2026, 3, 5, 19, 9, 20, 611872, tzinfo=UTC)

FETCHED_AT = datetime(2026, 8, 20, 9, 0, 0, tzinfo=UTC)
"""A fixed fetch instant, so cadence boundaries are exact rather than approximate."""

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
    return CelestrakClient(http, clock=clock)


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
    assert "will not ask again" in reason


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


def test_a_feed_that_has_never_answered_is_not_healthy(client: CelestrakClient) -> None:
    """Never-fetched is unavailable, not an empty layer that looks like a working one."""
    assert client.unavailable_reason == "CelesTrak has not been queried yet"
    assert client.cached_elements() == ()
    assert client.cached_at("stations") is None


# ---------------------------------------------------------------- the OMM mapping


def test_parses_the_recorded_iss_element_set() -> None:
    """Every field, against the payload as recorded. No hand-written record here."""
    satellites = parse_elements(fixture_bytes(ISS_FIXTURE), group="stations", fetched_at=FETCHED_AT)
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
    satellites = parse_elements(fixture_bytes(TDRS_FIXTURE), group="geo", fetched_at=FETCHED_AT)
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

    iss = parse_elements(fixture_bytes(ISS_FIXTURE), group="stations", fetched_at=FETCHED_AT)[0]
    assert iss.epoch.tzinfo is not None
    assert iss.epoch.utcoffset() == timedelta(0)
    assert iss.epoch == ISS_EPOCH
    assert iss.epoch.microsecond == 640160, "microsecond precision survives the mapping"


def test_an_epoch_arriving_with_an_offset_is_converted_not_relabelled() -> None:
    """If CelesTrak ever starts sending an offset, the instant must not shift."""
    record = _iss_record()
    record["EPOCH"] = "2026-08-19T14:48:46.640160+02:00"
    satellite = parse_elements(_array(record), group="stations", fetched_at=FETCHED_AT)[0]
    assert satellite.epoch == ISS_EPOCH


def test_a_multi_record_array_maps_every_record() -> None:
    """A group query is an array. Both recorded records, in one response."""
    satellites = parse_elements(
        _array(_iss_record(), _tdrs_record()), group="stations", fetched_at=FETCHED_AT
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
    satellite = parse_elements(_array(record), group="active", fetched_at=FETCHED_AT)[0]
    assert satellite.norad_cat_id == 100147


def test_an_analyst_object_with_no_name_or_designator_maps() -> None:
    """80000-series analyst objects carry neither ``OBJECT_NAME`` nor ``OBJECT_ID``."""
    record = _iss_record()
    record["NORAD_CAT_ID"] = 80001
    del record["OBJECT_NAME"]
    del record["OBJECT_ID"]

    satellite = parse_elements(_array(record), group="analyst", fetched_at=FETCHED_AT)[0]
    assert satellite.object_name is None
    assert satellite.object_id is None
    assert satellite.label == "80001"


def test_a_blank_name_becomes_none_rather_than_an_empty_string() -> None:
    """TLE output space-pads names, so a blank must not survive as a display value."""
    record = _iss_record()
    record["OBJECT_NAME"] = "   "
    record["OBJECT_ID"] = ""
    satellite = parse_elements(_array(record), group="stations", fetched_at=FETCHED_AT)[0]
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

    satellites = parse_elements(
        _array(bad, _tdrs_record()), group="stations", fetched_at=FETCHED_AT
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
    satellites = parse_elements(
        _array(record, _tdrs_record()), group="stations", fetched_at=FETCHED_AT
    )
    assert [s.norad_cat_id for s in satellites] == [TDRS_CATALOGUE_NUMBER]


def test_a_non_object_element_is_dropped() -> None:
    """A stray string or null in the array is one dropped record, not a dead layer."""
    satellites = parse_elements(
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

    satellites = parse_elements(_array(record), group="stations", fetched_at=FETCHED_AT)
    assert satellites[0].norad_cat_id == ISS_CATALOGUE_NUMBER


def test_numeric_strings_parse_so_a_space_track_payload_would_map() -> None:
    """CelesTrak sends numbers, Space-Track sends the same fields as strings."""
    record = {key: str(value) for key, value in _iss_record().items()}
    satellites = parse_elements(_array(record), group="stations", fetched_at=FETCHED_AT)
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
        parse_elements(body, group="stations", fetched_at=FETCHED_AT)


def test_an_array_whose_records_all_fail_is_a_contract_violation() -> None:
    """One dropped OMM keyword upstream must not read as an empty sky.

    Individual bad records are dropped and counted, but a 200 where **nothing** maps means
    the provider changed shape. Returning an empty tuple there is the same outcome
    ``_require_omm_array`` refuses for an empty array: a blank layer behind a healthy poll.
    """
    broken = _iss_record()
    del broken["MEAN_MOTION"]

    with pytest.raises(ContractViolationError) as caught:
        parse_elements(_array(*[broken] * 30), group="stations", fetched_at=FETCHED_AT)

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
    client._cache["stations"] = _CachedGroup(fetched_at=FETCHED_AT, satellites=())

    assert client.cached_elements() == ()
    reason = client.unavailable_reason
    assert reason is not None
    assert "has not served an element set" in reason or "has not been queried" in reason


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
    iss = parse_elements(fixture_bytes(ISS_FIXTURE), group="stations", fetched_at=FETCHED_AT)[0]
    assert not iss.is_stale_at(ISS_EPOCH + timedelta(days=3))
    assert iss.is_stale_at(ISS_EPOCH + timedelta(days=4))
    assert iss.epoch_age_s(ISS_EPOCH + timedelta(hours=1)) == pytest.approx(3600.0)


def test_the_recorded_geostationary_set_is_long_stale_against_today() -> None:
    """The TDRS 3 capture is five months old, and the guard says so."""
    tdrs = parse_elements(fixture_bytes(TDRS_FIXTURE), group="geo", fetched_at=FETCHED_AT)[0]
    assert tdrs.is_stale_at(FETCHED_AT)


async def test_the_default_clock_is_real_utc_time(http: httpx.AsyncClient) -> None:
    """With no clock injected the floor runs on real UTC, not on a test double."""
    client = CelestrakClient(http)
    with respx.mock(assert_all_called=True) as router:
        router.get(GP_URL).respond(200, content=fixture_bytes(ISS_FIXTURE))
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
        client = CelestrakClient(http)
        satellites: tuple[Satellite, ...] = await client.elements("stations")

    assert satellites, "the stations group is never empty"
    assert any(s.norad_cat_id == ISS_CATALOGUE_NUMBER for s in satellites)
    assert all(s.epoch.tzinfo is not None for s in satellites)
    assert all(s.source == SOURCE_NAME for s in satellites)
    assert client.unavailable_reason is None
