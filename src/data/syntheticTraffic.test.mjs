// src/data/syntheticTraffic.test.mjs
//
// Layer contract + test-seam behaviour for the synthetic-traffic layer.
// The live fetch path (fetchFlowForBounds) is not exercised here — it has
// its own integration coverage under the traffic layer's tests; this file
// pins the layer module's surface so the GTFS-RT-feed-aware fallback logic
// cannot regress without a unit test red-flashing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import { resetFlowTileCache } from './flowTiles.js';
import { tilesForBounds } from './tomtomTiles.js';
import syntheticTrafficLayer, {
  _planPhantomsForTest,
  _sampleAlongPolylineForTest,
  _rebuildPhantomsForTest,
  _resetPhantomsForTest,
  _drivePhantomPositionsForTest,
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

/** Latitude (degrees) currently stored on a phantom point primitive. */
const latitudeOf = (point) => Cesium.Math.toDegrees(
  Cesium.Cartographic.fromCartesian(point.position).latitude,
);

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

// ---------------------------------------------------------------------------
// Viewport + poll cycle
//
// `pollViewport()` is the layer's only network surface, so these tests stub
// `globalThis.fetch` and read the layer's decisions back through the tile URLs
// it requests. The viewport rectangle arrives from a stand-in
// `camera.computeViewRectangle()`; the radians→degrees conversion, the latitude
// clamp and the GTFS-RT suppression gate all run before tile selection, so the
// requested tile set pins each of those steps.
// ---------------------------------------------------------------------------

/** Degree box → Cesium.Rectangle in the radians a real camera would return. */
function rectangleFromDegrees(box) {
  return new Cesium.Rectangle(
    Cesium.Math.toRadians(box.west),
    Cesium.Math.toRadians(box.south),
    Cesium.Math.toRadians(box.east),
    Cesium.Math.toRadians(box.north),
  );
}

/** Stand-in viewer: altitude-bearing camera plus an optional viewport rect. */
function makeViewer({ height = 1000, rect = null, preUpdate = null } = {}) {
  const camera = { positionCartographic: { height } };
  if (rect) camera.computeViewRectangle = () => rect;
  const scene = { primitives: { add: (p) => p, remove: () => {} } };
  if (preUpdate) scene.preUpdate = preUpdate;
  return { camera, scene };
}

/** Recording fetch stub. The caller owns `restore()` (try/finally). */
function stubFetch(handler) {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, init) => {
    calls.push(String(url));
    return handler(url, init);
  };
  return { calls, restore: () => { globalThis.fetch = saved; } };
}

/** 'z/x/y' identity of a requested flow-tile proxy URL. */
const tileKeyOf = (url) => url.split('/flow/')[1].replace('.pbf', '');

/** Sorted z/x/y keys for the flow tiles covering a degree box at z12. */
const expectedTileKeys = (box) => tilesForBounds(box, 12)
  .map(({ z, x, y }) => `${z}/${x}/${y}`)
  .sort();

/** Sydney viewport — outside every registered GTFS-RT service box. */
const SYDNEY_BOX = { south: -33.95, west: 150.9, north: -33.9, east: 150.95 };

/** One poll of undecodable tile bytes: fetch + decode run, no segments come back. */
const undecodableTile = async () => new Response(new ArrayBuffer(8), { status: 200 });

/** Drain the fire-and-forget poll `enable()` starts (real macrotask turns). */
const drain = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('syntheticTraffic: non-finite polyline vertices void the spans they touch', () => {
  // TomTom geometry is always finite, so this is pure length accounting: a
  // span with a non-finite endpoint contributes zero length, which must never
  // surface as NaN geometry downstream.
  const segment = { trafficLevel: 0.9, roadType: 'primary', closure: false };

  // A trailing NaN vertex only voids the last span — the finite leg survives
  // and the segment plans exactly like its clean 2-vertex equivalent.
  const clean = _planPhantomsForTest([{ coords: [[0, 0], [0, 0.01]], ...segment }]);
  const trailing = _planPhantomsForTest([
    { coords: [[0, 0], [0, 0.01], [Number.NaN, Number.NaN]], ...segment },
  ]);
  assert.equal(trailing.eligibleSegments, 1, 'a usable finite leg keeps the polyline eligible');
  assert.equal(trailing.spawnablePhantoms, clean.spawnablePhantoms,
    'the voided span added no phantom-carrying length');

  // A NaN vertex in the middle voids BOTH spans → nothing measurable → rejected.
  const mid = _planPhantomsForTest([
    { coords: [[0, 0], [Number.NaN, 0.005], [0, 0.01]], ...segment },
  ]);
  assert.equal(mid.eligibleSegments, 0, 'a polyline with no measurable span spawns nothing');
});

