"""The enrichment join: registry metadata onto a live record, degrading to feed-only.

Both halves of every join here are real. The registry side is
``adsbdb_aircraft_live.json``, the whole 2026-08-19 body for Mode S address A835AF, read as
recorded and put through the real adapter in ``tracker.sources.adsbdb``. The feed side is
``adsb_point_live.json``, the live adsb.lol capture, put through the real parser in
``tracker.sources.adsb``.

The one thing these tests construct is the **pairing**. No recorded adsbdb body exists for
an address in the London capture, so the aircraft the A835AF body answers for is built from
the domain factory in ``tests/conftest.py`` carrying that address. Where a test needs a
disagreement or a rejected value it says so and changes one field, the way
``tests/services/test_union.py`` moves a recorded envelope timestamp and touches nothing
else.

Caching is not tested here because the service does not cache. ``sources/adsbdb.py`` owns
the cache, the TTL and the request budget, and ``tests/sources/test_adsbdb.py`` owns the
tests for all three. What is tested here is that this service keeps no memory of a failure
of its own, which is the part that would leave an aircraft permanently unenriched.
"""

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest

from tests.conftest import REFERENCE_TIME, FrozenClock, fixture_bytes, make_aircraft
from tracker.contracts.aircraft import Aircraft, AircraftClass
from tracker.services.enrich import Enricher
from tracker.sources.adsb import parse_response
from tracker.sources.adsbdb import SOURCE_NAME, AircraftRegistration, parse_aircraft

FEED = "adsb.lol"
POINT_FIXTURE = "adsb_point_live.json"
POINT_AIRCRAFT = 65
"""Records in the captured adsb.lol response, all of which carry a position."""

REGISTRY_FIXTURE = "adsbdb_aircraft_live.json"

RECORDED_HEX = "a835af"
"""The Mode S address the recorded adsbdb body answers for, in the domain's lowercase.

adsbdb answers uppercase whatever case it is asked in. Folding it is the adapter's job, and
this service hands the key over exactly as the domain holds it.
"""

RECORDED_REGISTRATION = "N628TS"
RECORDED_OWNER = "Falcon Landing LLC"
RECORDED_COUNTRY = "United States"
RECORDED_ICAO_TYPE = "G650"

UNHELD_HEX = "0201a0"
"""A real address from the London capture that adsbdb answers 404 for, checked live.

CN-RHF, a real aircraft with a real registration that adsbdb simply does not hold. About
one real aircraft in five misses, so a miss is normal operation rather than a fault.
"""

DESIGNATOR_MAX_CHARS = 4
"""``Aircraft.type_designator`` takes four characters, the width Doc 8643 gives a designator.

``AircraftRegistration.icao_type`` used to take eight, so the two contracts in this tree
disagreed and a legal registry record cost an airframe its whole enrichment. They now agree
and the adapter drops an over-long value where it arrives
(``tests/sources/test_adsbdb.py``), so no adsbdb record can reach the unmappable path any
more. The path stays and stays tested: phase 5 adds three national registers mapping into
this same shape, and the service is the only thing standing between a bad registry value and
a record served to a browser."""


def recorded_registration() -> AircraftRegistration:
    """The recorded adsbdb body through the real adapter."""
    return parse_aircraft(fixture_bytes(REGISTRY_FIXTURE), retrieved_at=REFERENCE_TIME)


def merge_registration(aircraft: Aircraft, facts: AircraftRegistration) -> Aircraft:
    """Apply an adsbdb record to a domain aircraft, the way the card will.

    Revalidates the whole record rather than patching it, so every constraint on the
    contract still applies to a value that came from a second-hand database. ``dict()`` over
    the model yields the real attribute values, so the nested ``Point`` and the
    timezone-aware timestamps survive strict validation untouched.
    """
    updates: dict[str, Any] = {
        "registration": facts.registration,
        "type_designator": facts.icao_type,
        "owner": facts.owner,
        "registered_country": facts.owner_country,
        # A Gulfstream G650 is a business jet. Classifying from the registry's type rather
        # than from the transponder is the phase 3 deliverable.
        "aircraft_class": AircraftClass.BUSINESS_JET,
    }
    return Aircraft.model_validate(dict(aircraft) | updates)


