import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  MESH_CELL_DEG,
  MESH_MISS_RETRY_MS,
  MESH_REFRESH_MIN_M,
  MESH_SAMPLE_BUDGET_MS,
  MESH_STREAMING_WAIT_MS,
  createMeshSampler,
} from './meshSampler.js';
import { meshFloorSampleWithinPrior } from '../../data/groundFloor.js';
import { metresBetween } from './view.js';

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const RAD = Math.PI / 180;

/** A scene whose mesh is 100 m everywhere except where `holes` say. */
function fakeViewer({ holes = () => false } = {}) {
  const tileset = Object.create(Cesium.Cesium3DTileset.prototype);
  const overlay = { name: 'lines' };
  const probes = [];
  const scene = {
    sampleHeightSupported: true,
    primitives: {
      length: 2,
      get: (i) => [tileset, overlay][i],
    },
    sampleHeight(carto, exclude) {
      const lon = carto.longitude / RAD;
      const lat = carto.latitude / RAD;
      probes.push({ lon, lat, exclude });
      return holes(lon, lat) ? undefined : 100;
    },
  };
  return {
    probes,
    overlay,
    viewer: {
      scene,
      camera: {
        positionCartographic: { longitude: 10 * RAD, latitude: 50 * RAD },
      },
    },
  };
}

test('cells are probed once, nearest first, with overlays excluded', async () => {
  const { viewer, probes, overlay } = fakeViewer();
  const sampler = createMeshSampler({ getViewer: () => viewer });
  sampler.setEnabled(true);
  const heard = [];
  sampler.onSampled((batch) => heard.push(batch.length));
  sampler.request([
    [10.004, 50],
    [10.001, 50],
    [10.00101, 50.00001], // same ~11 m cell as the previous point
  ]);
  await settle(1000);
  assert.equal(probes.length, 2);
  assert.ok(probes[0].lon < probes[1].lon, 'nearest the camera first');
  assert.deepEqual(probes[0].exclude, [overlay], 'only tilesets are hit');
  assert.equal(sampler.meshAt(10.001, 50), 100);
  assert.equal(sampler.meshAt(10.00101, 50.00001), 100);
  assert.deepEqual(heard, [2]);
  sampler.request([[10.001, 50]]);
  await settle();
  assert.equal(probes.length, 2, 'a sampled cell is not probed again');
  sampler.destroy();
});

test('far cells are skipped, misses are not latched, and nothing runs while disabled', async () => {
  const { viewer, probes } = fakeViewer({ holes: (lon) => lon > 10.0049 });
  const sampler = createMeshSampler({ getViewer: () => viewer });
  sampler.request([[10.001, 50]]);
  await settle();
  assert.equal(probes.length, 0, 'disabled: nothing queued');
  sampler.setEnabled(true);
  sampler.request([
    [10.05, 50], // ~3.6 km away
    [10.005, 50], // a hole: tiles not streamed
  ]);
  await settle();
  assert.equal(probes.length, 1);
  assert.equal(sampler.meshAt(10.05, 50), undefined);
  assert.equal(sampler.meshAt(10.005, 50), undefined);
  assert.ok(Math.abs(probes[0].lon - 10.005) < MESH_CELL_DEG);
  sampler.destroy();
});

/** Probes run on a 16 ms timer headless; with mocked timers, run them now. */
function probeNow(t) {
  t.mock.timers.tick(20);
}

test('a missed cell is probed again after the retry window, not before', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { viewer, probes } = fakeViewer({ holes: () => true });
  const sampler = createMeshSampler({ getViewer: () => viewer });
  sampler.setEnabled(true);
  sampler.request([[10.001, 50]]);
  probeNow(t);
  assert.equal(probes.length, 1, 'probed, and missed');
  t.mock.timers.tick(MESH_MISS_RETRY_MS - 100);
  sampler.request([[10.001, 50]]);
  probeNow(t);
  assert.equal(probes.length, 1, 'within the window: not probed');
  t.mock.timers.tick(100 + 1);
  sampler.request([[10.001, 50]]);
  probeNow(t);
  assert.equal(probes.length, 2, 'after the window: probed again');
  sampler.destroy();
});

test('remembered misses are bounded like the samples', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { viewer, probes } = fakeViewer({ holes: () => true });
  const sampler = createMeshSampler({ getViewer: () => viewer, cacheMax: 2 });
  sampler.setEnabled(true);
  for (const lon of [10.001, 10.002, 10.003]) {
    sampler.request([[lon, 50]]);
    probeNow(t);
  }
  assert.equal(probes.length, 3);
  // The third miss overflowed the list, which was dropped: the first cell
  // is asked about again rather than remembered forever.
  sampler.request([[10.001, 50]]);
  probeNow(t);
  assert.equal(probes.length, 4);
  sampler.destroy();
});

test('destroy forgets the samples', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { viewer } = fakeViewer();
  const sampler = createMeshSampler({ getViewer: () => viewer });
  sampler.setEnabled(true);
  sampler.request([[10.001, 50]]);
  probeNow(t);
  assert.equal(sampler.meshAt(10.001, 50), 100);
  sampler.destroy();
  assert.equal(sampler.meshAt(10.001, 50), undefined);
});

