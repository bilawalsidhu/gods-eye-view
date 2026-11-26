import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OBSERVATION_MAX_AGE_MS,
  STALE_AFTER_MS,
  mapAnalystRecord,
  newestObservation,
  readingsAreStale,
  readingsInView,
  selectAirQualityOverlayCohort,
} from './model.js';

const NOW = Date.parse('2026-09-24T18:30:00Z');

// ── freshness ──────────────────────────────────────────────────────────────

test('a set whose every observation was dropped as too old is stale, not nominal', () => {
  assert.equal(readingsAreStale([], NOW), true);
  assert.equal(readingsAreStale([{ observedMs: NOW - 60_000 }], NOW), false);
  assert.equal(
    readingsAreStale([{ observedMs: NOW - STALE_AFTER_MS - 1 }], NOW),
    true,
  );
  assert.ok(OBSERVATION_MAX_AGE_MS > STALE_AFTER_MS);
  assert.equal(
    newestObservation([{ observedMs: NOW - 5 }, { observedMs: NOW - 1 }, {}]),
    NOW - 1,
  );
  assert.equal(newestObservation([]), null);
});

// ── readout selection ──────────────────────────────────────────────────────

const reading = (id, value, lat, lon) => ({
  id,
  stationId: id,
  value,
  lat,
  lon,
  name: id,
});

test('the readout lists the worst readings inside the view rectangle', () => {
  const rows = [
    reading('west', 9, 51.0, -114.0),
    reading('east', 4, 43.6, -79.3),
    reading('mild', 2, 51.1, -114.1),
  ];
  const inView = readingsInView(
    rows,
    { west: -115, south: 50, east: -113, north: 52 },
    5,
  );
  assert.deepEqual(
    inView.map((r) => r.id),
    ['west', 'mild'],
  );
});

test('an unresolvable view rectangle degrades to the worst overall, not to blank', () => {
  // A space-level or fully oblique camera cannot produce a rectangle; the card
  // should still say something useful.
  const rows = [reading('a', 3, 0, 0), reading('b', 8, 10, 10)];
  assert.deepEqual(
    readingsInView(rows, null, 5).map((r) => r.id),
    ['b', 'a'],
  );
  assert.deepEqual(readingsInView(rows, null, 0), []);
  assert.deepEqual(readingsInView(null, null, 5), []);
});

test('a view rectangle crossing the antimeridian still selects correctly', () => {
  // west > east is how a dateline-crossing rectangle is expressed.
  const rows = [reading('near', 5, 0, 179), reading('far', 9, 0, 100)];
  const inView = readingsInView(
    rows,
    { west: 170, south: -10, east: -170, north: 10 },
    5,
  );
  assert.deepEqual(
    inView.map((r) => r.id),
    ['near'],
  );
});

test('the overlay cohort is capped and deterministic', () => {
  const entries = Array.from({ length: 120 }, (_, i) => ({
    id: `s${i}`,
    priority: i % 11,
  }));
  const cohort = selectAirQualityOverlayCohort(entries);
  assert.ok(cohort.length <= 48);
  assert.deepEqual(
    cohort.map((e) => e.id),
    selectAirQualityOverlayCohort(entries).map((e) => e.id),
  );
});

test('analyst records are JSON-safe and name the provider and scale', () => {
  const record = mapAnalystRecord(
    {
      id: 'national:1:PM2.5',
      provider: 'national',
      kind: 'observation',
      parameter: 'PM2.5',
      scale: 'PM2.5',
      value: 12,
      units: 'µg/m³',
      name: 'Khayelitsha',
      lat: -34.04,
      lon: 18.67,
      observedMs: NOW,
    },
    0,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
  assert.equal(record.provider, 'national');
  assert.equal(record.scale, 'PM2.5');
  const empty = mapAnalystRecord(undefined, 7);
  assert.equal(empty.id, 'AIR-0007');
  for (const [key, value] of Object.entries(empty)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`);
  }
});

test("an analyst record gives a pollutant's value in the layer's units, as the card does", () => {
  const observation = (parameter, value, units) =>
    mapAnalystRecord({
      id: `national:1:${parameter}`,
      provider: 'national',
      kind: 'observation',
      parameter,
      scale: parameter,
      value,
      units,
    });
  // 10 ppb of NO2 is 18.82 µg/m³ at 25 °C; 2 ppm of CO is 2.29 mg/m³.
  assert.deepEqual(
    (({ value, units }) => ({ value, units }))(observation('NO2', 10, 'ppb')),
    { value: 18.82, units: 'µg/m³' },
  );
  const co = observation('CO', 2, 'ppm');
  assert.ok(Math.abs(co.value - 2 * 1.1456) < 1e-9);
  assert.equal(co.units, 'mg/m³');
  const unconverted = observation('CO2', 420, 'ppm');
  assert.equal(unconverted.value, null);
  assert.equal(unconverted.units, null);
  assert.equal(unconverted.reportedValue, 420);
  assert.equal(unconverted.reportedUnits, 'ppm');
});
