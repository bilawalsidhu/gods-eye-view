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

function harness(t, url = '/dams.geojsonl') {
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
    id: 'local-dams', name: 'Dams', color: '#0088ff', url,
    overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
    screenSpaceEventHandlerFactory() {
      handlers++;
      return { setInputAction() {}, destroy() { handlers--; } };
    },
  });
  const layer = create();
  return { layer, create, viewer, sources, listeners, handlers: () => handlers };
}

test('a failed supplement preserves the main layer and is retried after a toggle', async t => {
  const env = harness(t, ['/dams.geojsonl', '/ign.geojsonl']);
  let fail = true;
  t.mock.method(globalThis, 'fetch', async url => {
    if (url === '/dams.geojsonl') return response();
    return { ok: !fail, status: 404, text: async () => dataset.replace('"id":"dam"', '"id":"ign"') };
  });
  await env.layer.enable(env.viewer);
  assert.equal(env.layer.getStats().count, 1);
  assert.ok(env.layer.getStats().error);
  assert.equal(env.sources.size, 1);
  fail = false;
  env.layer.disable(env.viewer);
  await env.layer.enable(env.viewer);
  assert.equal(env.layer.getStats().count, 2);
  assert.equal(env.layer.getStats().error, null);
  assert.equal(env.sources.size, 1);
});

for (const failed of ['/nve.geojsonl', '/ign.geojsonl']) {
  test(`three-source renderer preserves the healthy sibling when ${failed} fails and recovers on toggle`, async t => {
    const urls = ['/dams.geojsonl', '/nve.geojsonl', '/ign.geojsonl'];
    const env = harness(t, urls);
    let fail = true;
    t.mock.method(globalThis, 'fetch', async url => ({
      ok: !(fail && url === failed), status: 404,
      text: async () => dataset.replace('"id":"dam"', `"id":"${url}"`),
    }));
    await env.layer.enable(env.viewer);
    assert.equal(env.layer.getStats().count, 2);
    assert.ok(env.layer.getStats().error);
    assert.equal(env.sources.size, 1);
    fail = false;
    env.layer.disable(env.viewer);
    await env.layer.enable(env.viewer);
    assert.equal(env.layer.getStats().count, 3);
    assert.equal(env.layer.getStats().error, null);
    assert.equal(env.sources.size, 1, 'recovery replaces, rather than duplicates, the rendered data source');
  });
}

test('destroy removes context records and permits a fresh replacement', async t => {
  const env = harness(t);
  t.mock.method(globalThis, 'fetch', async () => response());
  await env.layer.enable(env.viewer);
  const oldEntity = [...getContextStore().entities.values()][0].entity;
  assert.equal(getContextStore().entities.size, 1);
  env.layer.disable(env.viewer);
  assert.equal(getContextStore().entities.size, 0, 'disable releases its records with the source');
  assert.equal(env.sources.size, 0, 'disable removes the built source from the scene');
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
  assert.equal([...env.sources][0].show, true);
  assert.equal(fetchMock.mock.callCount(), 1, 'the parsed dataset is cached across the toggle');
});

test('a toggle-off frees the entities and a toggle-on rebuilds them from the cached dataset', async t => {
  const env = harness(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => response());
  await env.layer.enable(env.viewer);
  const first = [...env.sources][0];
  assert.equal(first.entities.values.length, 1);
  assert.equal(getContextStore().entities.size, 1);
  env.layer.disable(env.viewer);
  assert.equal(env.sources.size, 0, 'no data source stays registered while the layer is off');
  assert.equal(getContextStore().entities.size, 0);
  assert.equal(env.layer.getLodDiagnostics().total, 0);
  assert.equal(env.layer.getStats().count, 1, 'the row keeps reporting the dataset size');
  await env.layer.enable(env.viewer);
  const second = [...env.sources][0];
  assert.notEqual(second, first, 're-enable builds a fresh source');
  assert.equal(second.show, true);
  assert.equal(second.entities.values.length, 1);
  assert.equal(getContextStore().entities.size, 1);
  assert.equal(fetchMock.mock.callCount(), 1, 'no second fetch for a bundled dataset');
  assert.equal(env.layer.getLodDiagnostics().total, 1);
});

test('renderer analyst records and selected contexts preserve each provider', async t => {
  const urls = ['/osm', '/nve', '/ign'];
  const env = harness(t, urls);
  const rows = [
    { id: 42, properties: { osm_id: 42, name: 'Same name' } },
    { id: 'nve-dam-42', properties: { source: 'nve', name: 'Same name', nve: { damNumber: 42 } } },
    { id: 'ign-ar-dique-42', properties: { data_source: 'IGN Argentina · Dique', source_feature_id: 'dique.42', name: 'Same name' } },
  ];
  t.mock.method(globalThis, 'fetch', async url => ({
    ok: true, text: async () => JSON.stringify({ ...JSON.parse(dataset), ...rows[urls.indexOf(url)] }),
  }));
  await env.layer.enable(env.viewer);
  const records = env.layer.getAnalystRecords();
  const sources = ['OpenStreetMap / OpenInfraMap', 'NVE', 'IGN Argentina · Dique'];
  assert.deepEqual(records.map(r => r.source), sources);
  assert.deepEqual(records.map(r => r.sourceFeatureId), ['42', 'nve-dam-42', 'dique.42']);
  assert.deepEqual([...getContextStore().entities.values()].map(r => r.source), sources);
});
