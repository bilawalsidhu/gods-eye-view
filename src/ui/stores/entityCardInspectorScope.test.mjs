// How the Inspector scopes a layer: a selected card's Closest to, sky-only
// views and aircraft on screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { useEntityCardStore } from './entityCard.js';
import { fromDegrees } from '../../geo/ellipsoid.js';

function harness(layers) {
  const rows = layers.map((layer) =>
    Object.assign(layer, {
      module: { getAnalystRecords: () => layer.records, ...layer.module },
    }),
  );
  const store = useEntityCardStore(createPinia());
  const manager = {
    layers: new Map(rows.map((row) => [row.id, row])),
    isEnabled: (id) => Boolean(manager.layers.get(id)?.enabled),
    getAll: () => [...manager.layers.values()],
    subscribe() {},
    subscribeActivity() {},
  };
  store.connect({ dataManager: () => manager });
  return { store, manager };
}
const point = (id, lat, lon, extra = {}) => ({
  id,
  icao24: id,
  callsign: id.toUpperCase(),
  lat,
  lon,
  ...extra,
});
const KM_DEG = 1 / 111.195;

test("a selected card's Closest to does not change with the camera height", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store } = harness([
    {
      id: 'earthquakes',
      enabled: true,
      stats: { recordsRevision: 1, count: 2 },
      records: [point('A', 0, 0), point('B', 1, 0)],
    },
  ]);
  t.after(() => store.setViewContextShown(false, null));
  t.after(store.setSelectedScopeOwner(() => true));
  const at = (heightM) => {
    const half = (heightM / 1000) * KM_DEG;
    store.setView({
      center: { lat: 0, lon: 0 },
      eye: { lat: 0, lon: 0 },
      rect: { west: -half, east: half, south: -half, north: half },
      heightM,
    });
    const read = () =>
      store.inspectorGroup('earthquakes', 25, {
        anchor: { lat: 0, lon: 0 },
        excludeKey: 'earthquakes:A',
      });
    let g = read();
    if (g?.loading) {
      t.mock.timers.tick(0);
      g = read();
    }
    return {
      scope: g.scope,
      ids: g.items.map((r) => r.identity.id),
      km: g.items[0]?.distanceKm,
    };
  };
  const low = at(10_000);
  const high = at(100_000);
  assert.equal(low.scope, high.scope, 'zoom must not change the selected card answer');
});

test('a sky-only view lists no ground Street Level photo In view', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const photo = {
    id: 'mly:1',
    name: 'Photo',
    lat: 0.001,
    lon: 0.001,
    providerId: 'mly',
    provider: 'Mapillary',
  };
  const inside = (p, r) =>
    p.lat >= r.south && p.lat <= r.north && p.lon >= r.west && p.lon <= r.east;
  const { store } = harness([
    {
      id: 'street-level',
      name: 'Street Level',
      enabled: true,
      stats: { recordsRevision: 1, count: 1 },
      records: [photo],
      module: {
        getViewRecords: (max, area) =>
          area?.rect ? [photo].filter((p) => inside(p, area.rect)) : [photo],
      },
    },
  ]);
  t.after(() => store.setViewContextShown(false, null));
  store.setViewContextShown(true, 1);
  const read = () => {
    let g = store.inspectorGroup('street-level');
    if (g?.loading) {
      t.mock.timers.tick(0);
      g = store.inspectorGroup('street-level');
    }
    return g;
  };
  const ground = {
    center: { lat: 0, lon: 0 },
    eye: { lat: 0, lon: 0 },
    rect: { west: -0.01, east: 0.01, south: -0.01, north: 0.01 },
    heightM: 500,
    groundFootprint: true,
  };
  store.setView(ground);
  const a = read();
  store.setView({
    center: { lat: 0, lon: 0 },
    eye: { lat: 0, lon: 0 },
    rect: { west: -180, east: 180, south: -90, north: 90 },
    corners: null,
    heightM: 500,
    groundFootprint: false,
  });
  const b = read();
  store.setView(ground);
  const c = read();
  assert.equal(a.count, 1, 'the ground view lists the photo');
  assert.equal(b.count, 0, 'sky-only view lists no ground photo');
  assert.equal(c.count, 1, 'the ground view lists the photo again');
});

