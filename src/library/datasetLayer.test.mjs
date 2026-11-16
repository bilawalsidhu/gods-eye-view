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

// One small triangle per name, each in its own place.
const point = (name) => {
  const x = name.charCodeAt(0) / 100;
  return {
    type: 'Feature',
    properties: { name },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [x, 0],
          [x + 0.01, 0],
          [x, 0.01],
          [x, 0],
        ],
      ],
    },
  };
};
// A clock that is never 0, which reads as "never loaded".
const START = 1_000_000;

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
  t.mock.timers.enable({ apis: ['Date'], now: START });
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

test('a slow upstream still refreshes on every tick, not every other one', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  // Each request takes two seconds to answer.
  const slow = (value) => async () => {
    t.mock.timers.tick(2000);
    return value;
  };
  const env = harness(t, [
    slow(result('a')),
    slow(result('b')),
    slow(result('c')),
  ]);
  await env.layer.enable(env.viewer);
  // The manager ticks every refreshInterval from when the layer came on.
  t.mock.timers.setTime(START + 60_000);
  await env.layer.update(env.viewer);
  t.mock.timers.setTime(START + 120_000);
  await env.layer.update(env.viewer);
  assert.equal(env.calls(), 3);
});

test('a failed first load is not retried by the tick that follows enable', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  t.mock.method(console, 'error', () => {});
  const env = harness(t, [
    () => Promise.reject(new Error('HTTP 503')),
    result('a'),
  ]);
  await env.layer.enable(env.viewer);
  assert.ok(env.layer.getStats().error);
  // Resolving (not rejecting) keeps the manager from failing the switch-on.
  await env.layer.update(env.viewer);
  assert.equal(env.calls(), 1);
});

test('a refresh keeps the old features drawn until the new ones are in, and the selection', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const env = harness(t, [result('a', 'b'), result('a', 'c')]);
  await env.layer.enable(env.viewer);
  const [first] = env.sources;
  const selected = first.entities.values.find(
    (entity) => entity.properties.name.getValue() === 'a',
  );
  env.viewer.selectedEntity = selected;
  const sizes = [];
  const add = env.viewer.dataSources.add;
  env.viewer.dataSources.add = async (source) => {
    sizes.push(env.sources.size);
    return add(source);
  };
  t.mock.timers.tick(60_000);
  await env.layer.update(env.viewer);
  assert.deepEqual(sizes, [1], 'the old source was still drawn');
  assert.equal(env.sources.size, 1);
  const [next] = env.sources;
  assert.notEqual(next, first);
  assert.ok(next.entities.values.includes(env.viewer.selectedEntity));
  assert.equal(env.viewer.selectedEntity.properties.name.getValue(), 'a');
});

test('a refresh whose rebuild fails keeps the drawn features', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  t.mock.method(console, 'error', () => {});
  const env = harness(t, [result('a'), result('b', 'c')]);
  await env.layer.enable(env.viewer);
  const [first] = env.sources;
  env.viewer.dataSources.add = async () => {
    throw new Error('scene full');
  };
  t.mock.timers.tick(60_000);
  await assert.rejects(env.layer.update(env.viewer));
  assert.deepEqual([...env.sources], [first]);
  assert.equal(env.layer.getStats().count, 1);
  assert.equal(env.layer.getStats().error, null);
});

test('a stale library dataset reloads on the next enable', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
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
  t.mock.timers.enable({ apis: ['Date'], now: START });
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
  t.mock.timers.enable({ apis: ['Date'], now: START });
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
