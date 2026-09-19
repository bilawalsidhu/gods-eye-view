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
  _rebuildPhantomsForTest,
  _resetPhantomsForTest,
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

// ---------------------------------------------------------------------------
// Rebuild lifecycle
//
// The original implementation checked the phantom cap BEFORE pruning the
// previous generation, so refresh #2 rejected every build (350 stale entries
// filled the cap) and pruneStale then emptied the layer — populated/blank
// oscillation every 35s (audit 2026-09-18). These tests drive the real
// rebuild path (`_rebuildPhantomsForTest` → production `rebuildPhantoms`)
// against a real Cesium.PointPrimitiveCollection with a stand-in viewer.
// ---------------------------------------------------------------------------

/** ~1.1 km north-south segment (0.01° lat) — `phantomsForSegment` gives 3. */
function longSegment(lon, lat) {
  return {
    coords: [[lon, lat], [lon, lat + 0.01]],
    trafficLevel: 0.9,
    roadType: 'primary',
    closure: false,
  };
}

test('syntheticTraffic: consecutive rebuilds keep the fleet stable (oscillation regression)', () => {
  const primitives = { add: (p) => p, remove: () => {} };
  const viewer = {
    camera: { positionCartographic: { height: 1000 } },
    scene: { primitives },
  };
  syntheticTrafficLayer.init(viewer);
  try {
    // enable() fires a void update(); with a stand-in camera (no
    // computeViewRectangle) pollViewport finds no rect and never fetches.
    syntheticTrafficLayer.enable(viewer);

    // Enough ~1.1 km segments to FILL the 350-phantom cap — the original
    // bug only engaged once `_phantoms.size >= MAX` (cap checked before the
    // old fleet was pruned), so a small fleet would pass vacuously.
    const segments = [];
    for (let i = 0; i < 800; i++) {
      segments.push(longSegment(-71.06 - i * 0.001, 42.35));
    }
    const plan = _planPhantomsForTest(segments);
    assert.equal(plan.spawnablePhantoms, SYNTHETIC_TRAFFIC_RENDER_BOUNDS.maxPhantomVehicles,
      'fixture must saturate the cap for this regression test to bite');

    const first = _rebuildPhantomsForTest(segments);
    assert.equal(first, SYNTHETIC_TRAFFIC_RENDER_BOUNDS.maxPhantomVehicles,
      'first refresh must fill the fleet to the cap');

    // The regression: refresh #2 (and #3) used to blank the layer because
    // stale entries counted against the cap. The fleet must be IDENTICAL.
    const second = _rebuildPhantomsForTest(segments);
    assert.equal(second, first, 'second refresh blanked the fleet — stale cap accounting');
    const third = _rebuildPhantomsForTest(segments);
    assert.equal(third, first, 'third refresh must remain stable too');

    assert.equal(syntheticTrafficLayer.getStats().count, first,
      'getStats().count must track the live fleet');
  } finally {
    _resetPhantomsForTest();
    syntheticTrafficLayer.destroy(viewer);
  }
});

test('syntheticTraffic: rebuild from empty and closure-only inputs stay at zero without error', () => {
  const primitives = { add: (p) => p, remove: () => {} };
  const viewer = {
    camera: { positionCartographic: { height: 1000 } },
    scene: { primitives },
  };
  syntheticTrafficLayer.init(viewer);
  try {
    syntheticTrafficLayer.enable(viewer);
    assert.equal(_rebuildPhantomsForTest([]), 0);
    const closures = [
      { coords: [[-71.06, 42.35], [-71.06, 42.36]], trafficLevel: 0, roadType: 'primary', closure: true },
    ];
    assert.equal(_rebuildPhantomsForTest(closures), 0,
      'closure-only segments must not spawn phantoms');
    assert.equal(syntheticTrafficLayer.getStats().count, 0);
  } finally {
    _resetPhantomsForTest();
    syntheticTrafficLayer.destroy(viewer);
  }
});

test('syntheticTraffic: sample positions pass through the same cache path as the per-frame callback', () => {
  // Guard the buildPolylineCache → sampleAlongCache refactor: a 3-vertex
  // polyline must interpolate through the middle vertex at t≈0.5, not cut
  // a straight chord across it.
  const bend = [
    [-71.00, 42.30],
    [-71.00, 42.32], // mid vertex — a straight chord would also pass near here,
    [-71.02, 42.32], // but the END at (-71.02, 42.32) proves the second leg exists
  ];
  const end = _sampleAlongPolylineForTest(bend, 0.999999);
  assert.ok(end, 'sample must resolve at t≈1');
  assert.ok(Math.abs(end[0] - (-71.02)) < 1e-6, `end lon should be -71.02, got ${end[0]}`);
  assert.ok(Math.abs(end[1] - 42.32) < 1e-6, `end lat should be 42.32, got ${end[1]}`);
  const midFirstLeg = _sampleAlongPolylineForTest(bend, 0.5);
  // Leg 1 (0.02° lat ≈ 2226 m) is LONGER than leg 2 (0.02° lon ≈ 1647 m at
  // this latitude), so half the total length is still mid-leg-1: lon pinned
  // at -71.00, lat between the endpoints.
  assert.ok(Math.abs(midFirstLeg[0] - (-71.00)) < 1e-6,
    `t=0.5 is mid-leg-1 so lon must be -71.00, got ${midFirstLeg[0]}`);
  assert.ok(midFirstLeg[1] > 42.30 && midFirstLeg[1] < 42.32,
    `t=0.5 lat must be strictly inside leg 1, got ${midFirstLeg[1]}`);
  const corner = _sampleAlongPolylineForTest(bend, 2226.4 / 3873.1);
  // The corner fraction = leg1 / (leg1 + leg2) ≈ 0.575 — the only t where
  // lat hits 42.32 while lon is still ≈ -71.00 (cumulative-table correctness).
  assert.ok(Math.abs(corner[1] - 42.32) < 1e-3,
    `corner fraction should sit at lat 42.32, got ${corner[1]}`);
});
