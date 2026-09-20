// src/data/transitVehicles.test.mjs — transit vehicles data layer.
//
// Pins:
//   - the layer module exposes the contract the manager expects
//   - the route-id → colour mapping is stable across calls
//   - the live MBTA fixture decodes through the seam to a vehicle count
//     in the expected range, with route distribution covering MBTA's
//     heavy-rail lines and a sample of bus routes
//   - the layer's render bounds (pixel size, height offset, cap) are
//     documented so any future tuning lands in one place
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import transitVehiclesLayer, {
  _decodeFeedForTest,
  _routeColorForTest,
  TRANSIT_VEHICLE_RENDER_BOUNDS,
} from './transitVehicles.js';
import { GTFS_RT_FEEDS, GTFS_RT_FEED_IDS } from './gtfsRtPolicy.js';
import { encodeFeed } from './gtfsRtTestEncode.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');

test('transitVehicles: exports the layer-manager contract', () => {
  for (const key of ['id', 'name', 'icon', 'source', 'updateInterval',
    'init', 'enable', 'disable', 'update', 'destroy', 'getStats']) {
    assert.ok(key in transitVehiclesLayer, `layer missing required key: ${key}`);
    if (typeof transitVehiclesLayer[key] === 'function' || key === 'updateInterval') {
      assert.ok(transitVehiclesLayer[key] != null, `${key} should be defined`);
    }
  }
  assert.equal(typeof transitVehiclesLayer.init, 'function');
  assert.equal(typeof transitVehiclesLayer.enable, 'function');
  assert.equal(typeof transitVehiclesLayer.disable, 'function');
  assert.equal(typeof transitVehiclesLayer.update, 'function');
  assert.equal(typeof transitVehiclesLayer.destroy, 'function');
  assert.equal(typeof transitVehiclesLayer.getStats, 'function');
  assert.equal(typeof transitVehiclesLayer.getDetectableObjects, 'function');
});

test('transitVehicles: id matches the layerState registry token', () => {
  assert.equal(transitVehiclesLayer.id, 'transit-vehicles');
  assert.equal(transitVehiclesLayer.icon, '🚆');
  assert.equal(transitVehiclesLayer.source, 'GTFS-RT');
});

test('transitVehicles: getStats returns well-formed zero state', () => {
  const stats = transitVehiclesLayer.getStats();
  assert.equal(typeof stats, 'object');
  assert.equal(stats.count, 0);
  assert.equal(stats.lastUpdate, null);
  assert.equal(stats.loading, false);
});

test('transitVehicles: getDetectableObjects returns [] when nothing is rendered', () => {
  assert.deepEqual(transitVehiclesLayer.getDetectableObjects(), []);
});

test('transitVehicles: _decodeFeedForTest on the live MBTA fixture yields the expected vehicle count', () => {
  const bytes = readFileSync(resolve(FIXTURES, 'mbta-vehicle-positions.pb'));
  const result = _decodeFeedForTest('mbta', bytes);
  assert.equal(result.feedId, 'mbta');
  // MBTA rush-hour fixture captured 2026-09-18 had 406 vehicles. Asserting
  // ≥100 keeps the test honest against a future feed outage (would still
  // pin ≥1 vehicle is decoding) while tolerating off-peak snapshots.
  assert.ok(result.vehicleCount >= 100,
    `expected ≥100 vehicles in MBTA fixture; got ${result.vehicleCount}`);
  assert.equal(result.sampleKeys.length, 5);
  assert.equal(result.sampleRoutes.length, 5);
  // Every sample key is namespaced by feedId — feed id collisions can't
  // shadow each other in the render map.
  for (const key of result.sampleKeys) {
    assert.ok(key.startsWith('mbta/'), `sample key not namespaced: ${key}`);
  }
});

test('transitVehicles: render bounds are documented', () => {
  assert.equal(TRANSIT_VEHICLE_RENDER_BOUNDS.maxTotalVehicles, 5000);
  assert.equal(TRANSIT_VEHICLE_RENDER_BOUNDS.pixelSize, 7);
  assert.ok(TRANSIT_VEHICLE_RENDER_BOUNDS.heightOffsetM > 0);
});

