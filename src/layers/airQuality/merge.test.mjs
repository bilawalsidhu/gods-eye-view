import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeObservations } from './merge.js';

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
