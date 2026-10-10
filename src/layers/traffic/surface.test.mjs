import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from 'cesium';
import {
  detailBand,
  renderedRoadHeight,
  prepareRoadSurfaces,
  roadSurfaceChunks,
  roadHeightStations,
  trafficSurfaceReady,
  trafficSurfaceKey,
  observeTrafficSurface,
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
  for (const chunk of chunks) {
    let length = 0;
    for (let i = 1; i < chunk.length; i++)
      length +=
        Math.hypot(
          (chunk[i][0] - chunk[i - 1][0]) *
            Math.cos((chunk[i - 1][1] * Math.PI) / 180),
          chunk[i][1] - chunk[i - 1][1],
        ) * 111320;
    assert.ok(
      length <= 600.01,
      'short chunks keep the population budget near the visible road',
    );
  }
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

test('a camera jump cannot certify old rendered depth or cache coarse heights as settled', async () => {
  const tileset = { show: true, tilesLoaded: true };
  let height = 20,
    samples = 0;
  const scene = {
    postRender: new C.Event(),
    camera: {
      viewMatrix: C.Matrix4.clone(C.Matrix4.IDENTITY),
      frustum: { projectionMatrix: C.Matrix4.clone(C.Matrix4.IDENTITY) },
    },
    globe: { show: false },
    primitives: { length: 1, get: () => tileset },
    sampleHeightSupported: true,
    sampleHeight: () => (samples++, height),
  };
  assert.equal(trafficSurfaceReady(scene), false);
  const removeSurfaceObserver = observeTrafficSurface(scene);
  scene.postRender.raiseEvent();
  assert.equal(trafficSurfaceReady(scene), true);
  scene.camera.viewMatrix[12] = 100;
  assert.equal(
    trafficSurfaceReady(scene),
    false,
    'old camera readiness is stale',
  );
  const r = road([
    [0, 0],
    [0.001, 0],
  ]);
  await prepareRoadSurfaces([r], scene, null, []);
  assert.equal(r.surfaceSettled, false);
  height = 80;
  scene.postRender.raiseEvent();
  await prepareRoadSurfaces([r], scene, null, []);
  assert.equal(samples, 4, 'the first fresh render revalidates coarse heights');
  assert.equal(r.surfaceSettled, true);
  assert.ok(
    Math.abs(C.Cartographic.fromCartesian(r.waypoints[0]).height - 83) < 0.01,
  );
  height = 100;
  await prepareRoadSurfaces([r, r], scene, null, [], null, {
    revalidate: true,
  });
  assert.equal(
    samples,
    6,
    'the bounded refinement replaces initially settled coarse samples too',
  );
  removeSurfaceObserver();
  assert.ok(
    Math.abs(C.Cartographic.fromCartesian(r.waypoints[0]).height - 103) < 0.01,
  );
  await prepareRoadSurfaces([r], scene, null, []);
  assert.equal(samples, 6, 'ordinary same-band revisits still reuse the cache');
  await prepareRoadSurfaces([r], scene, null, [], null, { revalidate: true });
  assert.equal(
    samples,
    6,
    'already refined same-band coordinates are not sampled twice',
  );
});

test('height stations preserve bends while bounding sample spacing along the road', async () => {
  const coords = Array.from({ length: 31 }, (_, i) => [
    i * 0.0001,
    (i % 2) * 0.00001,
  ]);
  const { indices, distances } = roadHeightStations(coords);
  assert.ok(indices.length <= 4);
  for (let i = 1; i < indices.length; i++)
    assert.ok(distances[indices[i]] - distances[indices[i - 1]] <= 150.001);
  const r = road(coords);
  let picks = 0;
  await prepareRoadSurfaces(
    [r],
    {
      globe: {
        show: true,
        tilesLoaded: true,
        getHeight: (c) => {
          picks++;
          return C.Math.toDegrees(c.longitude) * 1000;
        },
      },
    },
    null,
    [],
  );
  assert.equal(picks, indices.length);
  for (let i = 0; i < coords.length; i++) {
    const c = C.Cartographic.fromCartesian(r.waypoints[i]);
    assert.ok(Math.abs(C.Math.toDegrees(c.longitude) - coords[i][0]) < 1e-9);
    assert.ok(Math.abs(C.Math.toDegrees(c.latitude) - coords[i][1]) < 1e-9);
    assert.ok(Math.abs(c.height - (coords[i][0] * 1000 + 3)) < 0.01);
  }
});

test('rendered road depth is geographically checked, bounded, and avoids mesh redraws', async (t) => {
  t.mock.method(
    C.SceneTransforms,
    'worldToWindowCoordinates',
    (scene, point, out) => {
      out.x = 100;
      out.y = 100;
      return out;
    },
  );
  const scene = {
    globe: { show: false },
    frameState: {},
    canvas: { clientWidth: 800, clientHeight: 600 },
    pickPositionSupported: true,
    sampleHeightSupported: true,
    pickPosition: () => C.Cartesian3.fromDegrees(-97, 30, 100),
    sampleHeight: () =>
      assert.fail('valid depth must not draw another pick frustum'),
  };
  assert.ok(Math.abs(renderedRoadHeight(scene, -97, 30, 0) - 100) < 0.001);
  const r = road([
    [-97, 30],
    [-97, 30.000005],
  ]);
  r.waypoints = r.coords.map(([lon, lat]) =>
    C.Cartesian3.fromDegrees(lon, lat, 50),
  );
  const result = await prepareRoadSurfaces([r], scene, null, []);
  assert.equal(result.metrics.depthHits, 2);
  assert.equal(result.metrics.sampleCount, 0);
  let calls = 0;
  scene.pickPosition = () => {
    calls++;
    return C.Cartesian3.fromDegrees(-97.001, 30, 150);
  };
  assert.equal(
    renderedRoadHeight(scene, -97, 30, 0),
    undefined,
    'foreground roof is not the road coordinate',
  );
  assert.equal(calls, 4);
  scene.pickPosition = () => C.Cartesian3.fromDegrees(-97, 30, 10000);
  assert.equal(renderedRoadHeight(scene, -97, 30, 0), undefined);
  scene.pickPosition = () => {
    throw new Error('depth unavailable');
  };
  assert.equal(renderedRoadHeight(scene, -97, 30, 0), undefined);
  scene.pickTranslucentDepth = true;
  assert.equal(renderedRoadHeight(scene, -97, 30, 0), undefined);
});

test('surface keys reuse identity without building arrays or strings on unchanged frames', (t) => {
  const tiles = [
    { show: true, tilesLoaded: true },
    { show: true, tilesLoaded: false },
  ];
  const scene = {
    globe: { show: false, terrainProvider: {} },
    primitives: {
      get: (i) => tiles[i],
      get length() {
        return tiles.length;
      },
    },
    camera: {
      viewMatrix: C.Matrix4.clone(C.Matrix4.IDENTITY),
      frustum: { projectionMatrix: C.Matrix4.clone(C.Matrix4.IDENTITY) },
    },
    postRender: new C.Event(),
  };
  const first = trafficSurfaceKey(scene);
  const remove = observeTrafficSurface(scene);
  const originalMap = Array.prototype.map;
  const originalJoin = Array.prototype.join;
  let maps = 0,
    joins = 0;
  Array.prototype.map = function (...args) {
    maps++;
    return originalMap.apply(this, args);
  };
  Array.prototype.join = function (...args) {
    joins++;
    return originalJoin.apply(this, args);
  };
  try {
    for (let i = 0; i < 1000; i++) {
      scene.postRender.raiseEvent();
      assert.equal(trafficSurfaceKey(scene), first);
    }
  } finally {
    Array.prototype.map = originalMap;
    Array.prototype.join = originalJoin;
  }
  assert.equal(maps, 0);
  assert.equal(joins, 0);
  tiles[1].show = false;
  const hidden = trafficSurfaceKey(scene);
  assert.notEqual(hidden, first);
  tiles[1] = { show: true, tilesLoaded: true };
  assert.notEqual(
    trafficSurfaceKey(scene),
    first,
    'same-count tileset replacement is a new surface',
  );
  scene.globe.show = true;
  const terrain = trafficSurfaceKey(scene);
  scene.globe.terrainProvider = {};
  assert.notEqual(trafficSurfaceKey(scene), terrain);
  remove();
  remove();
  assert.equal(scene.postRender.numberOfListeners, 0);
  assert.equal(
    trafficSurfaceReady(scene),
    false,
    'readiness cannot recreate a subscription',
  );
});
