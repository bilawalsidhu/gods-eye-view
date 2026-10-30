import assert from 'node:assert/strict';
import test from 'node:test';
import { createEntsoeGridLayer } from './index.js';

function harness(source) {
  const sources = [];
  const events = [];
  const viewer = {
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
  };
  const layer = createEntsoeGridLayer({
    source,
    overlayHost: {
      setEntries(...args) {
        events.push(args);
      },
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, sources, events };
}

test('a layer requires its source and an overlay host', () => {
  assert.throws(() => createEntsoeGridLayer({}), /source/);
  assert.throws(
    () => createEntsoeGridLayer({ source: { getSnapshot: async () => [] } }),
    /overlay host/,
  );
});

test('a layer cannot be initialized twice', () => {
  const { layer, viewer } = harness({ getSnapshot: async () => [] });
  assert.throws(() => layer.init(viewer), /already/);
});

test('a disabled layer does not fetch', async () => {
  let calls = 0;
  const layer = createEntsoeGridLayer({
    source: {
      getSnapshot: async () => {
        calls += 1;
        return { series: [], unit: null, day: null };
      },
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init({ dataSources: { add() {}, remove() {} } });
  assert.equal(await layer.update(), false);
  assert.equal(calls, 0);
});

test('a late refresh cannot publish after disable or destroy', async () => {
  for (const action of ['disable', 'destroy']) {
    let resolve;
    let signal;
    const h = harness({
      getSnapshot(options) {
        signal = options.signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    const pending = h.layer.update(h.viewer);
    h.layer[action](h.viewer);
    assert.equal(signal.aborted, true);
    if (action === 'disable') h.layer.enable(h.viewer);
    resolve({ series: [], unit: null, day: null });
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.events.length, 0);
    h.layer.destroy(h.viewer);
  }
});

test('two displays own separate data sources and destruction', async () => {
  const a = harness({
    getSnapshot: async () => ({ series: [], unit: null, day: null }),
  });
  const b = harness({
    getSnapshot: async () => ({ series: [], unit: null, day: null }),
  });
  await a.layer.update(a.viewer);
  await b.layer.update(b.viewer);
  a.layer.destroy();
  assert.equal(a.sources.length, 0);
  assert.equal(b.sources.length, 1);
  b.layer.destroy();
});
test('the layer declares the key it needs through the registry id', () => {
  const h = harness({ getSnapshot: async () => ({ series: [], unit: null, day: null }) });
  assert.equal(h.layer.requiresKeyId, 'entsoe');
  h.layer.destroy();
});

test('a missing token is reported as key-required, not as a broken feed', async () => {
  const h = harness({
    getSnapshot: async () => {
      const error = new Error('ENTSO-E requires an API token');
      error.keyRequired = true;
      throw error;
    },
  });
  assert.equal(await h.layer.update(h.viewer), false);
  const stats = h.layer.getStats();
  assert.equal(stats.keyRequired, true);
  assert.match(h.layer.getRowControls().summary.status, /KEY REQUIRED/);
  h.layer.destroy();
});