/**
 * A sampler over `fakeViewer` on a fake clock: each probe costs `probeMs`
 * and each read of the camera `cameraMs` (work done before any probe).
 */
function clocked(t, { probeMs = 2, cameraMs = 0, holes } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const fake = fakeViewer({ holes });
  const clock = { now: 0 };
  const { scene, camera } = fake.viewer;
  const probe = scene.sampleHeight;
  scene.sampleHeight = (...args) => {
    clock.now += probeMs;
    return probe(...args);
  };
  const position = { ...camera.positionCartographic };
  Object.defineProperty(camera, 'positionCartographic', {
    get: () => {
      clock.now += cameraMs;
      return position;
    },
  });
  const sampler = createMeshSampler({
    getViewer: () => fake.viewer,
    now: () => clock.now,
  });
  sampler.setEnabled(true);
  /** Run one idle slice; its length on the fake clock. */
  function slice() {
    const started = clock.now;
    probeNow(t);
    return clock.now - started;
  }
  /** Put the camera over a point. */
  function moveTo(lon, lat) {
    position.longitude = lon * RAD;
    position.latitude = lat * RAD;
  }
  return { ...fake, sampler, slice, moveTo };
}

/** Points on a grid `step` degrees apart, `n`×`n`, centred on a point. */
function grid(lon, lat, n, step) {
  const points = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      points.push([
        lon + (i - (n - 1) / 2) * step,
        lat + (j - (n - 1) / 2) * step,
      ]);
  return points;
}

test('cells out of range when asked are not queued, even once the camera reaches them', (t) => {
  const { sampler, probes, slice, moveTo } = clocked(t);
  // 400 cells ~3.6 km east, past the sampler's range.
  sampler.request(grid(10.05, 50, 20, 0.0002));
  // The camera gets there before any idle slice runs.
  moveTo(10.05, 50);
  for (let i = 0; i < 5; i++) slice();
  assert.equal(probes.length, 0, 'nothing was queued for later');
  // Asked again from there (as a camera move does), they are probed.
  sampler.request([[10.05, 50]]);
  slice();
  assert.equal(probes.length, 1);
  sampler.destroy();
});

test('a slice keeps to its budget, counting the work before its first probe', (t) => {
  const { sampler, probes, slice } = clocked(t, { probeMs: 2, cameraMs: 3 });
  sampler.request(grid(10.001, 50, 5, 0.0002));
  const lengths = [];
  while (probes.length < 25 && lengths.length < 40) lengths.push(slice());
  assert.equal(probes.length, 25, 'every cell is probed in the end');
  for (const length of lengths)
    assert.ok(length <= MESH_SAMPLE_BUDGET_MS, `a ${length} ms slice`);
  sampler.destroy();
});

test('a large queue is ranked once, not sorted again every slice', (t) => {
  const { sampler, probes, slice, moveTo } = clocked(t);
  // 2,500 cells ~17 m apart around the camera, all within range.
  const cells = grid(10, 50, 50, 0.00015);
  sampler.request(cells);
  const sort = Array.prototype.sort;
  let sorted = 0;
  t.after(() => (Array.prototype.sort = sort));
  Array.prototype.sort = function (...args) {
    if (this.length >= 100) sorted += this.length;
    return sort.apply(this, args);
  };
  for (let i = 0; i < 10; i++) slice();
  const first = probes.map((probe) =>
    metresBetween(probe, { lon: 10, lat: 50 }),
  );
  assert.ok(first.length >= 10, 'probes ran');
  first.forEach((distance, i) =>
    assert.ok(
      !i || distance >= first[i - 1] - 0.01,
      'nearest the camera first, across slices',
    ),
  );
  Array.prototype.sort = sort;
  assert.equal(sorted, 0, `${sorted} queued cells sorted in 10 slices`);
  // The camera moves ~200 m east: the queue is ranked from there.
  const done = probes.length;
  moveTo(10.003, 50);
  slice();
  slice();
  const after = probes
    .slice(done)
    .map((probe) => metresBetween(probe, { lon: 10.003, lat: 50 }));
  assert.ok(after.length > 0);
  assert.ok(after[0] < 20, `nearest the new view first (${after[0]} m)`);
  sampler.destroy();
});

test('the sampling range is measured the short way round the date line', (t) => {
  const { sampler, probes, slice, moveTo } = clocked(t);
  moveTo(179.9999, 0);
  sampler.request([
    [-179.9999, 0], // ~22 m away, across the date line
    [179.99, 0], // ~1.1 km away, past the range
  ]);
  for (let i = 0; i < 5; i++) slice();
  assert.equal(probes.length, 1, 'only the neighbour across ±180°');
  assert.ok(Math.abs(Math.abs(probes[0].lon) - 179.9999) < MESH_CELL_DEG);
  sampler.destroy();
});