class ScriptedRegistry:
    """A registry double: one scripted answer per call, the last answer repeating.

    An exception in the script is raised rather than returned, which is the split the
    service branches on: a record is an answer, ``None`` is the answer "not held", and an
    exception is not an answer at all. ``BaseException`` rather than ``Exception`` because
    ``asyncio.CancelledError`` is not an ``Exception`` and has to reach the service as
    itself.

    It answers from a script rather than from a cache because the real lookup,
    ``AdsbdbLookup.aircraft``, is already cached: what matters here is what this service
    does with each kind of answer, and how many times it asks.
    """

    def __init__(self, *answers: AircraftRegistration | BaseException | None) -> None:
        self.answers = answers
        self.calls: list[str] = []

    async def __call__(self, key: str) -> AircraftRegistration | None:
        self.calls.append(key)
        answer = self.answers[min(len(self.calls) - 1, len(self.answers) - 1)]
        if isinstance(answer, BaseException):
            raise answer
        return answer


def build_enricher(
    registry: ScriptedRegistry,
    *,
    merge: Callable[[Aircraft, AircraftRegistration], Aircraft] = merge_registration,
) -> Enricher[Aircraft, AircraftRegistration]:
    return Enricher(
        registry=SOURCE_NAME,
        lookup=registry,
        merge=merge,
        key=lambda aircraft: aircraft.icao24,
        clock=FrozenClock(),
    )


def recorded_aircraft(**overrides: Any) -> Aircraft:
    """A feed record for the address the recorded registry body answers for."""
    return make_aircraft(icao24=RECORDED_HEX, callsign="N628TS", source=FEED, **overrides)


def captured_feed() -> tuple[Aircraft, ...]:
    """Every aircraft in the live adsb.lol capture, through the real parser."""
    return parse_response(fixture_bytes(POINT_FIXTURE), source=FEED)


def captured_aircraft(icao24: str) -> Aircraft:
    """One real record out of the live capture, by address."""
    return next(aircraft for aircraft in captured_feed() if aircraft.icao24 == icao24)


# ---------------------------------------------------------------- the join itself


async def test_a_recorded_registry_record_reaches_the_aircraft_with_both_provenances() -> None:
    """Acceptance 1: a business jet classified, with its registered owner, from real data.

    The record has to carry both halves of the join afterwards. The feed half is on the
    record itself, in ``source`` and ``observed_at``; the registry half is on the result. A
    merged record that cannot name both sides is unauditable.
    """
    registry = ScriptedRegistry(recorded_registration())
    result = await build_enricher(registry).enrich(recorded_aircraft())

    assert result.value.owner == RECORDED_OWNER
    assert result.value.registration == RECORDED_REGISTRATION
    assert result.value.registered_country == RECORDED_COUNTRY
    assert result.value.type_designator == RECORDED_ICAO_TYPE
    assert result.value.aircraft_class is AircraftClass.BUSINESS_JET

    assert result.registry == SOURCE_NAME
    assert result.joined_at == REFERENCE_TIME
    assert result.enriched
    assert result.error is None
    assert result.value.source == FEED
    assert result.value.observed_at == REFERENCE_TIME
    assert result.key == RECORDED_HEX
    assert registry.calls == [RECORDED_HEX]

    # Both branches of "the feed did not supply this": registration was None and
    # aircraft_class held the contract's own default. Neither is a conflict.
    assert result.conflicts == ()


async def test_a_registry_that_does_not_hold_the_address_leaves_the_feed_record_alone() -> None:
    """A miss is an answer, not a fault. The record comes back as the same object."""
    feed_record = captured_aircraft(UNHELD_HEX)
    registry = ScriptedRegistry(None)
    enricher = build_enricher(registry)

    result = await enricher.enrich(feed_record)

    assert result.value is feed_record
    assert not result.enriched
    assert result.error is None
    assert result.registry is None
    assert result.joined_at == REFERENCE_TIME
    assert enricher.tally.not_held == 1
    assert enricher.tally.failures == 0


