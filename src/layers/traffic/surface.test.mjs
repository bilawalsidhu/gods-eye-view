import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
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
  waypoints: coords.map(() => geo.cartesian3.create()),
  segmentDist: coords.slice(1).map(() => 0),
});
const heightOf = (point) => geo.cartographic.fromCartesian(point).height;
const toDegrees = geo.math.toDegrees;

/**
 * A fake engine over photoreal tiles (or the globe), with no rendered depth
 * unless a test scripts one.
 */
function surfaceEngine({ photoreal = true } = {}) {
  const engine = createFakeEngine();
  if (photoreal) engine.fake.maps.photoreal = { kind: 'photoreal' };
  else engine.fake.maps.imagery = { kind: 'osm' };
  engine.fake.script('pickPosition', undefined);
  return engine;
}
/** The camera straight down over (0, 0) at `height` metres. */
const lookFrom = (engine, height) =>
  engine.fake.setPose({ longitude: 0, latitude: 0, height });
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
test('per-vertex mesh heights follow terrain, reject invalid samples, and leave shared cache unmodified', async (t) => {
  const heights = [100, 200, NaN, 9001, -9001];
  let samples = 0;
  const r = road([
    [0, 0],
    [0.001, 0],
    [0.002, 0],
    [0.003, 0],
    [0.004, 0],
  ]);
  const engine = surfaceEngine();
  let loaded = true;
  engine.fake.script('tilesLoaded', () => loaded);
  engine.fake.script('sampleHeight', () => heights[samples++]);
  t.after(observeTrafficSurface(engine));
  engine.fake.frame();
  const ground = {
    cachedGroundFloor: () => 50,
    reportMeshFloorCell: () => assert.fail('raw sample poisoned shared floor'),
  };
  let metrics;
  const prepared = await prepareRoadSurfaces([r], engine, ground, [], null, {
    onMetrics: (value) => (metrics = value),
  });
  assert.equal(metrics.sampleCount, 5);
  assert.equal(metrics.resolvedSamples, 2);
  assert.equal(prepared.pending.length, 1);
  assert.equal(samples, 5);
  const actual = r.waypoints.map((p) => Math.round(heightOf(p)));
  assert.deepEqual(actual, [103, 203, 53, 53, 53]);
  loaded = false;
  engine.fake.frame();
  assert.equal(trafficSurfaceReady(engine), false);
  engine.fake.script('sampleHeight', () => 75);
  const resumed = await prepareRoadSurfaces([r], engine, ground, []);
  assert.equal(
    resumed.ready.length,
    1,
    'other loading tiles do not block a local mesh',
  );
  let picks = 0;
  engine.fake.script('sampleHeight', () => {
    picks++;
    return 75;
  });
  const cached = await prepareRoadSurfaces([r], engine, ground, []);
  assert.equal(
    cached.metrics.resolvedSamples,
    0,
    'cache hits are not progress',
  );
  assert.equal(picks, 0, 'validated coordinate heights survive cache hits');
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    prepareRoadSurfaces([r], engine, ground, [], abort.signal),
    { name: 'AbortError' },
  );
});
test('the vehicle sets are excluded from mesh samples', async () => {
  const engine = surfaceEngine();
  const excluded = [{ id: 'traffic-fill' }];
  const seen = [];
  engine.fake.script('sampleHeight', (_position, exclude) => {
    seen.push(exclude);
    return 10;
  });
  await prepareRoadSurfaces(
    [
      road([
        [0, 0],
        [0.001, 0],
      ]),
    ],
    engine,
    null,
    excluded,
  );
  assert.deepEqual(seen, [excluded, excluded]);
});
test('visible-globe roads floor each vertex without mesh picks', async () => {
  const r = road([
    [0, 0],
    [0.001, 0],
  ]);
  let calls = 0;
  const engine = surfaceEngine({ photoreal: false });
  engine.fake.script('terrainHeight', () => ++calls * 100);
  engine.fake.script('sampleHeight', () => assert.fail('mesh sampled'));
  await prepareRoadSurfaces([r], engine, { cachedGroundFloor: () => 20 }, []);
  assert.equal(calls, 2);
  assert.deepEqual(
    r.waypoints.map((p) => Math.round(heightOf(p))),
    [103, 203],
  );
});