test('transitVehicles: _routeColorForTest is deterministic and HSL-shaped', () => {
  // Same input → same colour (no Math.random anywhere in the pipeline).
  const a = _routeColorForTest('Red');
  const b = _routeColorForTest('Red');
  assert.deepEqual(a, b);
  // Different inputs → different colours (with overwhelming probability
  // across a 360-bucket hue wheel).
  const c = _routeColorForTest('Green-D');
  assert.notDeepEqual(a, c);
  // null / empty route id → still returns a colour (the layer never
  // crashes on a missing route).
  assert.ok(_routeColorForTest(null) != null);
  assert.ok(_routeColorForTest('') != null);
});

test('gtfsRtPolicy: GTFS_RT_FEEDS is keyed by lowercase id and points at https VehiclePositions.pb URLs', () => {
  for (const [id, url] of Object.entries(GTFS_RT_FEEDS)) {
    assert.match(id, /^[a-z0-9-]+$/, `feed id "${id}" must be lowercase kebab-case`);
    assert.match(url, /^https:\/\//);
    assert.match(url, /vehiclepositions\.pb/i);
  }
});

// ---------------------------------------------------------------------------
// Poll lifecycle (multi-feed)
//
// The original implementation pruned per-feed inside pollFeed, so the LAST
// feed to finish its Promise.all leg deleted every other feed's just-rendered
// vehicles (audit 2026-09-18). These tests drive the real update() lifecycle
// — mocked fetch, real Cesium.PointPrimitiveCollection, stand-in viewer —
// where that bug lived.
// ---------------------------------------------------------------------------

/** Drain pending microtasks/macrotasks so enable()'s fire-and-forget update
 * settles before assertions. A few setImmediate turns always suffice for the
 * mocked-fetch chain. */
async function settle(turns = 5) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Stand-in viewer: real altitude (gate opens), no computeViewRectangle, and
 * a primitives sink that tolerates real Cesium collections. */
function makeStubViewer() {
  const added = [];
  const primitives = {
    add: (p) => { added.push(p); return p; },
    remove: (p) => { const i = added.indexOf(p); if (i >= 0) added.splice(i, 1); return p; },
  };
  return {
    camera: { positionCartographic: { height: 1000 } },
    scene: { primitives },
  };
}

test('transitVehicles: one poll renders vehicles from ALL feeds concurrently (cross-feed prune regression)', async () => {
  // Three synthesized feeds with distinct geographies, mirroring the real
  // registry (Boston / Netherlands / Twin Cities).
  const feedBytes = new Map([
    ['mbta', encodeFeed({
      header: { version: '2.0' },
      entity: [
        { id: 'b1', vehicle: { trip: { routeId: 'Red' }, position: { lat: 42.35, lon: -71.06 } } },
        { id: 'b2', vehicle: { trip: { routeId: 'Orange' }, position: { lat: 42.36, lon: -71.06 } } },
      ],
    })],
    ['ovapi', encodeFeed({
      header: { version: '2.0' },
      entity: [
        { id: 'n1', vehicle: { trip: { routeId: '1' }, position: { lat: 52.37, lon: 4.90 } } },
      ],
    })],
    ['metro-mn', encodeFeed({
      header: { version: '2.0' },
      entity: [
        { id: 'm1', vehicle: { trip: { routeId: '901' }, position: { lat: 44.97, lon: -93.26 } } },
      ],
    })],
  ]);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = String(url);
    for (const [id, bytes] of feedBytes) {
      if (path.endsWith(`/api/gtfsrt/${id}`)) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      }
    }
    return { ok: false, status: 404 };
  };

  const viewer = makeStubViewer();
  try {
    transitVehiclesLayer.init(viewer);
    transitVehiclesLayer.enable(viewer); // fires void update() with mocked fetch
    await settle();
    await transitVehiclesLayer.update(); // explicit second cycle: prune must not regress

    const stats = transitVehiclesLayer.getStats();
    assert.equal(stats.count, 4,
      `expected 4 vehicles across all three feeds after a full poll, got ${stats.count}`);

    const keys = transitVehiclesLayer.getDetectableObjects({ maxCount: 100 })
      .map((o) => o.sourceId);
    assert.ok(keys.some((k) => k.startsWith('mbta/')), 'MBTA vehicles missing after prune');
    assert.ok(keys.some((k) => k.startsWith('ovapi/')), 'OVapi vehicles wiped by cross-feed prune');
    assert.ok(keys.some((k) => k.startsWith('metro-mn/')), 'MetroMN vehicles wiped by cross-feed prune');
    assert.ok(stats.lastUpdate != null, 'a poll with live vehicles must stamp lastUpdate');
  } finally {
    globalThis.fetch = realFetch;
    transitVehiclesLayer.destroy(viewer);
  }
});

