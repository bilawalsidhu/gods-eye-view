import assert from 'node:assert/strict';
import test from 'node:test';
import { createGnssIntegrityLayer, defaultGnssViewAnchor } from './index.js';
import { LayerLifecycle } from '../../data/lifecycle.js';
import { layerFeedState } from '../../data/feedState.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { bindRenderer } from '../../render/rendererOf.js';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

const row = (hex, lat, degraded) => ({
  hex,
  lat,
  lon: 30.2,
  nic: degraded ? 0 : 8,
  nacp: degraded ? 0 : 10,
  gpsLost: false,
  degraded,
});

function harness(
  getSnapshot,
  {
    anchor: initialAnchor = { latitude: 50, longitude: 30 },
    initialize = true,
  } = {},
) {
  let anchor = initialAnchor;
  const viewer = { scene: { globe: { show: true } } };
  const camera = fakeCameraPort();
  const { draw } = bindFakeDraw(viewer, { camera: camera.port });
  // The layer's one live set, or undefined once it is disposed.
  const fills = () =>
    [...draw.sets.values()].find((record) => !record.disposed);
  let clock = 1_000;
  const anchors = [];
  const layer = createGnssIntegrityLayer({
    // The real source refuses an undated snapshot; stubs default to a fresh one.
    source: {
      async getSnapshot(...args) {
        const snapshot = await getSnapshot(...args);
        return { ageMs: 0, ...snapshot };
      },
    },
    viewAnchor: () => {
      anchors.push(anchor);
      return anchor;
    },
    now: () => clock,
    monotonicNow: () => clock,
  });
  if (initialize) layer.init(viewer);
  return {
    layer,
    fills,
    camera,
    anchors,
    viewer,
    advance(ms) {
      clock += ms;
    },
    now: () => clock,
    setAnchor(value) {
      anchor = value;
    },
  };
}

const MIN = 60_000;
const threeHealthy = () => [
  row('a1', 1.1, false),
  row('a2', 1.12, false),
  row('a3', 1.14, false),
];

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a globe-wide rectangle uses the visible screen centre as the query anchor', () => {
  const viewer = {};
  // The eye high over (-97, 30), looking straight down.
  const eye = fromDegrees(-97, 30, 2e7);
  const ground = fromDegrees(-97, 30, 0);
  const length = Math.hypot(
    eye.x - ground.x,
    eye.y - ground.y,
    eye.z - ground.z,
  );
  const camera = fakeCameraPort({
    pose: {
      lon: 0,
      lat: 0,
      position: eye,
      direction: {
        x: (ground.x - eye.x) / length,
        y: (ground.y - eye.y) / length,
        z: (ground.z - eye.z) / length,
      },
    },
  });
  camera.port.viewRectangle = () => {
    throw new Error('centre hit must not compute a rectangle');
  };
  bindRenderer(viewer, { camera: camera.port });
  const anchor = defaultGnssViewAnchor(viewer);
  assert.ok(Math.abs(anchor.latitude - 30) < 1e-8);
  assert.ok(Math.abs(anchor.longitude + 97) < 1e-8);
});

test('a line of sight that misses the globe falls back to the view rectangle, then the point under the eye', () => {
  const viewer = {};
  // The eye over (10, 20), looking straight up.
  const eye = fromDegrees(10, 20, 1e6);
  const length = Math.hypot(eye.x, eye.y, eye.z);
  const camera = fakeCameraPort({
    pose: {
      lon: 10,
      lat: 20,
      position: eye,
      direction: { x: eye.x / length, y: eye.y / length, z: eye.z / length },
    },
  });
  let rectangle = { west: 170, south: -10, east: -170, north: 10 };
  camera.port.viewRectangle = () => rectangle;
  bindRenderer(viewer, { camera: camera.port });
  const across = defaultGnssViewAnchor(viewer);
  assert.ok(Math.abs(across.latitude) < 1e-8);
  assert.ok(Math.abs(Math.abs(across.longitude) - 180) < 1e-8);
  rectangle = null;
  const under = defaultGnssViewAnchor(viewer);
  assert.ok(Math.abs(under.latitude - 20) < 1e-8);
  assert.ok(Math.abs(under.longitude - 10) < 1e-8);
});

