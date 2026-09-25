import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindLayer, formatWindValidTime, windStats } from './index.js';

const snapshot = (model) => ({
  model,
  grid: { nx: 2, ny: 2 },
  cycle: { runIso: '2026-09-14T12:00:00Z', validIso: '2026-09-14T18:00:00Z' },
});
function harness(feed, diagnostics = {}) {
  const calls = [];
  const rendering = Object.fromEntries(
    ['attach', 'start', 'stop', 'clear', 'destroy', 'setField'].map((name) => [
      name,
      (...args) => calls.push([name, ...args]),
    ]),
  );
  rendering.getDiagnostics = () => diagnostics;
  const layer = createWindLayer({ feed, createRendering: () => rendering });
  layer.init({ container: {} });
  layer.enable();
  return { layer, calls };
}
test('forecast valid time and source age stay distinct', () => {
  assert.equal(formatWindValidTime('invalid'), null);
  assert.equal(
    formatWindValidTime('2026-01-05T06:30:00Z'),
    '2026-01-05 06:30 UTC',
  );
  assert.equal(
    windStats(snapshot('gfs')).lastUpdate,
    Date.parse('2026-09-14T12:00:00Z'),
  );
});
test('switching models clears old data and ignores an abort-insensitive late source', async () => {
  const pending = [];
  const { layer, calls } = harness({
    getSnapshot: (args) =>
      new Promise((resolve) => pending.push({ ...args, resolve })),
  });
  const first = layer.update();
  layer.setParams({ model: 'ifs' });
  await Promise.resolve();
  assert.equal(pending.length, 2);
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(layer.getStats().count, 0);
  assert.equal(layer.getStats().model, 'IFS');
  pending[0].resolve(snapshot('gfs'));
  await first;
  assert.equal(calls.filter(([name]) => name === 'setField').length, 0);
  pending[1].resolve(snapshot('ifs'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.find(([name]) => name === 'setField')[1].model, 'ifs');
  assert.match(
    layer.getRowControls().info,
    /IFS forecast[\s\S]*Valid: 2026-09-14 18:00 UTC[\s\S]*Issued: 2026-09-14 12:00 UTC/,
  );
  layer.destroy();
});
test('external and owned cancellation both cancel source work; queued switches stop on disable', async () => {
  let signal;
  const { layer } = harness({
    getSnapshot: (args) => {
      signal = args.signal;
      return new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve(snapshot('gfs')), {
          once: true,
        }),
      );
    },
  });
  const external = new AbortController();
  const update = layer.update(null, { signal: external.signal });
  layer.disable();
  assert.equal(signal.aborted, true);
  assert.equal(external.signal.aborted, false);
  assert.equal(await update, false);
  layer.enable();
  const other = layer.update(null, { signal: external.signal });
  external.abort();
  assert.equal(signal.aborted, true);
  await other;
  layer.setParams({ model: 'ifs' });
  layer.disable();
  await Promise.resolve();
  assert.equal(layer.getStats().loading, false);
  layer.destroy();
});

