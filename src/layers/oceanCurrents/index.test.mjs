import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOceanCurrentsLayer,
  boxChanged,
  viewBox,
  viewSpanKm,
  viewTier,
} from './index.js';

const snapshot = (tier = 'regional') => ({
  field: 'ocean-currents',
  tier,
  cycle: {
    validIso: '2026-10-16T06:00:00.000Z',
    runIso: null,
    forecastHour: null,
  },
  grid: { nx: 2, ny: 2, lo1: -75, la1: 39, dx: 5, dy: 5 },
  bbox: { latMin: 34, latMax: 39, lonMin: -75, lonMax: -70 },
  noData: -9999,
  speed: {
    medianMs: 0.3,
    p95Ms: 0.6,
    maxMs: 1.2,
    validCells: 4,
    totalCells: 4,
  },
  provenance: {
    tier: 'composite',
    tierLabel: 'HF radar over global surface currents',
    kind: 'mixed',
    ageLabel: '2 h old',
    rmseMs: 0.07,
    stale: false,
    caveats: ['x'],
    sources: [],
  },
  stale: false,
  unavailable: false,
  reason: null,
  u: new Float32Array(4).fill(0.3),
  v: new Float32Array(4),
});

const rad = Math.PI / 180;
const cesium = { Ellipsoid: { WGS84: {} } };

function harness(
  feed,
  { rectangle = null, retryMs = 60_000, debounceMs = 0 } = {},
) {
  const calls = [];
  const rendering = Object.fromEntries(
    [
      'attach',
      'start',
      'stop',
      'clear',
      'destroy',
      'setField',
      'setOptions',
      'rehome',
    ].map((name) => [name, (...args) => calls.push([name, ...args])]),
  );
  const gpu = { ready: true, pathCount: 10 };
  rendering.getDiagnostics = () => ({ renderMode: 'gpu-streamlines', gpu });
  let spec = null;
  const moveEnd = {
    listeners: new Set(),
    addEventListener(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    },
  };
  const viewer = {
    container: {},
    scene: { camera: { moveEnd, computeViewRectangle: () => rectangle } },
  };
  const layer = createOceanCurrentsLayer({
    feed,
    debounceMs,
    retryMs,
    cesium,
    createRendering: (options) => {
      spec = options.spec;
      return rendering;
    },
  });
  layer.init(viewer);
  layer.enable();
  return { layer, calls, viewer, moveEnd, gpu, spec: () => spec };
}

test('box helpers: camera rectangle to degrees and the quarter-degree change gate', () => {
  const box = viewBox(
    {
      scene: {
        camera: {
          computeViewRectangle: () => ({
            west: -75 * rad,
            east: -70 * rad,
            south: 34 * rad,
            north: 39 * rad,
          }),
        },
      },
    },
    cesium,
  );
  assert.deepEqual(box, { latMin: 34, latMax: 39, lonMin: -75, lonMax: -70 });
  assert.equal(
    viewBox(
      { scene: { camera: { computeViewRectangle: () => undefined } } },
      cesium,
    ),
    null,
  );
  assert.equal(boxChanged(box, { ...box, lonMax: -69.8 }), false);
  assert.equal(boxChanged(box, { ...box, lonMax: -69.7 }), true);
  assert.equal(boxChanged(null, box), true);
  assert.equal(boxChanged(box, null), true);
});

test('update sends the camera box, installs the field with the ocean spec and a moveEnd refetches on a changed box', async () => {
  const requests = [];
  let rectangle = {
    west: -75 * rad,
    east: -70 * rad,
    south: 34 * rad,
    north: 39 * rad,
  };
  const h = harness({
    getSnapshot: async (args) => {
      requests.push(args.box);
      return snapshot();
    },
  });
  h.viewer.scene.camera.computeViewRectangle = () => rectangle;
  assert.equal(h.spec().calmCutoffMs, 0.02);
  await h.layer.update(h.viewer);
  assert.deepEqual(requests[0], {
    latMin: 34,
    latMax: 39,
    lonMin: -75,
    lonMax: -70,
  });
  assert.equal(
    h.calls.find(([name]) => name === 'setField')[1].tier,
    'regional',
  );
  for (const fn of h.moveEnd.listeners) fn();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(requests.length, 1, 'unchanged box: no refetch');
  rectangle = { ...rectangle, east: -60 * rad };
  for (const fn of h.moveEnd.listeners) fn();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].lonMax, -60);
  const controls = h.layer.getRowControls();
  assert.equal(controls.summary.label, 'Ocean currents');
  assert.match(controls.summary.coverage, /HF radar over global/);
  assert.match(controls.info, /2026-10-16 06:00 UTC/);
  assert.match(controls.info, /RMSE 0.07/);
  assert.ok(controls.chips.some((chip) => chip.id === 'overlay-speed'));
  assert.ok(controls.chips.some((chip) => chip.id === 'motion'));
  assert.equal(controls.legend.length, 5);
  assert.equal(h.layer.getStats().count, 4);
  assert.equal(
    h.layer.getStats().source,
    'HF radar over global surface currents',
  );
  h.layer.destroy();
  assert.equal(h.moveEnd.listeners.size, 0);
});

