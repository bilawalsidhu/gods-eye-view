import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { getLocale, setLocale } from '../i18n/index.js';
import { createControls } from '../layers/awareness/controls.js';
import { trafficAnalystRecords } from '../layers/traffic/records.js';
import { EARTH_RADIUS_KM } from '../geoDistance.js';
import {
  INSPECTOR_PULSE_MS,
  MOVING_REFRESH_MAX_MS,
  MOVING_REFRESH_MS,
  useEntityCardStore,
} from './stores/entityCard.js';

// The store's in-view answer is shared by Context's globe view and the
// omnibar: worked out once per key (the exact view, the layers that are
// on, each one's data revision) and sliced for callers that want fewer rows.
function harness(layers) {
  let scans = 0;
  let listener;
  const rows = layers.map((layer) =>
    Object.assign(layer, {
      module: {
        getAnalystRecords: () => {
          scans++;
          return layer.records;
        },
        ...layer.module,
      },
    }),
  );
  const store = useEntityCardStore(createPinia());
  const manager = {
    layers: new Map(rows.map((row) => [row.id, row])),
    isEnabled: (id) => Boolean(rows.find((row) => row.id === id)?.enabled),
    getAll: () => rows,
    subscribe(callback) {
      listener = callback;
    },
  };
  store.connect({ dataManager: () => manager });
  return {
    store,
    scans: () => scans,
    refresh: (layerId) => listener({ type: 'refresh', layerId }),
  };
}

const point = (id, lat, lon) => ({
  id,
  icao24: id,
  callsign: id.toUpperCase(),
  lat,
  lon,
});
const GLOBE = { center: { lat: 0, lon: 0 }, heightM: 20_000_000, rect: null };

for (const [scope, read] of [
  ['Nearby', (store) => store.nearbyLayers(0, 0, { radiusKm: 25 })],
  ['globe', (store) => store.inView()],
  ['viewport', (store) => store.inView({ viewport: true })],
]) {
  test(`${scope} keeps healthy rows and retries both kinds of failed host reads`, (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    let available = false;
    const readRecords = t.mock.fn(() => {
      if (!available) throw new Error('records unavailable');
      return [{ id: 'recovered-record', lat: 0, lon: 0 }];
    });
    const readPoints = t.mock.fn(() => {
      if (!available) throw new Error('points unavailable');
      return {
        points: [{ id: 'recovered-point', lat: 0, lon: 0 }],
        recordForPoint: (point) => point,
      };
    });
    const readPointLayerRecords = t.mock.fn(() => {
      throw new Error('fallback records unavailable');
    });
    const readEmpty = t.mock.fn(() => []);
    const { store } = harness([
      {
        id: 'local-dams',
        enabled: true,
        stats: { count: 1, lastUpdate: 1 },
        module: { getAnalystRecords: readRecords },
      },
      {
        id: 'local-datacenters',
        enabled: true,
        stats: { count: 1, lastUpdate: 1 },
        module: {
          getNearbyContextPoints: readPoints,
          getAnalystRecords: readPointLayerRecords,
        },
      },
      {
        id: 'healthy-sites',
        enabled: true,
        records: [{ id: 'healthy', lat: 0, lon: 0 }],
      },
      {
        id: 'empty-sites',
        enabled: true,
        module: { getAnalystRecords: readEmpty },
      },
    ]);
    store.setView({
      ...GLOBE,
      heightM: scope === 'Nearby' ? 40_000 : GLOBE.heightM,
      rect: { west: -1, east: 1, south: -1, north: 1 },
    });
    const ids = (lists) =>
      lists.flatMap(({ items }) => items.map(({ identity }) => identity.id));
    const initial = read(store);
    assert.deepEqual(ids(initial), ['healthy']);

    available = true;
    assert.equal(read(store), initial, 'no repeated reads in the same pulse');
    assert.equal(readRecords.mock.callCount(), 1);
    assert.equal(readPoints.mock.callCount(), 1);
    assert.equal(readPointLayerRecords.mock.callCount(), 1);

    t.mock.timers.tick(INSPECTOR_PULSE_MS);
    store.pulseInspector();
    const next = read(store);
    assert.deepEqual(ids(next), [
      'recovered-record',
      'recovered-point',
      'healthy',
    ]);
    assert.equal(readRecords.mock.callCount(), 2);
    assert.equal(readPoints.mock.callCount(), 2);
    assert.equal(
      readEmpty.mock.callCount(),
      1,
      'a successful empty read is still cached',
    );
    assert.equal(
      next.find(({ layerId }) => layerId === 'healthy-sites'),
      initial.find(({ layerId }) => layerId === 'healthy-sites'),
      'the stationary healthy layer keeps its rows',
    );
  });
}

