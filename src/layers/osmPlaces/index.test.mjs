// OSM Places holds the last voice search's results: queryable while shown,
// labelled through the overlay host, and nothing when switched off.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOsmPlacesLayer } from './index.js';

function fakeOverlayHost() {
  const calls = [];
  return {
    calls,
    setEntries: (...args) => calls.push(['setEntries', ...args]),
    clearSource: (...args) => calls.push(['clearSource', ...args]),
    setVisible: (...args) => calls.push(['setVisible', ...args]),
  };
}

const RECORDS = [
  {
    id: 'node/1',
    lat: 27.7,
    lon: 85.3,
    name: 'Bir Hospital',
    kind: 'hospital',
  },
  { id: 'node/2', lat: 27.71, lon: 85.31, name: null, kind: 'hospital' },
];

test('results are queryable only while the layer is on, and labels follow names', () => {
  const host = fakeOverlayHost();
  const layer = createOsmPlacesLayer({ overlayHost: host });
  layer.setResults(RECORDS, {
    kind: 'hospital',
    label: 'hospitals',
    area: 'Kathmandu',
  });
  assert.deepEqual(layer.getAnalystRecords(), [], 'off: nothing to count');
  assert.equal(layer.getStats().count, 2);
  assert.equal(layer.getStats().statusMessage, 'hospitals · Kathmandu');
  layer.enable();
  const records = layer.getAnalystRecords();
  assert.equal(records.length, 2);
  records[0].name = 'changed';
  assert.equal(
    layer.getAnalystRecords()[0].name,
    'Bir Hospital',
    'callers get copies',
  );
  assert.deepEqual(layer.getResultsMeta(), {
    kind: 'hospital',
    label: 'hospitals',
    area: 'Kathmandu',
    count: 2,
  });
  layer.disable();
  assert.ok(
    host.calls.some(
      ([name, id]) => name === 'clearSource' && id === 'osm-places',
    ),
  );
});

test('an empty layer tells the operator how to fill it', () => {
  const layer = createOsmPlacesLayer({ overlayHost: fakeOverlayHost() });
  assert.match(layer.getStats().statusMessage, /needs an Overpass server/);
  assert.throws(() => createOsmPlacesLayer(), TypeError);
});

test('destroy and re-init expose a fresh empty session', () => {
  const host = fakeOverlayHost();
  const layer = createOsmPlacesLayer({ overlayHost: host });
  layer.setResults(RECORDS, {
    kind: 'hospital',
    label: 'hospitals',
    area: 'Kathmandu',
  });
  assert.ok(layer.getStats().lastUpdate);
  layer.destroy();
  const dataSources = {
    added: [],
    removed: [],
    add(source) {
      this.added.push(source);
      return source;
    },
    remove(source, destroy) {
      this.removed.push([source, destroy]);
      return true;
    },
  };
  layer.init({ dataSources });
  layer.enable();
  assert.equal(layer.getResultsMeta(), null);
  assert.deepEqual(layer.getAnalystRecords(), []);
  assert.deepEqual(layer.getStats(), {
    count: 0,
    lastUpdate: null,
    error: null,
    statusMessage: 'Voice place search (needs an Overpass server)',
  });
});

test('without an operator Overpass the layer shows as unavailable', async () => {
  const added = [];
  const viewer = { dataSources: { add: (ds) => added.push(ds), remove() {} } };
  const off = createOsmPlacesLayer({
    overlayHost: fakeOverlayHost(),
    overpassConfigured: async () => false,
  });
  assert.equal(
    off.getSourceAvailability().available,
    true,
    'unknown until asked',
  );
  off.init(viewer);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(off.getSourceAvailability().available, false);
  const unknown = createOsmPlacesLayer({
    overlayHost: fakeOverlayHost(),
    overpassConfigured: async () => null,
  });
  unknown.init(viewer);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    unknown.getSourceAvailability().available,
    true,
    'an unknown answer keeps it listed',
  );
});

test('places are depth-tested past close range, so they never show through the globe', () => {
  const added = [];
  const viewer = { dataSources: { add: (ds) => added.push(ds), remove() {} } };
  const layer = createOsmPlacesLayer({
    overlayHost: fakeOverlayHost(),
    overpassConfigured: async () => true,
  });
  layer.init(viewer);
  layer.enable();
  layer.setResults(RECORDS, {
    kind: 'hospital',
    label: 'hospitals',
    area: 'Kathmandu',
  });
  const point = added[0].entities.values[0].point;
  const distance = point.disableDepthTestDistance.getValue();
  assert.ok(
    Number.isFinite(distance) && distance <= 5000,
    `depth test off only within ${distance} m`,
  );
});
