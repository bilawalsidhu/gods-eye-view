import assert from 'node:assert/strict';
import test from 'node:test';
import { createBurntAreasLayer, computeAreaHectares } from './index.js';

function harness(source) {
  const sources = [];
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
  const layer = createBurntAreasLayer({ source });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, sources };
}

const row = {
  stableId: 'ba-1',
  lon: 10,
  lat: 45,
  polygon: [
    [10, 45],
    [10.1, 45],
    [10.1, 45.1],
    [10, 45],
  ],
  areaHa: 10,
  fireDate: '2026-09-22 00:00:00',
};

test('T3: late refresh cannot publish after disable or destroy', async () => {
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
    h.layer.destroy(h.viewer);
  }
});

test('T3: two displays own separate data sources and destruction', async () => {
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

test('T3: a row with null areaHa still gets an entity (falls back to computeAreaHectares, not dropped)', async () => {
  const noAreaRow = { ...row, stableId: 'ba-2', areaHa: null };
  const h = harness({ getSnapshot: async () => [noAreaRow] });
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().count, 1);
});

test('T3: computeAreaHectares matches a hand-computed equatorial square within 1 ha', () => {
  // 0.01deg x 0.01deg at the equator: side ~= 0.01 * (pi/180) * 6371000 m ~= 1111.95 m.
  const square = [
    [10, 0],
    [10.01, 0],
    [10.01, 0.01],
    [10, 0.01],
  ];
  const ha = computeAreaHectares(square);
  assert.ok(Math.abs(ha - 123.64) < 1, `expected ~123.64 ha, got ${ha}`);
});
