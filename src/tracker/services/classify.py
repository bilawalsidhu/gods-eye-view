"""Aircraft classification, over the domain contract rather than inside an adapter.

Every ADS-B provider we use serves the same readsb ``/v2`` schema, so classification is
the same job whichever provider supplied the record. Keeping it here means one
implementation for the provider union in :mod:`tracker.services.union` to feed, and it
means the rules are testable against a recorded payload without a client, a poller or a
network.

:func:`classified` is idempotent and returns the record unchanged when the class it
resolves is the one already on it, so it is safe to apply again after a union merge. This
module imports from :mod:`tracker.contracts` only, so an adapter calling it cannot create
an import cycle.

What is deliberately not classified
-----------------------------------
``COMMERCIAL`` and ``GENERAL_AVIATION`` are never returned. Commercial operation is a
fact about who is flying the aircraft and why, and no ADS-B field carries it: a Gulfstream
G650 on charter is a commercial flight and an Airbus A319 in corporate use is not, and
both broadcast exactly what their airframe is. The emitter category cannot stand in for
it either, because the live capture of 18 real G650s
(``tests/fixtures/adsb_type_glf6_live.json``) shows 17 of them broadcasting ``A3``, the
same category an airliner sends. An aircraft we cannot place is ``UNKNOWN``, which is an
honest answer, and guessing a class from altitude, speed or the shape of a callsign would
be inference presented as observation.

Two known ceilings, both from the type designator itself rather than from this code:

- **An airliner converted to a corporate jet is invisible here.** A Boeing Business Jet
  broadcasts ``B738`` and an Airbus Corporate Jet broadcasts ``A319``, the same
  designators as the airline aircraft, so no designator set can separate them. Telling
  them apart needs the registry owner from phase 3 enrichment, not the designator.
- **Business turboprops are out of scope of the class, not overlooked.** ``B350`` (Beech
  King Air 350) and ``P180`` (Piaggio Avanti) are verified Doc 8643 records with
  description code ``L2T``, so they are not jets and ``BUSINESS_JET`` would be wrong.
  A separate class would be needed, and nobody has asked for one.

LADD is not applied and there is no LADD branch below, per ADR 009: the FAA's Limiting
Aircraft Data Displayed programme binds feeds the FAA itself supplies, and every position
here comes from volunteer receivers. ``dbFlags`` bit 8 is the LADD bit, it reaches the domain
as :attr:`~tracker.contracts.aircraft.Aircraft.on_ladd`, and 16 of the 18 recorded G650s carry
it. They classify as ``BUSINESS_JET`` like the other two, and a test asserts exactly that.
The flag is an attribute on the card and never a class, because being on a privacy programme
says something about the owner rather than about what the airframe is.
"""

from typing import Final

from tracker.contracts.aircraft import Aircraft, AircraftClass

ROTORCRAFT_CATEGORY: Final = "A7"
"""ADS-B emitter category A7, rotorcraft. Broadcast by the aircraft, not looked up."""

