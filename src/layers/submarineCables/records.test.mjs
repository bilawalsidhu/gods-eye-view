// The cables and landing points the Context panel and the analyst read: one
// record per cable and per landing point, a cable at a vertex on its line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cableAnalystRecords,
  cableLinePoints,
  cableRepresentativePoint,
} from './records.js';
import {
  describeEntity,
  entityKind,
  layerMatches,
  nearbyForLayer,
  viewSummaryForLayer,
} from '../../data/entityContext.js';
import { normalizeFeatures } from './geometry.js';
import { greatCircleKm } from '../../geoDistance.js';

const cable = {
  type: 'Feature',
  properties: {
    id: 'kunoa-north',
    name: 'Kunoa North',
    coordinates: [-150.2, 21.1],
  },
  geometry: {
    type: 'MultiLineString',
    coordinates: [
      [
        [-160, 21],
        [-150, 21],
      ],
      [
        [-150, 21],
        [-140, 22],
      ],
    ],
  },
};
const landing = {
  type: 'Feature',
  properties: { id: 'kunoa-north', name: 'Nybor, Denmark', is_tbd: true },
  geometry: { type: 'Point', coordinates: [10.8, 55.3] },
};
const loaded = (extra = {}) => ({
  _enabled: true,
  _loaded: true,
  _cachedCableJson: { features: [cable] },
  _cachedLandingJson: { features: [landing] },
  ...extra,
});

test('a named cable with an empty provider ID keeps the same identity on the map and in records', () => {
  const source = {
    features: [{ ...cable, properties: { id: [], name: 'Pacific' } }],
  };
  const [feature] = normalizeFeatures(source, 'cable');
  const [record] = cableAnalystRecords(loaded({ _cachedCableJson: source }));
  assert.equal(feature.id, 'Pacific');
  assert.equal(record.id, 'cable:Pacific');
});

test('a cable stands at the vertex nearest its label point', () => {
  assert.deepEqual(cableRepresentativePoint(cable), { lon: -150, lat: 21 });
  // Without a label point: the vertex nearest the vertices' average.
  const bare = { ...cable, properties: { id: 'x' } };
  assert.deepEqual(cableRepresentativePoint(bare), { lon: -150, lat: 21 });
});

test('cables and landing points are listed with distinct ids', () => {
  const records = cableAnalystRecords(loaded());
  const parts = records[0].parts;
  assert.deepEqual(records, [
    {
      id: 'cable:kunoa-north',
      name: 'Kunoa North',
      feature: 'cable',
      lat: 21,
      lon: -150,
      parts,
    },
    {
      id: 'landing:kunoa-north',
      name: 'Nybor, Denmark',
      feature: 'landing point',
      lat: 55.3,
      lon: 10.8,
      planned: true,
    },
  ]);
  assert.equal(cableAnalystRecords(loaded(), 1).length, 1);
  // A caller's change does not reach the next call.
  records[0].name = 'changed';
  assert.equal(cableAnalystRecords(loaded())[0].name, 'Kunoa North');
  assert.ok(Object.isFrozen(parts) && Object.isFrozen(parts[0]));
});

test("a cable's points follow every line, no more than 40 km apart", () => {
  const points = cableLinePoints(cable);
  // Both lines, each from its first vertex to its last.
  assert.deepEqual(points[0], { lat: 21, lon: -160 });
  assert.deepEqual(points.at(-1), { lat: 22, lon: -140 });
  const second = points.findIndex(
    (point, index) => index > 0 && point.lon === -150 && point.lat === 21,
  );
  assert.ok(second > 0, 'the first line ends where the second starts');
  for (let i = 1; i < points.length; i++) {
    const km = greatCircleKm(points[i - 1], points[i]);
    assert.ok(km <= 40.01, `${km} km between points ${i - 1} and ${i}`);
  }
  // A line drawn with many close vertices keeps far fewer of them.
  const busy = {
    geometry: {
      type: 'LineString',
      coordinates: Array.from({ length: 1001 }, (_, i) => [i / 1000, 0]),
    },
  };
  const kept = cableLinePoints(busy);
  assert.ok(kept.length <= 5, `${kept.length} points for 111 km`);
  assert.deepEqual(kept.at(-1), { lat: 0, lon: 1 });
});

