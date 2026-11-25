import test from 'node:test';
import assert from 'node:assert/strict';
import { localGeoJsonServices } from '../app/localGeojsonServices.js';
import {
  getContextStore,
  getSelectedEntityContext,
  selectEntityContext,
} from '../data/contextStore.js';
import { describeEntity, findRecord } from '../data/entityContext.js';
import { bindFakeGroundRenderer } from '../testSupport/fakeGroundRenderer.mjs';
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
  const viewer = {};
  const fake = bindFakeGroundRenderer(viewer, {
    eye: { lon: 0.6, lat: 0, height: 50_000 },
  });
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
    inputFor: () => ({ onClick: () => () => {}, onPointer: () => () => {} }),
  });
  t.after(() => {
    layer.destroy(viewer);
    fake.unbind();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  // The fill sets drawn now: one per build still in the scene.
  const builds = () =>
    fake.liveSets().filter((set) => set.spec.id.endsWith(':fills'));
  return { layer, viewer, fake, builds, calls: () => calls };
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
  assert.equal(env.builds().length, 1, 'the old build is replaced, not kept');
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
  const [first] = env.builds();
  const carrierOf = (set, name) =>
    [...set.items.values()].find(
      (item) => item.meta.record.properties.name === name,
    ).meta;
  selectEntityContext(carrierOf(first, 'b'));
  // Drawn while the new build is made: watch the shapes sets made.
  const shapes = env.fake.draw.shapes;
  const drawnWhileBuilding = [];
  env.fake.draw.shapes = (spec) => {
    drawnWhileBuilding.push(first.disposed === false);
    return shapes(spec);
  };
  t.mock.timers.tick(60_000);
  const refreshing = env.layer.update(env.viewer);
  // The fetch has settled and the replacement is awaiting its pin assets.
  await Promise.resolve();
  selectEntityContext(carrierOf(first, 'a'));
  await refreshing;
  assert.ok(drawnWhileBuilding.length > 0);
  assert.ok(drawnWhileBuilding.every(Boolean), 'the old build was still drawn');
  assert.equal(first.disposed, true);
  const [next] = env.builds();
  assert.notEqual(next, first);
  assert.equal(next.show, true);
  const selected = getSelectedEntityContext();
  assert.equal(selected?.entity, carrierOf(next, 'a'));
  assert.equal(selected.properties.name, 'a');
  // Only the new set's features keep a context.
  const labels = [...getContextStore().entities.values()]
    .filter((record) => record.layerId === env.layer.id)
    .map((record) => record.label)
    .sort();
  assert.deepEqual(labels, ['a', 'c']);
});

test('a refresh keeps the selected anonymous feature through a reorder and clears it on removal', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const site = (operator) => ({
    ...point('Shared site'),
    properties: { name: 'Shared site', operator },
  });
  const north = site('North');
  const south = site('South');
  const env = harness(t, [
    { features: [north, south] },
    { features: structuredClone([south, north]) },
    { features: structuredClone([south]) },
  ]);
  await env.layer.enable(env.viewer);
  const layerId = env.layer.id;
  const manager = { layers: new Map([[layerId, { module: env.layer }]]) };
  const carrierOf = (operator) =>
    [...env.builds()[0].items.values()].find(
      (item) => item.meta.record.properties.operator === operator,
    ).meta;
  const northBefore = selectEntityContext(carrierOf('North'));
  const card = describeEntity(manager, { layerId, id: northBefore.id });

  t.mock.timers.tick(60_000);
  await env.layer.update(env.viewer);
  const afterReorder = getSelectedEntityContext();
  const northAfter = carrierOf('North');
  assert.notEqual(northAfter, northBefore.entity);
  assert.equal(findRecord(manager, card.identity)?.operator, 'North');

  selectEntityContext(northAfter);
  t.mock.timers.tick(60_000);
  await env.layer.update(env.viewer);
  const afterRemoval = getSelectedEntityContext();
  assert.equal(findRecord(manager, card.identity), null);

  assert.deepEqual(
    [
      afterReorder?.properties.operator,
      afterRemoval?.properties.operator ?? null,
    ],
    ['North', null],
  );
  assert.equal(
    afterReorder.entity,
    northAfter,
    'the current renderer carrier is selected',
  );
});

