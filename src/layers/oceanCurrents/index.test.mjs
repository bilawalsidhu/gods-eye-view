import test from 'node:test';
import assert from 'node:assert/strict';
import { createOceanCurrentsLayer, boxChanged, viewBox } from './index.js';

const snapshot = (tier = 'regional') => ({
  field: 'ocean-currents',
  tier,
  cycle: { validIso: '2026-10-16T06:00:00.000Z', runIso: null, forecastHour: null },
  grid: { nx: 2, ny: 2, lo1: -75, la1: 39, dx: 5, dy: 5 },
  bbox: { latMin: 34, latMax: 39, lonMin: -75, lonMax: -70 },
  noData: -9999,
  speed: { medianMs: 0.3, p95Ms: 0.6, maxMs: 1.2, validCells: 4, totalCells: 4 },
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

function harness(feed, { rectangle = null, retryMs = 60_000 } = {}) {
  const calls = [];
  const rendering = Object.fromEntries(
    ['attach', 'start', 'stop', 'clear', 'destroy', 'setField', 'setOptions', 'rehome'].map(
      (name) => [name, (...args) => calls.push([name, ...args])],
    ),
  );
  rendering.getDiagnostics = () => ({
    renderMode: 'gpu-streamlines',
    gpu: { ready: true, pathCount: 10 },
  });
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
    debounceMs: 0,
    retryMs,
    cesium,
    createRendering: (options) => {
      spec = options.spec;
      return rendering;
    },
  });
  layer.init(viewer);
  layer.enable();
  return { layer, calls, viewer, moveEnd, spec: () => spec };
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
    viewBox({ scene: { camera: { computeViewRectangle: () => undefined } } }, cesium),
    null,
  );
  assert.equal(boxChanged(box, { ...box, lonMax: -69.8 }), false);
  assert.equal(boxChanged(box, { ...box, lonMax: -69.7 }), true);
  assert.equal(boxChanged(null, box), true);
  assert.equal(boxChanged(box, null), true);
});

test('update sends the camera box, installs the field with the ocean spec and a moveEnd refetches on a changed box', async () => {
  const requests = [];
  let rectangle = { west: -75 * rad, east: -70 * rad, south: 34 * rad, north: 39 * rad };
  const h = harness({
    getSnapshot: async (args) => {
      requests.push(args.box);
      return snapshot();
    },
  });
  h.viewer.scene.camera.computeViewRectangle = () => rectangle;
  assert.equal(h.spec().calmCutoffMs, 0.02);
  await h.layer.update(h.viewer);
  assert.deepEqual(requests[0], { latMin: 34, latMax: 39, lonMin: -75, lonMax: -70 });
  assert.equal(h.calls.find(([name]) => name === 'setField')[1].tier, 'regional');
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
  assert.equal(h.layer.getStats().source, 'HF radar over global surface currents');
  h.layer.destroy();
  assert.equal(h.moveEnd.listeners.size, 0);
});

test('disable aborts in-flight work and clears; unavailable snapshots stop rendering and schedule a retry', async () => {
  let signal;
  const h = harness({
    getSnapshot: (args) => {
      signal = args.signal;
      return new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve(snapshot()), { once: true }),
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
  assert.equal(u.layer.getRowControls().summary.status, 'Ocean current upstream unavailable');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(attempts, 2, 'an unavailable answer retries after retryMs');
  assert.equal(u.layer.getStats().error, null);
  u.layer.destroy();
});