test('pan and zoom refresh through the manager without toggling; nearby changes are coalesced', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let calls = 0;
  const h = harness(
    async () => {
      calls++;
      return { rows: threeHealthy() };
    },
    { initialize: false },
  );
  const manager = new LayerLifecycle(h.viewer);
  manager.register(h.layer);
  h.layer.attachDataManager(manager);
  const changes = [];
  manager.subscribe((change) => changes.push(change.type));
  await manager.setEnabled(h.layer.id, true);
  h.setAnchor({ latitude: 54, longitude: 19 });
  h.camera.emit('changed');
  h.setAnchor({ latitude: 55, longitude: 20 });
  h.camera.emit('moveEnd');
  h.advance(2500);
  t.mock.timers.tick(2500);
  await flush();
  assert.equal(calls, 2, 'one initial read and one read for the latest view');
  assert.deepEqual(h.anchors.at(-1), { latitude: 55, longitude: 20 });
  assert.ok(changes.includes('refresh-transition'));
  assert.ok(changes.includes('refresh'));
  assert.equal(manager.isEnabled(h.layer.id), true);
  assert.deepEqual(h.layer.getStats().coverage, {
    kind: 'regional',
    latitude: 55,
    longitude: 20,
    radiusNm: 250,
  });
  assert.match(h.layer.getRowControls().info, /Regional sample.*250 nm radius/);
  h.setAnchor({ latitude: 55.1, longitude: 20.1 });
  h.camera.emit('changed');
  h.advance(5000);
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(calls, 2, 'nearby views reuse the same query region');
  await manager.destroyAll();
  assert.equal(h.camera.listenerCount('moveEnd'), 0);
  assert.equal(h.camera.listenerCount('changed'), 0);
});

test('movement during a pending refresh follows up at the newest view; disable cancels queued work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  let resolvePending;
  const h = harness((anchor) => {
    calls.push(anchor);
    if (calls.length === 2)
      return new Promise((resolve) => {
        resolvePending = resolve;
      });
    return { rows: threeHealthy() };
  });
  h.layer.enable();
  await h.layer.update();
  h.setAnchor({ latitude: 54, longitude: 19 });
  h.camera.emit('moveEnd');
  h.advance(2500);
  t.mock.timers.tick(2500);
  await flush();
  h.setAnchor({ latitude: 35, longitude: 140 });
  h.camera.emit('changed');
  h.advance(2500);
  t.mock.timers.tick(2500);
  await flush();
  assert.equal(calls.length, 2, 'only one camera request in flight');
  resolvePending({ rows: threeHealthy() });
  await flush();
  h.advance(600);
  t.mock.timers.tick(600);
  await flush();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.at(-1), { latitude: 35, longitude: 140 });
  h.setAnchor({ latitude: 10, longitude: 10 });
  h.camera.emit('moveEnd');
  h.layer.disable();
  h.advance(5000);
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(calls.length, 3, 'disable drains the camera timer');
  h.layer.destroy();
});

test('the layer requires a snapshot source and cannot be initialized twice', () => {
  assert.throws(() => createGnssIntegrityLayer({}), TypeError);
  const { layer } = harness(async () => ({ rows: [] }));
  assert.throws(() => layer.init({ dataSources: { add() {} } }), /already/);
});

