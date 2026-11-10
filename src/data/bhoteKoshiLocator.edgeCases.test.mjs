import { createFakeEngine } from '../globe/testing/fakeEngine.js';
// Edge cases for bhote-koshi-locator: a boundary that resolves late, after its
// request was cancelled, does not change the live scene; both engines show the
// same area and the same target.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createBhoteKoshiLocatorLayer } from './bhoteKoshiLocator.js';

const STALE_RING = [
  [10, 10],
  [11, 10],
  [11, 11],
  [10, 11],
];
const LIVE_RING = [
  [80, 26],
  [88, 26],
  [88, 30],
  [80, 30],
];

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

/** A locator on one engine; `shown()` is the data source the scene draws. */
function locator(engine) {
  const lookups = [];
  const renders = [];
  const publications = [];
  const shown = new Set();
  const overlayHost = {
    setEntries: (sourceId, entries) => publications.push(entries),
    clearSource() {},
  };
  const viewer = {
    creditDisplay: { addStaticCredit() {}, removeStaticCredit() {} },
    dataSources: {
      add: (source) => shown.add(source),
      remove: (source) => shown.delete(source),
    },
  };
  const navara = createFakeEngine({ kind: 'navara' });
  navara.render.request = (reason) => renders.push(reason);
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: (signal) => {
      const lookup = deferred();
      lookups.push({ signal, ...lookup });
      return lookup.promise;
    },
    createNativeRenderer: (_engine, dataSource) => {
      shown.add(dataSource);
      return { destroy: () => shown.delete(dataSource) };
    },
    requestRender: (reason) => renders.push(reason),
    overlayHost,
    scheduleFrame: () => 1,
    cancelFrame() {},
    scheduleDelay: () => 1,
    cancelDelay() {},
  });
  const scene = engine === 'cesium' ? viewer : null;
  layer.attachRenderer({
    engine: engine === 'navara' ? navara : null,
  });
  return {
    layer,
    scene,
    lookups,
    renders,
    publications,
    shown: () => [...shown],
  };
}

/** The drawn area as degree pairs, and the drawn targets. */
function drawn(source) {
  const entities = source.entities.values;
  const fill = source.entities.getById('nepal-border-fill');
  const area = fill
    ? fill.polygon.hierarchy.getValue().positions.map((position) => {
        const c = Cesium.Cartographic.fromCartesian(position);
        return [
          Math.round(Cesium.Math.toDegrees(c.longitude)),
          Math.round(Cesium.Math.toDegrees(c.latitude)),
        ];
      })
    : null;
  return { area, ids: entities.map((entity) => entity.id).sort() };
}

for (const engine of ['cesium', 'navara']) {
  test(`edge:bhote-koshi-locator: a boundary resolving after cancel leaves the live ${engine} scene alone`, async () => {
    const h = locator(engine);
    const cancelled = h.layer.enable(h.scene);
    await h.layer.disable();
    const live = h.layer.enable(h.scene);
    assert.equal(h.lookups.length, 2);
    h.lookups[1].resolve({ ring: LIVE_RING });
    assert.equal(await live, true);

    const [source] = h.shown();
    assert.equal(h.shown().length, 1);
    const before = drawn(source);
    const publications = h.publications.length;
    const renders = h.renders.length;

    h.lookups[0].resolve({ ring: STALE_RING });
    await assert.rejects(cancelled, (error) => error?.name === 'AbortError');

    assert.deepEqual(h.shown(), [source], 'the live source stays drawn');
    assert.deepEqual(drawn(source), before);
    assert.deepEqual(before.area, LIVE_RING);
    assert.equal(h.publications.length, publications, 'no late callouts');
    assert.equal(h.renders.length, renders, 'no late frame request');
    assert.equal(h.layer.getStats().status, 'nominal');
    await h.layer.destroy();
  });
}

test('edge:bhote-koshi-locator: both engines draw the same area and the same target', async () => {
  const result = {};
  for (const engine of ['cesium', 'navara']) {
    const h = locator(engine);
    const enabling = h.layer.enable(h.scene);
    h.lookups[0].resolve({ ring: LIVE_RING });
    await enabling;
    const [source] = h.shown();
    result[engine] = {
      ...drawn(source),
      callouts: h.publications.at(-1).map(({ id, position }) => ({
        id,
        position: Cesium.Cartesian3.clone(position),
      })),
    };
    await h.layer.destroy();
  }
  assert.deepEqual(result.navara, result.cesium);
  assert.deepEqual(result.cesium.area, LIVE_RING);
  assert.ok(result.cesium.ids.includes('bhote-koshi-incident-halo'));
  assert.deepEqual(
    result.cesium.callouts.map(({ id }) => id),
    ['nepal-context-callout', 'bhote-koshi-incident-callout'],
  );
});

test('edge:bhote-koshi-locator: an engine swap while the boundary resolves lands it on the new engine only', async () => {
  const shown = { cesium: new Set(), navara: new Set() };
  const lookup = deferred();
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: () => lookup.promise,
    createNativeRenderer: (_engine, dataSource) => {
      shown.navara.add(dataSource);
      return { destroy: () => shown.navara.delete(dataSource) };
    },
    requestRender() {},
    overlayHost: { setEntries() {}, clearSource() {} },
    scheduleFrame: () => 1,
    cancelFrame() {},
    scheduleDelay: () => 1,
    cancelDelay() {},
  });
  const viewer = {
    creditDisplay: { addStaticCredit() {}, removeStaticCredit() {} },
    dataSources: {
      add: (source) => shown.cesium.add(source),
      remove: (source) => shown.cesium.delete(source),
    },
  };
  layer.attachRenderer(viewer);
  const enabling = layer.enable(viewer);
  layer.detachRenderer();
  layer.attachRenderer({
    engine: createFakeEngine({ kind: 'navara' }),
  });
  lookup.resolve({ ring: LIVE_RING });
  assert.equal(await enabling, true);
  assert.equal(shown.cesium.size, 0, 'nothing left on the released scene');
  assert.equal(shown.navara.size, 1);
  assert.deepEqual(drawn([...shown.navara][0]).area, LIVE_RING);
  await layer.destroy();
  assert.equal(shown.navara.size, 0);
});
