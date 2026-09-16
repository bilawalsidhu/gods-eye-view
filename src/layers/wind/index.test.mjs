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
test('non-DOM renderer test containers do not construct a DOM presentation', () => {
  let presentations = 0;
  const rendering = Object.fromEntries(
    ['attach', 'start', 'stop', 'clear', 'destroy'].map((name) => [
      name,
      () => {},
    ]),
  );
  const layer = createWindLayer({
    feed: { getSnapshot: async () => complete('gfs') },
    createRendering: () => rendering,
    createPresentation: () => {
      presentations++;
      throw new Error('not a DOM');
    },
  });
  layer.init({ container: { appendChild() {} } });
  assert.equal(presentations, 0);
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
test('changing units dismisses an inspection snapshot showing the previous units', () => {
  let hidden = 0;
  const rendering = Object.fromEntries(
    ['attach', 'start', 'stop', 'clear', 'destroy'].map((name) => [
      name,
      () => {},
    ]),
  );
  const layer = createWindLayer({
    feed: { getSnapshot: async () => complete('gfs') },
    createRendering: () => rendering,
    createPresentation: () => ({
      hide() {
        hidden++;
      },
      destroy() {},
    }),
  });
  layer.init({
    container: { appendChild() {}, ownerDocument: { createElement() {} } },
  });
  layer.setParams({ units: 'mph' });
  assert.equal(hidden, 1);
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
  await layer.update();
  assert.equal(displayed.loading, true);
  assert.match(displayed.info, /Preparing globe flow/);
  ready = true;
  statusChanged();
  assert.equal(displayed.loading, false);
  assert.doesNotMatch(displayed.info, /Preparing globe flow/);
  layer.destroy();
});
