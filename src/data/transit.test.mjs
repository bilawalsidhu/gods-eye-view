import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import transitLayer, {
  TRANSIT_MODE_COLORS,
  TRANSIT_POLL_MS,
  TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
  MISSED_POLLS_TO_DROP,
  buildTransitSelectionCopy,
  createTransitLayer,
  createTransitSelectedOverlayEntry,
  createTransitSource,
  interpolatedVehiclePosition,
  isStaleVehicleFix,
  transitStats,
  transitVehicleKey,
  vehicleHeightM,
  vehicleVisible,
} from './transit.js';
import { TRANSIT_MODES, getTransitFeed } from './transitFeeds.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';
import { SPRITE_LAYER_ORDER } from './spriteOrder.js';

const HELSINKI = { lat: 60.17, lon: 24.94 };

/** A viewer with just enough surface for the layer, and no WebGL. */
function fakeViewer({ lat, lon, height }) {
  const primitives = [];
  return {
    primitives,
    scene: {
      primitives: {
        add: (p) => primitives.push(p),
        remove: (p) => primitives.splice(primitives.indexOf(p), 1),
      },
      preRender: { addEventListener: () => () => {} },
      canvas: null,
      globe: null,
      pick: () => null,
    },
    camera: {
      positionCartographic: {
        height,
        latitude: Cesium.Math.toRadians(lat),
        longitude: Cesium.Math.toRadians(lon),
      },
      computeViewRectangle: () => undefined,
      changed: { addEventListener() {}, removeEventListener() {} },
      percentageChanged: 1,
    },
  };
}

/** Recording fakes for every service the layer touches. */
function fakeServices({ floors = new Map(), pointerFree = true } = {}) {
  const calls = { holds: 0, releases: 0, warmed: [], credits: [], overlay: [] };
  const floorKey = (lat, lon) => `${lat.toFixed(3)},${lon.toFixed(3)}`;
  return {
    calls,
    render: {
      governorRequestRender() {},
      holdContinuousRender: () => calls.holds++,
      releaseContinuousRender: () => calls.releases++,
    },
    sprites: {
      registerSpriteCollection() {},
      unregisterSpriteCollection() {},
      restoreSpriteOrder() {},
    },
    picking: { registerPickOwner() {}, unregisterPickOwner() {} },
    overlays: {
      setOverlayEntries: (id, entries) => calls.overlay.push({ id, entries }),
      setOverlaySourceVisible() {},
      clearOverlaySource: (id) => calls.overlay.push({ id, entries: [] }),
    },
    ground: {
      GROUND_FLOOR_LIFT_M: 1.5,
      cachedGroundFloor: (lat, lon) => floors.get(floorKey(lat, lon)) ?? null,
      warmGroundFloor: (cells) => calls.warmed.push(...cells),
    },
    input: { isPointerFree: () => pointerFree },
    credits: {
      registerTransitFeedCredit: (_v, feed) => calls.credits.push(feed.id),
    },
  };
}

function snapshot(vehicles) {
  return { feedId: 'hsl-helsinki', vehicles, stale: false };
}
const bus = (id, lat, lon, extra = {}) => ({
  id,
  lat,
  lon,
  routeId: '9982',
  bearing: 240,
  speedMps: 6.75,
  timestamp: null,
  ...extra,
});

/** Build an enabled layer over Helsinki with a scripted source. */
async function enabledLayer({
  snapshots,
  services = fakeServices(),
  height = 9000,
}) {
  const queue = [...snapshots];
  const source = {
    getVehicles: async (feedId) => {
      assert.equal(feedId, 'hsl-helsinki');
      return queue.length > 1 ? queue.shift() : queue[0];
    },
  };
  const layer = createTransitLayer({ services, source });
  const viewer = fakeViewer({ ...HELSINKI, height });
  let now = 1_000_000;
  layer._setTransitClockForTest(() => now);
  layer.init(viewer);
  layer.enable(viewer);
  await layer.update();
  return { layer, viewer, services, tick: (ms) => (now += ms), now: () => now };
}

test('layer module declares the manager contract and is registered everywhere it must be', () => {
  assert.equal(transitLayer.id, 'transit');
  assert.equal(transitLayer.updateInterval, TRANSIT_POLL_MS);
  for (const method of [
    'init',
    'enable',
    'disable',
    'update',
    'getStats',
    'destroy',
    'attachDataManager',
  ])
    assert.equal(
      typeof transitLayer[method],
      'function',
      `${method} is implemented`,
    );
  const entry = LAYER_STATE_REGISTRY.find((row) => row.id === 'transit');
  assert.ok(entry, 'transit has a share-link token');
  assert.equal(
    LAYER_STATE_REGISTRY.filter((row) => row.token === entry.token).length,
    1,
    'token is unique',
  );
  const index = SPRITE_LAYER_ORDER.indexOf('transit');
  assert.ok(
    index > SPRITE_LAYER_ORDER.indexOf('bikeshare'),
    'vehicles draw above bikeshare stations',
  );
  assert.ok(
    index < SPRITE_LAYER_ORDER.indexOf('flights'),
    'aircraft stay on top',
  );
  assert.throws(
    () => createTransitLayer({ services: fakeServices(), source: {} }),
    /transit source/,
  );
});