test('an enabled refresh bins the snapshot into coloured ground cells', async () => {
  const { layer, fills, anchors } = harness(async (anchor, { signal }) => {
    assert.deepEqual(anchor, { latitude: 50, longitude: 30 });
    assert.ok(signal instanceof AbortSignal);
    return {
      rows: [
        row('a1', 50.1, true),
        row('a2', 50.1, true),
        row('a3', 50.2, false),
        row('a4', 50.3, false),
        row('b1', 55.1, false),
      ],
      stale: false,
    };
  });
  assert.equal(await layer.update(), false, 'disabled layers do not fetch');
  assert.equal(anchors.length, 0);
  layer.enable();
  assert.equal(fills().show, true);
  assert.equal(await layer.update(), true);
  const cells = [...fills().items.values()];
  assert.equal(cells.length, 2, 'a one-aircraft cell is shown too');
  assert.deepEqual(
    cells.map(({ id }) => id),
    ['gnss-integrity:841e631ffffffff', 'gnss-integrity:841f6b3ffffffff'],
  );
  for (const cell of cells) {
    assert.equal(cell.geometry.kind, 'polygon');
    assert.equal(cell.geometry.rings.length, 1);
    assert.equal(cell.geometry.rings[0].length, 6, 'a hexagon');
    assert.equal(cell.height, 'clampGround');
  }
  assert.equal(fills().spec.pickable, false, 'cells never take part in picks');
  const stats = layer.getStats();
  assert.equal(stats.count, 2);
  assert.equal(stats.error, null);
  assert.equal(stats.fallback, false);
  const { legend } = layer.getRowControls();
  assert.deepEqual(
    legend.map(({ count }) => count),
    [1, 0, 1],
  );
  assert.match(legend[0].blurb, /not a detection/);
  assert.doesNotMatch(legend[0].blurb, /need \d+ aircraft/);
});

test('the visible layer leads with low navigation accuracy and exposes its provenance', async () => {
  const { layer } = harness(async () => ({ rows: [], stale: false }));
  assert.equal(
    layer.id,
    'gnss-integrity',
    'the unpublished id describes the measured state',
  );
  assert.equal(layer.name, 'GNSS Integrity');
  assert.doesNotMatch(layer.name, /interference|jamming/i);
  const { legend } = layer.getRowControls();
  assert.deepEqual(
    legend.map(({ label }) => label),
    [
      'Low-accuracy score > 10%',
      'Low-accuracy score 2–10%',
      'Low-accuracy score < 2%',
    ],
  );
  const { blurb } = legend[0];
  assert.match(blurb, /one aircraft is discounted/);
  assert.match(blurb, /not the raw share/);
  assert.match(blurb, /not a detection/);
  assert.equal(layer.provenance.classifier.id, 'gev-nic-nacp-v2');
  assert.equal(layer.provenance.classifier.definedBy, 'GEV');
  assert.equal(layer.provenance.classifier.validated, false);
  assert.equal(layer.provenance.aggregation.source, 'https://gpsjam.org/faq');
  assert.deepEqual(layer.provenance.window, {
    minutes: 30,
    scope: 'visited-view',
    definedBy: 'GEV',
  });
  assert.equal(layer.provenance.aggregation.grid, 'h3');
  assert.equal(layer.provenance.aggregation.h3Resolution, 4);
  assert.equal(layer.provenance.interpretation.validated, false);
  assert.equal(layer.getStats().provenance, layer.provenance);
});

test('a failed refresh keeps the last cells and reports the error', async () => {
  let fail = false;
  const { layer, fills } = harness(async () => {
    if (fail) throw new Error('adsb.lol HTTP 502');
    return {
      rows: [
        row('a1', 1.1, false),
        row('a2', 1.12, false),
        row('a3', 1.14, false),
      ],
      stale: true,
    };
  });
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().stale, true);
  fail = true;
  assert.equal(await layer.update(), true);
  assert.equal(fills().items.size, 1);
  assert.equal(layer.getStats().error, 'adsb.lol HTTP 502');
  assert.equal(layer.getStats().count, 1);
});