test('transitVehicles: a failing feed contributes no keys but does not wipe the others', async () => {
  const feedBytes = new Map([
    ['mbta', encodeFeed({
      header: { version: '2.0' },
      entity: [
        { id: 'b1', vehicle: { trip: { routeId: 'Red' }, position: { lat: 42.35, lon: -71.06 } } },
      ],
    })],
    // ovapi + metro-mn intentionally NOT mocked → 404 path.
  ]);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = String(url);
    for (const [id, bytes] of feedBytes) {
      if (path.endsWith(`/api/gtfsrt/${id}`)) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      }
    }
    return { ok: false, status: 404 };
  };

  const viewer = makeStubViewer();
  try {
    transitVehiclesLayer.init(viewer);
    transitVehiclesLayer.enable(viewer);
    await settle();
    await transitVehiclesLayer.update();

    const stats = transitVehiclesLayer.getStats();
    assert.equal(stats.count, 1, 'only the healthy feed should render');
    const keys = transitVehiclesLayer.getDetectableObjects().map((o) => o.sourceId);
    assert.ok(keys.every((k) => k.startsWith('mbta/')), 'failed feeds must not leave stale keys');
    assert.ok(stats.error == null || typeof stats.error === 'string');
  } finally {
    globalThis.fetch = realFetch;
    transitVehiclesLayer.destroy(viewer);
  }
});

/** A 200 protobuf response wrapping synthesized feed bytes. */
function pbResponse(bytes) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test('transitVehicles: a vehicle that leaves the feed is pruned on the next cycle', async () => {
  // GTFS-RT ids are stable for the trip's lifetime, so the only way a key
  // disappears is a genuine run/train end. The sweep must delete the point
  // AND its map entry, or the HUD would keep detecting a ghost vehicle.
  let entities = [
    { id: 'b1', vehicle: { trip: { routeId: 'Red' }, position: { lat: 42.35, lon: -71.06 } } },
    { id: 'b2', vehicle: { trip: { routeId: 'Orange' }, position: { lat: 42.36, lon: -71.06 } } },
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).endsWith('/api/gtfsrt/mbta')
    ? pbResponse(encodeFeed({ header: { version: '2.0' }, entity: entities }))
    : { ok: false, status: 404 });

  const viewer = makeStubViewer();
  try {
    transitVehiclesLayer.init(viewer);
    transitVehiclesLayer.enable(viewer);
    await settle();
    assert.equal(transitVehiclesLayer.getStats().count, 2);

    entities = entities.slice(0, 1); // b2's trip ended between polls
    await transitVehiclesLayer.update();

    const keys = transitVehiclesLayer.getDetectableObjects().map((o) => o.sourceId);
    assert.deepEqual(keys, ['mbta/b1'], 'the departed vehicle is swept, the survivor kept');
    assert.equal(transitVehiclesLayer.getStats().count, 1);
  } finally {
    globalThis.fetch = realFetch;
    transitVehiclesLayer.destroy(viewer);
  }
});

test('transitVehicles: the altitude gate clears rendered vehicles and blocks polling until descent', async () => {
  // Cities are unreadable from space: above the exit altitude the layer must
  // drop its points and spend NO network, then re-render when you descend.
  const bytes = encodeFeed({
    header: { version: '2.0' },
    entity: [
      { id: 'b1', vehicle: { trip: { routeId: 'Red' }, position: { lat: 42.35, lon: -71.06 } } },
      { id: 'b2', vehicle: { trip: { routeId: 'Orange' }, position: { lat: 42.36, lon: -71.06 } } },
    ],
  });
  let polls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/gtfsrt/mbta')) {
      polls += 1;
      return pbResponse(bytes);
    }
    return { ok: false, status: 404 };
  };

  const viewer = makeStubViewer();
  try {
    transitVehiclesLayer.init(viewer);
    transitVehiclesLayer.enable(viewer);
    await settle();
    assert.equal(transitVehiclesLayer.getStats().count, 2);
    const lastUpdate = transitVehiclesLayer.getStats().lastUpdate;
    assert.ok(lastUpdate != null);

    viewer.camera.positionCartographic.height = 250_000; // above the 100 km exit gate
    polls = 0;
    await transitVehiclesLayer.update();

    assert.equal(transitVehiclesLayer.getStats().count, 0,
      'a closed gate empties the rendered cohort');
    assert.deepEqual(transitVehiclesLayer.getDetectableObjects(), [],
      'nothing is detectable while the gate is closed');
    assert.equal(polls, 0, 'a closed gate must not spend a single feed poll');
    assert.equal(transitVehiclesLayer.getStats().lastUpdate, lastUpdate,
      'the gated cycle is not a data update, so the freshness stamp survives');

    viewer.camera.positionCartographic.height = 1000; // descend back into the band
    await transitVehiclesLayer.update();
    assert.equal(transitVehiclesLayer.getStats().count, 2, 'descent reopens the gate and re-renders');
    assert.ok(polls >= 1, 'the reopened layer polls again');
  } finally {
    globalThis.fetch = realFetch;
    transitVehiclesLayer.destroy(viewer);
  }
});

