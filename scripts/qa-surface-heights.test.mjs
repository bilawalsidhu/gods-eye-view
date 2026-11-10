import assert from 'node:assert/strict';
import test from 'node:test';
import { compareHeights } from './qa-surface-heights.mjs';
import {
  layers,
  observeSurfaceMovers,
  fixtureRoutes,
  center,
  points,
  assertTileHeight,
  waitForSurfaceHeights,
} from './qa/surfaceHeights.mjs';
import { createFakeEngine } from '../src/globe/testing/fakeEngine.js';
import { decodeAlprTile } from '../src/layers/alpr/tileRecords.js';

const snapshot = (heightM = 50) => ({
  version: 1,
  fixture: 'surface-heights-v1',
  surface: 'terrain',
  engines: Object.fromEntries(
    ['cesium', 'navara'].map((engine) => [
      engine,
      Object.fromEntries(
        layers.map((layer) => [layer, { a: { heightM }, b: { heightM } }]),
      ),
    ]),
  ),
});

test('comparison accepts identical heights and the inclusive 0.1 m boundary', () => {
  for (const delta of [0, 0.099, 0.1, -0.1]) {
    const result = compareHeights(snapshot(), snapshot(50 + delta));
    assert.equal(result.ok, true);
    assert.equal(result.reports.length, 12);
    assert.ok(Math.abs(result.reports[0].maxAbsM - Math.abs(delta)) < 1e-10);
  }
});

test('comparison reports the largest absolute difference and fails above tolerance', () => {
  const after = snapshot();
  after.engines.navara.import.a.heightM = 50.01;
  after.engines.navara.import.b.heightM = 49.8999;
  const result = compareHeights(snapshot(), after);
  assert.equal(result.ok, false);
  const failures = result.reports.filter((r) => !r.ok);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].point, 'b');
  assert.ok(Math.abs(failures[0].maxAbsM - 0.1001) < 1e-10);
});

test('missing and extra points fail even with identical surviving heights', () => {
  for (const engine of ['cesium', 'navara'])
    for (const layer of layers)
      for (const change of ['missing', 'extra']) {
        const after = snapshot();
        if (change === 'missing') delete after.engines[engine][layer].a;
        else after.engines[engine][layer].extra = { heightM: 50 };
        const result = compareHeights(snapshot(), after);
        assert.equal(result.ok, false);
        const report = result.reports.find(
          (r) => r.engine === engine && r.layer === layer,
        );
        assert.deepEqual(report.missing, change === 'missing' ? ['a'] : []);
        assert.deepEqual(report.extra, change === 'extra' ? ['extra'] : []);
      }
});

test('missing engines, layers, empty cohorts and invalid heights cannot pass', () => {
  for (const change of [
    (s) => {
      delete s.engines.navara;
    },
    (s) => {
      delete s.engines.cesium.story;
    },
    (s) => {
      s.engines.navara.alpr = {};
    },
    ...[null, NaN, Infinity, '50'].map((height) => (s) => {
      s.engines.cesium.import.a.heightM = height;
    }),
  ]) {
    const after = snapshot();
    change(after);
    assert.equal(compareHeights(snapshot(), after).ok, false);
  }
  const empty = snapshot();
  empty.engines.cesium.story = {};
  assert.equal(compareHeights(empty, empty).ok, false);
});

test('tiles require explicit opt-in and cannot be compared with terrain', () => {
  const tiles = snapshot();
  tiles.surface = 'tiles';
  assert.throws(() => compareHeights(tiles, tiles), /tiles require --tiles/);
  assert.throws(() => compareHeights(snapshot(), tiles), /matching surfaces/);
  assert.equal(compareHeights(tiles, tiles, { tiles: true }).ok, true);
});

test('tile heights and tile comparisons use 0.5 m while terrain keeps 0.1 m', () => {
  const before = { ...snapshot(), surface: 'tiles' };
  for (const delta of [0.118, 0.5, -0.5]) {
    assertTileHeight(50 + delta, 50, 'navara/surface-0');
    const after = { ...snapshot(50 + delta), surface: 'tiles' };
    assert.equal(compareHeights(before, after, { tiles: true }).ok, true);
    assert.equal(compareHeights(snapshot(), snapshot(50 + delta)).ok, false);
  }
  for (const height of [50.5001, 49.4999, null, NaN, Infinity])
    assert.throws(
      () => assertTileHeight(height, 50, 'navara/surface-1'),
      /navara\/surface-1: .* m, expected 50 m \(±0.5 m\)/,
    );
  const after = { ...snapshot(50.5001), surface: 'tiles' };
  assert.equal(compareHeights(before, after, { tiles: true }).ok, false);
});