test('Context retries a partially read point snapshot from ordinary records', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  let available = false;
  const ordinary = { id: 'ordinary', lat: 0, lon: 0 };
  const optimized = { id: 'optimized', lat: 0, lon: 0 };
  const fallback = t.mock.fn(() => [ordinary]);
  const snapshot = t.mock.fn(() => ({
    points: (function* () {
      yield optimized;
      if (!available) throw new Error('point iteration failed');
    })(),
    recordForPoint: (record) => record,
  }));
  const { store } = harness([
    {
      id: 'local-dams',
      enabled: true,
      stats: { count: 1, lastUpdate: 1 },
      module: { getNearbyContextPoints: snapshot, getAnalystRecords: fallback },
    },
  ]);
  store.setView({
    ...GLOBE,
    rect: { west: -1, east: 1, south: -1, north: 1 },
  });
  const reads = [
    () => store.nearbyLayers(0, 0),
    () => store.inView(),
    () => store.inView({ viewport: true }),
  ];
  const results = () =>
    reads.map((read) => {
      const summary = read()[0];
      return [
        summary?.count,
        summary?.items.map(({ identity }) => identity.id),
      ];
    });
  const ordinaryResult = [1, ['ordinary']];
  assert.deepEqual(results(), [ordinaryResult, ordinaryResult, ordinaryResult]);
  assert.equal(fallback.mock.callCount(), 3);

  available = true;
  assert.deepEqual(results(), [ordinaryResult, ordinaryResult, ordinaryResult]);
  assert.equal(snapshot.mock.callCount(), 3);

  t.mock.timers.tick(INSPECTOR_PULSE_MS);
  store.pulseInspector();
  assert.deepEqual(results(), [
    [1, ['optimized']],
    [1, ['optimized']],
    [1, ['optimized']],
  ]);
  assert.equal(snapshot.mock.callCount(), 6);
  assert.equal(fallback.mock.callCount(), 3);
});

test('Nearby and globe search match the displayed layer name after switching languages', (t) => {
  const originalLocale = getLocale();
  t.after(() => setLocale(originalLocale));
  const { store } = harness([
    {
      id: 'local-datacenters',
      name: 'Datacenters',
      enabled: true,
      records: [{ id: '1', name: 'Example Facility', lat: 0.1, lon: 0.1 }],
    },
  ]);
  store.setView(GLOBE);
  const results = (query) => [
    store.nearbyLayers(0, 0, { query })[0]?.items[0]?.title,
    store.inView({ query })[0]?.items[0]?.title,
    store.nearbyGroups(0, 0, { query }).other[0]?.title,
  ];

  setLocale('en');
  assert.deepEqual(results('Centres de données'), [
    undefined,
    undefined,
    undefined,
  ]);
  setLocale('fr');
  assert.deepEqual(results('Centres de données'), [
    'Example Facility',
    'Example Facility',
    'Example Facility',
  ]);
  assert.deepEqual(results('Datacenters'), [
    'Example Facility',
    'Example Facility',
    'Example Facility',
  ]);
  assert.deepEqual(results('Centres de données'), [
    'Example Facility',
    'Example Facility',
    'Example Facility',
  ]);
  setLocale('en');
  assert.deepEqual(results('Centres de données'), [
    undefined,
    undefined,
    undefined,
  ]);
});