async def test_the_default_clock_dates_the_join_in_aware_utc() -> None:
    """Every other test injects a clock. The one nobody injects has to be UTC-aware.

    A naive default would be a validation error anywhere in the domain, and any arithmetic
    against an aware timestamp would raise on the first comparison.
    """
    enricher: Enricher[Aircraft, AircraftRegistration] = Enricher(
        registry=SOURCE_NAME,
        lookup=ScriptedRegistry(recorded_registration()),
        merge=merge_registration,
        key=lambda aircraft: aircraft.icao24,
    )

    result = await enricher.enrich(recorded_aircraft())

    assert result.joined_at.tzinfo is UTC
    assert abs((result.joined_at - datetime.now(UTC)).total_seconds()) < 5


# ---------------------------------------------------------------- failure degrades, never errors


async def test_a_registry_failure_degrades_to_feed_only_and_never_raises() -> None:
    """The card keeps everything the feed gave us. Losing the owner beats losing the jet.

    ``ConnectTimeout`` carries no message, which is why the reason is rendered rather than
    interpolated: an empty reason reads as broken for no stated cause.
    """
    feed_record = recorded_aircraft()
    registry = ScriptedRegistry(httpx.ConnectTimeout(""))
    enricher = build_enricher(registry)

    result = await enricher.enrich(feed_record)

    assert result.value is feed_record
    assert result.value.point == feed_record.point
    assert result.value.callsign == feed_record.callsign
    assert result.error is not None
    assert not result.enriched
    assert result.error == "ConnectTimeout"
    assert result.joined_at == REFERENCE_TIME
    assert enricher.tally.failures == 1
    assert enricher.tally.last_error == "ConnectTimeout"


async def test_every_record_in_a_real_capture_survives_a_registry_that_is_down() -> None:
    """65 real aircraft, a registry answering nothing, 65 aircraft still on the globe.

    Run over the whole capture because the failure this guards is not one card: it is a
    layer that empties when a second-hand database goes down.
    """
    feed = captured_feed()
    assert len(feed) == POINT_AIRCRAFT
    registry = ScriptedRegistry(httpx.ReadTimeout(""))
    enricher = build_enricher(registry)

    results = [await enricher.enrich(aircraft) for aircraft in feed]

    assert [r.value for r in results] == list(feed)
    assert all(r.error is not None and not r.enriched for r in results)
    assert enricher.tally.failures == POINT_AIRCRAFT
    assert enricher.tally.requests == POINT_AIRCRAFT


async def test_a_failure_leaves_no_trace_so_the_next_attempt_is_a_real_attempt() -> None:
    """The second-most-obvious bug: a timeout remembered as "no owner", for ever.

    The aircraft would stay unenriched for the life of the process and it would read as thin
    registry coverage rather than as a fault. The lookup below would answer on a second call
    and this service has to give it one.
    """
    registry = ScriptedRegistry(httpx.ConnectTimeout(""), recorded_registration())
    enricher = build_enricher(registry)

    first = await enricher.enrich(recorded_aircraft())
    second = await enricher.enrich(recorded_aircraft())

    assert first.error is not None
    assert first.value.owner is None
    assert second.enriched
    assert second.value.owner == RECORDED_OWNER
    assert registry.calls == [RECORDED_HEX, RECORDED_HEX]
    assert enricher.tally.failures == 1
    assert enricher.tally.enriched == 1


async def test_a_cancelled_lookup_is_not_swallowed_into_a_feed_only_record() -> None:
    """Shutdown has to propagate. Cancellation is not an upstream fault to be absorbed."""
    registry = ScriptedRegistry(asyncio.CancelledError())
    enricher = build_enricher(registry)

    with pytest.raises(asyncio.CancelledError):
        await enricher.enrich(recorded_aircraft())

    assert enricher.tally.failures == 0


# ---------------------------------------------------------------- conflicts