test('syntheticTraffic: phantom positions advance along the segment at free-flow × traffic speed', () => {
  const viewer = makeViewer();
  syntheticTrafficLayer.init(viewer);
  const collectionProto = Cesium.PointPrimitiveCollection.prototype;
  const realAdd = collectionProto.add;
  const realPerformance = globalThis.performance;
  const clock = { nowMs: 10_000_000 };
  const added = [];
  const points = [];
  try {
    // Spy only: every add still reaches the real collection so render-key and
    // cap bookkeeping run production code; the spy keeps BOTH the add options
    // and the live primitive so the preUpdate driver's writes are observable.
    collectionProto.add = function capture(options) {
      const point = realAdd.call(this, options);
      added.push(options);
      points.push(point);
      return point;
    };
    globalThis.performance = { now: () => clock.nowMs };

    const plan = _planPhantomsForTest([longSegment(-71.06, 42.35)]);
    assert.equal(_rebuildPhantomsForTest([longSegment(-71.06, 42.35)]), 3,
      'a ~1.1 km segment carries three staggered phantoms');
    assert.deepEqual(added.map((phantom) => phantom.id.vehicleIdx), [0, 1, 2]);
    // Raw point primitives CLONE position at add() and never evaluate
    // properties — a CallbackProperty here used to freeze every phantom at
    // ECEF (0,0,0), inside the globe. The stored position must be a real
    // Cartesian3 on the segment.
    assert.ok(added.every((phantom) => phantom.position instanceof Cesium.Cartesian3),
      'each phantom stores a plain Cartesian3, not an unevaluated property');
    assert.ok(added.every((phantom) => Math.abs(phantom.position.x) + Math.abs(phantom.position.y) > 0),
      'no phantom spawns at the ECEF origin');

    const speedMps = plan.freeFlowSpeedMpsByType.primary * 0.9; // longSegment trafficLevel
    const drive = () => _drivePhantomPositionsForTest();

    assert.ok(Math.abs(latitudeOf(points[0]) - 42.35) < 1e-9,
      `phantom 0 starts at the segment origin, got ${latitudeOf(points[0])}`);

    clock.nowMs += 1000; // one second of travel
    drive();
    const travelledDeg = speedMps / 111_320;
    assert.ok(Math.abs((latitudeOf(points[0]) - 42.35) - travelledDeg) < 1e-9,
      `1 s of travel must cover ${travelledDeg}°, got ${latitudeOf(points[0]) - 42.35}`);

    // Phantom 1 starts 1/3 along and runs against traffic — it must move south.
    clock.nowMs += 1000;
    drive();
    const reverseLat = latitudeOf(points[1]);
    assert.ok(reverseLat < 42.35 + 0.01 / 3 - 1e-4,
      `odd phantoms run southbound, got ${reverseLat}`);

    // 100 s at 14.85 m/s is 1.33 laps of a 1.113 km segment: the fraction wraps.
    clock.nowMs = 10_000_000 + 100_000;
    drive();
    const wrappedLat = latitudeOf(points[0]);
    const expectedLat = 42.35 + (((speedMps * 100) / 1113.2) % 1) * 0.01;
    assert.ok(Math.abs(wrappedLat - expectedLat) < 1e-6,
      `wrapped progress must land mid-segment, got ${wrappedLat} (want ${expectedLat})`);
  } finally {
    globalThis.performance = realPerformance;
    collectionProto.add = realAdd;
    _resetPhantomsForTest();
    syntheticTrafficLayer.destroy(viewer);
  }
});