test('disable aborts in-flight work and clears; unavailable snapshots stop rendering and schedule a retry', async () => {
  let signal;
  const h = harness({
    getSnapshot: (args) => {
      signal = args.signal;
      return new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve(snapshot()), {
          once: true,
        }),
      );
    },
  });
  const pending = h.layer.update(h.viewer);
  h.layer.disable();
  assert.equal(signal.aborted, true);
  assert.equal(await pending, false);
  let attempts = 0;
  const u = harness(
    {
      getSnapshot: async () => {
        attempts += 1;
        return attempts === 1
          ? {
              field: 'ocean-currents',
              unavailable: true,
              stale: true,
              reason: 'Ocean current upstream unavailable',
            }
          : snapshot('global');
      },
    },
    { retryMs: 10 },
  );
  await u.layer.update(u.viewer);
  assert.ok(u.calls.some(([name]) => name === 'clear'));
  assert.equal(u.layer.getStats().error, 'Ocean current upstream unavailable');
  assert.equal(
    u.layer.getRowControls().summary.status,
    'Ocean current upstream unavailable',
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(attempts, 2, 'an unavailable answer retries after retryMs');
  assert.equal(u.layer.getStats().error, null);
  u.layer.destroy();
});

test('an update superseded by a newer one resolves with the newer result instead of reporting a rejected refresh', async () => {
  const pending = [];
  const h = harness({
    getSnapshot: (args) =>
      new Promise((resolve, reject) => {
        pending.push({ args, resolve });
        args.signal.addEventListener(
          'abort',
          () => reject(args.signal.reason),
          { once: true },
        );
      }),
  });
  // The manager's enable-time update is in flight when a camera move lands.
  const managerCall = h.layer.update(h.viewer);
  await Promise.resolve();
  assert.equal(pending.length, 1);
  const moveCall = h.layer.update(h.viewer);
  await Promise.resolve();
  assert.equal(pending.length, 2);
  assert.equal(
    pending[0].args.signal.aborted,
    true,
    'the older request is cancelled',
  );
  pending[1].resolve(snapshot('regional'));
  assert.equal(await moveCall, true);
  assert.equal(
    await managerCall,
    true,
    'the manager sees the field that replaced its request',
  );
  assert.equal(h.layer.getStats().tier, 'regional');
  // An external abort still reports cancellation.
  const external = new AbortController();
  const cancelled = h.layer.update(h.viewer, { signal: external.signal });
  await Promise.resolve();
  external.abort();
  assert.equal(await cancelled, false);
  h.layer.destroy();
});

test('diagnostics carry the update timing: fetch, build, ready and total', async () => {
  const h = harness({
    getSnapshot: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return snapshot();
    },
  });
  assert.equal(h.layer.getDiagnostics().timing, null, 'nothing measured yet');
  await h.layer.update(h.viewer);
  const before = h.layer.getDiagnostics().timing;
  assert.ok(before.fetchMs >= 15, `fetch waited: ${before.fetchMs}`);
  assert.equal(before.buildMs, null, 'fake renderer reports no build');
  assert.equal(before.readyMs, null);
  assert.equal(before.totalMs, null, 'total waits for ready');
  // Once the renderer reports the field built and ready, the layer sums them.
  h.gpu.buildMs = 42;
  h.gpu.readyMs = 60;
  const after = h.layer.getDiagnostics().timing;
  assert.equal(after.fetchMs, before.fetchMs);
  assert.equal(after.buildMs, 42);
  assert.equal(after.readyMs, 60);
  assert.ok(after.totalMs >= after.fetchMs + 60, `total ${after.totalMs}`);
  assert.ok(after.totalMs < after.fetchMs + 60 + 1000);
});

