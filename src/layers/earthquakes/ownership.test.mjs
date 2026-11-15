import assert from 'node:assert/strict';
import test from 'node:test';
import { createEarthquakesLayer } from './index.js';
import { createUsgsEarthquakeSource } from './source.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
function harness(source) {
  const events = [];
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  const layer = createEarthquakesLayer({
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
const row = {
  stableId: 'event-a',
  usgsId: 'event-a',
  lon: 30,
  lat: 20,
  depthKm: 3,
  mag: 4,
  place: 'Fixture',
  time: 1000,
};
test('late refresh cannot publish after disable, re-enable, or destroy', async () => {
  for (const action of ['disable', 'destroy']) {
    let resolve, signal;
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
    resolve([row]);
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.events.length, 0);
    h.layer.destroy(h.viewer);
  }
});
test('two displays own separate draw sets and destruction', async () => {
  const a = harness({ getSnapshot: async () => [row] });
  const b = harness({ getSnapshot: async () => [] });
  await a.layer.update(a.viewer);
  await b.layer.update(b.viewer);
  assert.equal(a.layer.getStats().count, 1);
  assert.equal(b.layer.getStats().count, 0);
  assert.equal(a.draw.find('earthquakes:').items.size, 1);
  a.layer.destroy();
  assert.equal(a.draw.find('earthquakes:'), undefined, 'disposed');
  assert.equal(b.draw.find('earthquakes:').items.size, 0);
  b.layer.destroy();
  assert.equal(b.draw.find('earthquakes:'), undefined);
});
test('USGS body completion honors cancellation even with an uncooperative transport', async () => {
  const abort = new AbortController();
  const source = createUsgsEarthquakeSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        abort.abort();
        return { features: [] };
      },
    }),
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
test('analyst records come from the events the layer drew, and only while it is on', async () => {
  const h = harness({
    getSnapshot: async () => [
      row,
      { ...row, stableId: 'event-b', usgsId: 'event-b', mag: 5.5 },
    ],
  });
  await h.layer.update(h.viewer);
  assert.deepEqual(h.layer.getAnalystRecords(), [
    {
      id: 'event-a',
      magnitude: 4,
      depthKm: 3,
      lat: 20,
      lon: 30,
      timeMs: 1000,
      place: 'Fixture',
    },
    {
      id: 'event-b',
      magnitude: 5.5,
      depthKm: 3,
      lat: 20,
      lon: 30,
      timeMs: 1000,
      place: 'Fixture',
    },
  ]);
  assert.equal(h.layer.getAnalystRecords(1).length, 1);
  const [disc] = h.draw.find('earthquakes:').items.values();
  assert.equal(disc.meta, undefined, 'the disc carries drawing only');
  h.layer.disable(h.viewer);
  assert.deepEqual(h.layer.getAnalystRecords(), []);
  h.layer.destroy(h.viewer);
});
test('two layers share one renderer, each with its own disc set', async () => {
  const events = [];
  const overlayHost = {
    setEntries: (...args) => events.push(args),
    setVisible() {},
    clearSource() {},
  };
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  const a = createEarthquakesLayer({
    source: { getSnapshot: async () => [row] },
    overlayHost,
  });
  const b = createEarthquakesLayer({
    source: { getSnapshot: async () => [] },
    overlayHost,
  });
  a.init(viewer);
  b.init(viewer);
  a.enable(viewer);
  b.enable(viewer);
  await a.update(viewer);
  await b.update(viewer);
  const live = [...draw.sets.values()].filter((set) => !set.disposed);
  assert.equal(live.length, 2);
  assert.deepEqual(
    live.map((set) => set.items.size),
    [1, 0],
  );
  a.destroy();
  a.init(viewer);
  assert.equal(
    [...draw.sets.values()].filter((set) => !set.disposed).length,
    2,
    'destroyed, then started again',
  );
  a.destroy();
  b.destroy();
});
test('a viewer with nothing to draw with is refused at init, and init can be retried', () => {
  const layer = createEarthquakesLayer({
    source: { getSnapshot: async () => [] },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  const viewer = {};
  assert.throws(() => layer.init(viewer), /no renderer to draw with/);
  const { unbind } = bindFakeDraw(viewer);
  layer.init(viewer);
  layer.destroy();
  unbind();
});
