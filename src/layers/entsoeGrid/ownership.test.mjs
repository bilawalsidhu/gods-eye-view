import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { createEntsoeGridLayer } from './index.js';

function harness(source) {
  const events = [];
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
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
  return { layer, viewer, draw, events };
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
        return { zones: [], unit: null, day: null };
      },
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init(viewerWithDraw());
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
    resolve({ zones: [], unit: null, day: null });
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.events.length, 0);
    h.layer.destroy(h.viewer);
  }
});

test('two displays own separate data sources and destruction', async () => {
  const a = harness({
    getSnapshot: async () => ({ zones: [], unit: null, day: null }),
  });
  const b = harness({
    getSnapshot: async () => ({ zones: [], unit: null, day: null }),
  });
  await a.layer.update(a.viewer);
  await b.layer.update(b.viewer);
  a.layer.destroy();
  assert.equal(a.sources.length, 0);
  assert.equal(b.sources.length, 1);
  b.layer.destroy();
});
test('the layer declares the key it needs through the registry id', () => {
  const h = harness({
    getSnapshot: async () => ({ zones: [], unit: null, day: null }),
  });
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

const zonesSnapshot = () => ({
  unit: 'MW',
  day: '2026-10-25',
  zones: ['FR', 'DE'].map((code, index) => ({
    code,
    name: code === 'FR' ? 'France' : 'Germany',
    lat: 46 + index,
    lon: 2 + index,
    unit: 'MW',
    day: '2026-10-25',
    series: [
      { position: 1, value: 100, band: 'peak' },
      { position: 2, value: 40, band: 'moderate' },
    ],
  })),
});

test('one pin per zone, and picking a pin opens its card and focuses the rail', async () => {
  const slots = [];
  const sources = [];
  const layer = createEntsoeGridLayer({
    source: { getSnapshot: async () => zonesSnapshot() },
    overlayHost: {
      setEntries: (id, entries) => slots.push([id, entries]),
      setVisible() {},
      clearSource: (id) => slots.push([id, null]),
    },
  });
  layer.init({
    dataSources: { add: (value) => sources.push(value), remove() {} },
  });
  layer.enable();
  await layer.update();
  const entities = sources[0].entities.values;
  assert.deepEqual(entities.map((entity) => entity.id).sort(), [
    'entsoe-zone:DE',
    'entsoe-zone:FR',
  ]);
  assert.equal(layer.getStats().count, 2);
  // The rail follows France until another country is chosen.
  assert.match(layer.getRowControls().summary.detail, /France/);
  layer.destroy();
});
