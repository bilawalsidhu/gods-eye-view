import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from 'cesium';
import { createIngestion } from './ingestion.js';
import { createFlow } from './flow.js';
import { createRetention } from './retention.js';
import { createControls } from './controls.js';
import { createState } from './state.js';

const bounds = { west: 0, east: 0.01, south: 0, north: 0.01 };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function setup(source) {
  const state = { _enabled: true, _roadMode: 'osm', _loadGeneration: 0,
    _tileCache: new Map(), _parseRoads: (data) => data.roads };
  const paints = [];
  const ingestion = createIngestion({ state, source, services: {}, parts: {
    viewport: { clampBounds: (b) => b, getBoundsCenter: () => ({ lat: 0, lon: 0 }), onCameraChanged() {} },
    flow: { warmFlow: async () => [], applyFlowThenRender: async (roads) => { paints.push(roads); return true; } },
  } });
  return { state, ingestion, paints };
}
for (const stage of ['request', 'body']) test(`road ${stage} deadline releases an uncooperative transport and ignores late callbacks`, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let options, resolveLate;
  const stalled = new Promise((resolve) => { resolveLate = resolve; });
  const h = setup({ requestRoads: (_bounds, opts) => {
    options = opts;
    return stage === 'request' ? stalled : Promise.resolve({ ok: true, json: () => stalled });
  } });
  const request = h.ingestion.loadRoadsForBounds(bounds, 450);
  await flush();
  t.mock.timers.tick(12001);
  await request;
  assert.equal(options.signal.aborted, true);
  assert.equal(h.state._fetching, false);
  assert.equal(h.state._retryAttempts, 1);
  assert.ok(h.state._retryTimer);
  const source = h.state._roadSource;
  h.state._loadGeneration++;
  h.state._fetching = true;
  options.onTile({ roads: [{ coords: [] }], roadSource: 'late' });
  resolveLate(stage === 'request' ? { ok: true, json: async () => ({ roads: [], roadSource: 'late' }) } : { roads: [], roadSource: 'late' });
  await flush();
  assert.equal(h.state._roadSource, source);
  assert.equal(h.state._fetching, true, 'old completion cannot clear a new generation');
  assert.equal(h.paints.length, 0);
  h.ingestion.cancelActiveFetch();
});

test('detail deadline retains painted coarse roads and schedules bounded retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const coarse = [{ coords: [[0, 0], [0.01, 0.01]] }];
  const h = setup({ requestRoads: async (_b, options) => options.majorOnly
    ? { ok: true, json: async () => ({ roads: coarse }) } : new Promise(() => {}) });
  const request = h.ingestion.loadRoadsForBounds(bounds, 450);
  await flush();
  t.mock.timers.tick(20001);
  await request;
  assert.deepEqual(h.paints.at(-1), coarse);
  assert.equal(h.state._fetching, false);
  assert.equal(h.state._roadPartial, true);
  assert.equal(h.state._retryAttempts, 1);
  h.ingestion.cancelActiveFetch();
});

test('superseding a stalled pass aborts promptly without clearing newer loading', async () => {
  const h = setup({ requestRoads: () => new Promise(() => {}) });
  const old = h.ingestion.loadRoadsForBounds(bounds, 450);
  const next = h.ingestion.loadRoadsForBounds(bounds, 450);
  await old;
  assert.equal(h.state._fetching, true);
  h.state._enabled = false;
  h.ingestion.cancelActiveFetch();
  await next;
  clearTimeout(h.state._retryTimer);
});

