import test from 'node:test';
import assert from 'node:assert/strict';
import { isRatedReading, mergeObservations } from './merge.js';

const reading = (provider, id, lat, lon, overrides = {}) => ({
  id: `${provider}:${id}`,
  provider,
  lat,
  lon,
  name: id,
  observedMs: Date.parse('2026-11-23T10:00:00Z'),
  value: 12,
  units: 'µg/m³',
  parameter: 'PM2.5',
  ...overrides,
});

test('a direct reading replaces an OpenAQ copy within 150 m', () => {
  const merged = mergeObservations([
    {
      provider: 'openaq',
      direct: false,
      readings: [reading('openaq', '1', -33.9249, 18.4241)],
    },
    {
      provider: 'saaqis',
      direct: true,
      readings: [reading('saaqis', '1', -33.925, 18.4242)],
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].provider, 'saaqis');
});

test('a rated copy beats an unrated direct reading, and then the newer one loses to direct', () => {
  const site = (provider, overrides) =>
    reading(provider, '1', 28.6, 77.2, overrides);
  const rated = { assessment: { label: 'Poor', severity: 3 } };
  const older = { observedMs: Date.parse('2026-11-23T09:00:00Z') };
  const unrated = { rated: false, assessment: { reason: 'not confirmed' } };
  const merge = (cpcb, openaq) =>
    mergeObservations([
      { provider: 'cpcb', direct: true, readings: [site('cpcb', cpcb)] },
      { provider: 'openaq', direct: false, readings: [site('openaq', openaq)] },
    ]).map((kept) => kept.provider);
  assert.deepEqual(merge({ ...unrated, ...older }, rated), ['openaq']);
  // Neither rated: the direct reading wins even when it is older.
  assert.deepEqual(merge({ ...unrated, ...older }, {}), ['cpcb']);
  assert.deepEqual(merge({ ...rated, ...older }, rated), ['cpcb']);
});

test('rated means a category or a provider index, never a reading marked rated: false', () => {
  assert.equal(isRatedReading({ assessment: { label: 'Good' } }), true);
  assert.equal(isRatedReading({ rating: { label: 'Good', score: 2 } }), true);
  assert.equal(isRatedReading({ assessment: { reason: 'No usable' } }), false);
  assert.equal(isRatedReading({ rating: null }), false);
  assert.equal(
    isRatedReading({ rated: false, assessment: { label: 'Good' } }),
    false,
  );
});

test('readings 200 m apart both stay', () => {
  const merged = mergeObservations([
    {
      provider: 'openaq',
      direct: false,
      readings: [reading('openaq', '1', -33.9249, 18.4241)],
    },
    {
      provider: 'saaqis',
      direct: true,
      readings: [reading('saaqis', '1', -33.9249 + 0.0018, 18.4241)],
    },
  ]);
  assert.equal(merged.length, 2);
});

test('ties keep the newer reading', () => {
  const merged = mergeObservations([
    {
      provider: 'saaqis',
      direct: true,
      readings: [
        reading('saaqis', '1', -33.925, 18.4242, {
          observedMs: Date.parse('2026-11-23T10:00:00Z'),
        }),
      ],
    },
    {
      provider: 'cpcb',
      direct: true,
      readings: [
        reading('cpcb', '1', -33.925, 18.4242, {
          observedMs: Date.parse('2026-11-23T11:00:00Z'),
        }),
      ],
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].observedMs, Date.parse('2026-11-23T11:00:00Z'));
});

test('a network never collapses its own neighbouring stations', () => {
  const merged = mergeObservations([
    {
      provider: 'openaq',
      direct: false,
      readings: [
        reading('openaq', '1', 51.5, -0.12),
        reading('openaq', '2', 51.5003, -0.12),
      ],
    },
  ]);
  assert.equal(merged.length, 2);
});

test('neighbouring grid cells are checked, and the dedupe distance is an option', () => {
  // 0.02° cells: these two sit either side of a cell edge, about 22 m apart.
  const lists = [
    {
      provider: 'openaq',
      direct: false,
      readings: [reading('openaq', '1', 10.0399, 20.0399)],
    },
    {
      provider: 'saaqis',
      direct: true,
      readings: [reading('saaqis', '1', 10.0401, 20.0401)],
    },
  ];
  assert.deepEqual(
    mergeObservations(lists).map((row) => row.provider),
    ['saaqis'],
  );
  assert.equal(mergeObservations(lists, { dedupeM: 10 }).length, 2);
});