test('syntheticTraffic: the altitude gate polls inside the band and drops the fleet above the exit', async () => {
  const viewer = makeViewer({ height: 150_000, rect: rectangleFromDegrees(SYDNEY_BOX) });
  const stub = stubFetch(undecodableTile);
  syntheticTrafficLayer.init(viewer);
  try {
    resetFlowTileCache();
    syntheticTrafficLayer.enable(viewer);
    await drain();
    assert.equal(stub.calls.length, 0, 'above the exit threshold the layer does not poll');

    viewer.camera.positionCartographic.height = 90_000; // inside the band, gate still closed
    await syntheticTrafficLayer.update();
    await drain();
    assert.equal(stub.calls.length, 0, 'descending into the band alone does not open the gate');

    viewer.camera.positionCartographic.height = 1000;
    await syntheticTrafficLayer.update();
    await drain();
    assert.deepEqual([...new Set(stub.calls.map(tileKeyOf))].sort(), expectedTileKeys(SYDNEY_BOX),
      'crossing the enter threshold fetches exactly the flow tiles covering the viewport');
    resetFlowTileCache(); // each later poll must reach the proxy again

    _rebuildPhantomsForTest([longSegment(150.9, -33.95)]);
    const before = stub.calls.length;
    viewer.camera.positionCartographic.height = 95_000; // band, gate open → still polls
    await syntheticTrafficLayer.update();
    await drain();
    assert.ok(stub.calls.length > before, 'the gate stays open below the exit threshold');
    assert.equal(syntheticTrafficLayer.getStats().count, 0,
      'an open gate hands the fleet to whatever the tiles say');

    _rebuildPhantomsForTest([longSegment(150.9, -33.95)]);
    const beforeExit = stub.calls.length;
    viewer.camera.positionCartographic.height = 150_000;
    await syntheticTrafficLayer.update();
    await drain();
    assert.equal(stub.calls.length, beforeExit, 'a closed gate polls nothing');
    assert.equal(syntheticTrafficLayer.getStats().count, 0, 'leaving the band drops the fleet');
  } finally {
    stub.restore();
    resetFlowTileCache();
    _resetPhantomsForTest();
    syntheticTrafficLayer.destroy(viewer);
  }
});

test('syntheticTraffic: viewport latitude is clamped before tile selection', async () => {
  // A near-polar camera: the raw rect reaches 89°N, tiles stop at the clamp.
  const polarBox = { south: 84.9, west: 20, north: 89, east: 20.05 };
  const viewer = makeViewer({ rect: rectangleFromDegrees(polarBox) });
  const stub = stubFetch(undecodableTile);
  syntheticTrafficLayer.init(viewer);
  try {
    resetFlowTileCache();
    syntheticTrafficLayer.enable(viewer);
    await drain();
    assert.deepEqual([...new Set(stub.calls.map(tileKeyOf))].sort(), expectedTileKeys({ ...polarBox, north: 85 }),
      'the 89°N edge must behave as the 85° clamp, not request polar rows');
    assert.ok(expectedTileKeys(polarBox).length > expectedTileKeys({ ...polarBox, north: 85 }).length,
      'fixture: the unclamped box would have requested polar rows');
  } finally {
    stub.restore();
    resetFlowTileCache();
    _resetPhantomsForTest();
    syntheticTrafficLayer.destroy(viewer);
  }
});

test('syntheticTraffic: an unusable viewport rectangle clears the fleet and fetches nothing', async () => {
  const viewer = makeViewer();
  const stub = stubFetch(undecodableTile);
  syntheticTrafficLayer.init(viewer);
  try {
    syntheticTrafficLayer.enable(viewer);
    _rebuildPhantomsForTest([longSegment(-71.06, 42.35)]);
    assert.equal(syntheticTrafficLayer.getStats().count, 3, 'fixture needs a live fleet');

    // A rect with non-finite edges converts to a NaN box → unusable.
    viewer.camera.computeViewRectangle = () => rectangleFromDegrees({ south: 42, west: Number.NaN, north: 43, east: -71 });
    await syntheticTrafficLayer.update();
    assert.equal(syntheticTrafficLayer.getStats().count, 0, 'a NaN viewport drops the fleet');

    // So does a camera that cannot resolve a rectangle at all.
    viewer.camera.computeViewRectangle = () => undefined;
    _rebuildPhantomsForTest([longSegment(-71.06, 42.35)]);
    await syntheticTrafficLayer.update();
    assert.equal(syntheticTrafficLayer.getStats().count, 0, 'a missing viewport drops the fleet');

    assert.equal(stub.calls.length, 0, 'neither case may reach the flow proxy');
  } finally {
    stub.restore();
    _resetPhantomsForTest();
    syntheticTrafficLayer.destroy(viewer);
  }
});

