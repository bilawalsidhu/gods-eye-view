import test from 'node:test';
import assert from 'node:assert/strict';
import { createInfrastructureSessionLayer } from './index.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { localGeoJsonServices } from '../../app/localGeojsonServices.js';
import {
  getContextStore,
  selectEntityContext,
} from '../../data/contextStore.js';
import { layerFeedState } from '../../data/feedState.js';

test('a bundled file delivered between planets keeps multipart IDs and is read only once', async (t) => {
  let deliver,
    reads = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    reads++;
    return {
      ok: true,
      text: () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    };
  });
  const captures = [];
  const layer = createInfrastructureSessionLayer(
    { id: 'local-dams', name: 'Dams', url: '/dams' },
    {},
    () => ({
      show: (data) => captures.push(data),
      hide() {},
      destroy() {},
      lod() {},
    }),
  );
  layer.init(null, { engine: {} });
  const enabled = layer.enable();
  await new Promise(setImmediate);
  layer.detachRenderer();
  const ring = [
    [10, 20],
    [10.02, 20],
    [10, 20.01],
    [10, 20],
  ];
  deliver(
    JSON.stringify({
      type: 'Feature',
      id: 'd',
      properties: { name: 'Dam' },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [[ring], [ring]],
      },
    }),
  );
  await enabled;
  assert.equal(layer.getAnalystRecords().length, 2);
  assert.equal(captures.length, 0);
  await layer.attachRenderer({ engine: {} });
  layer.detachRenderer();
  await layer.attachRenderer({ engine: {} });
  assert.equal(captures[0], captures[1]);
  assert.deepEqual(
    captures[0].records.map((r) => r.id),
    ['d', 'd_2'],
  );
  assert.equal(reads, 1);
  layer.destroy();
});

test('a released scene stops waiting for a stalled dataset load, which stays in the session', async (t) => {
  let deliver;
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    text: () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
  }));
  const captures = [];
  const layer = createInfrastructureSessionLayer(
    { id: 'local-dams', name: 'Dams', url: '/dams' },
    {},
    () => ({
      show: (data) => captures.push(data),
      hide() {},
      destroy() {},
      lod() {},
    }),
  );
  layer.init(null, { engine: {} });
  const enabled = layer.enable();
  await new Promise(setImmediate);
  layer.detachRenderer();
  const scene = new AbortController();
  const attaching = layer.attachRenderer({
    engine: {},
    signal: scene.signal,
  });
  scene.abort();
  await attaching;
  layer.detachRenderer();
  deliver(
    JSON.stringify({
      type: 'Feature',
      id: 'd',
      properties: { name: 'Dam' },
      geometry: { type: 'Point', coordinates: [10, 20] },
    }),
  );
  await enabled;
  assert.equal(captures.length, 0);
  assert.equal(layer.getAnalystRecords().length, 1);
});

// The session layer with the contract display on the fake engine and the
// application's context store: dataset failures, analyst records, and
// the load, toggle and teardown lifecycle.