for (const y of [-175, -200, -300]) test(`off-screen camera-plane height correction settles without holding public loading (${y})`, () => {
  const angle = 35 * Math.PI / 180;
  const scene = {
    canvas: { clientWidth: 1280, clientHeight: 800 },
    frameState: { mode: C.SceneMode.SCENE3D },
    camera: { viewMatrix: C.Matrix4.computeView(new C.Cartesian3(0, 0, 450),
      new C.Cartesian3(0, Math.cos(angle), -Math.sin(angle)),
      new C.Cartesian3(0, Math.sin(angle), Math.cos(angle)), C.Cartesian3.UNIT_X, new C.Matrix4()),
    frustum: new C.PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: 1.6, near: 1, far: 1e7 }) },
  };
  const point = new C.Cartesian3(0, y, 100), target = new C.Cartesian3(0, y, 197);
  const state = createState({ services: {} });
  Object.assign(state, { _viewer: { scene }, _roads: [{ heightMoving: true, waypoints: [point], targetWaypoints: [target], segmentDist: [] }] });
  const retention = createRetention({ state, parts: {} });
  retention.easeHeights(1 / 60);
  const controls = createControls({ state, services: {}, source: { getFlowSessionStats: () => ({}) }, parts: { model: { trafficFeedPresentation: () => ({}) } } });
  assert.equal(controls.methods.getStats().loading, false);
  for (let frame = 0; frame < 180; frame++) retention.easeHeights(1 / 60);
  assert.equal(state._heightPending, false);
  assert.equal(state._roads[0].heightMoving, false);
  assert.ok(C.Cartesian3.distance(point, target) < 0.01);
  assert.equal(controls.methods.getLoadingDiagnostics().movingWaypoints, 0);
});


test('visible corrections use the pixel limit without the off-screen world-speed cap', () => {
  const angle = 35 * Math.PI / 180;
  const scene = {
    canvas: { clientWidth: 1280, clientHeight: 800 },
    frameState: { mode: C.SceneMode.SCENE3D },
    camera: { viewMatrix: C.Matrix4.computeView(new C.Cartesian3(0, 0, 450),
      new C.Cartesian3(0, Math.cos(angle), -Math.sin(angle)),
      new C.Cartesian3(0, Math.sin(angle), Math.cos(angle)), C.Cartesian3.UNIT_X, new C.Matrix4()),
    frustum: new C.PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: 1.6, near: 1, far: 1e7 }) },
  };
  const point = new C.Cartesian3(0, 1000, 0), target = new C.Cartesian3(0, 1000, 300);
  const state = { _viewer: { scene }, _roads: [{ heightMoving: true, waypoints: [point], targetWaypoints: [target], segmentDist: [] }] };
  const retention = createRetention({ state, parts: {} });
  let loadingFrames = 0, maxPixels = 0;
  for (let frame = 0; frame < 180; frame++) {
    const before = C.SceneTransforms.worldToWindowCoordinates(scene, point);
    retention.easeHeights(1 / 60);
    const after = C.SceneTransforms.worldToWindowCoordinates(scene, point);
    if (before.y >= 0 && after.y >= 0) maxPixels = Math.max(maxPixels, C.Cartesian2.distance(before, after));
    if (state._heightPending) loadingFrames++;
  }
  assert.ok(maxPixels <= 12.01, `visible correction: ${maxPixels} px`);
  assert.ok(loadingFrames <= 66, `visible loading: ${loadingFrames / 60} s`);
  assert.equal(state._roads[0].heightMoving, false);
});