async def test_the_feed_keeps_a_registration_it_supplied_and_the_registry_value_is_kept() -> None:
    """R2 in ``docs/pending-decisions.md`` starting to bite, on the field where it happens.

    Two real registrations from two real captures: the feed's record here carries CN-RHF,
    which is what adsb.lol reported for one of the 65 aircraft in the London capture, and
    the recorded adsbdb body says N628TS. The pairing is this test's construction. What it
    settles is which value reaches the card and what happens to the other one.

    The feed keeps the field because its value is dated and the registry's is not: adsbdb
    carries no date of its own, which is why the adapter's ``retrieved_at`` is our fetch
    time and not an extract date, and an undated claim does not displace a timestamped one.
    The registry's value is kept beside it as a conflict rather than dropped, so a card can
    show the disagreement.
    """
    feed_registration = captured_aircraft(UNHELD_HEX).registration
    assert feed_registration == "CN-RHF"
    feed_record = recorded_aircraft(registration=feed_registration)
    registry = ScriptedRegistry(recorded_registration())
    enricher = build_enricher(registry)

    result = await enricher.enrich(feed_record)

    assert result.value.registration == feed_registration
    assert [c.attribute for c in result.conflicts] == ["registration"]
    assert result.conflicts[0].feed_value == feed_registration
    assert result.conflicts[0].registry_value == RECORDED_REGISTRATION
    # The registry still fills what the feed left empty, in the same pass.
    assert result.value.owner == RECORDED_OWNER
    assert result.enriched
    assert result.error is None
    assert enricher.tally.conflicts == 1


async def test_enrichment_cannot_move_the_aircraft_or_restamp_its_observation() -> None:
    """The structural half of feed-wins, not a rule anyone has to remember.

    A merge that rewrites the position or the observation time gets reverted and says so.
    The point is that this holds whatever the injected merge does, so a registry adapter
    written in phase 5 cannot quietly relocate an aircraft.
    """

    def hostile_merge(aircraft: Aircraft, facts: AircraftRegistration) -> Aircraft:
        moved = dict(aircraft) | {
            "point": captured_aircraft(UNHELD_HEX).point,
            "observed_at": REFERENCE_TIME + timedelta(hours=1),
            "owner": facts.owner,
        }
        return Aircraft.model_validate(moved)

    feed_record = recorded_aircraft()
    registry = ScriptedRegistry(recorded_registration())
    enricher = build_enricher(registry, merge=hostile_merge)

    result = await enricher.enrich(feed_record)

    assert result.value.point == feed_record.point
    assert result.value.observed_at == feed_record.observed_at
    assert result.value.owner == RECORDED_OWNER
    assert sorted(c.attribute for c in result.conflicts) == ["observed_at", "point"]
    assert enricher.tally.conflicts == 2


# ---------------------------------------------------------------- facts that will not map


async def test_registry_facts_the_aircraft_contract_rejects_leave_the_record_unenriched() -> None:
    """Dropped and counted, applied to enrichment, and the record still renders.

    The last line of defence rather than the first. adsbdb can no longer trip this, because
    the two contracts now agree on width and the adapter drops an over-long identifier where
    it arrives, which is what stops one bad field costing an airframe its owner and its
    class. This asserts what the service does when a registry gets past that anyway, which
    is the position phase 5 puts it in with three more registers to map: the value never
    reaches the record and a 500 never reaches the card.

    ``model_copy`` is deliberate. It skips validation, which is the only way to hand the
    service a fact its own contract would have refused.
    """
    recorded = recorded_registration()
    assert recorded.icao_type is not None
    facts = recorded.model_copy(update={"icao_type": "G650" + "ER" * 2})
    assert len(facts.icao_type or "") > DESIGNATOR_MAX_CHARS
    feed_record = recorded_aircraft()
    enricher = build_enricher(ScriptedRegistry(facts))

    result = await enricher.enrich(feed_record)

    assert result.value is feed_record
    assert result.value.owner is None
    assert result.value.type_designator is None
    assert result.error is not None
    assert not result.enriched
    assert result.error is not None
    assert result.error.startswith("ValidationError")
    assert result.joined_at == REFERENCE_TIME
    assert enricher.tally.unmappable == 1
    assert enricher.tally.failures == 0