test('viewSpanKm mirrors the server boxSpanKm (server/ocean/fieldGrid.js) to the metre', () => {
  // Reference values printed by the server function on 2026-10-17.
  const cases = [
    [{ latMin: 34, latMax: 39, lonMin: -75, lonMax: -70 }, 554.8414796644629],
    [{ latMin: 65, latMax: 75, lonMin: 0, lonMax: 10 }, 1115.6202510275596],
    // Eastward longitude span: 175 -> -175 is 10 deg, not 350.
    [
      { latMin: -10, latMax: 10, lonMin: 175, lonMax: -175 },
      2211.4855164318865,
    ],
    [{ latMin: -60, latMax: 60, lonMin: -120, lonMax: 40 }, 17811.118526923772],
  ];
  for (const [box, maxKm] of cases)
    assert.ok(
      Math.abs(viewSpanKm(box) - maxKm) < 1e-6,
      `${JSON.stringify(box)} -> ${viewSpanKm(box)}`,
    );
  assert.equal(viewSpanKm(null), null);
  assert.equal(
    viewSpanKm({ latMin: 0, latMax: Number.NaN, lonMin: 0, lonMax: 1 }),
    null,
  );
});

test('viewTier mirrors the server thresholds: 5000 km global, 800 km HF radar composite', () => {
  // GLOBAL_SPAN_KM in server/providers/oceanCurrents.js, HFR_MAX_SPAN_KM in
  // server/ocean/fieldGrid.js; both compare on the larger ground span.
  const atLat0 = (lonDeg) => ({
    latMin: -1,
    latMax: 1,
    lonMin: 0,
    lonMax: lonDeg,
  });
  assert.equal(
    viewTier({ latMin: -60, latMax: 60, lonMin: -120, lonMax: 40 }),
    'global',
  );
  assert.equal(viewTier(atLat0(50)), 'global'); // 5566 km
  assert.equal(viewTier(atLat0(44)), 'regional'); // 4898 km
  assert.equal(viewTier(atLat0(8)), 'regional'); // 891 km
  assert.equal(viewTier(atLat0(7)), 'coastal'); // 779 km
  assert.equal(viewTier(null), null);
});

test('a moveEnd that crosses a tier updates at once; a pan inside a tier keeps the debounce', async () => {
  const requests = [];
  let rectangle = {
    west: -120 * rad,
    east: 40 * rad,
    south: -60 * rad,
    north: 60 * rad,
  };
  const h = harness(
    {
      getSnapshot: async (args) => {
        requests.push(args.box);
        return snapshot(
          viewTier(args.box) === 'global' ? 'global' : 'regional',
        );
      },
    },
    { debounceMs: 80 },
  );
  h.viewer.scene.camera.computeViewRectangle = () => rectangle;
  await h.layer.update(h.viewer);
  assert.equal(requests.length, 1);
  const fire = () => {
    for (const fn of h.moveEnd.listeners) fn();
  };
  // Globe -> regional (20 deg, about 2200 km): the request leaves before
  // the debounce elapses.
  rectangle = {
    west: -80 * rad,
    east: -60 * rad,
    south: 25 * rad,
    north: 45 * rad,
  };
  fire();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(requests.length, 2, 'tier crossing skips the debounce');
  assert.deepEqual(requests[1], {
    latMin: 25,
    latMax: 45,
    lonMin: -80,
    lonMax: -60,
  });
  // Same tier, box moved: nothing until the debounce elapses.
  rectangle = {
    west: -79 * rad,
    east: -59 * rad,
    south: 25 * rad,
    north: 45 * rad,
  };
  fire();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(requests.length, 2, 'same tier waits for the debounce');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(requests.length, 3);
  // Regional -> coastal crosses again; a second moveEnd in the same tier
  // and the same box asks for nothing.
  rectangle = {
    west: -122.6 * rad,
    east: -121.6 * rad,
    south: 36.2 * rad,
    north: 37.3 * rad,
  };
  fire();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(requests.length, 4, 'regional to coastal skips the debounce');
  fire();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(requests.length, 4, 'unchanged box: no request');
  h.layer.destroy();
});