test('the same key gives the same answer without scanning again; fewer rows are a slice', () => {
  const flights = {
    id: 'flights',
    name: 'Flights',
    enabled: true,
    stats: { lastUpdate: 1 },
    records: [
      point('a', 1, 1),
      point('b', 2, 2),
      point('c', 3, 3),
      point('d', 4, 4),
    ],
  };
  const { store, scans } = harness([flights]);
  store.setView({
    ...GLOBE,
    heightM: 40_000,
    rect: { west: -5, south: -5, east: 5, north: 5 },
  });
  const context = store.inView({ perLayer: 3 });
  assert.equal(scans(), 1);
  assert.equal(store.inView({ perLayer: 3 }), context, 'same object');
  const omnibar = store.inView({ perLayer: 2, viewport: true });
  assert.equal(scans(), 1, 'no rescan for the omnibar');
  assert.deepEqual(
    omnibar[0].items.map((item) => item.key),
    context[0].items.slice(0, 2).map((item) => item.key),
    'the omnibar and Context show the same nearest items',
  );
  assert.equal(omnibar[0].count, context[0].count, 'and agree on the count');
});

test('at globe height, in view is what the camera can see over the horizon', () => {
  const flights = {
    id: 'flights',
    name: 'Flights',
    enabled: true,
    stats: { lastUpdate: 1 },
    // From 10,000 km the horizon is about 67 degrees from the centre.
    records: [point('near', 0, 60), point('far', 0, 80)],
  };
  const { store } = harness([flights]);
  store.setView({ ...GLOBE, heightM: 10_000_000 });
  assert.equal(store.inView()[0].count, 1);
  store.setView({ ...GLOBE, heightM: 40_000_000 });
  assert.equal(store.inView()[0].count, 2, 'higher up, the horizon is farther');
});

test('the omnibar keeps viewport bounds at globe height without disturbing the Inspector cache', () => {
  const { store, scans } = harness([
    {
      id: 'flights',
      name: 'Flights',
      enabled: true,
      stats: { lastUpdate: 1 },
      records: [point('on', 0, 1), point('off', 0, 30)],
    },
  ]);
  store.setView({ ...GLOBE, rect: { west: -5, south: -5, east: 5, north: 5 } });
  const inspector = store.inView();
  const omnibar = store.inView({ viewport: true });
  assert.equal(inspector[0].count, 2);
  assert.equal(omnibar[0].count, 1);
  assert.equal(omnibar[0].items[0].identity.id, 'on');
  assert.equal(store.inView(), inspector);
  assert.equal(store.inView({ viewport: true }), omnibar);
  assert.equal(scans(), 2);
});

test('the Omnibar viewport tracks a small move across a rectangle edge', () => {
  const { store, scans } = harness([
    {
      id: 'local-datacenters',
      enabled: true,
      records: [{ id: 'edge', lat: 0, lon: 0.001 }],
    },
  ]);
  const where = (shift) => ({
    ...GLOBE,
    heightM: 40_000,
    rect: {
      west: shift - 0.001,
      east: shift + 0.001,
      south: -0.001,
      north: 0.001,
    },
  });
  const read = () => store.inView({ perLayer: 2, viewport: true });
  store.setView(where(-0.00004));
  const before = read();
  assert.deepEqual(before, []);

  const moved = where(0.00004);
  store.setView(moved, { settled: false });
  const settled = read();
  assert.equal(settled[0]?.items[0]?.identity.id, 'edge');

  store.setView(where(0.00004));
  assert.equal(read(), settled);
  assert.equal(scans(), 2, 'stationary reads reuse the settled answer');
});

