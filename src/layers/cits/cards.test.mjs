import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CITS_BUCKET_CSS,
  CITS_RANGE_SETTINGS,
  buildCitsSelectedCard,
  citsFormatAge,
  citsFormatRange,
  citsNextRangeStep,
} from './model.js';

const NOW = Date.parse('2026-10-05T08:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

test('report ages are compact seconds, minutes, hours and days', () => {
  assert.equal(citsFormatAge(4_200), '4s');
  assert.equal(citsFormatAge(125_000), '2m');
  assert.equal(citsFormatAge(3 * 3_600_000 + 1), '3h');
  assert.equal(citsFormatAge(50 * 3_600_000), '2d');
  assert.equal(citsFormatAge(Number.NaN), null);
  assert.equal(citsFormatAge(-1), null);
});

test('a selected tram card leads with kind and line, ends with age and provenance', () => {
  const card = buildCitsSelectedCard(
    {
      id: '00:30:e7:00:06:68',
      kind: 'tram',
      line: '6',
      destination: 'St. Peter',
      vehicleNumber: '217',
      speedKmh: 23.4,
      heading: 259.7,
      lastSeen: ago(4_000),
    },
    NOW,
  );
  assert.equal(card.title, 'TRAM · 6 → St. Peter');
  assert.deepEqual(card.details, [
    'vehicle 217 · 23 km/h · 260°',
    'station 00:30:e7:00:06:68',
    'heard 4s ago · OpenTrafficMap receivers',
  ]);
  assert.equal(card.variant, 'selected');
  assert.equal(card.selected, true);
  assert.equal(card.interactive, false);
  assert.equal(card.priority, Number.MAX_SAFE_INTEGER);
  assert.match(card.accent, /^#[0-9a-f]{6}$/i);
  assert.equal(card.accent, CITS_BUCKET_CSS.slow);
  assert.equal(JSON.parse(JSON.stringify(card)).title, card.title);
});

test('a traffic light card lists its signal groups and flags stale reports', () => {
  const card = buildCitsSelectedCard(
    {
      id: '00:0d:41:ff:e0:81',
      kind: 'traffic_light',
      name: 'Fixture crossing',
      spat: [
        { group: '1', state: 6 },
        { group: '2', state: 3 },
        { group: '3', state: 3 },
        { group: '4', state: 3 },
        { group: '5', state: 0 },
      ],
      lastSeen: ago(130_000),
      stale: true,
    },
    NOW,
  );
  assert.equal(card.title, 'TRAFFIC LIGHT · Fixture crossing');
  assert.deepEqual(card.details, [
    'signal 1 Green (protected) · 2 Red · 3 Red · 4 Red · +1 more',
    'station 00:0d:41:ff:e0:81',
    'heard 2m ago · OpenTrafficMap receivers · STALE',
  ]);
  assert.equal(card.accent, CITS_BUCKET_CSS.free);
});

test('a hazard card names the warning and its limit, without a station line', () => {
  const card = buildCitsSelectedCard(
    {
      id: 'anon-hazard',
      kind: 'hazard',
      hazardKind: 'roadworks',
      name: 'Roadworks',
      speedLimit: 30,
    },
    NOW,
  );
  assert.equal(card.title, 'HAZARD · Roadworks');
  assert.deepEqual(card.details, [
    'DENM warning · limit 30 km/h',
    'OpenTrafficMap receivers',
  ]);
});

test('long titles are bounded to 32 characters', () => {
  const card = buildCitsSelectedCard(
    {
      id: 'x',
      kind: 'bus',
      line: '33',
      destination: 'A very long destination name indeed',
    },
    NOW,
  );
  assert.equal(card.title.length, 32);
  assert.ok(card.title.endsWith('…'));
});

test('range chips step through their values and wrap', () => {
  const vehicles = CITS_RANGE_SETTINGS.find(
    (spec) => spec.id === 'vehicleRangeKm',
  );
  assert.equal(citsNextRangeStep(vehicles, 60), 120);
  assert.equal(citsNextRangeStep(vehicles, 400), 5);
  // A stored value between steps moves to the next step above it.
  assert.equal(citsNextRangeStep(vehicles, 70), 120);
  assert.equal(citsFormatRange(vehicles, 60), '60 km');
  const dots = CITS_RANGE_SETTINGS.find((spec) => spec.id === 'dotScale');
  assert.equal(citsFormatRange(dots, 1), '1.0×');
  assert.equal(citsFormatRange(dots, 0.75), '0.75×');
  for (const spec of CITS_RANGE_SETTINGS)
    assert.match(spec.label, /^[A-Z ]+$/, `${spec.id} chip is uppercase`);
});
