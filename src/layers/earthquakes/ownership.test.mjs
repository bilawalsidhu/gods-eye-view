import assert from 'node:assert/strict';
import test from 'node:test';
import { createEarthquakesLayer } from './index.js';
import { createUsgsEarthquakeSource } from './source.js';
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
  return { layer, viewer, sources, events };
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
test('two displays own separate data sources and destruction', async () => {
  const a = harness({ getSnapshot: async () => [row] });
  const b = harness({ getSnapshot: async () => [] });
  await a.layer.update(a.viewer);
  await b.layer.update(b.viewer);
  assert.equal(a.layer.getStats().count, 1);
  assert.equal(b.layer.getStats().count, 0);
  a.layer.destroy();
  assert.equal(a.sources.length, 0);
  assert.equal(b.sources.length, 1);
  b.layer.destroy();
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

test('a USGS reclassification removes a displayed quake on the next refresh', async () => {
  const feature = {
    id: 'reclassified',
    geometry: { type: 'Point', coordinates: [30, 20, 3] },
    properties: { mag: 3, type: 'earthquake' },
  };
  const source = createUsgsEarthquakeSource({
    fetchImpl: async () => Response.json({ features: [feature] }),
  });
  const h = harness(source);
  try {
    assert.equal(await h.layer.update(h.viewer), true);
    assert.deepEqual(
      h.layer.getAnalystRecords().map((entry) => entry.id),
      [feature.id],
    );

    feature.properties.type = { invalid: true };
    assert.equal(await h.layer.update(h.viewer), false);
    assert.equal(h.layer.getStats().error, 'Malformed USGS response');
    assert.equal(h.layer.getStats().count, 1);

    feature.properties.type = 'quarry blast';
    assert.equal(await h.layer.update(h.viewer), true);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.sources[0].entities.values.length, 0);
    assert.deepEqual(h.events.at(-1)[1], []);
    assert.deepEqual(h.layer.getAnalystRecords(), []);
  } finally {
    h.layer.destroy();
  }
});