const complete = (model, extra = {}) => ({
  ...snapshot(model),
  grid: { nx: 2, ny: 2, lo1: 0, la1: 90, dx: 180, dy: 180 },
  u: new Float32Array(4).fill(4),
  v: new Float32Array(4).fill(3),
  ...extra,
});
test('local appearance and units reuse the loaded field; optional scalar requests remain separate', async () => {
  const requests = [];
  const { layer, calls } = harness({
    getSnapshot: async (args) => {
      requests.push(args);
      return complete(
        args.model,
        args.overlay === 'pressure'
          ? {
              scalar: {
                kind: 'pressure',
                units: 'hPa',
                values: new Float32Array(4).fill(1013),
              },
            }
          : {},
      );
    },
  });
  await layer.update();
  layer.setParams({ overlay: 'none' });
  layer.setParams({ overlay: 'speed', units: 'mph', paused: true });
  await Promise.resolve();
  assert.equal(requests.length, 1, 'speed/units/pause do not download weather');
  assert.deepEqual(layer.getParams(), {
    model: 'gfs',
    overlay: 'speed',
    units: 'mph',
    paused: true,
  });
  layer.setParams({ overlay: 'pressure' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].overlay, 'pressure');
  assert.equal(layer.getStats().overlay, 'pressure');
  assert.ok(layer.getRowControls().info.includes('(hPa)'));
  assert.equal(layer.getRowControls().legend.at(-1).label, '1050+');
  layer.destroy();
});
test('local appearance changes preserve an in-flight first load', async () => {
  const requests = [];
  const { layer } = harness({
    getSnapshot: (args) =>
      new Promise((resolve) => requests.push({ ...args, resolve })),
  });
  const first = layer.update();
  layer.setParams({ overlay: 'none' });
  await Promise.resolve();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].signal.aborted, false);
  assert.equal(layer.getStats().loading, true);
  requests[0].resolve(complete('gfs'));
  await first;
  assert.equal(layer.getStats().count, 4);
  assert.equal(layer.getStats().loading, false);
  layer.destroy();
});
test('re-enable and an appearance change cannot reuse a released renderer field', async () => {
  const requests = [];
  const { layer, calls } = harness({
    getSnapshot: (args) =>
      new Promise((resolve) => requests.push({ ...args, resolve })),
  });
  const first = layer.update();
  requests[0].resolve(complete('gfs'));
  await first;
  layer.disable();
  assert.equal(layer.getStats().count, 0);
  layer.enable();
  const second = layer.update();
  layer.setParams({ overlay: 'none' });
  await Promise.resolve();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].signal.aborted, false);
  assert.equal(layer.getStats().loading, true);
  requests[1].resolve(complete('gfs'));
  await second;
  assert.equal(
    calls.filter(([name]) => name === 'setField').length,
    2,
    'new field must reach the cleared renderer',
  );
  assert.equal(layer.getStats().count, 4);
  assert.equal(layer.getStats().loading, false);
  layer.destroy();
});
test('missing optional scalar retains valid wind and labels the field unavailable', async () => {
  const { layer } = harness({
    getSnapshot: async () =>
      complete('gfs', {
        overlay: 'pressure',
        scalarError: 'Mean sea level pressure field unavailable',
      }),
  });
  layer.setParams({ overlay: 'pressure' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(layer.getStats().count, 4);
  assert.match(layer.getStats().error, /pressure field unavailable/);
  assert.match(layer.getRowControls().info, /Selected field unavailable/);
  assert.deepEqual(layer.getRowControls().legend, []);
  layer.destroy();
});

test('a pending companion does not claim that it is already unavailable', async () => {
  let resolve;
  const { layer } = harness({
    getSnapshot: (args) =>
      args.overlay === 'none'
        ? Promise.resolve(complete('gfs'))
        : new Promise((done) => {
            resolve = done;
          }),
  });
  await layer.update();
  layer.setParams({ overlay: 'pressure' });
  await Promise.resolve();
  assert.equal(layer.getStats().loading, true);
  assert.doesNotMatch(
    layer.getRowControls().info,
    /Selected field unavailable/,
  );
  resolve(
    complete('gfs', {
      scalarError: 'Mean sea level pressure field unavailable',
    }),
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.match(layer.getRowControls().info, /Selected field unavailable/);
  layer.destroy();
});
test('an imagery failure appears in status and cannot retain a misleading field legend', async () => {
  const diagnostics = { imageryError: null };
  const { layer } = harness(
    { getSnapshot: async () => complete('gfs') },
    diagnostics,
  );
  await layer.update();
  diagnostics.imageryError = 'Globe field image unavailable';
  assert.equal(layer.getStats().error, 'Globe field image unavailable');
  assert.match(layer.getRowControls().info, /Globe field image unavailable/);
  assert.deepEqual(layer.getRowControls().legend, []);
  layer.destroy();
});
test('renderer readiness pushes fresh loading stats and controls to the displayed row', async () => {
  let ready = false;
  let statusChanged;
  const rendering = {
    attach() {},
    start() {},
    stop() {},
    clear() {},
    destroy() {},
    setField() {},
    getDiagnostics: () => ({
      renderMode: 'gpu-streamlines',
      gpu: { pathCount: 10, ready },
    }),
  };
  const layer = createWindLayer({
    feed: { getSnapshot: async () => snapshot('gfs') },
    createRendering(options) {
      statusChanged = options.onStatusChange;
      return rendering;
    },
  });
  layer.init({ container: {} });
  layer.enable();
  let displayed;
  layer.setRowControlsListener(() => {
    displayed = {
      loading: layer.getStats().loading,
      info: layer.getRowControls().info,
    };
  });
  const update = layer.update();
  const loadingInfo = layer.getRowControls().info;
  assert.match(loadingInfo, /Valid: [^\n]+ · loading/);
  await update;
  assert.equal(displayed.loading, true);
  assert.match(displayed.info, /Valid: [^\n]+ · preparing/);
  assert.equal(displayed.info.split('\n').length, loadingInfo.split('\n').length);
  ready = true;
  statusChanged();
  assert.equal(displayed.loading, false);
  assert.doesNotMatch(displayed.info, / · preparing| · loading/);
  assert.equal(displayed.info.split('\n').length, loadingInfo.split('\n').length);
  layer.destroy();
});

test('weather summary describes the selected forecast and count remains numeric', async () => {
  const { layer } = harness({ getSnapshot: async () => complete('gfs') });
  await layer.update();
  assert.equal(typeof layer.getStats().count, 'number');
  assert.equal(layer.getStats().countLabel, 'Forecast');
  const summary = layer.getRowControls().summary;
  assert.equal(summary.label, 'Wind motion');
  assert.equal(summary.units, 'km/h');
  assert.match(summary.detail, /GFS forecast.*UTC/);
  assert.equal((summary.detail.match(/UTC/g) || []).length, 1);
  assert.equal(layer.getRowControls().chips.find(c => c.id === 'overlay-temperature').label, 'Temperature');
  layer.destroy();
});

test('sample stays fixed across model, field and unit changes; dismissal and disable clear marker', async () => {
  const nodes = [];
  let listener;
  let samples = 0;
  const container = {
    ownerDocument: { createElement: () => ({ style: {}, setAttribute() {}, remove() { nodes.splice(nodes.indexOf(this), 1); } }) },
    appendChild(node) { nodes.push(node); },
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  const viewer = {
    container,
    camera: { positionWC: {}, pickEllipsoid: () => { samples++; return { longitude: 0, latitude: 0 }; } },
    scene: {
      mode: 3,
      canvas: { clientWidth: 800, clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
      cartesianToCanvasCoordinates: () => ({ x: 400, y: 300 }),
      postRender: { addEventListener(fn) { listener = fn; return () => { listener = null; }; } },
      requestRender() {},
    },
  };
  const rendering = Object.fromEntries(['attach', 'start', 'stop', 'clear', 'destroy', 'setField'].map(name => [name, () => {}]));
  const layer = createWindLayer({
    feed: { getSnapshot: async ({ model }) => complete(model) },
    cesium: {
      Cartesian2: class {}, Ellipsoid: { WGS84: {} }, SceneMode: { SCENE3D: 3 },
      Cartographic: { fromCartesian: point => point }, Math: { toDegrees: value => value },
      EllipsoidalOccluder: class { isPointVisible() { return true; } },
    },
    createRendering: () => rendering,

  });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.setParams({ inspect: true });
  const captured = layer.getRowControls().summary.reading;
  assert.equal(samples, 1);
  const retained = nodes[0];
  layer.setParams({ units: 'mph' });
  assert.equal(nodes[0], retained);
  const changed = layer.getRowControls().summary.reading;
  assert.equal(changed.speed, captured.speed);
  assert.equal(changed.coordinates, captured.coordinates);
  assert.match(changed.wind, /mph/);
  assert.equal(samples, 1, 'units do not resample');
  assert.equal(layer.getRowControls().summary.result.id, 'reading');
  assert.deepEqual(layer.getRowControls().summary.settings.map(({ label }) => label), ['MODEL', 'FIELD', 'UNITS', 'MOTION']);
  assert.equal(nodes.length, 1);
  assert.equal(typeof listener, 'function');
  viewer.camera.pickEllipsoid = () => { samples++; return { longitude: 70, latitude: 20 }; };
  layer.setParams({ overlay: 'speed' });
  assert.equal(layer.getRowControls().summary.reading.coordinates, captured.coordinates);
  layer.setParams({ model: 'ifs' });
  await new Promise(resolve => setImmediate(resolve));
  const resampled = layer.getRowControls().summary.reading;
  assert.equal(resampled.coordinates, captured.coordinates);
  assert.equal(resampled.model, 'ECMWF');
  assert.equal(resampled.position, captured.position);
  assert.equal(samples, 1, 'model and field changes never sample the moved camera');
  assert.match(layer.getRowControls().summary.result.lines.find(({ id }) => id === 'meta').text, /ECMWF · valid/);
  await layer.update();
  assert.equal(layer.getRowControls().summary.reading.coordinates, captured.coordinates);
  layer.setParams({ inspect: true });
  assert.equal(layer.getRowControls().summary.reading.coordinates, '20.00°N · 70.00°E');
  assert.equal(samples, 2, 'the next explicit read samples the new center');
  for (const change of [() => layer.setParams({ inspect: false }), () => layer.disable()]) {
    layer.setParams({ inspect: true });
    assert.equal(nodes.length, 1);
    change();
    assert.equal(nodes.length, 0);
    assert.equal(layer.getRowControls().summary.reading, null);
    assert.equal(layer.getRowControls().summary.result, null);
    assert.equal(listener, null);
  }
  layer.destroy();
});

test('observed history labels wind as a forecast without changing its data or parameters', async () => {
  const { createWeatherClock } = await import('../weather/clock.js');
  const clock = createWeatherClock();
  const layer = createWindLayer({ feed: { getSnapshot: async () => snapshot('gfs') }, clock });
  let changes = 0;
  layer.setRowControlsListener(() => changes++);
  const params = layer.getParams();
  await clock.setTarget('2026-09-14T12:00:00.000Z');
  assert.equal(layer.getRowControls().summary.status, null, 'history does not mask source status');
  assert.ok(changes > 0);
  assert.match(layer.getRowControls().info, /Forecast · does not follow history/);
  assert.deepEqual(layer.getParams(), params);
  await clock.latest();
  assert.equal(layer.getRowControls().summary.status, null);
  layer.destroy();
  const before = changes;
  await clock.setTarget('2026-09-14T12:00:00.000Z');
  assert.equal(changes, before);
  clock.destroy();
});

test('wind unit chips appear only alongside a speed legend, including canvas trails', async () => {
  let renderMode = 'gpu-streamlines'; let imageryError = null;
  const layer = createWindLayer({ feed: { getSnapshot: async () => complete('gfs') }, createRendering: () => ({ attach() {}, start() {}, clear() {}, setField() {}, setOptions() {}, getDiagnostics: () => ({ renderMode, imageryError }), stop() {}, destroy() {} }) });
  layer.init({ container: {} }); layer.enable(); await layer.update();
  const unitChips = () => layer.getRowControls().chips.filter(({ id }) => id.startsWith('units-'));
  assert.equal(layer.getRowControls().readout, true); assert.equal(layer.getRowControls().summary.coverage, 'Global · 1° grid');
  assert.deepEqual(unitChips(), []); assert.deepEqual(layer.getRowControls().legend, []);
  renderMode = 'canvas-fallback'; assert.equal(unitChips().length, 3); assert.ok(layer.getRowControls().legend.length);
  renderMode = 'gpu-streamlines'; layer.setParams({ overlay: 'speed' }); assert.equal(unitChips().length, 3);
  imageryError = 'Unavailable'; assert.deepEqual(unitChips(), []); imageryError = null;
  for (const overlay of ['pressure', 'temperature', 'none']) { layer.setParams({ overlay }); assert.deepEqual(unitChips(), []); }
  layer.destroy();
});