/** A scene whose mesh height can change (finer tiles) and a camera that can move. */
function liveViewer({ surface = 80, height = 700, ready = () => true } = {}) {
  const tileset = Object.create(Cesium.Cesium3DTileset.prototype);
  const probes = [];
  const viewer = {
    surface,
    ready,
    scene: {
      sampleHeightSupported: true,
      primitives: { length: 1, get: () => tileset },
      sampleHeight(carto) {
        probes.push(carto);
        return viewer.surface;
      },
    },
    camera: {
      positionCartographic: { longitude: 10 * RAD, latitude: 50 * RAD, height },
    },
  };
  return { viewer, probes };
}

function liveSampler(viewer, options = {}) {
  return createMeshSampler({
    getViewer: () => viewer,
    groundAt: () => 75,
    withinPrior: meshFloorSampleWithinPrior,
    tilesReady: () => viewer.ready(),
    ...options,
  });
}

test('a sample is probed again once the camera is twice as close, and the change is redrawn', async () => {
  const { viewer, probes } = liveViewer({ surface: 80, height: 700 });
  const sampler = liveSampler(viewer);
  sampler.setEnabled(true);
  const heard = [];
  sampler.onSampled((batch) => heard.push(batch.length));
  sampler.request([[10.001, 50]]);
  await settle(900);
  assert.equal(sampler.meshAt(10.001, 50), 80);
  // Finer tiles load: the surface is really 100 m.
  viewer.surface = 100;
  sampler.request([[10.001, 50]]);
  await settle();
  assert.equal(probes.length, 1, 'no new probe from the same distance');
  assert.equal(sampler.meshAt(10.001, 50), 80);
  viewer.camera.positionCartographic.height = 250;
  sampler.request([[10.001, 50]]);
  await settle(900);
  assert.equal(probes.length, 2);
  assert.equal(sampler.meshAt(10.001, 50), 100);
  assert.deepEqual(heard, [1, 1], 'the new height is announced for a redraw');
  sampler.destroy();
});

test('refreshing stops once a cell was probed from close by', async () => {
  const { viewer, probes } = liveViewer({ surface: 80, height: 110 });
  viewer.camera.positionCartographic.longitude = 10.001 * RAD;
  const sampler = liveSampler(viewer);
  sampler.setEnabled(true);
  sampler.request([[10.001, 50]]);
  await settle();
  viewer.camera.positionCartographic.height = 85;
  sampler.request([[10.001, 50]]);
  await settle();
  assert.equal(probes.length, 1, `probed from under ${MESH_REFRESH_MIN_M} m`);
  sampler.destroy();
});

test('probes wait while the visible tileset is still streaming', async () => {
  let ready = false;
  const { viewer, probes } = liveViewer({ ready: () => ready });
  const sampler = liveSampler(viewer);
  sampler.setEnabled(true);
  sampler.request([[10.001, 50]]);
  await settle(MESH_STREAMING_WAIT_MS * 2);
  assert.equal(probes.length, 0);
  ready = true;
  await settle(MESH_STREAMING_WAIT_MS * 2);
  assert.equal(probes.length, 1);
  assert.equal(sampler.meshAt(10.001, 50), 80);
  sampler.destroy();
});

test('a sample needs a real bare-earth prior and must sit in the shared mesh window', async () => {
  const { viewer } = liveViewer({ surface: 300 });
  const unknown = liveSampler(viewer, { groundAt: () => null });
  unknown.setEnabled(true);
  unknown.request([[10.001, 50]]);
  const outside = liveSampler(viewer);
  outside.setEnabled(true);
  outside.request([[10.001, 50]]);
  await settle();
  assert.equal(unknown.meshAt(10.001, 50), undefined, 'no prior: not kept');
  assert.equal(
    outside.meshAt(10.001, 50),
    undefined,
    '225 m above it: not kept',
  );
  unknown.destroy();
  outside.destroy();
});

test('a failed refresh keeps the last good distance and is retried after the cooldown', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { viewer, probes } = liveViewer({ surface: 90, height: 700 });
  viewer.camera.positionCartographic.longitude = 10.001 * RAD;
  const sampler = liveSampler(viewer);
  sampler.setEnabled(true);
  sampler.request([[10.001, 50]]);
  probeNow(t);
  assert.equal(sampler.meshAt(10.001, 50), 90);
  // The camera comes down to 20 m and the refresh misses (tiles in flux).
  viewer.camera.positionCartographic.height = 110;
  viewer.surface = undefined;
  sampler.request([[10.001, 50]]);
  probeNow(t);
  assert.equal(probes.length, 2);
  assert.equal(sampler.meshAt(10.001, 50), 90, 'the old sample stays');
  viewer.surface = 100;
  t.mock.timers.tick(MESH_MISS_RETRY_MS - 100);
  sampler.request([[10.001, 50]]);
  probeNow(t);
  assert.equal(probes.length, 2, 'not before the cooldown');
  t.mock.timers.tick(100);
  sampler.request([[10.001, 50]]);
  probeNow(t);
  assert.equal(probes.length, 3, 'retried after it');
  assert.equal(sampler.meshAt(10.001, 50), 100);
  sampler.destroy();
});