for (const targetHeight of [200, 2000]) test(`visible height steps stay pixel-limited outside the margin or across the near plane (${targetHeight})`, () => {
  const angle = 35 * Math.PI / 180;
  const scene = {
    canvas: { clientWidth: 1280, clientHeight: 800 },
    frameState: { mode: C.SceneMode.SCENE3D },
    camera: { viewMatrix: C.Matrix4.computeView(new C.Cartesian3(0, 0, 450),
      new C.Cartesian3(0, Math.cos(angle), -Math.sin(angle)),
      new C.Cartesian3(0, Math.sin(angle), Math.cos(angle)), C.Cartesian3.UNIT_X, new C.Matrix4()),
    frustum: new C.PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: 1.6, near: 1, far: 1e7 }) },
  };
  const point = new C.Cartesian3(0, 50, 400), target = new C.Cartesian3(0, 50, targetHeight);
  const state = { _viewer: { scene }, _roads: [{ heightMoving: true, waypoints: [point], targetWaypoints: [target], segmentDist: [] }] };
  const before = C.SceneTransforms.worldToWindowCoordinates(scene, point);
  assert.ok(before.y > 0 && before.y < 800);
  const trial = C.Cartesian3.lerp(point, target, 0.2, new C.Cartesian3());
  const trialEye = C.Matrix4.multiplyByPoint(scene.camera.viewMatrix, trial, new C.Cartesian3());
  if (targetHeight === 200) {
    assert.ok(trialEye.z < -1);
    assert.ok(C.SceneTransforms.worldToWindowCoordinates(scene, trial).y > 900);
  } else assert.ok(trialEye.z >= -1);
  createRetention({ state, parts: {} }).easeHeights(1 / 60);
  const after = C.SceneTransforms.worldToWindowCoordinates(scene, point);
  const pixels = C.Cartesian2.distance(before, after);
  assert.ok(pixels > 0 && pixels <= 12, `visible correction: ${pixels} px`);
  assert.ok(C.Matrix4.multiplyByPoint(scene.camera.viewMatrix, point, new C.Cartesian3()).z < -1);
  assert.equal(state._heightPending, true);
});

for (const outcome of ['timeout', 'abort']) test(`a road pass ${outcome} invalidates queued tiles and terrain publication without a newer generation`, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const held = [];
  const setTimer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => delay === 0
    ? (held.push(fn), held.length) : setTimer(fn, delay, ...args));
  let clock = 0;
  t.mock.method(performance, 'now', () => clock += 13);
  const state = createState({ services: {} });
  let options, samples = 0;
  const road = { type: 'primary', oneway: 1, coords: [[0, 0], [0.001, 0]],
    waypoints: [C.Cartesian3.fromDegrees(0, 0), C.Cartesian3.fromDegrees(0.001, 0)], segmentDist: [111] };
  const source = { getStatus: async () => ({ hasKey: false }), requestRoads: (_b, opts) => {
    options = opts;
    opts.onTile({ roads: [road] });
    return new Promise(() => {});
  } };
  const paints = [];
  Object.assign(state, { _enabled: true, _roadMode: 'osm', _parseRoads: (data) => data.roads,
    _viewer: { scene: { globe: { show: true, getHeight: () => { samples++; return 100; } } } } });
  const parts = {
    viewport: { clampBounds: (b) => b, getBoundsCenter: () => ({ lat: 0, lon: 0 }), onCameraChanged() {} },
    rendering: { visibleRoadsForAltitude: (roads) => roads, renderRoadsForAltitude: (...args) => paints.push(args) },
    model: { allocateRoadDotBudgets: (roads) => roads.map(() => 1), recolorDotsInPlace() {} },
  };
  const ctx = { state, source, services: { credits: {} }, parts };
  parts.flow = createFlow(ctx);
  const ingestion = createIngestion(ctx);
  const request = ingestion.loadRoadsForBounds(bounds, 450);
  await flush();
  assert.equal(held.length, 1);
  held.shift()(); await flush();
  assert.equal(held.length, 1, 'held at the final station before the real terrain onReady callback');
  options.onTile({ roads: [road] });
  const generation = state._loadGeneration;
  const revision = state._surfaceRevision;
  const samplesBefore = samples;
  if (outcome === 'timeout') t.mock.timers.tick(12001);
  else ingestion.cancelActiveFetch();
  await request;
  assert.equal(options.signal.aborted, true);
  assert.equal(state._loadGeneration, generation);
  assert.equal(state._fetching, false);
  if (outcome === 'timeout') {
    assert.equal(state._activeFetchAbort.signal.aborted, false);
    assert.match(state._roadError, /timed out/);
    assert.equal(state._retryAttempts, 1);
  }
  held.shift()(); await flush();
  assert.equal(paints.length, 0, 'expired terrain cannot publish');
  assert.equal(samples, samplesBefore, 'queued tiles cannot start surface preparation');
  assert.equal(state._surfaceRevision, revision, 'queued tiles cannot invalidate another surface pass');
  ingestion.cancelActiveFetch();
});