test('syntheticTraffic: a GTFS-RT feed owning the viewport silences and clears synthetics', async () => {
  const bostonBox = { south: 42.3, west: -71.1, north: 42.4, east: -71.0 };
  const viewer = makeViewer({ rect: rectangleFromDegrees(bostonBox) });
  const stub = stubFetch(undecodableTile);
  syntheticTrafficLayer.init(viewer);
  try {
    syntheticTrafficLayer.enable(viewer);
    assert.equal(stub.calls.length, 0, 'no flow tiles are fetched under a real feed');

    _rebuildPhantomsForTest([longSegment(-71.06, 42.35)]);
    assert.equal(syntheticTrafficLayer.getStats().count, 3, 'fixture needs a live fleet');
    await syntheticTrafficLayer.update();
    assert.equal(syntheticTrafficLayer.getStats().count, 0,
      'the poll drops synthetics a real feed is responsible for');
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    _resetPhantomsForTest();
    syntheticTrafficLayer.destroy(viewer);
  }
});

test('syntheticTraffic: disable() aborts an in-flight poll and settles without an error stat', async () => {
  const viewer = makeViewer({ rect: rectangleFromDegrees(SYDNEY_BOX) });
  const signals = [];
  const stub = stubFetch((_url, init) => new Promise((resolve, reject) => {
    signals.push(init.signal);
    init.signal.addEventListener('abort', () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      reject(abortError);
    });
  }));
  syntheticTrafficLayer.init(viewer);
  try {
    syntheticTrafficLayer.enable(viewer); // fires poll #1
    const pending = syntheticTrafficLayer.update(); // poll #2
    assert.equal(new Set(signals).size, 2, 'fixture needs two polls in flight');

    syntheticTrafficLayer.disable(viewer);
    assert.ok(signals.every((signal) => signal.aborted), 'disable must abort every in-flight poll');
    await pending;

    const stats = syntheticTrafficLayer.getStats();
    assert.equal(stats.loading, false, 'loading counter is reset by disable');
    assert.equal(stats.error, undefined, 'an abort is a cancellation, not an error');
    assert.equal(stats.count, 0);
  } finally {
    stub.restore();
    _resetPhantomsForTest();
    syntheticTrafficLayer.destroy(viewer);
  }
});

test('syntheticTraffic: a completed poll with no usable segments still timestamps and clears the fleet', async () => {
  const viewer = makeViewer({ rect: rectangleFromDegrees(SYDNEY_BOX) });
  const stub = stubFetch(undecodableTile);
  syntheticTrafficLayer.init(viewer);
  try {
    resetFlowTileCache();
    syntheticTrafficLayer.enable(viewer);
    await drain();
    _rebuildPhantomsForTest([longSegment(150.9, -33.95)]);
    assert.equal(syntheticTrafficLayer.getStats().count, 3, 'fixture needs a live fleet');

    await syntheticTrafficLayer.update();
    await drain();
    const stats = syntheticTrafficLayer.getStats();
    assert.equal(stats.count, 0, 'an empty segment list rebuilds an empty fleet');
    assert.equal(stats.loading, false, 'the poll released its loading slot');
    assert.ok(Number.isFinite(stats.lastUpdate), 'a completed poll is timestamped');
    assert.equal(stats.error, undefined);
    assert.ok(stats.tilesFetched >= stub.calls.length, 'tile accounting tracks the requests');
    assert.equal(stats.totalCapacity, SYNTHETIC_TRAFFIC_RENDER_BOUNDS.maxPhantomVehicles);
    assert.equal(stats.altitudeBand, '1 km');
  } finally {
    stub.restore();
    resetFlowTileCache();
    _resetPhantomsForTest();
    syntheticTrafficLayer.destroy(viewer);
  }
});

test('syntheticTraffic: a failing flow fetch surfaces the proxy error without throwing', async () => {
  const viewer = makeViewer({ rect: rectangleFromDegrees(SYDNEY_BOX) });
  const warn = [];
  const savedWarn = console.warn;
  console.warn = (...args) => warn.push(args.join(' '));
  const stub = stubFetch(async () => new Response('nope', { status: 503 }));
  syntheticTrafficLayer.init(viewer);
  try {
    resetFlowTileCache();
    syntheticTrafficLayer.enable(viewer);
    await syntheticTrafficLayer.update();
    const stats = syntheticTrafficLayer.getStats();
    assert.equal(stats.error, 'flow tile 12/3764/2458: HTTP 503',
      'the first failing tile is reported to getStats() consumers');
    assert.ok(warn.some((line) => line.includes('poll failed')), 'the failure is logged');
    assert.equal(stats.loading, false, 'the failed poll released its loading slot');
  } finally {
    console.warn = savedWarn;
    stub.restore();
    resetFlowTileCache();
    _resetPhantomsForTest();
    syntheticTrafficLayer.destroy(viewer);
  }
});

