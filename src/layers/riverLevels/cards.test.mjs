import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRiverLevelCard,
  buildRiverLevelLabel,
  selectRiverLabelCohort,
  trendGlyph,
} from './cards.js';
import { normalizeRiverStation } from './source.js';

const NOW = Date.parse('2026-11-04T21:00:00Z');
const bonn = {
  id: 'pegelonline:593647aa-9fea-43ec-a7d6-6476a76ae868',
  provider: 'pegelonline',
  code: '2710080',
  name: 'Bonn',
  river: 'Rhein',
  lat: 50.736398,
  lon: 7.108045,
  level: 0.81,
  observedMs: NOW - 15 * 60_000,
  refs: { recordLow: 0.81, low: 1.21, mean: 2.9, high: 6.8, recordHigh: 10.13 },
  band: 'record-low',
  trend: -1.6,
};

test('the label names the gauge, its level and its trend', () => {
  const label = buildRiverLevelLabel(bonn);
  assert.equal(label.title, 'Bonn · 0.81 m ▼');
  assert.equal(label.accent, '#b8621b');
  assert.equal(trendGlyph(0.2), '▬');
  assert.equal(trendGlyph(null), '');
});

test('floods outrank record lows, which outrank normal gauges', () => {
  const flood = buildRiverLevelLabel({ ...bonn, id: 'wra:1', band: 'flood' });
  const normal = buildRiverLevelLabel({ ...bonn, id: 'wra:2', band: 'normal' });
  const low = buildRiverLevelLabel(bonn);
  assert.deepEqual(
    selectRiverLabelCohort([normal, low, flood], 2).map((e) => e.id),
    [flood.id, low.id],
  );
});

test('the card shows level, trend, references, plot and caveats', () => {
  const start = NOW - 72 * 3_600_000;
  const points = Array.from({ length: 73 }, (_, i) => [
    start + i * 3_600_000,
    0.9 - i * 0.001,
  ]);
  const card = buildRiverLevelCard(bonn, { points, partial: false }, NOW);
  assert.equal(card.title, 'LOWEST ON RECORD · Bonn');
  assert.equal(card.details[0], 'Rhein · PEGELONLINE (WSV)');
  assert.equal(card.details[1], '0.81 m · ▼ −2 cm/h · 15 min ago');
  assert.equal(
    card.details[2],
    'Record low 0.81 m · Mean 2.90 m · Record high 10.13 m',
  );
  assert.match(card.details[3], /^[▁-█]{24} last 72 h$/);
  assert.ok(card.details.some((line) => /not quality controlled/.test(line)));
  assert.ok(card.details.some((line) => /Local gauge zero/.test(line)));
});

test('a Canadian card lists the mean yearly low and high it is coloured by', () => {
  const medicineHat = {
    ...bonn,
    id: 'eccc:05AJ001',
    provider: 'eccc',
    code: '05AJ001',
    name: 'South Saskatchewan River at Medicine Hat',
    river: 'South Saskatchewan River',
    level: 2.2,
    refs: { low: 1.95, high: 5.6 },
    band: 'normal',
  };
  const card = buildRiverLevelCard(medicineHat, null, NOW);
  assert.equal(
    card.details[0],
    'South Saskatchewan River · Water Survey of Canada (ECCC)',
  );
  assert.equal(
    card.details[2],
    'Mean yearly low 1.95 m · Mean yearly high 5.60 m',
  );
  // Beside a long-term mean (Bonn) the yearly means stay off the line.
  assert.ok(
    !buildRiverLevelCard(bonn, null, NOW).details[2].includes('yearly'),
  );
});

test('the series trend stands in until the snapshot carries one', () => {
  const card = buildRiverLevelCard(
    { ...bonn, trend: null },
    {
      points: [
        [NOW - 3_600_000, 0.83],
        [NOW, 0.81],
      ],
      partial: false,
      trend: -2,
    },
    NOW,
  );
  assert.equal(card.details[1], '0.81 m · ▼ −2 cm/h · 15 min ago');
  assert.equal(
    buildRiverLevelCard({ ...bonn, trend: null }, null, NOW).details[1],
    '0.81 m · 15 min ago',
  );
});

test('the card says when history is loading or seen only by this server', () => {
  assert.ok(
    buildRiverLevelCard(bonn, null, NOW).details.includes(
      'Loading recent readings…',
    ),
  );
  const taiwan = {
    ...bonn,
    id: 'wra:1010H006',
    provider: 'wra',
    name: 'Xinshuxi Bridge',
    nativeName: '新磺溪橋(即時)',
    river: 'Huang River',
    refs: { warning: 4.6, flood: 5.8 },
    band: 'normal',
    observedMs: NOW - 5 * 3_600_000,
  };
  const card = buildRiverLevelCard(
    taiwan,
    {
      points: [
        [NOW - 7_200_000, 1.8],
        [NOW, 1.9],
      ],
      partial: true,
    },
    NOW,
  );
  assert.equal(
    card.details[0],
    'Huang River · 新磺溪橋(即時) · Water Resources Agency (WRA)',
  );
  assert.match(card.details[1], /Late reading · 5 h ago/);
  assert.equal(card.details[2], 'Warning 4.60 m · Flood 5.80 m');
  assert.match(card.details[3], /2 h seen by this server$/);
});

test('malformed or stale server rows are dropped', () => {
  assert.equal(normalizeRiverStation({ ...bonn }, NOW).name, 'Bonn');
  assert.equal(
    normalizeRiverStation({ ...bonn, id: 'pegelonline:x' }, NOW),
    null,
  );
  assert.equal(normalizeRiverStation({ ...bonn, provider: 'wra' }, NOW), null);
  assert.equal(normalizeRiverStation({ ...bonn, lat: 'x' }, NOW), null);
  assert.equal(
    normalizeRiverStation({ ...bonn, observedMs: NOW - 4 * 86_400_000 }, NOW),
    null,
  );
  assert.equal(
    normalizeRiverStation({ ...bonn, band: '<script>' }, NOW).band,
    'unknown',
  );
});