test('cached heights follow detail and provider; same-detail revisits sample nothing', async (t) => {
  const r = road([
    [0, 0],
    [0.001, 0],
  ]);
  let mesh = 40,
    samples = 0;
  const engine = surfaceEngine();
  engine.fake.script('sampleHeight', () => (samples++, mesh));
  t.after(observeTrafficSurface(engine));
  const camera = (height) => {
    lookFrom(engine, height);
    engine.fake.frame();
  };
  const heightAt = () => Math.round(heightOf(r.waypoints[0]));
  // Settled but coarse: sampled from 3 km.
  camera(3000);
  await prepareRoadSurfaces([r], engine, null, []);
  assert.equal(samples, 2);
  assert.equal(heightAt(), 43);
  // Same detail band on a revisit: zero samples.
  await prepareRoadSurfaces([r], engine, null, []);
  assert.equal(samples, 2);
  // Zooming out never re-samples a finer height either.
  camera(6000);
  await prepareRoadSurfaces([r], engine, null, []);
  assert.equal(samples, 2);
  // Closer view, finer mesh: re-sampled and the waypoint follows it.
  mesh = 47;
  camera(250);
  await prepareRoadSurfaces([r], engine, null, []);
  assert.equal(samples, 4);
  assert.equal(heightAt(), 50);
  await prepareRoadSurfaces([r], engine, null, []);
  assert.equal(samples, 4, 'the finer sample is now the cached one');
  // Different photoreal tiles (map provider switch) invalidate all, even
  // from a coarser view that would otherwise reuse the finer sample.
  engine.fake.maps.photoreal = { kind: 'photoreal' };
  camera(3000);
  mesh = 30;
  await prepareRoadSurfaces([r], engine, null, []);
  assert.equal(samples, 6);
  assert.equal(heightAt(), 33);
  // A finer sample that fails keeps the coarser measured height.
  camera(250);
  mesh = NaN;
  const kept = await prepareRoadSurfaces([r], engine, null, []);
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
  let height = 20,
    samples = 0;
  const engine = surfaceEngine();
  engine.fake.script('sampleHeight', () => (samples++, height));
  lookFrom(engine, 3000);
  assert.equal(trafficSurfaceReady(engine), false);
  const removeSurfaceObserver = observeTrafficSurface(engine);
  engine.fake.frame();
  assert.equal(trafficSurfaceReady(engine), true);
  lookFrom(engine, 3100);
  assert.equal(
    trafficSurfaceReady(engine),
    false,
    'old camera readiness is stale',
  );
  const r = road([
    [0, 0],
    [0.001, 0],
  ]);
  await prepareRoadSurfaces([r], engine, null, []);
  assert.equal(r.surfaceSettled, false);
  height = 80;
  engine.fake.frame();
  await prepareRoadSurfaces([r], engine, null, []);
  assert.equal(samples, 4, 'the first fresh render revalidates coarse heights');
  assert.equal(r.surfaceSettled, true);
  assert.ok(Math.abs(heightOf(r.waypoints[0]) - 83) < 0.01);
  height = 100;
  await prepareRoadSurfaces([r, r], engine, null, [], null, {
    revalidate: true,
  });
  assert.equal(
    samples,
    6,
    'the bounded refinement replaces initially settled coarse samples too',
  );
  removeSurfaceObserver();
  assert.ok(Math.abs(heightOf(r.waypoints[0]) - 103) < 0.01);
  await prepareRoadSurfaces([r], engine, null, []);
  assert.equal(samples, 6, 'ordinary same-band revisits still reuse the cache');
  await prepareRoadSurfaces([r], engine, null, [], null, { revalidate: true });
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
  const engine = surfaceEngine({ photoreal: false });
  engine.fake.script('terrainHeight', (c) => {
    picks++;
    return toDegrees(c.longitude) * 1000;
  });
  await prepareRoadSurfaces([r], engine, null, []);
  assert.equal(picks, indices.length);
  for (let i = 0; i < coords.length; i++) {
    const c = geo.cartographic.fromCartesian(r.waypoints[i]);
    assert.ok(Math.abs(toDegrees(c.longitude) - coords[i][0]) < 1e-9);
    assert.ok(Math.abs(toDegrees(c.latitude) - coords[i][1]) < 1e-9);
    assert.ok(Math.abs(c.height - (coords[i][0] * 1000 + 3)) < 0.01);
  }
});

