import test from 'node:test';
import assert from 'node:assert/strict';
import { localGeoJsonServices } from '../app/localGeojsonServices.js';
import { createLocalGeoJsonLayer as createLayer } from './localGeojsonCore.js';
import { getContextStore } from './contextStore.js';
import { bindFakeGroundRenderer } from '../testSupport/fakeGroundRenderer.mjs';

/** The catalog's services, with the overlay host each test supplies. */
const createLocalGeoJsonLayer = (options) =>
  createLayer(options, {
    ...localGeoJsonServices,
    overlayHost: options.overlayHost,
  });

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
    fake.unbind();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  let handlers = 0;
  const viewer = {};
  const fake = bindFakeGroundRenderer(viewer);
  // The builds drawn now: one per five live sets (fills, lines, pins,
  // stems and dots).
  const sources = {
    get size() { return fake.liveSets().length / 6; },
    get shown() { return fake.liveSets().every((set) => set.show); },
  };
  const listeners = {
    get size() { return fake.preRender.listeners.size + fake.moveEnd.listeners.size; },
  };
  const create = () => createLocalGeoJsonLayer({
    id: 'local-dams', name: 'Dams', color: '#0088ff', url: '/dams.geojsonl',
    overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
    inputFor: () => ({
      onClick() {
        handlers++;
        return () => { handlers--; };
      },
      suspendCamera: () => () => {},
    }),
  });
  const layer = create();
  return { layer, create, viewer, fake, sources, listeners, handlers: () => handlers };
}

test('destroy removes context records and permits a fresh replacement', async t => {
  const env = harness(t);
  t.mock.method(globalThis, 'fetch', async () => response());
  await env.layer.enable(env.viewer);
  const oldEntity = [...getContextStore().entities.values()][0].entity;
  assert.equal(getContextStore().entities.size, 1);
  env.layer.disable(env.viewer);
  assert.equal(getContextStore().entities.size, 0, 'disable releases its records with the source');
  assert.equal(env.sources.size, 0, 'disable disposes the built sets');
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

for (const phase of ['fetch', 'text']) {
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
  assert.equal(env.sources.shown, true);
});

test('disable during loading releases the completed source; re-enable rebuilds without refetching', async t => {
  const env = harness(t);
  const release = deferred();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { await release.promise; return response(); });
  const loading = env.layer.enable(env.viewer);
  env.layer.disable(env.viewer);
  release.resolve();
  await loading;
  assert.equal(env.sources.size, 0, 'a build that finishes after disable() is released, not parked hidden');
  assert.equal(env.listeners.size, 0);
  assert.equal(getContextStore().entities.size, 0);
  await env.layer.enable(env.viewer);
  assert.equal(env.sources.size, 1);
  assert.equal(env.sources.shown, true);
  assert.equal(fetchMock.mock.callCount(), 1, 'the parsed dataset is cached across the toggle');
});

test('a toggle-off frees the entities and a toggle-on rebuilds them from the cached dataset', async t => {
  const env = harness(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => response());
  await env.layer.enable(env.viewer);
  const first = env.fake.set('fills');
  assert.equal(first.items.size, 1);
  assert.equal(getContextStore().entities.size, 1);
  env.layer.disable(env.viewer);
  assert.equal(env.sources.size, 0, 'no set stays drawn while the layer is off');
  assert.equal(getContextStore().entities.size, 0);
  assert.equal(env.layer.getLodDiagnostics().total, 0);
  assert.equal(env.layer.getStats().count, 1, 'the row keeps reporting the dataset size');
  await env.layer.enable(env.viewer);
  const second = env.fake.set('fills');
  assert.notEqual(second, first, 're-enable builds fresh sets');
  assert.equal(env.sources.shown, true);
  assert.equal(second.items.size, 1);
  assert.equal(getContextStore().entities.size, 1);
  assert.equal(fetchMock.mock.callCount(), 1, 'no second fetch for a bundled dataset');
  assert.equal(env.layer.getLodDiagnostics().total, 1);
});

test('destroy while a pin icon loads cancels it and leaves no late objects', async t => {
  const saved = {
    document: globalThis.document, CESIUM_BASE_URL: globalThis.CESIUM_BASE_URL,
    createImageBitmap: globalThis.createImageBitmap,
  };
  globalThis.document = { createElement: () => ({ getContext: () => ({}) }), baseURI: 'http://gev.test/' };
  globalThis.CESIUM_BASE_URL = '/cesium/';
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1 });
  t.after(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
  });
  const env = harness(t);
  const entered = deferred();
  const release = deferred();
  let iconSignal;
  const pinned = JSON.stringify({
    type: 'Feature', id: 'pin', properties: { 'marker-symbol': 'rail' },
    geometry: { type: 'Point', coordinates: [0, 0] },
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/maki/')) return { ok: true, text: async () => pinned };
    iconSignal = options.signal;
    entered.resolve();
    await release.promise;
    return { ok: false };
  });
  const loading = env.layer.enable(env.viewer);
  await entered.promise;
  env.layer.destroy(env.viewer);
  assert.equal(iconSignal.aborted, true);
  release.resolve();
  await loading;
  assert.equal(env.fake.liveSets().length, 0);
  assert.equal(env.listeners.size, 0);
  assert.equal(env.handlers(), 0);
  assert.equal(getContextStore().entities.size, 0);
});