test('Nearby tracks a small move across the radius boundary', () => {
  const radiusKm = 25;
  const { store, scans } = harness([
    {
      id: 'local-datacenters',
      enabled: true,
      records: [
        {
          id: 'edge',
          lat: 0,
          lon: (radiusKm / EARTH_RADIUS_KM) * (180 / Math.PI),
        },
      ],
    },
  ]);
  const where = (lon) => ({
    ...GLOBE,
    heightM: 40_000,
    center: { lat: 0, lon },
  });
  const read = () =>
    store.nearbyLayers(store.view.center.lat, store.view.center.lon, {
      radiusKm,
    });
  store.setView(where(-0.00004));
  const before = read();
  assert.equal(before[0].count, 0);

  const moved = where(0.00004);
  store.setView(moved, { settled: false });
  const settled = read();
  assert.equal(settled[0].count, 1);
  assert.equal(settled[0].items[0].identity.id, 'edge');

  store.setView(where(0.00004));
  assert.equal(read(), settled);
  assert.equal(scans(), 2, 'stationary reads reuse the settled answer');
});

test('a settled camera move, a layer toggle or a data refresh each work it out again', () => {
  const flights = {
    id: 'flights',
    name: 'Flights',
    enabled: true,
    stats: { lastUpdate: 1 },
    records: [point('a', 1, 1)],
  };
  const vessels = {
    id: 'ais-live-vessels',
    name: 'Vessels',
    enabled: false,
    stats: {},
    records: [{ id: 'v', mmsi: 'v', name: 'BOAT', lat: 0, lon: 1 }],
  };
  const { store, scans } = harness([flights, vessels]);
  store.setView({ ...GLOBE });
  store.inView();
  const before = scans();
  store.setView({ ...GLOBE, center: { lat: 10, lon: 20 } });
  store.inView();
  assert.ok(scans() > before, 'camera move');
  const afterMove = scans();
  vessels.enabled = true;
  store.inView();
  assert.ok(scans() > afterMove, 'layer toggle');
  const afterToggle = scans();
  flights.stats = { lastUpdate: 2 };
  store.inView();
  assert.ok(scans() > afterToggle, 'data revision');
});

test('a layer refreshing at the same count replaces only its own static rows', () => {
  const centers = {
    id: 'local-datacenters',
    name: 'Datacenters',
    enabled: true,
    stats: { count: 1 },
    records: [{ id: 'first', name: 'First site', lat: 0, lon: 0 }],
  };
  const other = {
    id: 'local-dams',
    name: 'Dams',
    enabled: true,
    stats: { count: 1 },
    records: [{ id: 'dam', name: 'Dam', lat: 0, lon: 0 }],
  };
  const { store, scans, refresh } = harness([centers, other]);
  store.setView(GLOBE);
  const title = (groups) =>
    groups.find((group) => group.layerId === centers.id).items[0].title;
  assert.equal(title(store.inView()), 'First site');
  assert.equal(title(store.nearbyLayers(0, 0)), 'First site');
  const before = scans();

  centers.records = [{ id: 'second', name: 'Second site', lat: 0, lon: 0 }];
  refresh(centers.id);
  assert.equal(title(store.inView()), 'Second site');
  assert.equal(title(store.nearbyLayers(0, 0)), 'Second site');
  assert.equal(scans() - before, 2, 'only the updated layer is read');
});