const dam = JSON.stringify({
  type: 'Feature',
  id: 'dam',
  properties: {
    name: 'Runtime Dam',
    output: '12 MW',
    tags: { associated_river: 'Test River', operator: 'Test Hydro' },
  },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-97.7, 30.2],
        [-97.69, 30.2],
        [-97.69, 30.21],
        [-97.7, 30.2],
      ],
    ],
  },
});
const serve = (text = dam) => ({
  ok: true,
  status: 200,
  text: async () => text,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function contractHarness(t) {
  const previousWindow = globalThis.window;
  globalThis.window = { dispatchEvent() {} };
  const engine = createFakeEngine();
  const create = () =>
    createInfrastructureSessionLayer(
      {
        id: 'local-dams',
        name: 'Dams',
        color: '#0088ff',
        url: '/dams.geojsonl',
        osmDerived: true,
      },
      {
        ...localGeoJsonServices,
        overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
      },
    );
  const layer = create();
  layer.init(null, { engine });
  t.after(() => {
    layer.destroy();
    engine.destroy();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  return {
    engine,
    layer,
    create,
    contexts: () => getContextStore().entities.size,
    drawn: () =>
      engine.movers.list().length +
      engine.lines.list().length +
      engine.ground.list().length,
    listeners: () => engine.fake.callsOf('input.on').length,
  };
}

test('a missing dataset reports UNAVAILABLE instead of a silent empty layer', async (t) => {
  const env = contractHarness(t);
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 404,
    text: async () => '<!DOCTYPE html>',
  }));
  await env.layer.enable();
  const stats = env.layer.getStats();
  assert.equal(stats.count, 0);
  assert.equal(stats.lastUpdate, null);
  assert.equal(stats.error, 'dataset unavailable (HTTP 404)');
  assert.equal(layerFeedState(stats), 'unavailable');
  assert.equal(env.drawn(), 0);
});

test('a corrupt dataset line reports malformed rather than parsing into nothing', async (t) => {
  const env = contractHarness(t);
  t.mock.method(globalThis, 'fetch', async () => serve('{"type":"Feature"\n'));
  await env.layer.enable();
  const stats = env.layer.getStats();
  assert.equal(stats.error, 'dataset is malformed');
  assert.equal(layerFeedState(stats), 'unavailable');
});

test('a failed load is retried by the next enable and then clears its error', async (t) => {
  const env = contractHarness(t);
  let fail = true;
  t.mock.method(globalThis, 'fetch', async () =>
    fail ? { ok: false, status: 500, text: async () => '' } : serve(),
  );
  await env.layer.enable();
  assert.equal(env.layer.getStats().error, 'dataset unavailable (HTTP 500)');
  fail = false;
  env.layer.disable();
  await env.layer.enable();
  const stats = env.layer.getStats();
  assert.equal(stats.error, null);
  assert.equal(stats.count, 1);
  assert.ok(Number.isFinite(stats.lastUpdate));
  assert.equal(layerFeedState(stats), 'nominal');
  assert.equal(env.engine.ground.list().length, 2, 'one draw, not two');
});

test('a loaded dataset is distinguishable from a dead one', async (t) => {
  const env = contractHarness(t);
  t.mock.method(globalThis, 'fetch', async () => serve());
  await env.layer.enable();
  const stats = env.layer.getStats();
  assert.equal(stats.error, null);
  assert.equal(stats.count, 1);
  assert.ok(Number.isFinite(stats.lastUpdate), 'a load timestamps itself');
  assert.equal(layerFeedState(stats), 'nominal');
});

test('analyst records snapshot the enabled layer; disable and destroy return []', async (t) => {
  const env = contractHarness(t);
  t.mock.method(globalThis, 'fetch', async () => serve());
  assert.deepEqual(env.layer.getAnalystRecords(), []);
  await env.layer.enable();
  const rows = env.layer.getAnalystRecords();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'Runtime Dam');
  assert.equal(rows[0].name, 'Runtime Dam');
  assert.equal(rows[0].operator, 'Test Hydro');
  assert.equal(rows[0].river, 'Test River');
  assert.equal(rows[0].output, '12 MW');
  assert.ok(Number.isFinite(rows[0].lat) && Number.isFinite(rows[0].lon));
  assert.deepEqual(JSON.parse(JSON.stringify(rows[0])), rows[0]);
  assert.equal(env.layer.getAnalystRecords(0).length, 1, 'at least one');
  env.layer.disable();
  assert.deepEqual(env.layer.getAnalystRecords(), []);
  await env.layer.enable();
  env.layer.destroy();
  assert.deepEqual(env.layer.getAnalystRecords(), []);
});

