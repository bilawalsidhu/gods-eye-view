import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  createSanAntonioLayer,
  getSanAntonioDataset,
} from 'gods-eye-view/layers/san-antonio';

const dataset = getSanAntonioDataset('san-antonio-trailheads');
const feature = (id = 1, name = 'Trail access') => ({
  type: 'Feature',
  properties: { OBJECTID: id, Name: name },
  geometry: { type: 'Point', coordinates: [-98.49, 29.42] },
});
const snapshot = (features = [feature()], fetchedAt = 1000) => ({
  features,
  sourceCount: features.length,
  sourceUpdatedAt: 500,
  fetchedAt,
});
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(
  source = { getSnapshot: async () => snapshot() },
  options = {},
) {
  const renderers = [];
  const publications = [];
  const handlers = [];
  const viewer = { scene: { requestRender() {}, pick: () => null } };
  const overlayHost = {
    setEntries(id, entries) {
      publications.push({ id, entries });
    },
    setVisible() {},
    clearSource(id) {
      publications.push({ id, entries: [] });
    },
    hitTest: () => null,
  };
  const layer = createSanAntonioLayer({
    dataset,
    source,
    rendererFactory() {
      const renderer = {
        destroyed: false,
        visible: false,
        replace(records) {
          this.records = records;
        },
        setVisible(value) {
          this.visible = value;
        },
        destroy() {
          this.destroyed = true;
          this.visible = false;
        },
      };
      renderers.push(renderer);
      return renderer;
    },
    overlayHost,
    picking: {
      resolvePickId: (picked) => picked?.id?.id ?? picked?.id ?? null,
      isOwnedByOtherLayer: (_layerId, id) => id === 'aircraft',
    },
    screenSpaceEventHandlerFactory() {
      const handler = {
        setInputAction(fn, type) {
          this.fn = fn;
          this.type = type;
        },
        destroy() {
          this.destroyed = true;
        },
      };
      handlers.push(handler);
      return handler;
    },
    ...options,
  });
  return { layer, viewer, renderers, publications, handlers, overlayHost };
}

test('package consumer is lazy, keeps snapshot dates, and releases display on disable', async () => {
  const calls = [];
  const raw = snapshot();
  const env = harness({
    getSnapshot: async (request) => {
      calls.push(request);
      return structuredClone(raw);
    },
  });
  env.layer.init(env.viewer);
  env.layer.enable();
  assert.equal(calls.length, 0);
  assert.equal(env.renderers.length, 0);
  assert.equal(await env.layer.update(), true);
  assert.equal(calls[0].datasetId, dataset.id);
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.equal(env.layer.getStats().count, 1);
  assert.equal(env.layer.getStats().lastUpdate, 1000);
  assert.equal(env.layer.getStats().sourceUpdatedAt, 500);
  assert.equal(env.layer.getAnalystRecords()[0].name, 'Trail access');
  assert.equal(await env.layer.update(), true);
  assert.equal(
    env.renderers.length,
    1,
    'same cached snapshot does not rebuild graphics',
  );
  env.layer.disable();
  assert.ok(env.renderers[0].destroyed);
  assert.ok(env.handlers[0].destroyed);
  assert.deepEqual(env.layer.getAnalystRecords(), []);
  assert.equal(env.layer.getStats().count, 0);
  env.layer.enable();
  assert.equal(await env.layer.update(), true);
  assert.equal(env.renderers.length, 2);
  env.layer.destroy();
  assert.ok(env.renderers[1].destroyed);
  assert.equal(env.layer.enable(), false);
});

test('failed refresh retains the previous complete display and reports stale data', async () => {
  let fail = false;
  const env = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('ArcGIS HTTP 503');
      return snapshot();
    },
  });
  env.layer.init(env.viewer);
  env.layer.enable();
  await env.layer.update();
  fail = true;
  assert.equal(await env.layer.update(), false);
  assert.equal(env.layer.getStats().count, 1);
  assert.equal(env.layer.getStats().stale, true);
  assert.match(env.layer.getStats().error, /503/);
  assert.equal(env.renderers[0].destroyed, false);
  env.layer.destroy();
});