test('a fresh layer connection cannot reuse rows from an older snapshot', () => {
  const store = useEntityCardStore(createPinia());
  const record = (id) => ({ id, name: id, lat: 1, lon: 1 });
  let listener;
  const connect = (layer) => {
    let ready = false;
    const manager = {
      layers: new Map([[layer.id, layer]]),
      isEnabled: () => layer.enabled,
      getAll: () => [layer],
      subscribe(cb) {
        listener = cb;
        return () => {
          listener = null;
        };
      },
    };
    store.connect({ dataManager: () => (ready ? manager : null) });
    ready = true;
  };
  const layer = (name) => {
    const row = {
      id: 'local-datacenters',
      name: 'Data centers',
      enabled: true,
      stats: { count: 1 },
      records: [record(name)],
    };
    row.module = { getAnalystRecords: () => row.records };
    return row;
  };
  const check = (name) => {
    assert.equal(store.inView()[0]?.items[0]?.title, name);
    assert.equal(store.inView({ query: 'record' })[0]?.items[0]?.title, name);
    assert.equal(store.nearbyLayers(1, 1)[0]?.items[0]?.title, name);
  };
  connect(layer('First record'));
  store.setView({ ...GLOBE });
  check('First record');
  assert.equal(
    typeof listener,
    'function',
    'an initial in-view read attaches the late manager',
  );
  const second = layer('Second record');
  connect(second);
  assert.equal(store.nearbyLayers(1, 1)[0]?.items[0]?.title, 'Second record');
  assert.equal(
    typeof listener,
    'function',
    'an initial nearby read attaches the late manager',
  );
  check('Second record');
  second.enabled = false;
  listener({ type: 'visibility', layerId: second.id, enabled: false });
  second.records = [record('Third record')];
  second.enabled = true;
  listener({ type: 'visibility', layerId: second.id, enabled: true });
  check('Third record');
  second.records = [record('Configured record')];
  listener({ type: 'params', layerId: second.id });
  check('Configured record');
});

test('the store ignores retired listeners and keeps the selection when managers change', (t) => {
  function manager(name) {
    const callbacks = new Set();
    const row = {
      id: 'local-datacenters',
      name: 'Data centers',
      enabled: true,
      stats: { count: 1, lastUpdate: 1 },
      module: {
        getAnalystRecords: () => [{ id: 'site', name, lat: 1, lon: 1 }],
      },
    };
    return {
      callbacks,
      layers: new Map([[row.id, row]]),
      isEnabled: () => true,
      getAll: () => [row],
      subscribe(callback) {
        callbacks.add(callback);
        return () => callbacks.delete(callback);
      },
    };
  }
  const store = useEntityCardStore(createPinia());
  t.after(() => store.connect(null));
  const first = manager('First site');
  const second = manager('Second site');
  let current = first;
  store.connect({ dataManager: () => current });
  store.setView({ ...GLOBE });
  const [outgoing] = first.callbacks;
  const initial = store.inView();
  assert.ok(store.select(initial[0].items[0].identity));
  const selected = store.card.key;
  const revision = store.layerRevision;
  current = second;
  assert.equal(store.inView()[0].items[0].title, 'Second site');
  assert.equal(first.callbacks.size, 0);
  assert.equal(second.callbacks.size, 1);
  assert.equal(store.card.key, selected);
  assert.equal(store.layerRevision, revision);

  const [active] = second.callbacks;
  const params = { type: 'params', layerId: 'local-datacenters' };
  const rows = store.inView();
  outgoing(params);
  assert.equal(store.inView(), rows);
  assert.equal(store.layerRevision, revision);
  store.syncDataManager();
  assert.deepEqual([...second.callbacks], [active]);
  assert.equal(store.inView(), rows);

  active(params);
  assert.notEqual(store.inView(), rows);
  assert.equal(store.layerRevision, revision + 1);
  current = first;
  store.syncDataManager();
  outgoing(params);
  assert.equal(
    store.layerRevision,
    revision + 1,
    'reattaching does not revive the old listener',
  );
  store.connect(null);
  assert.equal(first.callbacks.size, 0);
});

test('at globe view only the visible hemisphere counts, nearest the centre first', () => {
  const flights = {
    id: 'flights',
    name: 'Flights',
    enabled: true,
    stats: { lastUpdate: 1 },
    records: [
      point('far', 50, 60),
      point('near', 1, 1),
      point('behind', 0, 180),
      point('mid', 10, 10),
    ],
  };
  const { store } = harness([flights]);
  store.setView({ ...GLOBE });
  const [group] = store.inView();
  assert.equal(group.count, 3, 'the one behind the globe is left out');
  assert.deepEqual(
    group.items.map((item) => item.identity.id),
    ['near', 'mid', 'far'],
  );
});