BUSINESS_JET_TYPE_DESIGNATORS: Final = frozenset(
    {
        # Gulfstream and its Israel Aerospace Industries predecessors.
        "ASTR",  # GULFSTREAM AEROSPACE Gulfstream G100
        "G150",  # GULFSTREAM AEROSPACE Gulfstream G150
        "G280",  # GULFSTREAM AEROSPACE Gulfstream G280
        "GA5C",  # GULFSTREAM AEROSPACE G-7 Gulfstream G500
        "GA6C",  # GULFSTREAM AEROSPACE G-7 Gulfstream G600
        "GA7C",  # GULFSTREAM AEROSPACE G-8 Gulfstream G700
        "GALX",  # GULFSTREAM AEROSPACE Gulfstream G200
        "GLF2",  # GRUMMAN C-20J Gulfstream 2SP
        "GLF3",  # GULFSTREAM AEROSPACE C-20A Gulfstream 3
        "GLF4",  # GULFSTREAM AEROSPACE C-20F Gulfstream 4
        "GLF5",  # GULFSTREAM AEROSPACE C-37 Gulfstream 5
        "GLF6",  # GULFSTREAM AEROSPACE Gulfstream G650
        "WW23",  # IAI 1123 Westwind
        "WW24",  # IAI 1124 Sea Scan
        # Bombardier Challenger and Global.
        "CL30",  # BOMBARDIER BD-100 Challenger 300
        "CL35",  # BOMBARDIER BD-100 Challenger 350
        "CL60",  # BOMBARDIER CL-600 Challenger 650
        "GL5T",  # BOMBARDIER BD-700 Global 5000
        "GL7T",  # BOMBARDIER BD-700 Global 7000
        "GLEX",  # BOMBARDIER BD-700 Global Express
        # Learjet.
        "LJ23",  # LEAR JET 23
        "LJ24",  # GATES LEARJET 24
        "LJ25",  # GATES LEARJET 25
        "LJ28",  # GATES LEARJET 28
        "LJ31",  # GATES LEARJET 31
        "LJ35",  # GATES LEARJET 35
        "LJ40",  # LEARJET 40
        "LJ45",  # LEARJET 45
        "LJ55",  # GATES LEARJET 55
        "LJ60",  # LEARJET 60
        "LJ70",  # LEARJET 70
        "LJ75",  # LEARJET 75
        # Dassault Falcon.
        "F2TH",  # DASSAULT Falcon 2000
        "F900",  # DASSAULT Falcon 900
        "FA10",  # DASSAULT Falcon 10
        "FA20",  # DASSAULT Falcon 20
        "FA50",  # DASSAULT Falcon 50
        "FA6X",  # DASSAULT Falcon 6X
        "FA7X",  # DASSAULT Falcon 7X
        "FA8X",  # DASSAULT Falcon 8X
        # Cessna Citation.
        "C25A",  # CESSNA 525A Citation CJ2
        "C25B",  # CESSNA 525B Citation CJ3
        "C25C",  # CESSNA 525C Citation CJ4
        "C25M",  # CESSNA 525 Citation M2
        "C500",  # CESSNA 500 Citation
        "C501",  # CESSNA 501 Citation 1SP
        "C510",  # CESSNA 510 Citation Mustang
        "C525",  # CESSNA 525 Citation CJ1
        "C550",  # CESSNA 550 Citation 2
        "C551",  # CESSNA 551 Citation 2SP
        "C560",  # CESSNA 560 Citation 5
        "C56X",  # CESSNA 560XL Citation Excel
        "C650",  # CESSNA 650 Citation 3
        "C680",  # CESSNA 680 Citation Sovereign
        "C68A",  # CESSNA 680A Citation Latitude
        "C700",  # CESSNA 700 Citation Longitude
        "C750",  # CESSNA 750 Citation 10
        # Embraer executive jets.
        "E35L",  # EMBRAER EMB-135BJ Legacy
        "E50P",  # EMBRAER EMB-500 Phenom 100
        "E545",  # EMBRAER EMB-545 Legacy 450
        "E550",  # EMBRAER EMB-550 Legacy 500
        "E55P",  # EMBRAER EMB-505 Phenom 300
        # Hawker, de Havilland and Beechcraft.
        "BE40",  # BEECH 400 Beechjet
        "H25A",  # HAWKER SIDDELEY HS-125-1
        "H25B",  # BRITISH AEROSPACE BAe-125-700
        "H25C",  # BRITISH AEROSPACE BAe-125-1000
        "HA4T",  # HAWKER BEECHCRAFT 4000 Hawker 4000
        "PRM1",  # HAWKER BEECHCRAFT 390 Premier 1
        # Everything else with a single business-jet product line.
        "EA50",  # ECLIPSE Eclipse 500
        "HDJT",  # HONDA HA-420 HondaJet
        "MU30",  # MITSUBISHI MU-300 Diamond
        "PC24",  # PILATUS PC-24
        "SBR1",  # NORTH AMERICAN CT-39 Sabreliner
        "SF50",  # CIRRUS SJ-X Vision
    }
)
"""ICAO type designators whose Doc 8643 record is a business jet.

Source: **ICAO Doc 8643, Aircraft Type Designators**, the document air traffic control
plans against, published at
https://www.icao.int/operational-safety/doc-8643-aircraft-type-designators (HTTP 200 on
2026-08-20). ICAO's own search application at ``https://cfapps.icao.int/doc8643/``
answered HTTP 404 host-wide on the same date, so each designator here was read off its
own Doc 8643 record through the per-designator mirror at ``https://doc8643.com/aircraft/``,
one request per designator, on 2026-08-20. The manufacturer and model beside each entry is
that record verbatim, which is the citation: ``GLF6`` returns ``GULFSTREAM AEROSPACE
Gulfstream G650``, description code ``L2J``, wake category ``M/E``.

Nothing was written here from memory. Nine candidates that returned HTTP 404 rather than a
Doc 8643 record were dropped rather than guessed at: ``FA5X``, ``MYST``, ``C526``,
``C552``, ``GL8T``, ``LJ29``, ``LJ36``, ``LJ54``, ``CL65``.

**Doc 8643 does not have a "business jet" field, and this is the part that is our
judgement rather than ICAO's.** Doc 8643 supplies the designator, the manufacturer, the
model and a description code, so it settles what each airframe is and whether it is a jet.
Which product families count as business aviation is our commercial line, taken family by
family from the model names above, and it is deliberately written out one designator at a
time so it can be argued with.

Two traps that a shorter implementation walks straight into:

- **Matching on the model string pulls in regional airliners.** Doc 8643 names ``CRJ2``
  ``CANADAIR CL-600 Challenger 800``, so anything keyed on "Challenger" classifies a
  50-seat regional jet as a business jet. ``CRJ2`` is absent here on purpose.
- **A Doc 8643 model name is often the military variant.** ``GLF5`` reads ``C-37`` and
  ``GLF2`` reads ``C-20J``, both United States Air Force designations for a Gulfstream.
  That does not make the type military, and it does not need to: military comes from the
  feed's own database flag, which is checked first.

One correction worth carrying: the mirror's description code for ``FA6X`` reads ``L1P``,
a single-engine piston, which is wrong for a Dassault Falcon 6X. The designator and the
model name are right and are what this set is keyed on, so treat that column as
indicative and the designator and model as the fact.
"""


