import assert from 'node:assert/strict';
import test from 'node:test';
import { createGlmLayer, flashColor } from './index.js';

const cesium = {
  PointPrimitiveCollection: class {
    constructor() { this.items = []; this.show = true; }
    add(point) { this.items.push(point); return point; }
    removeAll() { this.items = []; }
  },
  Cartesian3: { fromDegrees: (lon, lat) => ({ lon, lat }) },
};
const viewer = () => ({ scene: { primitives: {
  items: [],
  add(point) { this.items.push(point); return point; },
  remove(point) { this.items = this.items.filter((item) => item !== point); },
} } });
const feed = (flashes) => ({ getSnapshot: async () => ({ flashes, returnedCount: flashes.length, fetchedAt: 1, truncated: false }) });

test('GLM layer manages points and caps snapshots', async () => {
  const v = viewer();
  const layer = createGlmLayer({ feed: feed([
    { id: 'a', lon: 1, lat: 2, energyJ: 1e-15 },
    { id: 'b', lon: 3, lat: 4, energyJ: 2e-14 },
    { id: 'c', lon: 5, lat: 6, energyJ: 2e-13 },
  ]), cesium });
  layer.init(v);
  assert.equal(await layer.update(v), false);
  layer.enable();
  assert.equal(await layer.update(v), true);
  assert.equal(layer.getPointCount(), 3);
  assert.deepEqual(v.scene.primitives.items[0].items[1].position, { lon: 3, lat: 4 });
  assert.equal(layer.getStats().count, 3);
  const capped = createGlmLayer({ feed: { getSnapshot: async () => ({
    flashes: Array.from({ length: 25000 }, () => ({ lon: 0, lat: 0 })),
    returnedCount: 25000, truncated: true,
  }) }, cesium });
  capped.init(viewer()); capped.enable(); await capped.update();
  assert.equal(capped.getPointCount(), 20000);
  assert.equal(capped.getStats().truncated, true);
  layer.disable();
  assert.equal(layer.getPointCount(), 0);
  layer.destroy(v); layer.destroy(v);
  assert.equal(v.scene.primitives.items.length, 0);
});

test('GLM flash colors use energy buckets', () => {
  assert.equal(flashColor(1e-15).toCssColorString(), 'rgb(127,227,255)');
  assert.equal(flashColor(1e-14).toCssColorString(), 'rgb(255,209,102)');
  assert.equal(flashColor(1e-13).toCssColorString(), 'rgb(255,255,255)');
});