test('destroy removes context records and permits a fresh replacement', async (t) => {
  const env = contractHarness(t);
  t.mock.method(globalThis, 'fetch', async () => serve());
  await env.layer.enable();
  const oldEntity = [...getContextStore().entities.values()][0].entity;
  assert.equal(env.contexts(), 1);
  env.layer.disable();
  assert.equal(env.contexts(), 0, 'disable releases its records');
  assert.equal(env.drawn(), 0, 'and what it drew');
  env.layer.destroy();
  assert.equal(env.contexts(), 0);
  assert.equal(env.drawn(), 0);
  const replacement = env.create();
  replacement.init(null, { engine: env.engine });
  await replacement.enable();
  assert.equal(env.contexts(), 1);
  assert.notEqual(
    [...getContextStore().entities.values()][0].entity,
    oldEntity,
  );
  replacement.destroy();
  await env.layer.enable();
  assert.equal(env.contexts(), 0, 'a destroyed layer stays inert');
  assert.equal(env.drawn(), 0);
});

for (const phase of ['fetch', 'text']) {
  test(`destroy during ${phase} leaves no late objects or context records`, async (t) => {
    const env = contractHarness(t);
    const entered = deferred();
    const release = deferred();
    const pause = async (value) => {
      entered.resolve();
      await release.promise;
      return value;
    };
    let signal;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      signal = options.signal;
      if (phase === 'fetch') return pause(serve());
      return { ok: true, text: () => pause(dam) };
    });
    const loading = env.layer.enable();
    await entered.promise;
    env.layer.destroy();
    assert.equal(signal.aborted, true);
    release.resolve();
    await loading;
    assert.equal(env.drawn(), 0);
    assert.equal(env.contexts(), 0);
    assert.deepEqual(env.layer.getStats(), {
      count: 0,
      lastUpdate: null,
      error: null,
    });
  });
}

test('concurrent enable and disable/re-enable share one pending dataset load', async (t) => {
  const env = contractHarness(t);
  const release = deferred();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    await release.promise;
    return serve();
  });
  const first = env.layer.enable();
  env.layer.disable();
  const second = env.layer.enable();
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(env.engine.ground.list().length, 2, 'drawn once');
  assert.equal(env.contexts(), 1);
});

test('disable during loading draws nothing; re-enable draws without refetching', async (t) => {
  const env = contractHarness(t);
  const release = deferred();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    await release.promise;
    return serve();
  });
  const loading = env.layer.enable();
  env.layer.disable();
  release.resolve();
  await loading;
  assert.equal(env.drawn(), 0, 'a load that ends after disable draws nothing');
  assert.equal(env.contexts(), 0);
  await env.layer.enable();
  assert.ok(env.drawn() > 0);
  assert.equal(fetchMock.mock.callCount(), 1, 'the dataset is kept');
});

test('a toggle-off frees the drawing and a toggle-on rebuilds it from the kept dataset', async (t) => {
  const env = contractHarness(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => serve());
  await env.layer.enable();
  assert.equal(env.layer.getLodDiagnostics().total, 1);
  env.layer.disable();
  assert.equal(env.drawn(), 0, 'nothing stays drawn while the layer is off');
  assert.equal(env.contexts(), 0);
  assert.equal(env.layer.getLodDiagnostics().total, 0);
  assert.equal(env.layer.getStats().count, 1, 'the row keeps the dataset size');
  await env.layer.enable();
  assert.ok(env.drawn() > 0);
  assert.equal(env.contexts(), 1);
  assert.equal(fetchMock.mock.callCount(), 1, 'no second fetch');
  assert.equal(env.layer.getLodDiagnostics().total, 1);
});

test('a scene switch restores the selected feature on the next display', async (t) => {
  const env = contractHarness(t);
  t.mock.method(globalThis, 'fetch', async () => serve());
  await env.layer.enable();
  const record = [...getContextStore().entities.values()][0];
  selectEntityContext(record.entity);
  env.layer.detachRenderer();
  assert.equal(getContextStore().selectedEntityId, null);
  await env.layer.attachRenderer({ engine: env.engine });
  assert.equal(getContextStore().selectedEntityId, 'local-dams:dam');
});
