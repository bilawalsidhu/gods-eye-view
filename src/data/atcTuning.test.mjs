// src/data/atcTuning.test.mjs
// Gates on what the ATC feature is allowed to tell a viewer: which airport,
// which position, and — at most airports in the world — why there is none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLASS_KIND,
  NO_TUNING_REASON,
  chooseReferenceAirport,
  resolveAtcTuning,
  tuneAirportForPhase,
} from './atcTuning.js';
import { FLIGHT_PHASE } from './flightPhase.js';
import { loadAtcFrequencies } from './ourAirportsAtc.js';

const freq = (type, mhz) => ({ type, label: type, mhz });
const airportOf = (...frequencies) => ({ ident: 'TEST', frequencies });

test('the phase picks the position, in preference order', () => {
  const full = airportOf(
    freq('TWR', 118.1),
    freq('GND', 121.9),
    freq('APP', 124.0),
    freq('ATIS', 127.0),
  );
  const pick = (phase) => tuneAirportForPhase(full, phase).frequency.type;
  assert.equal(pick(FLIGHT_PHASE.TAXI), 'GND');
  assert.equal(pick(FLIGHT_PHASE.RUNWAY), 'TWR');
  assert.equal(pick(FLIGHT_PHASE.TAKEOFF), 'TWR');
  assert.equal(pick(FLIGHT_PHASE.CLIMB), 'APP');
  assert.equal(pick(FLIGHT_PHASE.APPROACH), 'APP');
  assert.equal(
    pick(FLIGHT_PHASE.CRUISE),
    'APP',
    'no CNTR here, so the next one',
  );
});

test('it falls down the order rather than showing nothing', () => {
  // 443 airports of 9,562 publish all four classes. Everywhere else the
  // preference order has to degrade, and degrading is not failing.
  const towerOnly = airportOf(freq('TWR', 118.1));
  const taxi = tuneAirportForPhase(towerOnly, FLIGHT_PHASE.TAXI);
  assert.equal(taxi.frequency.type, 'TWR', 'no ground frequency, so the tower');
  assert.equal(taxi.matchedPhase, true);
  assert.equal(taxi.reason, null);
});

test('an uncontrolled field is reported AS uncontrolled, not as a match', () => {
  // The majority case: 5,902 of the 9,562 packed airports publish no tower,
  // ground, approach or ATIS at all. Handing back a CTAF with matchedPhase
  // true would let a panel caption it "Ground 122.8" — a controller that does
  // not exist.
  const field = airportOf(freq('CTAF', 122.8));
  const result = tuneAirportForPhase(field, FLIGHT_PHASE.TAXI);
  assert.equal(result.frequency.type, 'CTAF');
  assert.equal(result.matchedPhase, false, 'a CTAF never matches a phase');
  assert.equal(result.reason, NO_TUNING_REASON.UNCONTROLLED);
});

test('an advisory frequency is never preferred over a controlled one', () => {
  const both = airportOf(freq('CTAF', 122.8), freq('TWR', 118.1));
  const result = tuneAirportForPhase(both, FLIGHT_PHASE.TAXI);
  assert.equal(result.frequency.type, 'TWR');
  assert.equal(result.matchedPhase, true);
});

test('an airport with nothing usable says so instead of returning a blank', () => {
  const result = tuneAirportForPhase(airportOf(), FLIGHT_PHASE.CRUISE);
  assert.equal(result.frequency, null);
  assert.equal(result.reason, NO_TUNING_REASON.NO_MATCHING_CLASS);
  // And a missing airport must not throw on the way past.
  assert.equal(tuneAirportForPhase(null, FLIGHT_PHASE.CRUISE).frequency, null);
});

test('an unknown phase still gets a usable order rather than falling through', () => {
  const full = airportOf(freq('TWR', 118.1), freq('GND', 121.9));
  const result = tuneAirportForPhase(full, 'not-a-phase');
  assert.equal(
    result.frequency.type,
    'TWR',
    'unrecognised phases use the UNKNOWN order',
  );
  assert.equal(result.matchedPhase, true);
});

test('the first frequency of a class wins, and later duplicates do not shadow it', () => {
  const twoTowers = airportOf(freq('TWR', 118.1), freq('TWR', 118.5));
  assert.equal(
    tuneAirportForPhase(twoTowers, FLIGHT_PHASE.RUNWAY).frequency.mhz,
    118.1,
  );
});

test('the reference airport follows the route when the aircraft has one', async () => {
  // Climbing out, the field it just left still owns it — even if a bigger
  // airport is nearer. The route is already plausibility-gated by the flights
  // layer, so when present it is better evidence than proximity.
  const climbingOut = {
    latitude: 32.9,
    longitude: -97.0,
    verticalRateMps: 8,
    onGround: false,
    route: { origin: { code: 'KAUS' }, destination: { code: 'KDEN' } },
  };
  const departure = await chooseReferenceAirport(climbingOut);
  assert.equal(departure.airport.ident, 'KAUS');
  assert.equal(departure.basis, 'origin');

  const descending = { ...climbingOut, verticalRateMps: -8 };
  const arrival = await chooseReferenceAirport(descending);
  assert.equal(arrival.airport.ident, 'KDEN');
  assert.equal(arrival.basis, 'destination');

  // Level: neither end of the route is more relevant than where it is now.
  const level = { ...climbingOut, verticalRateMps: 0 };
  assert.equal((await chooseReferenceAirport(level)).basis, 'nearest');
});

