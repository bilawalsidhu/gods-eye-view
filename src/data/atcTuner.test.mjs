import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateFlightPhase,
  resolveAtcTune,
  feetToMeters,
  metersToFeet,
  DEFAULT_ATC_RANGE_M,
} from './atcTuner.js';

test('atcTuner: unit conversions', () => {
  assert.equal(feetToMeters(1000), 304.8);
  assert.equal(Math.round(metersToFeet(304.8)), 1000);
});

test('atcTuner: evaluateFlightPhase classifies surface taxiing', () => {
  const onGround = evaluateFlightPhase({ onGround: true, groundSpeedKts: 12 });
  assert.equal(onGround.phase, 'surface');
  assert.equal(onGround.recommendedFreq, 'ground');

  const onRunway = evaluateFlightPhase({ onGround: true, groundSpeedKts: 90 });
  assert.equal(onRunway.phase, 'surface');
  assert.equal(onRunway.recommendedFreq, 'tower');

  const lowNearAirport = evaluateFlightPhase({ altitudeM: 100, distanceM: 3000 });
  assert.equal(lowNearAirport.phase, 'surface');
});

test('atcTuner: evaluateFlightPhase classifies final approach and tower handoff', () => {
  // 15 NM out (~27.7 km), 4000 ft (~1219 m), descending -> Approach control
  const midApproach = evaluateFlightPhase({
    altitudeM: 1219,
    distanceM: 27780,
    verticalRateMps: -3.5,
  });
  assert.equal(midApproach.phase, 'approach');
  assert.equal(midApproach.recommendedFreq, 'approach');

  // 6 NM out (~11.1 km), 1800 ft (~548 m), descending -> Tower handoff
  const finalApproach = evaluateFlightPhase({
    altitudeM: 548,
    distanceM: 11112,
    verticalRateMps: -3.0,
  });
  assert.equal(finalApproach.phase, 'approach');
  assert.equal(finalApproach.recommendedFreq, 'tower');
});

test('atcTuner: evaluateFlightPhase classifies departure climbing out', () => {
  // 8 NM out (~14.8 km), climbing at 5 m/s, at 2500 ft (~762 m)
  const departure = evaluateFlightPhase({
    altitudeM: 762,
    distanceM: 14816,
    verticalRateMps: 5.0,
  });
  assert.equal(departure.phase, 'departure');
});

test('atcTuner: evaluateFlightPhase classifies enroute cruise', () => {
  // High cruise: 35,000 ft (~10,668 m), far away
  const enroute = evaluateFlightPhase({
    altitudeM: 10668,
    distanceM: 100000,
    verticalRateMps: 0,
  });
  assert.equal(enroute.phase, 'enroute');
});

test('atcTuner: resolveAtcTune handles empty or missing aircraft', () => {
  const result = resolveAtcTune({ aircraft: null });
  assert.equal(result.tuned, false);
  assert.equal(result.inRange, false);
  assert.equal(result.airport, null);
});

test('atcTuner: resolveAtcTune automatically resolves nearest airport in approach range', () => {
  // Plane descending into Austin Bergstrom (KAUS: 30.1945, -97.6699)
  const aircraft = {
    lat: 30.10,
    lon: -97.65,
    altitudeM: 900,
    verticalRateMps: -3.0,
    groundSpeedKts: 140,
    onGround: false,
    callsign: 'SWA1234',
  };

  const tune = resolveAtcTune({ aircraft });
  assert.equal(tune.tuned, true);
  assert.equal(tune.inRange, true);
  assert.equal(tune.airport.icao, 'KAUS');
  assert.equal(tune.phase, 'approach');
  assert.equal(tune.callsign, 'SWA1234');
  assert.ok(tune.frequencyMHz);
});

test('atcTuner: resolveAtcTune honors manual airport and frequency overrides', () => {
  const aircraft = {
    lat: 30.10,
    lon: -97.65,
    altitudeM: 900,
    callsign: 'TEST',
  };

  // Manual override to KLAX tower
  const manual = resolveAtcTune({
    aircraft,
    manualAirportIcao: 'KLAX',
    manualFreqType: 'tower',
  });

  assert.equal(manual.airport.icao, 'KLAX');
  assert.equal(manual.frequencyMHz, '120.950');
  assert.equal(manual.freqType, 'tower');
});