test('a parked globe view reads moving satellites again every few seconds, not only when new orbits arrive', (t) => {
  let now = 1_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  // Satellites stamp their revision only when new orbits arrive, so the
  // revision holds while their positions move.
  const satellites = {
    id: 'satellites',
    name: 'Satellites',
    enabled: true,
    stats: { lastUpdate: 1, count: 2 },
    records: [
      { noradId: '1', name: 'NEAR', lat: 1, lon: 1 },
      { noradId: '2', name: 'FAR', lat: 40, lon: 40 },
    ],
  };
  const quakes = {
    id: 'earthquakes',
    name: 'Earthquakes',
    enabled: true,
    stats: { lastUpdate: 1, count: 1 },
    records: [{ id: 'q', title: 'QUAKE', lat: 2, lon: 2 }],
  };
  const { store, scans } = harness([satellites, quakes]);
  store.setView({ ...GLOBE });
  const nearest = () =>
    store.inView().find((group) => group.layerId === 'satellites').items[0]
      .title;
  assert.equal(nearest(), 'NEAR');
  assert.equal(scans(), 2);
  // They swap places; within the same step the answer is kept.
  satellites.records = [
    { noradId: '1', name: 'NEAR', lat: 40, lon: 40 },
    { noradId: '2', name: 'FAR', lat: 1, lon: 1 },
  ];
  now += MOVING_REFRESH_MS / 2;
  assert.equal(nearest(), 'NEAR', 'kept within one step');
  assert.equal(scans(), 2);
  now += MOVING_REFRESH_MS;
  assert.equal(nearest(), 'FAR', 'read again once the step passes');
  assert.ok(MOVING_REFRESH_MS <= 10_000, 'every few seconds');
});

test('a costly read of moving items waits longer: reading again stays near 1% of the main thread', (t) => {
  let now = 2_000_000_000_000;
  let clock = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => clock);
  let positions = [{ noradId: '1', name: 'NEAR', lat: 1, lon: 1 }];
  const satellites = {
    id: 'satellites',
    name: 'Satellites',
    enabled: true,
    stats: { lastUpdate: 1, count: 1 },
    // Propagating the whole catalogue takes 300 ms here.
    get records() {
      clock += 300;
      return positions;
    },
  };
  const { store, scans } = harness([satellites]);
  store.setView({ ...GLOBE });
  store.inView();
  assert.equal(scans(), 1);
  positions = [{ noradId: '2', name: 'OTHER', lat: 1, lon: 1 }];
  now += 15_000;
  store.inView();
  assert.equal(scans(), 1, 'past 10 s, but within 300 ms / 1% = 30 s');
  now += 16_000;
  assert.equal(store.inView()[0].items[0].title, 'OTHER');
  assert.equal(scans(), 2);
});

/** A satellites layer whose every read costs `costMs` on the fake clock. */
function costlySatellites(clock, costMs) {
  const layer = {
    id: 'satellites',
    name: 'Satellites',
    enabled: true,
    stats: { lastUpdate: 1, count: 1 },
    reads: 0,
    get records() {
      layer.reads++;
      clock.ms += costMs;
      return [{ noradId: '1', name: 'SAT', lat: 1, lon: 1 }];
    },
  };
  return layer;
}

test('crossing 5,000 km switches the memoized view mode even during motion', (t) => {
  const clock = { ms: 0 };
  t.mock.method(Date, 'now', () => 3_000_000_000_000);
  t.mock.method(performance, 'now', () => clock.ms);
  const { store } = harness([costlySatellites(clock, 300)]);
  const where = {
    ...GLOBE,
    rect: { west: -0.5, south: -0.5, east: 0.5, north: 0.5 },
  };
  store.setView({ ...where, heightM: 4_999_999 });
  assert.deepEqual(store.inView(), []);
  store.setView({ ...where, heightM: 5_000_000 }, { settled: false });
  assert.deepEqual(
    store.inView()[0]?.items.map((item) => item.title),
    ['SAT'],
  );
  store.setView({ ...where, heightM: 4_999_999 }, { settled: false });
  assert.deepEqual(store.inView(), []);
});