test('observations expire with the window, and disable aborts the request in flight', async () => {
  let pending;
  const { layer, fills, advance } = harness(
    (anchor, { signal }) =>
      new Promise((resolve, reject) => {
        pending = { resolve };
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
  );
  layer.enable();
  let result = layer.update();
  pending.resolve({
    rows: [
      row('a1', 1.1, false),
      row('a2', 1.12, false),
      row('a3', 1.14, false),
    ],
  });
  assert.equal(await result, true);
  assert.equal(layer.getStats().count, 1);

  advance(31 * 60_000);
  result = layer.update();
  pending.resolve({ rows: [] });
  assert.equal(await result, true);
  assert.equal(layer.getStats().count, 0);
  assert.equal(fills().items.size, 0);

  result = layer.update();
  layer.disable();
  assert.equal(await result, false);
  assert.equal(fills().show, false);
});

test('no view anchor means no request, and destroy releases the data source', async () => {
  let calls = 0;
  const { layer, fills } = harness(
    async () => {
      calls += 1;
      return { rows: [] };
    },
    { anchor: null },
  );
  layer.enable();
  assert.equal(
    await layer.update(),
    true,
    'a settling camera is not a failure',
  );
  assert.equal(calls, 0);
  assert.equal(layer.getStats().error, null);
  layer.destroy();
  assert.equal(fills(), undefined, 'destroy disposes the set');
  assert.equal(layer.getStats().count, 0);
});

test('a replayed stale snapshot keeps its observation age and expires on time', async () => {
  // The proxy keeps answering with the snapshot it observed at t=1000.
  const { layer, fills, advance, now } = harness(async () => ({
    rows: threeHealthy(),
    ageMs: now() - 1_000,
    stale: true,
  }));
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().count, 1);
  advance(29 * MIN);
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().count, 1);
  advance(2 * MIN);
  assert.equal(
    await layer.update(),
    true,
    'the replay is not an error, only no evidence',
  );
  assert.equal(
    layer.getStats().count,
    0,
    'the replay did not restart the window',
  );
  assert.equal(fills().items.size, 0);
});

test('cells expire during prolonged fetch failures', async () => {
  let fail = false;
  const { layer, fills, advance } = harness(async () => {
    if (fail) throw new Error('adsb.lol HTTP 502');
    return { rows: threeHealthy() };
  });
  layer.enable();
  await layer.update();
  fail = true;
  advance(20 * MIN);
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().count, 1, 'still inside the window');
  advance(11 * MIN);
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().count, 0);
  assert.equal(fills().items.size, 0);
  assert.equal(layer.getStats().error, 'adsb.lol HTTP 502');
});

test('cells expire while no view anchor is available', async () => {
  let calls = 0;
  const { layer, fills, advance, setAnchor } = harness(async () => {
    calls += 1;
    return { rows: threeHealthy() };
  });
  layer.enable();
  await layer.update();
  setAnchor(null);
  advance(20 * MIN);
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().count, 1);
  advance(11 * MIN);
  assert.equal(await layer.update(), true);
  assert.equal(calls, 1, 'no anchor means no request');
  assert.equal(layer.getStats().count, 0);
  assert.equal(fills().items.size, 0);
  assert.equal(layer.getStats().error, null);
});

test('re-enabling after a long disable does not show cells past the window', async () => {
  const { layer, fills, advance } = harness(async () => ({
    rows: threeHealthy(),
  }));
  layer.enable();
  await layer.update();
  assert.equal(fills().items.size, 1);
  layer.disable();
  advance(31 * MIN);
  layer.enable();
  assert.equal(layer.getStats().count, 0);
  assert.equal(fills().items.size, 0);
});

const threeCells = () => ({
  rows: [row('a1', 50.1, true), row('a2', 50.1, true), row('a3', 50.2, false)],
});

test('an identical snapshot draws nothing again', async () => {
  const { layer, fills } = harness(async () => threeCells());
  layer.enable();
  await layer.update();
  const writes = fills().writes;
  await layer.update();
  assert.equal(fills().items.size, 1);
  assert.equal(fills().writes, writes);
});