test('two catalogs get two instances that share no vehicle state', async () => {
  const a = await enabledLayer({
    snapshots: [snapshot([bus('1', 60.17, 24.94)])],
  });
  const b = await enabledLayer({ snapshots: [snapshot([])] });
  assert.equal(a.layer.getStats().count, 1);
  assert.equal(b.layer.getStats().count, 0);
  assert.notEqual(a.layer, b.layer);
});

test('every transit mode has a colour and the selected card uses it as accent', () => {
  for (const mode of TRANSIT_MODES)
    assert.match(
      TRANSIT_MODE_COLORS[mode],
      /^#[0-9a-f]{6}$/i,
      `${mode} has a colour`,
    );
  const position = Cesium.Cartesian3.fromDegrees(-71.06, 42.36, 3);
  const card = createTransitSelectedOverlayEntry(
    'mbta:1',
    position,
    { title: 'T', details: ['d'] },
    'subway',
  );
  assert.equal(card.accent, TRANSIT_MODE_COLORS.subway);
  assert.equal(card.protected, true);
  assert.equal(
    createTransitSelectedOverlayEntry(
      '',
      position,
      { title: 'T', details: [] },
      'bus',
    ),
    null,
  );
  assert.equal(
    TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS.moving,
    true,
    'the card follows a moving vehicle',
  );
});

test('a vehicle glides linearly from its drawn position to the new fix over one poll', () => {
  const entry = {
    from: { lat: 0, lon: 0 },
    to: { lat: 1, lon: 2 },
    tStart: 1000,
    tEnd: 1000 + TRANSIT_POLL_MS,
  };
  assert.deepEqual(interpolatedVehiclePosition(entry, 500), {
    lat: 0,
    lon: 0,
    settled: false,
  });
  const mid = interpolatedVehiclePosition(entry, 1000 + TRANSIT_POLL_MS / 2);
  assert.ok(Math.abs(mid.lat - 0.5) < 1e-9 && Math.abs(mid.lon - 1) < 1e-9);
  assert.deepEqual(interpolatedVehiclePosition(entry, 1000 + TRANSIT_POLL_MS), {
    lat: 1,
    lon: 2,
    settled: true,
  });
  assert.deepEqual(
    interpolatedVehiclePosition(
      { from: null, to: { lat: 5, lon: 6 }, tStart: 0, tEnd: 0 },
      10,
    ),
    { lat: 5, lon: 6, settled: true },
  );
});

test('fixes older than ten minutes are stale; feeds without timestamps are trusted', () => {
  const now = 1_700_000_000_000;
  assert.equal(isStaleVehicleFix({ timestamp: now / 1000 - 30 }, now), false);
  assert.equal(isStaleVehicleFix({ timestamp: now / 1000 - 601 }, now), true);
  assert.equal(isStaleVehicleFix({ timestamp: null }, now), false);
});

test('height and visibility follow the shared ground floor near the ground only', () => {
  assert.equal(vehicleHeightM(1600, 1.5), 1601.5);
  assert.equal(vehicleHeightM(null, 1.5), null);
  assert.equal(
    vehicleVisible(null, true),
    false,
    'near the ground a cold cell hides the vehicle',
  );
  assert.equal(vehicleVisible(1600, true), true);
  assert.equal(
    vehicleVisible(null, false),
    true,
    'from far away the fleet is always shown',
  );
});

test('selection copy reads like a transit card and never leaks nulls', () => {
  const feed = getTransitFeed('metrotransit-msp');
  const now = 1_788_936_960_000;
  const full = buildTransitSelectionCopy(
    feed,
    {
      id: '1557',
      label: '1557',
      routeId: '17',
      lat: 44.9,
      lon: -93.4,
      bearing: 248,
      speedMps: 11.2,
      timestamp: 1_788_936_945,
      stopId: '57458',
      status: 'STOPPED_AT',
      occupancy: 'FEW_SEATS_AVAILABLE',
    },
    'bus',
    now,
  );
  assert.equal(full.title, '🚌 Route 17');
  assert.deepEqual(full.details, [
    'Metro Transit · Minneapolis–St Paul, MN',
    '40 km/h · hdg 248°',
    'Stopped at stop 57458 · few seats available',
    'Vehicle 1557',
    'Reported 15 s ago',
  ]);
  const sparse = buildTransitSelectionCopy(
    feed,
    { id: 'abc', lat: 1, lon: 1 },
    'rail',
    now,
  );
  assert.equal(sparse.title, '🚆 Vehicle abc');
  for (const line of [...full.details, ...sparse.details])
    assert.doesNotMatch(line, /null|undefined|NaN/);
  assert.equal(transitVehicleKey('mbta', '17'), 'mbta:17');
});