test('a refresh whose rebuild fails keeps the drawn features', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  t.mock.method(console, 'error', () => {});
  const env = harness(t, [result('a'), result('b', 'c')]);
  await env.layer.enable(env.viewer);
  const [first] = env.builds();
  env.fake.draw.shapes = () => {
    throw new Error('scene full');
  };
  t.mock.timers.tick(60_000);
  await assert.rejects(env.layer.update(env.viewer), /scene full/);
  assert.deepEqual(env.builds(), [first]);
  assert.equal(first.show, true);
  assert.equal(env.layer.getStats().count, 1);
  assert.equal(env.layer.getStats().error, null);
  // The kept features keep their contexts.
  assert.ok(
    [...getContextStore().entities.values()].some(
      (record) => record.layerId === env.layer.id && record.label === 'a',
    ),
  );
});

test('a stale library dataset reloads on the next enable', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const env = harness(t, [result('a'), result('b', 'c')]);
  await env.layer.enable(env.viewer);
  env.layer.disable(env.viewer);
  await env.layer.enable(env.viewer);
  assert.equal(
    env.calls(),
    1,
    'a re-enable within cacheSeconds reuses the data',
  );
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
  assert.equal(env.builds().length, 1);
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
  assert.equal(env.builds().length, 0);
});

test('a refresh that drops the selected feature clears the selection', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const env = harness(t, [result('b', 'a'), result('c', 'd')]);
  await env.layer.enable(env.viewer);
  const [first] = env.builds();
  selectEntityContext(
    [...first.items.values()].find(
      (item) => item.meta.record.properties.name === 'a',
    ).meta,
  );
  t.mock.timers.tick(60_000);
  await env.layer.update(env.viewer);
  assert.equal(getSelectedEntityContext(), null);
});

test('colorBy colours each feature’s fill, stem, dot and label accent', async (t) => {
  const previousWindow = globalThis.window;
  globalThis.window = { dispatchEvent() {} };
  const viewer = {};
  const fake = bindFakeGroundRenderer(viewer, {
    eye: { lon: 0.6, lat: 0, height: 50_000 },
  });
  const colored = {
    ...entry,
    display: {
      color: '#ff0000',
      colorBy: { field: 'kind', colors: { hot: '#00ff00' } },
    },
  };
  const entries = [];
  const features = [point('a'), point('b')];
  features[0].properties.__gevColorKey = 'hot';
  // A manifest rank raises a label's priority, at most by 600.
  features[1].properties.__gevRank = 9999;
  const layer = createLibraryDatasetLayer(colored, {
    services: {
      ...localGeoJsonServices,
      overlayHost: {
        setVisible() {},
        setEntries: (_source, next) => entries.push(...next),
        clearSource() {},
      },
    },
    source: { loadDataset: async () => ({ features, truncated: false }) },
    inputFor: () => ({ onClick: () => () => {}, onPointer: () => () => {} }),
  });
  t.after(() => {
    layer.destroy(viewer);
    fake.unbind();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  await layer.enable(viewer);
  const byName = (role, name) =>
    [...fake.set(role).items.values()].find(
      (item) => item.meta.record.properties.name === name,
    );
  assert.deepEqual(byName('fills', 'a').fill, [0, 1, 0, 0.3]);
  assert.deepEqual(byName('fills', 'b').fill, [1, 0, 0, 0.3]);
  assert.deepEqual(byName('stems', 'a').style.color, [0, 1, 0, 1]);
  assert.deepEqual(byName('dots', 'b').color, [1, 0, 0, 1]);
  assert.equal(byName('fills', 'a').meta.record.entry.accent, '#00ff00');
  assert.equal(byName('fills', 'b').meta.record.entry.accent, '#ff0000');
  assert.equal(
    byName('fills', 'b').meta.record.priority -
      byName('fills', 'a').meta.record.priority,
    600,
  );
});

test('library card lines reach the label copy, the first two only', async () => {
  const { localInfrastructureOverlayCopy } =
    await import('../data/localGeojsonCore.js');
  assert.deepEqual(
    localInfrastructureOverlayCopy(
      { name: 'Dam', __gevDetails: ['River: Nile', ' ', 'Height: 111 m', 'x'] },
      'lib-test',
    ),
    { title: 'Dam', details: ['River: Nile'] },
  );
});
