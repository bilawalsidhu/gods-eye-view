"""Aircraft classification, driven by the recorded live payloads rather than by fixtures
built to suit the classifier.

Everything here runs a real captured response through the real parser in
``tracker.sources.adsb`` and asserts the class that came out. That order matters: a
classifier tested against hand-built records agrees with whatever the test author
believed the feed sends, and the whole point of ``adsb_type_glf6_live.json`` is that 18
real Gulfstream G650s broadcast emitter category ``A3``, the same category an airliner
sends, so category can never stand in for a type designator.

Payloads used, with what each one proves:

``adsb_type_glf6_live.json``
    18 real G650s from ``/v2/type/GLF6`` on 2026-08-19. Business-jet classification, and
    the ADR 009 rule that the LADD bit changes nothing: 16 of the 18 carry ``dbFlags: 8``.

``adsb_mil_live.json``
    391 real ``/v2/mil`` records, every one carrying ``dbFlags: 1``. Military
    classification, and that military beats the rotorcraft category on the 103 records
    that broadcast ``A7``.

``adsb_point_live.json``
    65 real aircraft over central London. One real EC135 helicopter, and the airliners
    that must stay ``UNKNOWN`` because no ADS-B field says who is operating them.

``adsb_pia_live.json``
    The live ``/v2/pia`` response, captured 2026-08-20. See
    :func:`test_the_recorded_privacy_payload_carries_the_bit_and_no_position` for why the
    privacy-address branch is asserted the way it is.
"""

import pytest

from tests.conftest import fixture_bytes, fixture_json
from tracker.contracts.aircraft import Aircraft, AircraftClass
from tracker.services.classify import (
    BUSINESS_JET_TYPE_DESIGNATORS,
    ROTORCRAFT_CATEGORY,
    classified,
    classify,
)
from tracker.sources.adsb import DB_FLAG_LADD, DB_FLAG_PRIVACY_ICAO, parse_response

GLF6_PAYLOAD = "adsb_type_glf6_live.json"
MIL_PAYLOAD = "adsb_mil_live.json"
POINT_PAYLOAD = "adsb_point_live.json"
PIA_PAYLOAD = "adsb_pia_live.json"

GLF6_AIRCRAFT_COUNT = 18
GLF6_WITH_LADD_BIT = 16
"""16 of the 18 recorded G650s carry ``dbFlags: 8``, the readsb LADD bit."""

MIL_AIRCRAFT_COUNT = 310
"""310 of the 391 military records carry a position; the other 81 were heard, not located."""

MIL_ROTORCRAFT_RECORDS = 103
"""Military records broadcasting emitter category A7. Military has to win on all of them."""

HELICOPTER_ICAO24 = "407fdd"
"""A real Airbus EC135 over London, ``t: EC35``, category ``A7``, no database flags."""

MILITARY_HELICOPTER_ICAO24 = "ae3333"
"""A real Sikorsky H-60, ``dbFlags: 1`` and category ``A7`` on the same record."""


def _parse(name: str) -> tuple[Aircraft, ...]:
    return parse_response(fixture_bytes(name), source="adsb.lol")


def _by_icao24(name: str, icao24: str) -> Aircraft:
    found = next((a for a in _parse(name) if a.icao24 == icao24), None)
    assert found is not None, f"{icao24} is not in {name}; the recorded payload changed"
    return found


# ---------------------------------------------------------------- business jets


def test_the_live_gulfstream_response_classifies_as_business_jets() -> None:
    aircraft = _parse(GLF6_PAYLOAD)

    assert len(aircraft) == GLF6_AIRCRAFT_COUNT
    assert {a.type_designator for a in aircraft} == {"GLF6"}
    assert all(a.aircraft_class is AircraftClass.BUSINESS_JET for a in aircraft)


def test_the_gulfstreams_broadcast_an_airliner_category() -> None:
    """The reason classification is keyed on the designator and not on the category.

    17 of the 18 real G650s send ``A3``, "large aeroplane", which is what a Boeing 737
    sends. Classifying on the emitter category would call every business jet an airliner
    and every airliner a business jet.
    """
    categories = {a.category for a in _parse(GLF6_PAYLOAD)}

    assert categories == {"A3", None}


