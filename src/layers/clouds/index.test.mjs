import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudStats, createCloudsLayer } from './index.js';

function setup(feed) {
  const cesium = {
    Rectangle: {
      fromDegrees: (west, south, east, north) => ({ west, south, east, north }),
    },
    SingleTileImageryProvider: { fromUrl: async (url) => ({ url }) },
  };
  const imageryLayers = {
    layers: [],
    addImageryProvider(p) {
      const layer = { provider: p, alpha: 1 };
      this.layers.push(layer);
      return layer;
    },
    remove(layer) {
      this.layers = this.layers.filter((item) => item !== layer);
      return true;
    },
  };
  const viewer = { imageryLayers, scene: { globe: { show: true } } };
  return { layer: createCloudsLayer({ feed, cesium }), viewer };
}

const manifest = (id = 'a') => ({
  fetchedAt: 1,
  sources: [
    {
      observationTime: 2,
      parts: [{ url: id, rectangle: { west: 1, south: 2, east: 3, north: 4 } }],
    },
  ],
});

test('cloud layer lifecycle replaces imagery and handles unavailable sources', async () => {
  let current = manifest();
  const { layer, viewer } = setup({ getSnapshot: async () => current });
  await layer.init(viewer);
  assert.equal(await layer.update(viewer), false);
  layer.enable();
  assert.equal(await layer.update(viewer), true);
  assert.equal(layer.getOwnedLayerCount(), 1);
  current = manifest('b');
  await layer.update(viewer);
  assert.equal(viewer.imageryLayers.layers.length, 1);
  viewer.scene.globe.show = false;
  await layer.update(viewer);
  assert.match(layer.getStats().error, /Satellite or OSM/);
  layer.disable();
  layer.destroy(viewer);
  layer.destroy(viewer);
});

test('cloudStats counts only available sources', () => {
  assert.deepEqual(
    cloudStats({
      fetchedAt: 4,
      sources: [
        { parts: [{}], observationTime: 3 },
        { unavailable: true, parts: [{}], reason: 'down' },
      ],
    }),
    { count: 1, lastUpdate: 3, error: null },
  );
});