def classify(aircraft: Aircraft) -> AircraftClass:
    """Resolve the display class of one aircraft from what its feed actually reported.

    Order is precedence and each step is a fact the feed gave us, never a guess:

    1. **Military**, from ``dbFlags`` bit 1. First because a state-operated business jet
       is a military aircraft: the recorded ``/v2/mil`` sample carries 54 ``H60`` and 25
       ``C30J`` records, and a Gulfstream in air force service reads ``GLF5`` while its
       Doc 8643 model name is ``C-37``.
    2. **Anonymous**, from ``dbFlags`` bit 4, the privacy ICAO address. Held ahead of the
       type so a privacy-address aircraft displays anonymised until phase 11 correlates
       it, per ADR 009. The ``uses_privacy_address`` flag stays on the record either way,
       so a card can say both things.
    3. **Helicopter**, from emitter category ``A7``. Broadcast rather than looked up, and
       no designator in :data:`BUSINESS_JET_TYPE_DESIGNATORS` is a rotorcraft, so this
       cannot fight step 4.
    4. **Business jet**, from the ICAO type designator.

    Anything else is ``UNKNOWN``.
    """
    if aircraft.is_military:
        return AircraftClass.MILITARY
    if aircraft.uses_privacy_address:
        return AircraftClass.ANONYMOUS
    if aircraft.category == ROTORCRAFT_CATEGORY:
        return AircraftClass.HELICOPTER
    designator = (aircraft.type_designator or "").strip().upper()
    if designator in BUSINESS_JET_TYPE_DESIGNATORS:
        return AircraftClass.BUSINESS_JET
    return AircraftClass.UNKNOWN


def classified(aircraft: Aircraft) -> Aircraft:
    """The same aircraft carrying its resolved class.

    Returns the argument itself when the class already on the record is the one
    :func:`classify` resolves, which makes this idempotent and cheap to apply more than
    once. That matters because the adapter classifies on the way into the domain and the
    provider union may hand the same record on again.
    """
    resolved = classify(aircraft)
    if resolved is aircraft.aircraft_class:
        return aircraft
    return aircraft.model_copy(update={"aircraft_class": resolved})
