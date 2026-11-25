import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { useEntityCardStore } from './stores/entityCard.js';
import { trafficAnalystRecords } from '../layers/traffic/records.js';

test('Omnibar In view counts a road that crosses the viewport with its middle vertex outside', () => {
  const state = {
    _enabled: true,
    _liveMode: false,
    _roads: [
      // Crosses the view centre; its middle vertex (0.002° E) is just outside the viewport.
      {
        type: 'primary',
        directFlow: 0,
        coords: [
          [-0.02, 0],
          [0.002, 0],
          [0.03, 0],
        ],
      },
      // Wholly outside the viewport.
      {
        type: 'primary',
        directFlow: 0,
        coords: [
          [1, 1],
          [1.01, 1],
          [1.02, 1],
        ],
      },
    ],
  };
  const row = {
    id: 'traffic',
    name: 'Traffic',
    enabled: true,
    stats: { count: 2, lastUpdate: 1 },
    module: { getAnalystRecords: (n) => trafficAnalystRecords(state, n) },
  };
  const manager = {
    layers: new Map([[row.id, row]]),
    isEnabled: () => true,
    getAll: () => [row],
    subscribe() {},
  };
  const store = useEntityCardStore(createPinia());
  store.connect({ dataManager: () => manager });
  store.setView({
    center: { lat: 0, lon: 0 },
    rect: { west: -0.001, south: -0.001, east: 0.001, north: 0.001 },
    heightM: 300,
    eye: { lat: 0, lon: 0 },
  });
  const traffic = store
    .inView({ viewport: true })
    .find((g) => g.layerId === 'traffic');
  assert.equal(
    traffic?.count,
    1,
    'the crossing road is in view; the outside road is not',
  );
});
