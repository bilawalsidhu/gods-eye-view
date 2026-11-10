import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeGroundHarness } from '../../testSupport/groundDisplayEngines.mjs';
import { createEarthquakesLayer } from './index.js';
import { createUsgsEarthquakeSource } from './source.js';
function harness(source) {
  const events = [];
  const ground = createFakeGroundHarness();
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
  layer.init(null, { engine: ground.engine });
  layer.enable();
  return { layer, ground, events };
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
    const pending = h.layer.update();
    h.layer[action]();
    assert.equal(signal.aborted, true);
    if (action === 'disable') h.layer.enable();
    resolve([row]);
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.events.length, 0);
    h.layer.destroy();
  }
});
test('two displays own separate ground sets and destruction', async () => {
  const a = harness({ getSnapshot: async () => [row] });
  const b = harness({ getSnapshot: async () => [] });
  await a.layer.update();
  await b.layer.update();
  assert.equal(a.layer.getStats().count, 1);
  assert.equal(b.layer.getStats().count, 0);
  a.layer.destroy();
  assert.equal(a.ground.sets(), 0);
  assert.equal(b.ground.sets(), 1);
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

test('an observation received between scenes is queryable and draws without a second fetch', async () => {
  let resolve,
    polls = 0;
  const h = harness({
    getSnapshot() {
      polls++;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  try {
    const pending = h.layer.update();
    h.layer.detachRenderer();
    assert.equal(h.ground.sets(), 0);
    resolve([row]);
    assert.equal(await pending, true);
    const [record] = h.layer.getAnalystRecords();
    assert.equal(record.id, row.usgsId);
    assert.equal(record.lat, row.lat);
    assert.equal(h.events.length, 0);
    h.layer.attachRenderer({ engine: h.ground.engine });
    assert.equal(h.ground.set('earthquakes').items.length, 1);
    assert.equal(h.events.length, 1);
    assert.equal(polls, 1);
  } finally {
    h.layer.destroy();
  }
});