test('rendered road depth is geographically checked, bounded, and avoids mesh redraws', async (t) => {
  const engine = surfaceEngine();
  engine.fake.script('worldToWindow', () => ({ x: 100, y: 100 }));
  engine.fake.script('pickPosition', () =>
    geo.cartesian3.fromDegrees(-97, 30, 100),
  );
  engine.fake.script('sampleHeight', () =>
    assert.fail('valid depth must not draw another pick frustum'),
  );
  assert.equal(
    renderedRoadHeight(engine, -97, 30, 0),
    undefined,
    'no rendered frame of this camera yet',
  );
  t.after(observeTrafficSurface(engine));
  engine.fake.frame();
  assert.ok(Math.abs(renderedRoadHeight(engine, -97, 30, 0) - 100) < 0.001);
  const r = road([
    [-97, 30],
    [-97, 30.000005],
  ]);
  r.waypoints = r.coords.map(([lon, lat]) =>
    geo.cartesian3.fromDegrees(lon, lat, 50),
  );
  const result = await prepareRoadSurfaces([r], engine, null, []);
  assert.equal(result.metrics.depthHits, 2);
  assert.equal(result.metrics.sampleCount, 0);
  let calls = 0;
  engine.fake.script('pickPosition', () => {
    calls++;
    return geo.cartesian3.fromDegrees(-97.001, 30, 150);
  });
  assert.equal(
    renderedRoadHeight(engine, -97, 30, 0),
    undefined,
    'foreground roof is not the road coordinate',
  );
  assert.equal(calls, 4);
  engine.fake.script('pickPosition', () =>
    geo.cartesian3.fromDegrees(-97, 30, 10000),
  );
  assert.equal(renderedRoadHeight(engine, -97, 30, 0), undefined);
  engine.fake.script('pickPosition', () => {
    throw new Error('depth unavailable');
  });
  assert.equal(renderedRoadHeight(engine, -97, 30, 0), undefined);
  engine.fake.script('pickPosition', () =>
    geo.cartesian3.fromDegrees(-97, 30, 100),
  );
  engine.picker.pickPositionSupported = false;
  assert.equal(renderedRoadHeight(engine, -97, 30, 0), undefined);
});

test('surface keys reuse identity without building arrays or strings on unchanged frames', async () => {
  const engine = surfaceEngine();
  const first = trafficSurfaceKey(engine);
  const remove = observeTrafficSurface(engine);
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
      engine.fake.emit('frames.postRender', i);
      assert.equal(trafficSurfaceKey(engine), first);
    }
  } finally {
    Array.prototype.map = originalMap;
    Array.prototype.join = originalJoin;
  }
  assert.equal(maps, 0);
  assert.equal(joins, 0);
  engine.fake.maps.photoreal = { kind: 'photoreal' };
  assert.notEqual(
    trafficSurfaceKey(engine),
    first,
    'replacement photoreal tiles are a new surface',
  );
  engine.fake.maps.photoreal = null;
  engine.fake.maps.imagery = { kind: 'osm' };
  const globe = trafficSurfaceKey(engine);
  assert.notEqual(globe, first, 'the globe is another surface');
  engine.fake.maps.imagery = { kind: 'esri-imagery' };
  assert.notEqual(
    trafficSurfaceKey(engine),
    globe,
    'a map stack switch on the globe is a new surface',
  );
  const terrainBefore = trafficSurfaceKey(engine);
  await engine.maps.setTerrain({ kind: 'ellipsoid' });
  assert.notEqual(
    trafficSurfaceKey(engine),
    terrainBefore,
    'a terrain that loads under the same imagery is a new surface',
  );
  remove();
  remove();
  assert.equal(engine.frames.postRender.numberOfListeners, 0);
  assert.equal(
    trafficSurfaceReady(engine),
    false,
    'readiness cannot recreate a subscription',
  );
});