test('a sky-only view counts an airborne aircraft inside the frame', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store } = harness([
    {
      id: 'flights',
      enabled: true,
      stats: { recordsRevision: 1, count: 1, lastUpdate: 1 },
      records: [
        point('above', 0, 5 * KM_DEG, { altitudeM: 3900, onGround: false }),
      ],
    },
  ]);
  t.after(() => store.setViewContextShown(false, null));
  store.setViewContextShown(true, 1);
  // At (0, 0) east is ECEF +y and up is +x. The camera, 1 km up, looks 30
  // degrees above the horizon; the aircraft is about 30 degrees up.
  const sin30 = Math.sin(Math.PI / 6);
  const cos30 = Math.cos(Math.PI / 6);
  const tanY = Math.tan(Math.PI / 6);
  const frustum = (east) => ({
    position: fromDegrees(0, 0, 1000),
    direction: { x: sin30, y: east * cos30, z: 0 },
    up: { x: cos30, y: -east * sin30, z: 0 },
    right: { x: 0, y: 0, z: -east },
    tanY,
    tanX: 1.5 * tanY,
  });
  const read = (east) => {
    store.setView({
      center: { lat: 0, lon: 0 },
      eye: { lat: 0, lon: 0 },
      rect: { west: -180, east: 180, south: -90, north: 90 },
      heightM: 1000,
      groundFootprint: false,
      frustum: frustum(east),
    });
    let g = store.inspectorGroup('flights');
    if (g?.loading) {
      t.mock.timers.tick(0);
      g = store.inspectorGroup('flights');
    }
    return g;
  };
  assert.equal(read(1).count, 1, 'facing east the aircraft is in the frame');
  assert.equal(read(-1).count, 0, 'facing west it is behind the camera');
});

test('a tilted view counts an aircraft on screen whose ground point is before the visible ground', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Camera 12 km over (0,0) looking east, pitch -12 deg, vFOV 8 deg, hFOV 14 deg.
  const h = 12;
  const near = h / Math.tan((16 * Math.PI) / 180);
  const far = h / Math.tan((8 * Math.PI) / 180);
  const halfNear =
    (h / Math.sin((16 * Math.PI) / 180)) * Math.tan((7 * Math.PI) / 180);
  const halfFar =
    (h / Math.sin((8 * Math.PI) / 180)) * Math.tan((7 * Math.PI) / 180);
  const c = (n, e) => ({ lat: n * KM_DEG, lon: e * KM_DEG });
  const corners = [
    c(halfFar, far),
    c(halfNear, near),
    c(-halfNear, near),
    c(-halfFar, far),
  ];
  const rect = {
    west: near * KM_DEG,
    east: far * KM_DEG,
    south: -halfFar * KM_DEG,
    north: halfFar * KM_DEG,
  };
  // A is 9.4 km east at 10 km up (12 degrees below the eye: the screen
  // centre); B is 52 km east at 1 km.
  const A = point('A', 0, 9.4 * KM_DEG, { altitudeM: 10_000, onGround: false });
  const B = point('B', 0, 52 * KM_DEG, { altitudeM: 1_000, onGround: false });
  const { store } = harness([
    {
      id: 'flights',
      enabled: true,
      stats: { recordsRevision: 1, count: 2, lastUpdate: 1 },
      records: [A, B],
    },
  ]);
  t.after(() => store.setViewContextShown(false, null));
  store.setViewContextShown(true, 1);
  store.setView({
    center: c(0, h / Math.tan((12 * Math.PI) / 180)),
    eye: { lat: 0, lon: 0 },
    rect,
    corners,
    heightM: h * 1000,
    groundFootprint: true,
  });
  let g = store.inspectorGroup('flights');
  if (g?.loading) {
    t.mock.timers.tick(0);
    g = store.inspectorGroup('flights');
  }
  assert.equal(g.count, 2);
});