test('stats: guidance out of range, loading, degraded, stale, and the per-feed coverage line', () => {
  const base = {
    enabled: true,
    count: 0,
    lastUpdate: null,
    gateOpen: true,
    feeds: [],
    statuses: [],
    regions: 7,
    activationKm: 3000,
  };
  assert.equal(transitStats(base).status, 'zoom-in');
  assert.match(transitStats(base).coverage, /No feed here yet · 7 regions/);
  assert.match(
    transitStats({ ...base, gateOpen: false }).coverage,
    /Fly below 3,000 km/,
  );
  const hsl = { id: 'hsl-helsinki', name: 'HSL' };
  const loading = transitStats({
    ...base,
    feeds: [hsl],
    statuses: [{ count: 0, error: null, stale: false, loading: true }],
  });
  assert.equal(loading.loading, true);
  assert.equal(loading.loadingLabel, 'Loading HSL');
  const ready = transitStats({
    ...base,
    count: 881,
    feeds: [hsl],
    statuses: [{ count: 881, error: null, stale: true, loading: false }],
  });
  assert.equal(ready.coverage, 'HSL 881');
  assert.equal(ready.stale, true);
  assert.deepEqual(ready.feeds, ['hsl-helsinki']);
  const failed = transitStats({
    ...base,
    feeds: [hsl],
    statuses: [
      { count: 0, error: 'HSL feed unavailable', stale: false, loading: false },
    ],
  });
  assert.equal(failed.error, 'HSL feed unavailable');
  assert.equal(transitStats({ ...base, enabled: false }).count, 0);
});

test('enable over Helsinki polls HSL only, draws its vehicles, and holds continuous render', async () => {
  const { layer, viewer, services } = await enabledLayer({
    snapshots: [
      snapshot([
        bus('a', 60.17, 24.94),
        bus('b', 60.18, 24.95, { routeId: '31M1' }),
      ]),
    ],
  });
  const stats = layer.getStats();
  assert.equal(stats.count, 2);
  assert.deepEqual(stats.feeds, ['hsl-helsinki']);
  assert.equal(stats.coverage, 'HSL 2');
  const drawn = layer._transitVehiclesForTest();
  assert.deepEqual(drawn.map((v) => v.mode).sort(), ['bus', 'subway']);
  assert.equal(
    viewer.primitives.length,
    1,
    'one point collection in the scene',
  );
  assert.equal(viewer.primitives[0].length, 2, 'one point per vehicle');
  assert.equal(
    services.calls.holds,
    1,
    'continuous render is held while vehicles exist',
  );
  assert.deepEqual(
    services.calls.credits,
    ['hsl-helsinki'],
    'the operator is credited once its vehicles render',
  );
  layer.disable(viewer);
  assert.equal(layer.getStats().count, 0);
  assert.equal(services.calls.releases, 1, 'the hold is released on disable');
  assert.equal(viewer.primitives[0].length, 0);
  layer.destroy(viewer);
  assert.equal(viewer.primitives.length, 0);
});

test('a second poll makes a vehicle glide to its new fix and drops one that vanished', async () => {
  const { layer, tick } = await enabledLayer({
    snapshots: [
      snapshot([bus('a', 60.17, 24.94), bus('gone', 60.1, 24.9)]),
      snapshot([bus('a', 60.18, 24.94)]),
    ],
  });
  tick(TRANSIT_POLL_MS);
  await layer.update(); // fix 2: a moved north, gone missing (1st miss)
  let a = layer
    ._transitVehiclesForTest()
    .find((v) => v.key === 'hsl-helsinki:a');
  assert.deepEqual(a.from, { lat: 60.17, lon: 24.94 });
  assert.deepEqual(a.to, { lat: 60.18, lon: 24.94 });
  tick(TRANSIT_POLL_MS / 2);
  layer._advanceTransitForTest(tick(0));
  a = layer._transitVehiclesForTest().find((v) => v.key === 'hsl-helsinki:a');
  const midLat = Cesium.Math.toDegrees(
    Cesium.Cartographic.fromCartesian(a.position).latitude,
  );
  assert.ok(
    Math.abs(midLat - 60.175) < 1e-4,
    `halfway through the glide, got ${midLat}`,
  );
  assert.ok(
    layer._transitVehiclesForTest().some((v) => v.key === 'hsl-helsinki:gone'),
    'one missed poll keeps the vehicle',
  );
  tick(TRANSIT_POLL_MS / 2);
  await layer.update(); // fix 3: gone missing again
  assert.equal(MISSED_POLLS_TO_DROP, 2);
  assert.ok(
    !layer._transitVehiclesForTest().some((v) => v.key === 'hsl-helsinki:gone'),
    'two missed polls remove it',
  );
});

