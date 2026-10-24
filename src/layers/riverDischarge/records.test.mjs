import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RIVER_OUTLOOK_COLORS,
  RIVER_OUTLOOK_LABELS,
  RIVER_OUTLOOK_LEVELS,
  classifyRiverOutlook,
  normalizeFloodSeries,
  normalizeRiverPoint,
  riverPointsInBox,
} from './records.js';

const point = {
  id: '51.125_13.725',
  name: 'Elbe',
  lat: 51.125,
  lon: 13.725,
  p50: 200,
  p90: 600,
  p99: 1500,
  mean: 300,
  max: 4000,
};

const days = (start, count) =>
  Array.from({ length: count }, (_, i) =>
    new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000)
      .toISOString()
      .slice(0, 10),
  );

function series(discharge, { start = '2026-10-23', extra = {} } = {}) {
  const time = days(start, discharge.length);
  const same = (scale) => discharge.map((v) => (v === null ? null : v * scale));
  return {
    time,
    discharge,
    median: same(1),
    min: same(0.5),
    max: same(2),
    p25: same(0.8),
    p75: same(1.2),
    ...extra,
  };
}

test('bundled points are validated before they reach a map or a URL', () => {
  assert.deepEqual(normalizeRiverPoint(point), point);
  assert.equal(normalizeRiverPoint({ ...point, id: '../../x' }), null);
  assert.equal(normalizeRiverPoint({ ...point, lat: 91 }), null);
  assert.equal(normalizeRiverPoint({ ...point, p90: 100 }), null);
  assert.equal(normalizeRiverPoint({ ...point, name: '' }), null);
  assert.equal(normalizeRiverPoint({ ...point, mean: -1 }).mean, null);
  assert.equal(normalizeRiverPoint(null), null);
});

test('box selection handles the antimeridian', () => {
  const pts = [
    { ...point, id: 'a', lat: 0, lon: 179 },
    { ...point, id: 'b', lat: 0, lon: -179 },
    { ...point, id: 'c', lat: 0, lon: 0 },
    { ...point, id: 'd', lat: 60, lon: 179 },
  ];
  const ids = (box) => riverPointsInBox(pts, box).map((p) => p.id);
  assert.deepEqual(ids({ south: -10, west: 170, north: 10, east: -170 }), [
    'a',
    'b',
  ]);
  assert.deepEqual(ids({ south: -10, west: -10, north: 10, east: 10 }), ['c']);
  assert.deepEqual(ids({ south: -90, west: -180, north: 90, east: 180 }), [
    'a',
    'b',
    'c',
    'd',
  ]);
});

test('flood rows normalise to aligned series; malformed rows are refused', () => {
  const row = {
    daily: {
      time: ['2026-10-23', '2026-10-24'],
      river_discharge: [10, null],
      river_discharge_median: [9, 'x'],
      river_discharge_min: [1, 2],
      river_discharge_max: [20, 30],
      river_discharge_p25: [8, 9],
      river_discharge_p75: [11, -3],
    },
  };
  assert.deepEqual(normalizeFloodSeries(row), {
    time: ['2026-10-23', '2026-10-24'],
    discharge: [10, null],
    median: [9, null],
    min: [1, 2],
    max: [20, 30],
    p25: [8, 9],
    p75: [11, null],
  });
  // Ensemble statistics may be absent; the headline series may not.
  const bare = normalizeFloodSeries({
    daily: { time: ['2026-10-23'], river_discharge: [5] },
  });
  assert.deepEqual(bare.median, [null]);
  assert.equal(
    normalizeFloodSeries({
      daily: { time: ['2026-10-23'], river_discharge: [] },
    }),
    null,
  );
  assert.equal(
    normalizeFloodSeries({
      daily: { time: ['23/10/2026'], river_discharge: [5] },
    }),
    null,
  );
  assert.equal(
    normalizeFloodSeries({
      daily: { time: ['2026-10-23'], river_discharge: [null] },
    }),
    null,
  );
  assert.equal(normalizeFloodSeries({}), null);
});

test('the level compares the 7-day peak from today with the point’s own percentiles', () => {
  // Yesterday's 5,000 m³/s is past and must not count.
  const s = series([5000, 300, 400, 650, 700, 500, 400, 300, 9000]);
  const outlook = classifyRiverOutlook(point, s, '2026-10-24');
  assert.equal(outlook.level, 'high');
  assert.equal(outlook.peak, 700);
  assert.equal(outlook.peakDay, '2026-10-27');
  assert.equal(outlook.today, 300);
  // The ninth day (today + 7) is outside the 7-day window.
  assert.deepEqual(outlook.ensemble, {
    median: 700,
    min: 350,
    max: 1400,
    p25: 560,
    p75: 840,
  });
  assert.equal(outlook.ensembleMaxPeak, 1400);
  assert.equal(outlook.ratioToMedian, 3.5);

  assert.equal(
    classifyRiverOutlook(point, series([0, 100, 1500]), '2026-10-24').level,
    'very-high',
  );
  assert.equal(
    classifyRiverOutlook(point, series([0, 100, 599]), '2026-10-24').level,
    'normal',
  );
  // Exactly the 90th percentile is above it.
  assert.equal(
    classifyRiverOutlook(point, series([0, 600]), '2026-10-24').level,
    'high',
  );
});

test('a stale series counts from the next day it has, and says nothing about today', () => {
  const s = series([100, 200, 300], { start: '2026-10-25' });
  const outlook = classifyRiverOutlook(point, s, '2026-10-24');
  assert.equal(outlook.peak, 300);
  assert.equal(outlook.today, null);
  assert.equal(
    classifyRiverOutlook(point, series([100, 200]), '2026-11-30').level,
    'unknown',
  );
  assert.equal(
    classifyRiverOutlook(point, null, '2026-10-24').level,
    'unknown',
  );
  assert.equal(classifyRiverOutlook(point, s, 'today').level, 'unknown');
  const holes = series([null, null, null], { start: '2026-10-24' });
  assert.equal(
    classifyRiverOutlook(point, holes, '2026-10-24').level,
    'unknown',
  );
});

test('every level has a colour and a label', () => {
  for (const level of [...RIVER_OUTLOOK_LEVELS, 'unknown']) {
    assert.match(RIVER_OUTLOOK_COLORS[level], /^#[0-9a-f]{6}$/);
    assert.ok(RIVER_OUTLOOK_LABELS[level]);
  }
});
