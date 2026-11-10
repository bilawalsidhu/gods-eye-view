import assert from 'node:assert/strict';
import test from 'node:test';
import { compareHeights } from './qa-surface-heights.mjs';
import {
  layers,
  observeSurfaceMovers,
  fixtureRoutes,
  center,
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