def test_the_ladd_bit_does_not_change_a_business_jets_class() -> None:
    """ADR 009: LADD is not applied, so bit 8 is not a branch anywhere.

    16 of the 18 recorded G650s are on the FAA's Limiting Aircraft Data Displayed
    programme according to the feed's own database. They classify identically to the two
    that are not, and neither is suppressed.
    """
    payload = fixture_json(GLF6_PAYLOAD)
    flagged = [r["hex"] for r in payload["ac"] if (r.get("dbFlags") or 0) & DB_FLAG_LADD]

    assert len(flagged) == GLF6_WITH_LADD_BIT

    aircraft = {a.icao24: a for a in _parse(GLF6_PAYLOAD)}
    assert all(aircraft[hex_].aircraft_class is AircraftClass.BUSINESS_JET for hex_ in flagged)


def test_a_designator_is_matched_case_and_whitespace_insensitively() -> None:
    """Feeds send the designator uppercase, and one that does not must still classify."""
    jet = _parse(GLF6_PAYLOAD)[0]
    scruffy = jet.model_copy(update={"type_designator": " glf6 "})

    assert classify(scruffy) is AircraftClass.BUSINESS_JET


# ---------------------------------------------------------------- military


def test_every_live_military_record_classifies_as_military() -> None:
    aircraft = _parse(MIL_PAYLOAD)

    assert len(aircraft) == MIL_AIRCRAFT_COUNT
    assert all(a.is_military for a in aircraft)
    assert all(a.aircraft_class is AircraftClass.MILITARY for a in aircraft)


def test_military_beats_the_rotorcraft_category_on_a_real_record() -> None:
    """A military helicopter is military, and the live sample is full of them."""
    rotorcraft = [a for a in _parse(MIL_PAYLOAD) if a.category == ROTORCRAFT_CATEGORY]

    assert len(rotorcraft) <= MIL_ROTORCRAFT_RECORDS
    assert rotorcraft
    assert all(a.aircraft_class is AircraftClass.MILITARY for a in rotorcraft)

    blackhawk = _by_icao24(MIL_PAYLOAD, MILITARY_HELICOPTER_ICAO24)
    assert blackhawk.category == ROTORCRAFT_CATEGORY
    assert blackhawk.is_military is True
    assert blackhawk.aircraft_class is AircraftClass.MILITARY


# ---------------------------------------------------------------- rotorcraft


def test_a_real_civil_rotorcraft_classifies_as_a_helicopter() -> None:
    helicopter = _by_icao24(POINT_PAYLOAD, HELICOPTER_ICAO24)

    assert helicopter.category == ROTORCRAFT_CATEGORY
    assert helicopter.is_military is False
    assert helicopter.aircraft_class is AircraftClass.HELICOPTER


# ---------------------------------------------------------------- privacy addresses


def test_the_recorded_privacy_payload_carries_the_bit_and_no_position() -> None:
    """Why the branch below is asserted against a modified real record.

    ``https://api.adsb.lol/v2/pia`` was polled eleven times over about three minutes on
    2026-08-20. It returned at most one aircraft each time, always the same Mode S
    contact, and never once a position: the record carries ``rr_lat`` and ``rr_lon``,
    which is the receiver's own rough reckoning, and no ``lat`` or ``lon``. The parser
    therefore drops it, correctly, because putting it at (0, 0) would draw a phantom
    aircraft in the Gulf of Guinea.

    So there is no real positioned privacy-address payload to record, and this test
    asserts what the real one does say rather than inventing one that says more.
    """
    payload = fixture_json(PIA_PAYLOAD)
    (record,) = payload["ac"]

    assert record["dbFlags"] & DB_FLAG_PRIVACY_ICAO
    assert "lat" not in record
    assert "lon" not in record
    assert _parse(PIA_PAYLOAD) == ()


