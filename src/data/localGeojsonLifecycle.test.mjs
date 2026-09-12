import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createLocalGeoJsonLayer } from './localGeojson.js';
import { getContextStore } from './contextStore.js';

const dataset = JSON.stringify({
  type: 'Feature', id: 'dam', properties: { name: 'Test dam' },
  geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.01, 0], [0, 0.01], [0, 0]]] },
});
const response = () => ({ ok: true, text: async () => dataset });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function harness(t) {
  const previousWindow = globalThis.window;
  globalThis.window = { dispatchEvent() {} };
  t.after(() => {
    layer.destroy(viewer);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const sources = new Set();
  const listeners = new Set();
  const event = { addEventListener(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  let handlers = 0;
  const viewer = {
    dataSources: {
      async add(source) { sources.add(source); return source; },
      remove(source) { return sources.delete(source); },
    },
    scene: { canvas: {}, preRender: event, requestRender() {} },
    camera: { moveEnd: event },
  };
  const create = () => createLocalGeoJsonLayer({
    id: 'local-dams', name: 'Dams', color: '#0088ff', url: '/dams.geojsonl',
    overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
    screenSpaceEventHandlerFactory() {
      handlers++;
      return { setInputAction() {}, destroy() { handlers--; } };
    },
  });
  const layer = create();
  return { layer, create, viewer, sources, listeners, handlers: () => handlers };
}

test('destroy removes context records and permits a fresh replacement', async t => {
  const env = harness(t);
  t.mock.method(globalThis, 'fetch', async () => response());
  await env.layer.enable(env.viewer);
  const oldEntity = [...getContextStore().entities.values()][0].entity;
  assert.equal(getContextStore().entities.size, 1);
  env.layer.disable(env.viewer);
  assert.equal(getContextStore().entities.size, 1, 'disabled cached source retains its records');
  env.layer.destroy(env.viewer);
  assert.equal(getContextStore().entities.size, 0);
  assert.equal(env.sources.size, 0);
  assert.equal(env.listeners.size, 0);
  assert.equal(env.handlers(), 0);
  const replacement = env.create();
  await replacement.enable(env.viewer);
  assert.equal(getContextStore().entities.size, 1);
  assert.notEqual([...getContextStore().entities.values()][0].entity, oldEntity);
  replacement.destroy(env.viewer);
  await env.layer.enable(env.viewer);
  assert.equal(getContextStore().entities.size, 0);
});

for (const phase of ['fetch', 'text', 'parse', 'add']) {
  test(`destroy during ${phase} leaves no late objects or context records`, async t => {
    const env = harness(t);
    const entered = deferred();
    const release = deferred();
    const pause = async value => { entered.resolve(); await release.promise; return value; };
    let signal;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      signal = options.signal;
      if (phase === 'fetch') return pause(response());
      if (phase === 'text') return { ok: true, text: () => pause(dataset) };
      return response();
    });
    if (phase === 'parse') {
      const load = Cesium.GeoJsonDataSource.load;
      t.mock.method(Cesium.GeoJsonDataSource, 'load', async (...args) => pause(await load(...args)));
    }
    if (phase === 'add') {
      t.mock.method(env.viewer.dataSources, 'add', async source => {
        await pause();
        env.sources.add(source);
        return source;
      });
    }
    const loading = env.layer.enable(env.viewer);
    await entered.promise;
    env.layer.destroy(env.viewer);
    assert.equal(signal.aborted, true);
    release.resolve();
    await loading;
    assert.equal(env.sources.size, 0);
    assert.equal(env.listeners.size, 0);
    assert.equal(env.handlers(), 0);
    assert.equal(getContextStore().entities.size, 0);
    assert.deepEqual(env.layer.getStats(), { count: 0, lastUpdate: null, error: null });
  });
}

test('concurrent enable and disable/re-enable share one pending dataset load', async t => {
  const env = harness(t);
  const release = deferred();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    await release.promise;
    return response();
  });
  const first = env.layer.enable(env.viewer);
  env.layer.disable(env.viewer);
  const second = env.layer.enable(env.viewer);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(env.sources.size, 1);
  assert.equal(env.handlers(), 1);
  assert.equal(env.listeners.size, 2);
  assert.equal([...env.sources][0].show, true);
});

test('disable during loading keeps the completed source hidden until re-enabled', async t => {
  const env = harness(t);
  const release = deferred();
  t.mock.method(globalThis, 'fetch', async () => { await release.promise; return response(); });
  const loading = env.layer.enable(env.viewer);
  env.layer.disable(env.viewer);
  release.resolve();
  await loading;
  assert.equal([...env.sources][0].show, false);
  assert.equal(env.listeners.size, 0);
  await env.layer.enable(env.viewer);
  assert.equal([...env.sources][0].show, true);
  assert.equal(env.sources.size, 1);
});