test('invalid geometry is reported as partial; an all-invalid refresh cannot erase good data', async () => {
  const bad = {
    ...feature(2),
    geometry: { type: 'Point', coordinates: [null, 29] },
  };
  let raw = snapshot([feature(), bad]);
  const env = harness({ getSnapshot: async () => raw });
  env.layer.init(env.viewer);
  env.layer.enable();
  assert.equal(await env.layer.update(), true);
  assert.equal(env.layer.getStats().sourceCount, 2);
  assert.equal(env.layer.getStats().count, 1);
  assert.equal(env.layer.getStats().skippedCount, 1);
  assert.equal(env.layer.getStats().partial, true);
  raw = snapshot([bad], 2000);
  assert.equal(await env.layer.update(), false);
  assert.equal(env.layer.getStats().count, 1);
  assert.equal(env.layer.getStats().lastUpdate, 1000);
  env.layer.destroy();
});

test('disable aborts acquisition and late completion cannot revive graphics', async () => {
  const pending = deferred();
  let request;
  const env = harness({
    getSnapshot: (value) => {
      request = value;
      return pending.promise;
    },
  });
  env.layer.init(env.viewer);
  env.layer.enable();
  const updating = env.layer.update();
  env.layer.disable();
  assert.equal(request.signal.aborted, true);
  pending.resolve(snapshot());
  assert.equal(await updating, false);
  assert.equal(env.renderers.length, 0);
  assert.equal(env.layer.getStats().loading, false);
  env.layer.destroy();
});

test('cancellation during async renderer installation destroys pending resources', async () => {
  const installing = deferred();
  const entered = deferred();
  const pendingRenderer = {
    destroyed: false,
    replace() {
      entered.resolve();
      return installing.promise;
    },
    setVisible() {
      assert.fail('cancelled renderer must never become visible');
    },
    destroy() {
      this.destroyed = true;
    },
  };
  const env = harness(undefined, { rendererFactory: () => pendingRenderer });
  env.layer.init(env.viewer);
  env.layer.enable();
  const owner = new AbortController();
  const updating = env.layer.update(env.viewer, { signal: owner.signal });
  await entered.promise;
  owner.abort();
  assert.ok(pendingRenderer.destroyed);
  installing.resolve();
  assert.equal(await updating, false);
  assert.equal(env.layer.getStats().count, 0);
  env.layer.destroy();
});

test('selection uses plain source text, respects other overlay cards, and opens only the fixed catalog link', async () => {
  const name = '<img src=x onerror=alert(1)> Trail';
  const opened = [];
  const env = harness(
    { getSnapshot: async () => snapshot([feature(1, name)]) },
    {
      openExternal: (url) => opened.push(url),
    },
  );
  env.layer.init(env.viewer);
  env.layer.enable();
  await env.layer.update();
  const id = env.layer.getAnalystRecords()[0].id;
  env.viewer.scene.pick = () => ({ id: { id, part: 0 } });
  const click = { position: { x: 10, y: 20 } };
  assert.equal(env.handlers[0].type, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  env.handlers[0].fn(click);
  assert.equal(env.layer.getStats().selectedId, id);
  const card = env.publications.at(-1).entries[0];
  assert.equal(card.title, 'Trail');
  card.activate();
  assert.deepEqual(opened, [dataset.datasetUrl]);
  env.overlayHost.hitTest = () => ({
    sourceId: 'another-layer',
    entryId: 'card',
  });
  env.viewer.scene.pick = () => null;
  env.handlers[0].fn(click);
  assert.equal(
    env.layer.getStats().selectedId,
    id,
    'sibling cards preserve selection',
  );
  env.overlayHost.hitTest = () => null;
  env.handlers[0].fn(click);
  assert.equal(env.layer.getStats().selectedId, null);
  env.layer.destroy();
});