def test_a_privacy_address_classifies_as_anonymous() -> None:
    """Per ADR 009 the aircraft displays anonymised until phase 11 correlates it.

    Built from a real parsed G650 with the one flag set that the recorded ``/v2/pia``
    record proves real aircraft carry, because no positioned privacy-address payload
    exists to record. Anonymous ahead of business jet is the precedence being asserted.
    """
    jet = _parse(GLF6_PAYLOAD)[0]
    assert jet.aircraft_class is AircraftClass.BUSINESS_JET

    anonymised = jet.model_copy(update={"uses_privacy_address": True})

    assert classify(anonymised) is AircraftClass.ANONYMOUS
    assert classified(anonymised).uses_privacy_address is True


def test_military_beats_a_privacy_address() -> None:
    jet = _parse(GLF6_PAYLOAD)[0]
    both = jet.model_copy(update={"uses_privacy_address": True, "is_military": True})

    assert classify(both) is AircraftClass.MILITARY


# ---------------------------------------------------------------- unknown


def test_live_airliners_stay_unknown() -> None:
    """No ADS-B field says an aircraft is in commercial service, so nothing claims it.

    The London capture is mostly scheduled airline traffic. Every one of those records
    reaches the domain as ``UNKNOWN``, which is the honest answer, and none of them is
    guessed at from altitude, speed or the shape of its callsign.
    """
    airliners = [a for a in _parse(POINT_PAYLOAD) if a.type_designator in {"A320", "A20N", "B738"}]

    assert len(airliners) >= 3
    assert all(a.aircraft_class is AircraftClass.UNKNOWN for a in airliners)
    assert all(a.callsign for a in airliners)


def test_a_record_with_no_designator_and_no_category_stays_unknown() -> None:
    jet = _parse(GLF6_PAYLOAD)[0]
    bare = jet.model_copy(update={"type_designator": None, "category": None})

    assert classify(bare) is AircraftClass.UNKNOWN


# ---------------------------------------------------------------- the designator set


@pytest.mark.parametrize(
    ("designator", "why"),
    [
        ("CRJ2", "Doc 8643 names it CANADAIR CL-600 Challenger 800; it is a regional jet"),
        ("A320", "airliner, and an Airbus Corporate Jet shares the designator"),
        ("B738", "airliner, and a Boeing Business Jet shares the designator"),
        ("E170", "regional airliner"),
        ("B350", "Beech King Air 350, description code L2T, a turboprop not a jet"),
        ("P180", "Piaggio Avanti, description code L2T, a turboprop not a jet"),
        ("G159", "Grumman Gulfstream 1, description code L2T, a turboprop not a jet"),
        ("H60", "rotorcraft"),
        ("EC35", "rotorcraft"),
    ],
)
def test_the_designator_set_excludes_known_traps(designator: str, why: str) -> None:
    """Each of these is a real Doc 8643 designator that must not read as a business jet."""
    assert designator not in BUSINESS_JET_TYPE_DESIGNATORS, why


def test_every_designator_in_the_set_is_the_shape_icao_publishes() -> None:
    """Doc 8643 designators are two to four uppercase alphanumerics, and the contract
    caps ``type_designator`` at four characters, so a longer entry could never match."""
    assert BUSINESS_JET_TYPE_DESIGNATORS
    assert all(2 <= len(d) <= 4 for d in BUSINESS_JET_TYPE_DESIGNATORS)
    assert all(d.isalnum() and d.isupper() for d in BUSINESS_JET_TYPE_DESIGNATORS)


# ---------------------------------------------------------------- applying the class


def test_classified_returns_the_same_object_when_the_class_already_fits() -> None:
    """Idempotent, so the provider union can apply it again without allocating."""
    jet = _parse(GLF6_PAYLOAD)[0]

    assert classified(jet) is jet
    assert classified(classified(jet)) is jet


def test_classified_replaces_a_wrong_class_and_changes_nothing_else() -> None:
    jet = _parse(GLF6_PAYLOAD)[0]
    mislabelled = jet.model_copy(update={"aircraft_class": AircraftClass.COMMERCIAL})

    fixed = classified(mislabelled)

    assert fixed.aircraft_class is AircraftClass.BUSINESS_JET
    assert fixed.model_dump(exclude={"aircraft_class"}) == jet.model_dump(
        exclude={"aircraft_class"}
    )
