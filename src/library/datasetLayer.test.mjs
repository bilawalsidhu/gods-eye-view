import test from 'node:test';
import assert from 'node:assert/strict';
import { localGeoJsonServices } from '../app/localGeojsonServices.js';
import { createLibraryDatasetLayer } from './layers.js';

const entry = {
  id: 'test-alerts',
  kind: 'dataset',
  title: 'Test alerts',
  icon: '!',
  provider: 'Test',
  display: { color: '#ff0000' },
  source: { cacheSeconds: 60 },
  attribution: { text: 'Test' },
  licence: { name: 'CC0', url: 'https://example.org/licence' },
};

const point = (name) => ({
  type: 'Feature',
  properties: { name },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [0.01, 0],
        [0, 0.01],
        [0, 0],
      ],
    ],
  },
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

function harness(t, loads) {
  const previousWindow = globalThis.window;
  globalThis.window = { dispatchEvent() {} };
  const sources = new Set();
  const event = { addEventListener: () => () => {} };
  const viewer = {
    dataSources: {
      async add(source) {
        sources.add(source);
        return source;
      },
      remove(source) {
        return sources.delete(source);
      },
    },
    scene: { canvas: {}, preRender: event, requestRender() {} },
    camera: { moveEnd: event },
  };
  let calls = 0;
  const source = {
    async loadDataset(_entry, { signal }) {
      const answer = loads[calls++];
      return typeof answer === 'function' ? answer(signal) : answer;
    },
  };
  const layer = createLibraryDatasetLayer(entry, {
    services: {
      ...localGeoJsonServices,
      overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
    },
    source,
    screenSpaceEventHandlerFactory: () => ({
      setInputAction() {},
      destroy() {},
    }),
  });
  t.after(() => {
    layer.destroy(viewer);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  return { layer, viewer, sources, calls: () => calls };
}

const result = (...names) => ({
  features: names.map(point),
  truncated: false,
});

test('a library dataset refreshes on the manager tick once older than cacheSeconds', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const env = harness(t, [result('a'), result('b', 'c')]);
  assert.equal(env.layer.refreshInterval, 60_000);
  await env.layer.enable(env.viewer);
  assert.equal(env.layer.getStats().count, 1);
  await env.layer.update(env.viewer);
  assert.equal(env.calls(), 1, 'fresh data is not refetched');
  t.mock.timers.tick(60_000);
  await env.layer.update(env.viewer);
  assert.equal(env.calls(), 2);
  assert.equal(env.layer.getStats().count, 2);
  assert.equal(env.sources.size, 1, 'the old source is replaced, not kept');
});

test('a stale library dataset reloads on the next enable', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const env = harness(t, [result('a'), result('b', 'c')]);
  await env.layer.enable(env.viewer);
  env.layer.disable(env.viewer);
  await env.layer.enable(env.viewer);
  assert.equal(env.calls(), 1, 'a re-enable within cacheSeconds reuses the data');
  env.layer.disable(env.viewer);
  t.mock.timers.tick(60_000);
  await env.layer.enable(env.viewer);
  assert.equal(env.calls(), 2);
  assert.equal(env.layer.getStats().count, 2);
});

test('a failed refresh keeps the drawn features', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const env = harness(t, [
    result('a'),
    () => Promise.reject(new Error('HTTP 503')),
  ]);
  await env.layer.enable(env.viewer);
  t.mock.timers.tick(60_000);
  await assert.rejects(env.layer.update(env.viewer), /HTTP 503/);
  assert.equal(env.layer.getStats().count, 1);
  assert.equal(env.sources.size, 1);
});

test('disable during a refresh cancels it and draws nothing late', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const pending = deferred();
  let refreshSignal = null;
  const env = harness(t, [
    result('a'),
    (signal) => {
      refreshSignal = signal;
      return pending.promise;
    },
  ]);
  await env.layer.enable(env.viewer);
  t.mock.timers.tick(60_000);
  const refreshing = env.layer.update(env.viewer);
  env.layer.disable(env.viewer);
  assert.equal(refreshSignal.aborted, true);
  pending.resolve(result('b', 'c'));
  await refreshing;
  assert.equal(env.sources.size, 0);
});