test('an initial feed failure stays enabled, reports unavailable, and recovers automatically', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let calls = 0;
  const h = harness(
    async () => {
      calls++;
      if (calls === 1) throw new Error('adsb.lol HTTP 502');
      return { rows: threeHealthy() };
    },
    { initialize: false },
  );
  const manager = new LayerLifecycle(h.viewer);
  manager.register(h.layer);
  h.layer.attachDataManager(manager);
  const changes = [];
  manager.subscribe((c) => changes.push(c.type));
  assert.equal(await manager.setEnabled(h.layer.id, true), true);
  assert.equal(manager.isEnabled(h.layer.id), true);
  assert.equal(layerFeedState(h.layer.getStats()), 'unavailable');
  assert.equal(h.layer.getStats().retryInSec, 30);
  assert.match(
    h.layer.getRowControls().info,
    /HTTP 502.*Retrying automatically at/,
  );
  assert.equal(changes.includes('visibility-failed'), false);
  assert.equal(
    await manager.refreshLayer(h.layer.id),
    false,
    'feed remains honestly unhealthy during cooldown',
  );
  assert.equal(calls, 1, 'a manual refresh cannot bypass cooldown');
  h.advance(30000);
  t.mock.timers.tick(30000);
  await flush();
  assert.equal(calls, 2);
  assert.equal(manager.isEnabled(h.layer.id), true);
  assert.equal(layerFeedState(h.layer.getStats()), 'nominal');
  assert.equal(h.layer.getStats().count, 1);
  assert.equal(h.layer.getStats().retryInSec, null);
  assert.doesNotMatch(h.layer.getRowControls().info, /Retrying/);
  await manager.destroyAll();
});

test('provider cooldown is preserved across movement and toggling; disable cancels retry work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const h = harness(async () => {
    calls++;
    if (calls === 1)
      throw Object.assign(new Error('Rate limited (HTTP 429)'), {
        retryAfterMs: 3600000,
      });
    return { rows: threeHealthy() };
  });
  h.layer.enable();
  await h.layer.update();
  h.setAnchor({ latitude: 10, longitude: 20 });
  h.camera.emit('moveEnd');
  h.advance(30000);
  t.mock.timers.tick(30000);
  await flush();
  await h.layer.update();
  assert.equal(calls, 1);
  assert.equal(h.layer.getStats().retryInSec, 3570);
  h.layer.disable();
  h.advance(30000);
  t.mock.timers.tick(30000);
  await flush();
  h.layer.enable();
  await h.layer.update();
  assert.equal(calls, 1, 'reenabling does not erase a provider deadline');
  h.advance(3540000);
  t.mock.timers.tick(3540000);
  await flush();
  assert.equal(calls, 2);
  assert.deepEqual(h.anchors.at(-1), { latitude: 10, longitude: 20 });
  h.layer.destroy();

  const stopped = harness(async () => {
    throw new Error('network unavailable');
  });
  stopped.layer.enable();
  await stopped.layer.update();
  stopped.layer.disable();
  stopped.advance(30000);
  t.mock.timers.tick(30000);
  await flush();
  assert.equal(stopped.anchors.length, 1, 'disabled layers do not retry');
  stopped.layer.destroy();
});

test('repeated acquisition failures back off, while genuine non-retryable failures reject startup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const h = harness(async () => {
    calls++;
    throw new Error('network unavailable');
  });
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.layer.getStats().retryInSec, 30);
  h.advance(30000);
  t.mock.timers.tick(30000);
  await flush();
  assert.equal(h.layer.getStats().retryInSec, 60);
  h.advance(60000);
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(h.layer.getStats().retryInSec, 120);
  assert.equal(calls, 3);
  h.layer.destroy();
  const fatal = harness(async () => {
    throw Object.assign(new Error('invalid request (HTTP 400)'), {
      retryable: false,
    });
  });
  fatal.layer.enable();
  assert.equal(await fatal.layer.update(), false);
  assert.equal(fatal.layer.getStats().retryInSec, null);
  fatal.layer.destroy();
});

test('GERMAN: stale snapshot keeps the source observation age in row stats', async () => {
  const h = harness(async () => ({
    rows: threeHealthy(),
    ageMs: 120000,
    stale: true,
  }));
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.layer.getStats().lastUpdate, h.now() - 120000);
  h.layer.destroy();
});

