import assert from 'node:assert/strict';
import test from 'node:test';
import { createEarthquakesLayer } from './index.js';
import { createEarthquakeSource, createUsgsEarthquakeSource } from './source.js';
import { layerFeedState } from '../../data/feedState.js';
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


test('partial catalog coverage is visible in layer stats until both sources recover', async () => {
  for (const missing of ['USGS', 'EMSC']) {
    let unavailable = true;
    const source = createEarthquakeSource({
      ...Object.fromEntries(['USGS', 'EMSC'].map((name) => [name.toLowerCase(), {
        async getSnapshot() {
          if (unavailable && name === missing) throw new Error('offline');
          return name === missing ? [] : [row];
        },
      }])),
    });
    const h = harness(source);
    try {
      assert.equal(await h.layer.update(h.viewer), true);
      const stats = h.layer.getStats();
      assert.equal(stats.count, 1);
      assert.equal(stats.complete, false);
      assert.equal(stats.partial, true);
      assert.deepEqual(stats.missingSources, [missing]);
      assert.match(stats.error, new RegExp(missing));
      assert.equal(layerFeedState(stats), 'degraded');
      unavailable = false;
      assert.equal(await h.layer.update(h.viewer), true);
      assert.equal(h.layer.getStats().error, null);
      assert.equal(h.layer.getStats().complete, true);
      assert.equal(layerFeedState(h.layer.getStats()), 'nominal');
    } finally {
      h.layer.destroy();
    }
  }
});