test('loaded incorrect tile heights fail immediately with the point and measured height', async (t) => {
  const previous = globalThis.window;
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
  const engine = createFakeEngine();
  t.after(() => engine.destroy());
  globalThis.window = { __godsEyeView: { engine } };
  engine.maps.photorealActive = () => true;
  let height = 50.118;
  engine.surface.sampleHeight = () => height;
  const dispose = t.mock.fn();
  const page = {
    async waitForFunction(fn, options, args) {
      const state = fn(args);
      assert.ok(
        state,
        'finite loaded values return without waiting for tolerance',
      );
      return { jsonValue: async () => state, dispose };
    },
  };
  await waitForSurfaceHeights(page, 'navara', true);
  height = 51.25;
  await assert.rejects(
    waitForSurfaceHeights(page, 'navara', true),
    /navara\/surface-0 sampleHeight: 51.25 m, expected 50 m/,
  );
  assert.equal(dispose.mock.callCount(), 2);
});

test('unavailable surface timeout reports all points and readiness state', async () => {
  const cause = new Error('timeout');
  const page = {
    waitForFunction: async () => {
      throw cause;
    },
    evaluate: async () => ({
      loaded: false,
      photoreal: true,
      points: points.map((p) => ({ id: p.id, height: null })),
    }),
  };
  await assert.rejects(waitForSurfaceHeights(page, 'navara', true), (error) => {
    assert.equal(error.cause, cause);
    for (const p of points)
      assert.ok(error.message.includes(`${p.id}: null m`));
    assert.match(error.message, /loaded=false, photoreal=true/);
    return true;
  });
});

test('the probe reads committed contract positions, snapshots mutable inputs and drops destroyed sets', () => {
  const engine = createFakeEngine();
  const original = globalThis.window;
  globalThis.window = { __godsEyeView: { engine } };
  try {
    observeSurfaceMovers();
    const probe = window.qaSurfaceMovers;
    const set = engine.movers.createSet({
      id: 'alpr-cameras',
      kind: 'point',
      capacity: 1,
      point: { sizePx: 5 },
    });
    const position = { x: 1, y: 2, z: 3 };
    set.set(0, { position, show: true, pickId: 'camera' });
    set.setCount(1);
    assert.throws(() => probe.read('alpr'), /Uncommitted mover count/);
    set.commit();
    position.z = 500;
    assert.equal(probe.read('alpr')[0].position.z, 3);
    set.set(0, { position });
    assert.equal(probe.read('alpr')[0].position.z, 3);
    set.commit();
    assert.equal(probe.read('alpr')[0].position.z, 500);
    assert.equal(probe.read('alpr')[0].id, 'camera');
    set.destroy();
    assert.deepEqual(probe.read('alpr'), []);
    probe.restore();
  } finally {
    engine.destroy();
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
  }
});

test('fixture routes match both bundled and dev infrastructure URLs and decode real camera tiles', () => {
  const origin = 'http://localhost:4308';
  const routes = fixtureRoutes(origin, true);
  const answer = (url) =>
    routes.find((r) => new URLPattern(r.pattern).test(url))?.respond({ url });
  for (const path of [
    '/assets/datacenters-abc.geojsonl',
    '/src/data/local_data/dams/dams.geojsonl',
  ]) {
    const rows = answer(origin + path)
      .body.split('\n')
      .map(JSON.parse);
    assert.equal(rows.length, 3);
    assert.ok(
      rows.every(
        (r) => Math.abs(r.geometry.coordinates[1] - center.lat) < 0.0004,
      ),
    );
  }
  const z = 12,
    scale = 2 ** z;
  const x = Math.floor(((center.lon + 180) / 360) * scale);
  const y = Math.floor(
    ((1 - Math.asinh(Math.tan((center.lat * Math.PI) / 180)) / Math.PI) / 2) *
      scale,
  );
  const tile = answer(
    `https://tiles.dontgetflocked.com/cameras-us-hourly/${z}/${x}/${y}.mvt`,
  );
  const cameras = decodeAlprTile(tile.body, z, x, y);
  assert.equal(cameras.length, 3);
  assert.equal(new Set(cameras.map((r) => r.id)).size, 3);
  assert.ok(cameras.every((r) => Math.abs(r.longitude - center.lon) < 0.0004));
  assert.equal(answer(origin + '/api/unexpected-feed').status, 503);
});
