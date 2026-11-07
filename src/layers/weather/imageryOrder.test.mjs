import test from 'node:test';
import assert from 'node:assert/strict';
import { orderWeatherImagery } from './imageryOrder.js';

test('weather compositing remains consistent when scalar, observation and history arrive out of order', () => {
  const base = { name: 'basemap' },
    radar = { name: 'radar' },
    cloud = { name: 'cloud' },
    wind = { name: 'wind' },
    lightning = { name: 'lightning' };
  const items = [base];
  const collection = {
    get length() {
      return items.length;
    },
    get: (i) => items[i],
    raiseToTop(layer) {
      items.push(...items.splice(items.indexOf(layer), 1));
    },
  };
  for (const [layer, priority] of [
    [radar, 2],
    [cloud, 1],
    [lightning, 3],
    [wind, 0],
  ]) {
    items.push(layer);
    orderWeatherImagery(collection, layer, priority);
  }
  assert.deepEqual(items, [base, wind, cloud, radar, lightning]);
  const next = { name: 'new radar history frame' };
  items.push(next);
  orderWeatherImagery(collection, next, 2);
  assert.deepEqual(items, [base, wind, cloud, radar, next, lightning]);
});

test('tileset imagery collection preserves scalar, infrared, radar and lightning order', async () => {
  const { ImageryLayerCollection, ImageryLayer } = await import('cesium');
  const tileset = { imageryLayers: new ImageryLayerCollection() };
  const layers = Array.from({ length: 4 }, () => new ImageryLayer());
  for (const priority of [3, 2, 0, 1]) {
    tileset.imageryLayers.add(layers[priority]);
    orderWeatherImagery(tileset.imageryLayers, layers[priority], priority);
  }
  assert.deepEqual(
    layers.map((_, i) => tileset.imageryLayers.get(i)),
    layers,
  );
  tileset.imageryLayers.destroy();
});

test('already ordered imagery adds and repeated ordering cause no collection churn', () => {
  const items = [];
  let raises = 0;
  const collection = {
    get length() {
      return items.length;
    },
    get: (i) => items[i],
    raiseToTop(layer) {
      raises++;
      items.push(...items.splice(items.indexOf(layer), 1));
    },
  };
  for (const priority of [0, 1, 1, 2, 3]) {
    const layer = {};
    items.push(layer);
    orderWeatherImagery(collection, layer, priority);
    orderWeatherImagery(collection, layer, priority);
  }
  assert.equal(raises, 0);
});