test('near the ground a vehicle waits for its floor cell; the cell is warmed, not sampled per frame', async () => {
  const floors = new Map([['60.180,24.950', 22]]);
  const services = fakeServices({ floors });
  const { layer } = await enabledLayer({
    services,
    snapshots: [
      snapshot([bus('cold', 60.17, 24.94), bus('warm', 60.18, 24.95)]),
    ],
  });
  const byKey = Object.fromEntries(
    layer._transitVehiclesForTest().map((v) => [v.key, v]),
  );
  assert.equal(byKey['hsl-helsinki:warm'].shown, true);
  assert.equal(byKey['hsl-helsinki:warm'].floorM, 22);
  assert.equal(
    byKey['hsl-helsinki:cold'].shown,
    false,
    'hidden until its cell answers',
  );
  assert.deepEqual(
    services.calls.warmed,
    [{ lat: 60.17, lon: 24.94 }],
    'only the cold cell is warmed',
  );
  const warmHeight = Cesium.Cartographic.fromCartesian(
    byKey['hsl-helsinki:warm'].position,
  ).height;
  assert.ok(Math.abs(warmHeight - 23.5) < 0.01, 'floor plus lift');
});

test('from 1,500 km the fleet is shown at the ellipsoid and no cell is warmed', async () => {
  const services = fakeServices();
  const { layer } = await enabledLayer({
    services,
    height: 1_500_000,
    snapshots: [snapshot([bus('a', 60.17, 24.94)])],
  });
  assert.equal(layer._transitVehiclesForTest()[0].shown, true);
  assert.deepEqual(services.calls.warmed, []);
});

test('clicks select and clear vehicles, and yield while a tool holds the pointer', async () => {
  let free = true;
  const services = fakeServices();
  services.input.isPointerFree = () => free;
  const { layer } = await enabledLayer({
    services,
    snapshots: [snapshot([bus('a', 60.17, 24.94)])],
  });
  assert.equal(
    layer._handleTransitClickForTest({ id: 'hsl-helsinki:a' }),
    'selected',
  );
  assert.equal(layer._transitSelectedKeyForTest(), 'hsl-helsinki:a');
  const card = services.calls.overlay.at(-1);
  assert.equal(card.id, 'transit-selected');
  assert.equal(card.entries[0].title, '🚌 Route 9982');
  free = false;
  assert.equal(
    layer._handleTransitClickForTest(null),
    'yielded',
    'a draw session keeps the selection',
  );
  assert.equal(layer._transitSelectedKeyForTest(), 'hsl-helsinki:a');
  free = true;
  assert.equal(layer._handleTransitClickForTest(null), 'cleared');
  assert.equal(layer._transitSelectedKeyForTest(), null);
  assert.equal(
    layer._handleTransitClickForTest({ id: 'not-a-vehicle' }),
    'ignored',
  );
});

test('a failing feed is reported without dropping vehicles already drawn', async () => {
  let fail = false;
  const source = {
    getVehicles: async () => {
      if (fail) throw new Error('boom');
      return snapshot([bus('a', 60.17, 24.94)]);
    },
  };
  const layer = createTransitLayer({ services: fakeServices(), source });
  const viewer = fakeViewer({ ...HELSINKI, height: 9000 });
  layer.init(viewer);
  layer.enable(viewer);
  await layer.update();
  fail = true;
  await layer.update();
  const stats = layer.getStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.degraded, true);
  assert.equal(
    stats.error,
    null,
    'a degraded feed with vehicles on screen is not an outage',
  );
});

test('the source asks the proxy for a registered id only and reads the stale marker', async () => {
  const calls = [];
  const source = createTransitSource({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        headers: {
          get: (name) => (name === 'x-gev-cache' ? 'STALE-ERROR' : null),
        },
        json: async () => ({ feedId: 'mbta', vehicles: [] }),
      };
    },
  });
  const result = await source.getVehicles('mbta');
  assert.equal(calls[0].url, '/api/transit/vehicles/mbta');
  assert.equal(result.stale, true);
  await assert.rejects(
    source.getVehicles('../etc'),
    /registered transit feed id/,
  );
  await assert.rejects(
    source.getVehicles('https://evil.example'),
    /registered transit feed id/,
  );
});