test('another layer refreshing never reads the costly moving layer again', (t) => {
  let now = 3_000_000_000_000;
  const clock = { ms: 0 };
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => clock.ms);
  const satellites = costlySatellites(clock, 300);
  const vessels = {
    id: 'ais-live-vessels',
    name: 'Vessels',
    enabled: true,
    stats: { lastUpdate: 1, count: 1 },
    records: [{ mmsi: '1', name: 'SHIP', lat: 2, lon: 2 }],
  };
  const { store } = harness([satellites, vessels]);
  store.setView({ ...GLOBE });
  // Context asks every 4 s for two minutes; Vessels refresh on every tick.
  for (let tick = 0; tick < 30; tick++) {
    vessels.stats = { lastUpdate: 2 + tick, count: 1 + tick };
    store.inView();
    now += 4_000;
  }
  // 300 ms reads wait 30 s each: about four reads in two minutes.
  assert.ok(satellites.reads <= 5, `${satellites.reads} satellite reads`);
  assert.equal(store.inView().length, 2, 'both layers still listed');
});

test('a very costly read still has its rows read again within the cap', (t) => {
  let now = 4_000_000_000_000;
  const clock = { ms: 0 };
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => clock.ms);
  // 2 s per read would wait 200 s at 1%; the cap holds it to a minute.
  const satellites = costlySatellites(clock, 2_000);
  const { store } = harness([satellites]);
  store.setView({ ...GLOBE });
  store.inView();
  assert.equal(satellites.reads, 1);
  now += MOVING_REFRESH_MAX_MS - 1_000;
  store.inView();
  assert.equal(satellites.reads, 1, 'kept until the cap');
  now += 2_000;
  store.inView();
  assert.equal(satellites.reads, 2, 'read again at the cap');
  assert.equal(MOVING_REFRESH_MAX_MS, 60_000);
});

test('while the camera moves, a costly layer keeps its rows; a settled view reads it at once', (t) => {
  let now = 5_000_000_000_000;
  const clock = { ms: 0 };
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => clock.ms);
  const satellites = costlySatellites(clock, 300);
  const { store } = harness([satellites]);
  store.setView({ ...GLOBE });
  store.inView();
  assert.equal(satellites.reads, 1);
  // A drag: a new view about every second, none of them settled.
  for (let step = 1; step <= 10; step++) {
    now += 1_000;
    store.setView(
      { ...GLOBE, center: { lat: step, lon: step } },
      { settled: false },
    );
    store.inView();
  }
  assert.equal(satellites.reads, 1, 'not read for each step of the drag');
  store.setView({ ...GLOBE, center: { lat: 10, lon: 10 } });
  store.inView();
  assert.equal(satellites.reads, 2, 'the settled view is read at once');
});

test('the same globe search keeps costly rows while moving and refreshes on settle', (t) => {
  let now = 5_500_000_000_000;
  const clock = { ms: 0 };
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => clock.ms);
  const satellites = costlySatellites(clock, 300);
  const { store } = harness([satellites]);
  const matching = { query: 'sat', perLayer: 12 };
  const empty = { query: 'no match xyz', perLayer: 12 };
  store.setView({ ...GLOBE });
  assert.equal(store.inView(matching)[0]?.items[0]?.title, 'SAT');
  for (let step = 1; step <= 10; step++) {
    now += 1_000;
    store.setView(
      { ...GLOBE, center: { lat: step, lon: step } },
      { settled: false },
    );
    store.inView(matching);
  }
  assert.equal(
    satellites.reads,
    1,
    'an unchanged search is not read per moving view',
  );
  assert.deepEqual(
    store.inView(empty),
    [],
    'a new query takes effect immediately',
  );
  assert.equal(satellites.reads, 2);
  store.inView(matching);
  assert.equal(satellites.reads, 3);
  store.setView({ ...GLOBE, center: { lat: 11, lon: 11 } }, { settled: false });
  store.inView(matching);
  assert.equal(satellites.reads, 3);
  store.setView({ ...GLOBE, center: { lat: 11, lon: 11 } });
  store.inView(matching);
  assert.equal(satellites.reads, 4, 'settled view reads the search again');
});