test('GERMAN: camera debounce and minimum request gap are pinned', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const h = harness(async () => {
    calls++;
    return { rows: [] };
  });
  h.layer.enable();
  await h.layer.update();
  h.setAnchor({ latitude: 51, longitude: 31 });
  h.camera.emit('changed');
  h.advance(2499);
  t.mock.timers.tick(2499);
  await flush();
  assert.equal(calls, 1);
  h.advance(1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 2);
  h.advance(3000);
  h.setAnchor({ latitude: 52, longitude: 32 });
  h.camera.emit('changed');
  h.advance(599);
  t.mock.timers.tick(599);
  await flush();
  assert.equal(calls, 2);
  h.advance(1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 3);
  h.layer.destroy();
});

test('camera movement during initial activation waits for acquisition before following up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  let resolve;
  const h = harness((anchor) => {
    calls.push(anchor);
    return calls.length === 1
      ? new Promise((r) => (resolve = r))
      : Promise.resolve({ rows: threeHealthy() });
  });
  h.layer.enable();
  const initial = h.layer.update();
  h.setAnchor({ latitude: 51, longitude: 31 });
  h.camera.emit('changed');
  h.advance(2500);
  t.mock.timers.tick(2500);
  await flush();
  assert.equal(calls.length, 1);
  resolve({ rows: threeHealthy() });
  assert.equal(await initial, true);
  h.advance(600);
  t.mock.timers.tick(600);
  await flush();
  assert.equal(calls.length, 2);
  h.layer.destroy();
});

test('monotonic camera scheduling is unaffected by wall-clock rollback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(async () => ({ rows: [] }));
  h.layer.destroy();
  let wall = 1800000000000,
    mono = 0,
    anchor = { latitude: 50, longitude: 30 },
    calls = 0;
  const layer = createGnssIntegrityLayer({
    source: {
      getSnapshot: async () => {
        calls++;
        return { rows: [], ageMs: 0 };
      },
    },
    viewAnchor: () => anchor,
    now: () => wall,
    monotonicNow: () => mono,
  });
  layer.init(h.viewer);
  layer.enable();
  await layer.update();
  wall -= 3600000;
  mono = 3000;
  anchor = { latitude: 51, longitude: 31 };
  h.camera.emit('changed');
  mono += 600;
  t.mock.timers.tick(600);
  await flush();
  assert.equal(calls, 2);
  layer.destroy();
});

test('view anchor falls back to rectangle, then nadir, then no camera', () => {
  assert.equal(defaultGnssViewAnchor({}), null);
  const viewer = { scene: {} };
  // Looking away from the globe: the line of sight misses it.
  const camera = fakeCameraPort({
    pose: {
      lon: 21,
      lat: 41,
      position: fromDegrees(21, 41, 1e7),
      direction: { x: 0, y: 0, z: 1 },
    },
    viewRectangle: { west: 20, south: 40, east: 22, north: 42 },
  });
  bindRenderer(viewer, { camera: camera.port });
  const rectangleAnchor = defaultGnssViewAnchor(viewer);
  assert.ok(Math.abs(rectangleAnchor.latitude - 41) < 1e-10);
  assert.ok(Math.abs(rectangleAnchor.longitude - 21) < 1e-10);
  // Across the antimeridian, the middle is on it.
  camera.setViewRectangle({ west: 170, south: 40, east: -170, north: 42 });
  assert.ok(
    Math.abs(Math.abs(defaultGnssViewAnchor(viewer).longitude) - 180) < 1e-10,
  );
  camera.setViewRectangle({ west: 175, south: 40, east: -165, north: 42 });
  assert.ok(Math.abs(defaultGnssViewAnchor(viewer).longitude + 175) < 1e-10);
  camera.setViewRectangle(null);
  const nadirAnchor = defaultGnssViewAnchor(viewer);
  assert.ok(Math.abs(nadirAnchor.latitude - 41) < 1e-10);
  assert.ok(Math.abs(nadirAnchor.longitude - 21) < 1e-10);
  camera.setPose({ lon: NaN, lat: NaN });
  assert.equal(defaultGnssViewAnchor(viewer), null, 'no settled camera');
});
