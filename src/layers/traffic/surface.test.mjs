import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from 'cesium';
import {
  detailBand,
  prepareRoadSurfaces,
  roadSurfaceChunks,
  trafficSurfaceReady,
} from './surface.js';
const road = (coords) => ({
  coords,
  waypoints: coords.map(() => new C.Cartesian3()),
  segmentDist: coords.slice(1).map(() => 0),
});
test('surface points preserve bends, bound spacing, and split rather than decimate long roads', () => {
  const chunks = roadSurfaceChunks([
    [0, 0],
    [0.2, 0],
    [0.2, 0.1],
  ]);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 80));
  assert.ok(chunks.flat().some((p) => p[0] === 0.2 && p[1] === 0));
  for (const c of chunks)
    for (let i = 1; i < c.length; i++)
      assert.ok(
        Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]) * 111320 <=
          150.01,
      );
});
test('per-vertex mesh heights follow terrain, reject invalid samples, and leave shared cache unmodified', async () => {
  const heights = [100, 200, NaN, 9001, -9001];
  let samples = 0;
  const r = road([
    [0, 0],
    [0.001, 0],
    [0.002, 0],
    [0.003, 0],
    [0.004, 0],
  ]);
  const tileset = { show: true, tilesLoaded: true };
  const scene = {
    globe: { show: false },
    primitives: { length: 1, get: () => tileset },
    sampleHeightSupported: true,
    sampleHeight: () => heights[samples++],
  };
  const ground = {
    cachedGroundFloor: () => 50,
    reportMeshFloorCell: () => assert.fail('raw sample poisoned shared floor'),
  };
  let metrics;
  const prepared = await prepareRoadSurfaces([r], scene, ground, [], null, {
    onMetrics: (value) => (metrics = value),
  });
  assert.equal(metrics.sampleCount, 5);
  assert.equal(prepared.pending.length, 1);
  assert.equal(samples, 5);
  const actual = r.waypoints.map((p) =>
    Math.round(C.Cartographic.fromCartesian(p).height),
  );
  assert.deepEqual(actual, [103, 203, 53, 53, 53]);
  tileset.tilesLoaded = false;
  assert.equal(trafficSurfaceReady(scene), false);
  scene.sampleHeight = () => 75;
  const resumed = await prepareRoadSurfaces([r], scene, ground, []);
  assert.equal(
    resumed.ready.length,
    1,
    'other loading tiles do not block a local mesh',
  );
  let picks = 0;
  scene.sampleHeight = () => {
    picks++;
    return 75;
  };
  await prepareRoadSurfaces([r], scene, ground, []);
  assert.equal(picks, 0, 'validated coordinate heights survive cache hits');
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    prepareRoadSurfaces([r], scene, ground, [], abort.signal),
    { name: 'AbortError' },
  );
});
test('visible-globe roads floor each vertex without mesh picks', async () => {
  const r = road([
    [0, 0],
    [0.001, 0],
  ]);
  let calls = 0;
  await prepareRoadSurfaces(
    [r],
    {
      globe: { show: true, tilesLoaded: true, getHeight: () => ++calls * 100 },
      sampleHeight: () => assert.fail('mesh sampled'),
    },
    { cachedGroundFloor: () => 20 },
    [],
  );
  assert.equal(calls, 2);
  assert.deepEqual(
    r.waypoints.map((p) => Math.round(C.Cartographic.fromCartesian(p).height)),
    [103, 203],
  );
});

test('cached heights follow detail and provider; same-detail revisits sample nothing', async () => {
  const r = road([
    [0, 0],
    [0.001, 0],
  ]);
  const tileset = { show: true, tilesLoaded: true };
  let mesh = 40,
    samples = 0;
  const camera = (height) => ({
    positionCartographic: { longitude: 0, latitude: 0, height },
  });
  const scene = {
    globe: { show: false },
    primitives: { length: 1, get: () => tileset },
    sampleHeightSupported: true,
    sampleHeight: () => (samples++, mesh),
    camera: camera(3000),
  };
  const heightAt = () =>
    Math.round(C.Cartographic.fromCartesian(r.waypoints[0]).height);
  // Settled but coarse: sampled from 3 km.
  await prepareRoadSurfaces([r], scene, null, []);
  assert.equal(samples, 2);
  assert.equal(heightAt(), 43);
  // Same detail band on a revisit: zero samples.
  await prepareRoadSurfaces([r], scene, null, []);
  assert.equal(samples, 2);
  // Zooming out never re-samples a finer height either.
  scene.camera = camera(6000);
  await prepareRoadSurfaces([r], scene, null, []);
  assert.equal(samples, 2);
  // Closer view, finer mesh: re-sampled and the waypoint follows it.
  mesh = 47;
  scene.camera = camera(250);
  await prepareRoadSurfaces([r], scene, null, []);
  assert.equal(samples, 4);
  assert.equal(heightAt(), 50);
  await prepareRoadSurfaces([r], scene, null, []);
  assert.equal(samples, 4, 'the finer sample is now the cached one');
  // A different photoreal tileset (map provider switch) invalidates all,
  // even from a coarser view that would otherwise reuse the finer sample.
  const other = { show: true, tilesLoaded: true };
  scene.primitives.get = () => other;
  scene.camera = camera(3000);
  mesh = 30;
  await prepareRoadSurfaces([r], scene, null, []);
  assert.equal(samples, 6);
  assert.equal(heightAt(), 33);
  // A finer sample that fails keeps the coarser measured height.
  scene.camera = camera(250);
  mesh = NaN;
  const kept = await prepareRoadSurfaces([r], scene, null, []);
  assert.equal(samples, 8);
  assert.equal(kept.ready.length, 1);
  assert.equal(heightAt(), 33);
});

test('detail bands double with distance and ignore a missing camera', () => {
  assert.equal(detailBand(0, 0, NaN, 0, 0), 0);
  assert.equal(detailBand(0, 0, 150, 0, 0), 0);
  assert.equal(detailBand(0, 0, 250, 0, 0), 1);
  assert.equal(detailBand(0, 0, 3000, 0, 0), 4);
  assert.ok(detailBand(0, 0, 250, 0.02, 0) > detailBand(0, 0, 250, 0, 0));
});