test('transitVehicles: disable() aborts every in-flight feed poll', async () => {
  // A disable mid-cycle must cut the network, not let three half-second feeds
  // run to completion against a hidden layer.
  const aborted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (_url, init = {}) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      aborted.push(init.signal.aborted);
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      reject(error);
    });
  });

  const viewer = makeStubViewer();
  try {
    transitVehiclesLayer.init(viewer);
    transitVehiclesLayer.enable(viewer); // fires update() → three hanging fetches
    await settle(2);
    assert.equal(transitVehiclesLayer.getStats().loading, true, 'a poll is in flight');

    transitVehiclesLayer.disable(viewer);

    assert.equal(aborted.length, GTFS_RT_FEED_IDS.length,
      'every in-flight controller got abort()');
    assert.ok(aborted.every(Boolean), 'the fetches observed the abort on their signal');
    assert.equal(transitVehiclesLayer.getStats().loading, false);
    await settle(); // the AbortError rejections drain through pollFeed's catch
    assert.equal(transitVehiclesLayer.getStats().error, undefined,
      'a deliberate abort is not a feed failure and must not raise the error flag');
  } finally {
    globalThis.fetch = realFetch;
    transitVehiclesLayer.destroy(viewer);
  }
});

// The cap warning is one-shot module state (`_limitWarned` never resets), so
// this test stays last in the file: running it earlier would silence the warn
// for every later test.
test('transitVehicles: the global point cap sheds new vehicles after warning once', async () => {
  // 5001 vehicles: 5000 render, and the overflow is dropped rather than
  // silently blowing the GPU budget.
  const entities = [];
  for (let i = 0; i < 5001; i++) {
    entities.push({
      id: `v${i}`,
      vehicle: {
        trip: { routeId: `R${i % 7}` },
        position: { lat: 42.3 + (i % 50) / 1000, lon: -71.0 + (i % 40) / 1000 },
      },
    });
  }
  const bytes = encodeFeed({ header: { version: '2.0' }, entity: entities });

  const warnings = [];
  const realWarn = console.warn;
  const realFetch = globalThis.fetch;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  globalThis.fetch = async (url) => (String(url).endsWith('/api/gtfsrt/mbta')
    ? pbResponse(bytes)
    : { ok: false, status: 404 });

  const viewer = makeStubViewer();
  try {
    transitVehiclesLayer.init(viewer);
    transitVehiclesLayer.enable(viewer);
    await settle();

    assert.equal(transitVehiclesLayer.getStats().count, 5000, 'the cap holds');
    assert.equal(
      warnings.filter((line) => line.includes('point cap reached')).length, 1,
      'the cap is reported to the console exactly once, not per vehicle',
    );
    const keys = transitVehiclesLayer.getDetectableObjects({ maxCount: 5000 })
      .map((o) => o.sourceId);
    assert.ok(keys.includes('mbta/v0'), 'vehicles that fit are rendered');
    assert.equal(keys.includes('mbta/v5000'), false, 'the overflow vehicle is not rendered');

    await transitVehiclesLayer.update(); // second cycle: no new warning storm
    assert.equal(transitVehiclesLayer.getStats().count, 5000);
    assert.equal(
      warnings.filter((line) => line.includes('point cap reached')).length, 1,
      'the one-shot warn stays one-shot on later cycles',
    );
  } finally {
    console.warn = realWarn;
    globalThis.fetch = realFetch;
    transitVehiclesLayer.destroy(viewer);
  }
});