test('a cable crossing the dateline is sampled along the short leg', () => {
  const points = cableLinePoints({
    geometry: {
      type: 'LineString',
      coordinates: [
        [179, 0],
        [-179, 0],
      ],
    },
  });
  assert.deepEqual(points[0], { lat: 0, lon: 179 });
  assert.deepEqual(points.at(-1), { lat: 0, lon: -179 });
  assert.ok(points.length > 2);
  for (let i = 1; i < points.length; i++) {
    assert.ok(Math.abs(points[i].lon) >= 179);
    assert.ok(greatCircleKm(points[i - 1], points[i]) <= 40.01);
  }
});

test('nothing while off or before the data loads', () => {
  assert.deepEqual(cableAnalystRecords(loaded({ _enabled: false })), []);
  assert.deepEqual(cableAnalystRecords(loaded({ _loaded: false })), []);
  assert.deepEqual(cableAnalystRecords(null), []);
});

test('a doubled-back cable keeps a sample within 25 km of the bend', () => {
  const bends = [
    [
      [-0.3, 0],
      [0, 0],
      [-0.3, 0],
    ],
    [
      [-0.15, 0.27],
      [0, 0.2],
      [-0.15, 0.27],
    ],
  ];
  const here = { lat: 0, lon: 0 };
  for (const coordinates of bends) {
    const bent = { geometry: { type: 'LineString', coordinates } };
    const nearestKm = Math.min(
      ...cableLinePoints(bent).map((point) => greatCircleKm(here, point)),
    );
    assert.ok(nearestKm <= 25, `${nearestKm} km to the nearest sample`);
  }
});

test('a landing point reads as a cable landing point, not a cable', () => {
  const layerId = 'telegeography-submarine-cables';
  assert.equal(
    entityKind(layerId, { feature: 'cable' }).kind,
    'submarine cable',
  );
  assert.equal(
    entityKind(layerId, { feature: 'landing point' }).kind,
    'cable landing point',
  );
  assert.equal(entityKind(layerId).kind, 'submarine cable');
});

test('a bundled cable laid in pieces is one record, listed and counted once near any piece', () => {
  const read = (name) =>
    JSON.parse(
      readFileSync(
        new URL(
          `../../data/local_data/telegeography_submarine_cables/${name}`,
          import.meta.url,
        ),
        'utf8',
      ),
    );
  const cableJson = read('cable-geo.json');
  const state = loaded({
    _cachedCableJson: cableJson,
    _cachedLandingJson: { features: [] },
  });
  const records = cableAnalystRecords(state);
  const cableIds = new Set(
    cableJson.features.map((feature) => feature.properties.id),
  );
  assert.ok(cableJson.features.length > cableIds.size, 'some cables repeat');
  assert.equal(records.length, cableIds.size, 'one record per cable');
  // Topaz is drawn as two features: one off Japan, one off Canada.
  const pieces = cableJson.features.filter(
    (feature) => feature.properties.id === 'topaz',
  );
  assert.equal(pieces.length, 2);
  const topaz = records.filter((record) => record.name === 'Topaz');
  assert.equal(topaz.length, 1);
  const layerId = 'telegeography-submarine-cables';
  const layer = {
    id: layerId,
    name: 'Submarine Cables',
    enabled: true,
    module: { getAnalystRecords: () => cableAnalystRecords(state) },
  };
  const manager = {
    layers: new Map([[layerId, layer]]),
    getAll: () => [layer],
    isEnabled: () => true,
  };
  // A point on each piece's first line.
  for (const piece of pieces) {
    const [lon, lat] = piece.geometry.coordinates[0][0];
    const list = nearbyForLayer(
      manager,
      layer,
      { lat, lon },
      { radiusKm: 25, limit: 12, query: 'topaz' },
    );
    assert.equal(list.count, 1, 'counted once');
    assert.deepEqual(
      list.items.map((item) => item.title),
      ['Topaz'],
    );
    assert.equal(list.items[0].distanceKm, 0, 'measured to the nearest piece');
    assert.equal(list.items[0].identity.lat, lat);
    assert.equal(list.items[0].identity.lon, lon);
  }
});