test('syntheticTraffic: the detection cohort is stride-sampled, capped and seed-offset', () => {
  const viewer = makeViewer();
  syntheticTrafficLayer.init(viewer);
  try {
    syntheticTrafficLayer.enable(viewer);
    // Stride 6 picks segments 0 and 6 — two segments → six phantoms.
    const segments = [];
    for (let i = 0; i < 12; i += 1) segments.push(longSegment(-71.06 - i * 0.001, 42.35));
    _rebuildPhantomsForTest(segments);
    assert.equal(syntheticTrafficLayer.getStats().count, 6, 'fixture needs two 3-phantom segments');

    const cohort = syntheticTrafficLayer.getDetectableObjects();
    assert.equal(cohort.length, 6, 'no cap → every phantom is detectable');
    assert.ok(cohort.every((entry) => entry.type === 'VEH' && entry.id.startsWith('🚗 synth/')),
      'phantoms are HUD-vehicle entries keyed by their render key');
    assert.ok(cohort.every((entry) => typeof entry.sourceId === 'string' && entry.position),
      'each entry carries its render key and a position property');

    const capped = syntheticTrafficLayer.getDetectableObjects({ maxCount: 2 });
    assert.deepEqual(capped.map((entry) => entry.sourceId), [cohort[0].sourceId, cohort[3].sourceId],
      'maxCount sets a stride of ceil(n / maxCount) starting at index 0');

    const shifted = syntheticTrafficLayer.getDetectableObjects({ maxCount: 2, seed: 1 });
    assert.deepEqual(shifted.map((entry) => entry.sourceId), [cohort[1].sourceId, cohort[4].sourceId],
      'seed rotates the stride start deterministically');

    const unbounded = syntheticTrafficLayer.getDetectableObjects({ maxCount: Number.NaN, seed: Number.NaN });
    assert.equal(unbounded.length, 6, 'non-finite options fall back to the full cohort');
  } finally {
    _resetPhantomsForTest();
    syntheticTrafficLayer.destroy(viewer);
  }
});

test('syntheticTraffic: init attaches the preUpdate position driver once and destroy detaches it', () => {
  const listeners = new Set();
  const viewer = makeViewer({
    preUpdate: {
      addEventListener: (fn) => listeners.add(fn),
      removeEventListener: (fn) => listeners.delete(fn),
    },
  });

  syntheticTrafficLayer.init(viewer);
  assert.equal(listeners.size, 1, 'init registers exactly one per-frame driver');

  const collectionProto = Cesium.PointPrimitiveCollection.prototype;
  const realAdd = collectionProto.add;
  const realPerformance = globalThis.performance;
  const clock = { nowMs: 5_000_000 };
  const points = [];
  try {
    syntheticTrafficLayer.init(viewer);
    assert.equal(listeners.size, 1, 'a re-init never double-binds the driver');

    collectionProto.add = function capture(options) {
      const point = realAdd.call(this, options);
      points.push(point);
      return point;
    };
    globalThis.performance = { now: () => clock.nowMs };
    assert.equal(_rebuildPhantomsForTest([longSegment(-71.06, 42.35)]), 3,
      'fixture: a ~1.1 km segment carries three phantoms');

    const [driver] = listeners;
    const startLat = latitudeOf(points[0]);
    clock.nowMs += 1000;
    driver();
    assert.ok(Math.abs(latitudeOf(points[0]) - startLat) > 1e-6,
      'the attached listener is the real position driver, not a no-op');

    syntheticTrafficLayer.destroy(viewer);
    assert.equal(listeners.size, 0, 'destroy detaches the driver from the scene');
    syntheticTrafficLayer.destroy(viewer);
    assert.equal(listeners.size, 0, 'destroy is idempotent about the detach');
  } finally {
    globalThis.performance = realPerformance;
    collectionProto.add = realAdd;
    _resetPhantomsForTest();
  }
});
