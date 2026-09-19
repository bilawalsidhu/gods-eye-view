// src/data/syntheticTraffic.test.mjs
//
// Layer contract + test-seam behaviour for the synthetic-traffic layer.
// The live fetch path (fetchFlowForBounds) is not exercised here — it has
// its own integration coverage under the traffic layer's tests; this file
// pins the layer module's surface so the GTFS-RT-feed-aware fallback logic
// cannot regress without a unit test red-flashing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import syntheticTrafficLayer, {
  _planPhantomsForTest,
  _sampleAlongPolylineForTest,
  _gtfsRtAnyFeedCoversRectForTest,
  SYNTHETIC_TRAFFIC_RENDER_BOUNDS,
} from './syntheticTraffic.js';

test('syntheticTraffic: layer contract exposes init/enable/disable/update/destroy/getStats/getDetectableObjects', () => {
  for (const key of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getDetectableObjects']) {
    assert.equal(typeof syntheticTrafficLayer[key], 'function', `layer must expose ${key}`);
  }
  assert.equal(syntheticTrafficLayer.id, 'synthetic-traffic');
  assert.equal(typeof syntheticTrafficLayer.name, 'string');
  assert.ok(syntheticTrafficLayer.updateInterval > 0, 'updateInterval must be positive');
});

test('syntheticTraffic: getStats() returns the documented surface without throwing when _viewer is null', () => {
  // No init() called — _viewer is the module-level null. getStats() must not
  // throw; it should still report a sensible "no viewer" picture via the
  // altitudeBand='unknown' branch.
  const stats = syntheticTrafficLayer.getStats();
  assert.equal(typeof stats.count, 'number');
  assert.equal(stats.count, 0);
  assert.equal(stats.loading, false);
  assert.equal(stats.suppressedByRealFeed, false);
  assert.equal(typeof stats.tilesFetched, 'number');
  assert.equal(typeof stats.altitudeBand, 'string');
  assert.equal(stats.altitudeBand, 'unknown', 'no viewer ⇒ altitudeBand must be "unknown"');
});

test('syntheticTraffic: getDetectableObjects() returns [] when layer is not enabled', () => {
  const cohort = syntheticTrafficLayer.getDetectableObjects();
  assert.deepEqual(cohort, []);
});

test('syntheticTraffic: _planPhantomsForTest picks eligible segments within the budget', () => {
  const segments = [];
  for (let i = 0; i < 50; i++) {
    segments.push({
      coords: [[-71.05 + i * 0.001, 42.36], [-71.05 + (i + 1) * 0.001, 42.36]],
      trafficLevel: 0.7,
      roadType: 'primary',
      closure: false,
    });
  }
  const summary = _planPhantomsForTest(segments);
  assert.equal(summary.totalSegments, 50);
  assert.ok(summary.eligibleSegments > 0, 'stride-sampled count must be > 0');
  assert.ok(summary.spawnablePhantoms >= summary.eligibleSegments,
    'each picked segment produces ≥1 phantom');
  assert.ok(summary.spawnablePhantoms <= SYNTHETIC_TRAFFIC_RENDER_BOUNDS.maxPhantomVehicles,
    'spawnable count must respect the phantom cap');
  assert.equal(summary.phantomBudget, SYNTHETIC_TRAFFIC_RENDER_BOUNDS.maxPhantomVehicles);
  assert.equal(summary.freeFlowSpeedMpsByType.primary, 16.5);
});

test('syntheticTraffic: _planPhantomsForTest skips closure segments', () => {
  const segments = [
    { coords: [[0, 0], [0, 0.001]], trafficLevel: 0.5, roadType: 'primary', closure: false },
    { coords: [[1, 1], [1, 1.001]], trafficLevel: 0.5, roadType: 'primary', closure: true  },
    { coords: [[2, 2], [2, 2.001]], trafficLevel: 0.5, roadType: 'primary', closure: false },
  ];
  const summary = _planPhantomsForTest(segments);
  assert.equal(summary.totalSegments, 3);
  // Stride is 6 — with 3 segments, only the first is picked, and it's not closed.
  assert.equal(summary.eligibleSegments, 1);
});

test('syntheticTraffic: _planPhantomsForTest caps at MAX_PHANTOM_VEHICLES', () => {
  // Force a tiny cap set by constructing a huge segment array. The
  // function returns spawnable count ≤ phantomBudget even with hundreds
  // of eligible segments.
  const segments = [];
  for (let i = 0; i < 5_000; i++) {
    segments.push({
      coords: [[i, 0], [i + 1, 0]], // zero-length is filtered by the actual renderer, but the planner runs on segment metadata only
      trafficLevel: 1.0,
      roadType: 'motorway',
      closure: false,
    });
  }
  const summary = _planPhantomsForTest(segments);
  assert.equal(summary.spawnablePhantoms, SYNTHETIC_TRAFFIC_RENDER_BOUNDS.maxPhantomVehicles);
});

test('syntheticTraffic: _sampleAlongPolylineForTest returns endpoints at t=0 and a midpoint at t=0.5', () => {
  const coords = [
    [-71.00, 42.30],
    [-71.00, 42.31],
    [-71.00, 42.32],
  ];
  const start = _sampleAlongPolylineForTest(coords, 0);
  const end = _sampleAlongPolylineForTest(coords, 0.999999);
  const mid = _sampleAlongPolylineForTest(coords, 0.5);
  assert.ok(Array.isArray(start));
  assert.ok(Array.isArray(mid));
  // First coordinate is the same lon, latitude climbs 0.02°, so the midpoint
  // is at lat ≈ 42.31 ± small drift from sub-segment interpolation.
  assert.ok(Math.abs(start[0] - (-71.00)) < 1e-6);
  assert.ok(Math.abs(end[0] - (-71.00)) < 1e-6);
  assert.ok(mid[1] >= 42.30 && mid[1] <= 42.32,
    `midpoint latitude ${mid[1]} should be within the polyline's lat band`);
});

test('syntheticTraffic: _sampleAlongPolylineForTest returns null for unusable input', () => {
  assert.equal(_sampleAlongPolylineForTest([], 0.5), null);
  assert.equal(_sampleAlongPolylineForTest(null, 0.5), null);
  assert.equal(_sampleAlongPolylineForTest([[0, 0]], 0.5), null); // fewer than 2 points
});

test('syntheticTraffic: bbox test seam surfaces the GTFS-RT-suppression signal', () => {
  // Sydney → no registered feed covers it → synthetics NOT suppressed.
  assert.equal(_gtfsRtAnyFeedCoversRectForTest({ south: -34, west: 150.5, north: -33.5, east: 151.5 }), false);
  // Boston → MBTA covers → synthetics ARE suppressed.
  assert.equal(_gtfsRtAnyFeedCoversRectForTest({ south: 42.30, west: -71.10, north: 42.40, east: -71.00 }), true);
});

test('syntheticTraffic: render-bounds surface documents phantom cap, stride, height offset', () => {
  assert.equal(SYNTHETIC_TRAFFIC_RENDER_BOUNDS.maxPhantomVehicles, 350);
  assert.equal(SYNTHETIC_TRAFFIC_RENDER_BOUNDS.segmentStride, 6);
  assert.equal(SYNTHETIC_TRAFFIC_RENDER_BOUNDS.heightOffsetM, 5.0);
});