test('Nearby finds a bundled cable by any of its lines', () => {
  const read = (name) =>
    JSON.parse(
      readFileSync(
        new URL(
          `../../data/local_data/telegeography_submarine_cables/${name}`,
          import.meta.url,
        ),
        'utf8',
      ),
    );
  const cableJson = read('cable-geo.json');
  const state = loaded({
    _cachedCableJson: cableJson,
    _cachedLandingJson: { features: [] },
  });
  const layerId = 'telegeography-submarine-cables';
  const layer = {
    id: layerId,
    name: 'Submarine Cables',
    enabled: true,
    module: { getAnalystRecords: () => cableAnalystRecords(state) },
  };
  const manager = {
    layers: new Map([[layerId, layer]]),
    getAll: () => [layer],
    isEnabled: () => true,
  };
  // Cables with any drawn vertex within a distance of a point.
  const withVertexWithin = (here, km) => {
    const names = new Set();
    for (const feature of cableJson.features) {
      for (const line of feature.geometry.coordinates) {
        if (line.some(([lon, lat]) => greatCircleKm(here, { lat, lon }) <= km))
          names.add(feature.properties.name);
      }
    }
    return names;
  };
  const places = {
    Marseille: { lat: 43.3, lon: 5.37 },
    Singapore: { lat: 1.29, lon: 103.85 },
    Fortaleza: { lat: -3.72, lon: -38.54 },
  };
  for (const [place, here] of Object.entries(places)) {
    const list = nearbyForLayer(manager, layer, here, {
      radiusKm: 250,
      limit: 1000,
    });
    const found = new Set(list.items.map((item) => item.title));
    assert.equal(found.size, list.count, `${place}: each cable once`);
    // All cables with a vertex within 230 km must appear. The 250 km
    // comparison allows for sampling near the edge.
    const expected = withVertexWithin(here, 250);
    const missing = [...withVertexWithin(here, 230)].filter(
      (name) => !found.has(name),
    );
    assert.deepEqual(missing, [], `${place}: none missed`);
    assert.ok(
      list.count >= expected.size * 0.9,
      `${place}: ${list.count} found, ${expected.size} with a vertex within 250 km`,
    );
  }
});

test('rectangle results open a cable crossing the viewport between vertices', () => {
  const state = loaded({
    _cachedCableJson: {
      features: [
        {
          type: 'Feature',
          properties: { id: 'crossing', name: 'Crossing' },
          geometry: {
            type: 'MultiLineString',
            coordinates: [
              [
                [179.85, 0],
                [-179.85, 0],
              ],
              [
                [-179.85, 1],
                [179.85, 1],
              ],
            ],
          },
        },
      ],
    },
    _cachedLandingJson: { features: [] },
  });
  const layer = {
    id: 'telegeography-submarine-cables',
    enabled: true,
    module: { getAnalystRecords: () => cableAnalystRecords(state) },
  };
  const manager = { layers: new Map([[layer.id, layer]]) };
  const rect = { west: 179.95, east: -179.95, south: -0.05, north: 0.05 };
  const center = { lat: 0, lon: 180 };
  const answer = layerMatches(manager, layer.id, { rect, center });
  assert.equal(answer.count, 1);
  const [item] = answer.items;
  assert.equal(item.distanceKm, 0);
  assert.deepEqual(
    viewSummaryForLayer(manager, layer, rect, center)?.items.map(
      (one) => one.key,
    ),
    [item.key],
  );
  const opened = describeEntity(manager, item.identity);
  assert.equal(opened.lon, item.identity.lon);
  assert.equal(describeEntity(manager, opened.identity).lon, opened.lon);

  const gap = { west: -179.95, east: -179.8, south: 0.45, north: 0.55 };
  assert.equal(
    layerMatches(manager, layer.id, {
      rect: gap,
      center: { lat: 0.5, lon: -179.85 },
    }).count,
    0,
    'separate lines do not create a segment across the gap',
  );
  const nearby = nearbyForLayer(
    manager,
    layer,
    { lat: 0.215, lon: 180 },
    { radiusKm: 25 },
  );
  assert.equal(nearby.count, 0, 'radius keeps its existing sampling contract');
});