test('an unroutable or unknown route code falls back to proximity', async () => {
  const bogus = {
    latitude: 30.1975,
    longitude: -97.662,
    verticalRateMps: 8,
    onGround: false,
    route: { origin: { code: 'ZZZZ9' }, destination: { code: 'ZZZZ8' } },
  };
  const result = await chooseReferenceAirport(bogus);
  assert.equal(result.basis, 'nearest');
  assert.equal(result.airport.ident, 'KAUS');
});

test('nothing within range is a stated reason, not an empty panel', async () => {
  // Mid-Pacific, thousands of km from anything in the pack.
  const result = await resolveAtcTuning({
    latitude: -30,
    longitude: -140,
    altitudeM: 11_000,
    verticalRateMps: 0,
    onGround: false,
  });
  assert.equal(result.airport, null);
  assert.equal(result.frequency, null);
  assert.equal(result.basis, 'none');
  assert.equal(result.reason, NO_TUNING_REASON.NO_AIRPORT);
  // With no airport there is no field elevation, so the phase must stay coarse
  // rather than being computed against sea level.
  assert.equal(result.phase, FLIGHT_PHASE.AIRBORNE);
  assert.ok(result.missing.includes('fieldElevationM'));
});

test('the airport is chosen BEFORE the phase, because the phase needs its elevation', async () => {
  // Denver's field is 1,655 m. An aircraft 300 m above it is on short final;
  // measured against sea level the same aircraft reads as 1,955 m and lands in
  // the cruise band. If the order were reversed this test would show it.
  const { airports } = await loadAtcFrequencies();
  const denver = airports.find((a) => a.ident === 'KDEN');
  assert.ok(denver?.elevationM > 1_600, 'KDEN must be a high-elevation field');
  const shortFinal = {
    latitude: denver.lat,
    longitude: denver.lon,
    altitudeM: denver.elevationM + 300,
    velocityMps: 70,
    verticalRateMps: -5,
    onGround: false,
    route: { origin: { code: 'KAUS' }, destination: { code: 'KDEN' } },
  };
  const result = await resolveAtcTuning(shortFinal);
  assert.equal(result.airport.ident, 'KDEN');
  assert.equal(result.basis, 'destination');
  assert.equal(result.phase, FLIGHT_PHASE.APPROACH);
  assert.ok(Math.abs(result.aglM - 300) < 1, 'height must be above the FIELD');
});

test('ATIS is offered but marked as a broadcast, not as a controller', async () => {
  // Austin publishes no approach frequency, so an arrival gets its ATIS. That
  // is the right thing to offer and the wrong thing to caption as "the
  // controller this aircraft is talking to".
  const result = await resolveAtcTuning({
    latitude: 30.25,
    longitude: -97.7,
    altitudeM: 165.2 + 300,
    velocityMps: 70,
    verticalRateMps: -4,
    onGround: false,
  });
  assert.equal(result.airport.ident, 'KAUS');
  assert.equal(result.phase, FLIGHT_PHASE.APPROACH);
  assert.equal(result.frequency.type, 'ATIS');
  assert.equal(result.kind, 'broadcast');
  assert.equal(CLASS_KIND.TWR, 'control');
  assert.equal(CLASS_KIND.CTAF, 'advisory');
});

test('a taxiing aircraft gets ground, and the result is fully populated', async () => {
  const result = await resolveAtcTuning({
    latitude: 30.1975,
    longitude: -97.662,
    altitudeM: 165,
    velocityMps: 8,
    verticalRateMps: 0,
    onGround: true,
  });
  assert.equal(result.phase, FLIGHT_PHASE.TAXI);
  assert.equal(result.frequency.type, 'GND');
  assert.equal(result.positionLabel, 'Ground');
  assert.equal(result.kind, 'control');
  assert.equal(result.controlled, true);
  assert.equal(result.matchedPhase, true);
  assert.equal(result.reason, null);
  assert.deepEqual(result.missing, []);
});

test('a missing vertical rate degrades the phase without losing the frequency', async () => {
  // The common real case before #718: the tracked seam carried no rate at all.
  // The feature must still name an airport and a frequency, and must say what
  // it could not determine.
  const result = await resolveAtcTuning({
    latitude: 30.25,
    longitude: -97.7,
    altitudeM: 165.2 + 300,
    velocityMps: 70,
    onGround: false,
  });
  assert.equal(result.phase, FLIGHT_PHASE.AIRBORNE);
  assert.deepEqual(result.missing, ['verticalRateMps']);
  assert.ok(result.frequency, 'a coarse phase still has a preference order');
  assert.equal(result.airport.ident, 'KAUS');
});

test('junk in does not throw', async () => {
  for (const info of [null, undefined, {}, { latitude: 'x', longitude: 'y' }]) {
    const result = await resolveAtcTuning(info);
    assert.equal(result.airport, null);
    assert.equal(result.reason, NO_TUNING_REASON.NO_AIRPORT);
  }
});
