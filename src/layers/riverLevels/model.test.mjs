import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLOOD_LINE_FRACTION,
  RIVER_LEVEL_BANDS,
  classifyRiverLevel,
  cleanReferences,
  compareSeverity,
  formatLevel,
  formatTrend,
  readingIsLate,
  riverBandById,
  sparkline,
  stageFraction,
  stationPageUrl,
  stationsInView,
  trendDirection,
} from './model.js';

// Bonn on the Rhine, 2026-11-04: 0.81 m equals the lowest level on record.
const BONN = cleanReferences({
  recordLow: 0.81,
  low: 1.21,
  mean: 2.9,
  high: 6.8,
  recordHigh: 10.13,
});
// A Taiwanese gauge with all three alert levels (level 1 the most severe).
const TAIWAN = cleanReferences({ watch: 3.2, warning: 4.6, flood: 5.8 });

test('every band has a unique id, a label and a colour', () => {
  const ids = RIVER_LEVEL_BANDS.map((band) => band.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const band of RIVER_LEVEL_BANDS) {
    assert.match(band.color, /^#[0-9a-f]{6}$/);
    assert.ok(band.label);
  }
  assert.equal(riverBandById('nonsense').id, 'unknown');
});

test('a gauge at its lowest level ever reads as a record low', () => {
  assert.equal(classifyRiverLevel(0.81, BONN), 'record-low');
  assert.equal(classifyRiverLevel(0.95, BONN), 'low');
  assert.equal(classifyRiverLevel(2.9, BONN), 'normal');
});

test('without alert stages, above the mean yearly high reads as watch', () => {
  assert.equal(classifyRiverLevel(7.2, BONN), 'watch');
  assert.equal(classifyRiverLevel(10.2, BONN), 'major');
});

test('alert stages map to watch, warning and flood', () => {
  assert.equal(classifyRiverLevel(1.9, TAIWAN), 'normal');
  assert.equal(classifyRiverLevel(3.2, TAIWAN), 'watch');
  assert.equal(classifyRiverLevel(4.6, TAIWAN), 'warning');
  assert.equal(classifyRiverLevel(6.1, TAIWAN), 'flood');
});

test('alert stages win over climatology', () => {
  const refs = cleanReferences({ high: 5, watch: 6, warning: 7, flood: 8 });
  assert.equal(classifyRiverLevel(5.5, refs), 'normal');
  assert.equal(classifyRiverLevel(6.5, refs), 'watch');
});

test('a gauge with no references stays grey', () => {
  assert.equal(classifyRiverLevel(1.2, {}), 'unknown');
  assert.equal(classifyRiverLevel(Number.NaN, BONN), 'unknown');
});

test('alert stages out of order are dropped, not guessed', () => {
  const refs = cleanReferences({ watch: 3, warning: 5.8, flood: 4.6, mean: 2 });
  assert.deepEqual(refs, { mean: 2 });
  assert.equal(classifyRiverLevel(5, refs), 'normal');
});

test('references keep finite numbers only', () => {
  assert.deepEqual(cleanReferences({ low: '', high: null, mean: '1.5' }), {
    mean: 1.5,
  });
});

test('stage fraction puts the flood stage at the flood line', () => {
  assert.equal(stageFraction(5.8, TAIWAN), FLOOD_LINE_FRACTION);
  assert.ok(stageFraction(4.6, TAIWAN) < FLOOD_LINE_FRACTION);
  // Below the lowest reference the lowest segment's slope continues.
  assert.ok(stageFraction(2, TAIWAN) < stageFraction(3.2, TAIWAN));
  assert.equal(stageFraction(-50, TAIWAN), 0.03);
  assert.equal(stageFraction(1, {}), null);
  // Bonn at its record low sits at the bottom of its column.
  assert.equal(stageFraction(0.81, BONN), 0.06);
});

test('trend direction ignores changes under 1 cm/h', () => {
  assert.equal(trendDirection(12), 'rising');
  assert.equal(trendDirection(-3), 'falling');
  assert.equal(trendDirection(0.5), 'steady');
  assert.equal(trendDirection(null), null);
  assert.equal(formatTrend(12.4), '+12 cm/h');
  assert.equal(formatTrend(-3), '−3 cm/h');
  assert.equal(formatLevel(0.81), '0.81 m');
});

test('a reading over three hours old is late', () => {
  const now = Date.parse('2026-11-04T21:00:00Z');
  assert.equal(readingIsLate({ observedMs: now - 60_000 }, now), false);
  assert.equal(readingIsLate({ observedMs: now - 4 * 3_600_000 }, now), true);
  assert.equal(readingIsLate({}, now), true);
});

test('sparkline draws one block per column from low to high', () => {
  const start = Date.parse('2026-11-01T00:00:00Z');
  const points = Array.from({ length: 8 }, (_, i) => [
    start + i * 3_600_000,
    i,
  ]);
  assert.equal(sparkline(points, 8), '▁▂▃▄▅▆▇█');
  assert.equal(sparkline(points.slice(0, 1), 8), '');
  const flat = points.map(([at]) => [at, 2]);
  assert.equal(sparkline(flat, 4), '▄▄▄▄');
});

test('stations in view are ordered by severity and skip grey gauges', () => {
  const stations = [
    { id: 'a', lat: 50, lon: 7, band: 'normal', trend: 0 },
    { id: 'b', lat: 50.5, lon: 7.5, band: 'flood', trend: 5 },
    { id: 'c', lat: 51, lon: 8, band: 'record-low', trend: -1 },
    { id: 'd', lat: 51, lon: 8, band: 'unknown', trend: 0 },
    { id: 'e', lat: 10, lon: 8, band: 'major', trend: 0 },
  ];
  const rect = { west: 6, east: 9, south: 49, north: 52 };
  assert.deepEqual(
    stationsInView(stations, rect).map((s) => s.id),
    ['b', 'c', 'a'],
  );
  assert.ok(compareSeverity(stations[1], stations[0]) < 0);
  // A rectangle across the antimeridian.
  const pacific = { west: 170, east: -170, south: -10, north: 10 };
  assert.deepEqual(
    stationsInView([{ id: 'x', lat: 0, lon: -175, band: 'low' }], pacific).map(
      (s) => s.id,
    ),
    ['x'],
  );
});

test('official station pages are built from a validated code only', () => {
  assert.equal(
    stationPageUrl({ provider: 'pegelonline', code: '2710080' }),
    'https://www.pegelonline.wsv.de/gast/stammdaten?pegelnr=2710080',
  );
  assert.equal(
    stationPageUrl({ provider: 'pegelonline', code: '27100"><x' }),
    null,
  );
  assert.equal(stationPageUrl({ provider: 'wra', code: '1010H006' }), null);
});