test('a cheap layer is read for each step of a moving camera', () => {
  const flights = {
    id: 'flights',
    name: 'Flights',
    enabled: true,
    stats: { lastUpdate: 1 },
    records: [point('a', 1, 1)],
  };
  const { store, scans } = harness([flights]);
  store.setView({ ...GLOBE });
  store.inView();
  store.setView({ ...GLOBE, center: { lat: 5, lon: 5 } }, { settled: false });
  store.inView();
  assert.equal(scans(), 2);
});

test("Nearby reuses a fresh layer's rows when another layer refreshes or the same ask repeats", (t) => {
  let now = 6_000_000_000_000;
  const clock = { ms: 0 };
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => clock.ms);
  const satellites = costlySatellites(clock, 300);
  const vessels = {
    id: 'ais-live-vessels',
    name: 'Vessels',
    enabled: true,
    stats: { lastUpdate: 1, count: 1 },
    records: [{ mmsi: '1', name: 'SHIP', lat: 1.1, lon: 1 }],
  };
  const { store, scans } = harness([satellites, vessels]);
  const ask = (options = {}) =>
    store.nearbyLayers(1, 1, { radiusKm: 250, limit: 3, ...options });
  const first = ask();
  assert.deepEqual(
    first.map((list) => list.layerId),
    ['satellites', 'ais-live-vessels'],
  );
  assert.equal(satellites.reads, 1);
  assert.equal(ask(), first, 'the same answer for the same ask');
  for (let tick = 0; tick < 10; tick++) {
    vessels.stats = { lastUpdate: 2 + tick, count: 1 };
    ask();
    now += 500;
  }
  assert.equal(satellites.reads, 1, 'vessels refreshing read no satellites');
  const vesselScans = scans();
  ask({ radiusKm: 500 });
  assert.equal(satellites.reads, 2, 'a new radius reads again');
  assert.ok(scans() > vesselScans);
  assert.equal(
    ask({ excludeLayers: ['satellites'], radiusKm: 500 }).length,
    1,
    'a layer left out is not listed',
  );
});

test('Nearby shows a renamed stationary Contacts subject without a pan', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  // Real Contacts controls: a stationary subject whose label is enriched after selection
  // (awareness/subject.js replaces subject.label without re-evaluating results).
  const layerState = {
    enabled: true,
    passive: false,
    subject: {
      layerId: 'flights',
      id: 'abc123',
      label: 'ABC123',
      position: { x: 6378137, y: 0, z: 0 },
    },
    results: {
      evaluatedAt: 1,
      radiusM: 250_000,
      cohorts: [{ id: 'flights', summary: { count: 1 } }],
    },
  };
  const { methods } = createControls({
    state: layerState,
    services: {},
    parts: { dependencies: {} },
    source: {},
  });
  const row = {
    id: 'military-awareness',
    name: 'Contacts',
    enabled: true,
    module: methods,
  };
  Object.defineProperty(row, 'stats', { get: () => methods.getStats() });
  const { store } = harness([row]);
  const titles = () =>
    store
      .nearbyLayers(0, 0, { radiusKm: 25 })
      .flatMap((g) => g.items.map((i) => i.title));
  assert.deepEqual(titles(), ['ABC123']);
  layerState.subject = { ...layerState.subject, label: 'N123AB' };
  layerState.results.subject = layerState.subject;
  t.mock.timers.tick(10_000);
  assert.deepEqual(titles(), ['N123AB']);
});

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
  const { store } = harness([row]);
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
