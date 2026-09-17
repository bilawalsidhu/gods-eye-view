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
