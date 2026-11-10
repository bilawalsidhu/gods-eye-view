import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createGnssDisplay } from './render/display.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as geo from '../../geo/index.js';
import { createFakeGroundHarness } from '../../testSupport/groundDisplayEngines.mjs';
import { rgbaFromCss } from '../shared/color.js';
import { createGnssIntegrityLayer, defaultGnssViewAnchor } from './index.js';
import { LayerLifecycle } from '../../data/lifecycle.js';
import { layerFeedState } from '../../data/feedState.js';

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
  const ground = createFakeGroundHarness();
  const { engine } = ground;
  // What the manager's lifecycle reads of a scene besides the engine.
  const viewer = { scene: { globe: { show: true } } };
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
    rendererFactory: ({ engine }) =>
      createGnssDisplay(engine, {
        viewAnchor: () => {
          anchors.push(anchor);
          return anchor;
        },
      }),
    now: () => clock,
    monotonicNow: () => clock,
  });
  if (initialize) layer.init(null, { engine });
  return {
    layer,
    ground,
    engine,
    camera: engine.camera,
    /** The drawn cells' ground set (undefined once released). */
    cells: () => ground.set('gnss-integrity'),
    /** How many cells are drawn. */
    drawn: () => ground.set('gnss-integrity')?.items.length ?? 0,
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
  row('a2', 1.2, false),
  row('a3', 1.3, false),
];

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a globe-wide rectangle uses the visible screen centre as the query anchor', () => {
  const engine = createFakeEngine({ width: 1000, height: 800 });
  engine.fake.script('pickEllipsoid', (pixel) => {
    assert.deepEqual(pixel, { x: 500, y: 400 });
    return geo.cartesian3.fromDegrees(-97, 30);
  });
  engine.fake.script('viewRectangle', () => {
    throw new Error('centre hit must not compute a rectangle');
  });
  const anchor = defaultGnssViewAnchor(engine);
  assert.ok(Math.abs(anchor.latitude - 30) < 1e-8);
  assert.ok(Math.abs(anchor.longitude + 97) < 1e-8);
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
  const manager = new LayerLifecycle(h.viewer, { engine: h.engine });
  manager.register(h.layer);
  h.layer.attachDataManager(manager);
  const changes = [];
  manager.subscribe((change) => changes.push(change.type));
  await manager.setEnabled(h.layer.id, true);
  h.setAnchor({ latitude: 54, longitude: 19 });
  h.camera.changed.raiseEvent();
  h.setAnchor({ latitude: 55, longitude: 20 });
  h.camera.moveEnd.raiseEvent();
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
  h.camera.changed.raiseEvent();
  h.advance(5000);
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(calls, 2, 'nearby views reuse the same query region');
  await manager.destroyAll();
  assert.equal(h.camera.moveEnd.numberOfListeners, 0);
  assert.equal(h.camera.changed.numberOfListeners, 0);
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
  h.camera.moveEnd.raiseEvent();
  h.advance(2500);
  t.mock.timers.tick(2500);
  await flush();
  h.setAnchor({ latitude: 35, longitude: 140 });
  h.camera.changed.raiseEvent();
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
  h.camera.moveEnd.raiseEvent();
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
  assert.throws(
    () => layer.init(null, { engine: createFakeEngine() }),
    /already/,
  );
});

test('an enabled refresh bins the snapshot into coloured ground cells', async () => {
  const { layer, cells, anchors } = harness(async (anchor, { signal }) => {
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
  assert.equal(cells().shown, true);
  assert.equal(await layer.update(), true);
  const { items, options } = cells();
  assert.equal(items.length, 1, 'the one-aircraft cell is withheld');
  // Cell 280:420, half a degree from 50° N, 30° E, at the high level.
  assert.deepEqual(
    { ...items[0], fill: undefined },
    { west: 30, south: 50, east: 30.5, north: 50.5, fill: undefined },
  );
  assert.deepEqual(
    items[0].fill,
    rgbaFromCss('#f85149').withAlpha(0.55).rgba(),
  );
  assert.equal(options.kind, 'cell');
  assert.equal(options.pickable, false);
  const stats = layer.getStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.error, null);
  assert.equal(stats.fallback, false);
  const { legend } = layer.getRowControls();
  assert.deepEqual(
    legend.map(({ count }) => count),
    [1, 0, 0],
  );
  assert.match(legend[0].blurb, /not a detection/);
  assert.match(legend[0].blurb, /need 3 aircraft/);
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
    cellDeg: 0.5,
    minAircraft: 3,
    definedBy: 'GEV',
  });
  assert.equal(layer.provenance.interpretation.validated, false);
  assert.equal(layer.getStats().provenance, layer.provenance);
});

test('a failed refresh keeps the last cells and reports the error', async () => {
  let fail = false;
  const { layer, drawn } = harness(async () => {
    if (fail) throw new Error('adsb.lol HTTP 502');
    return {
      rows: [
        row('a1', 1.1, false),
        row('a2', 1.2, false),
        row('a3', 1.3, false),
      ],
      stale: true,
    };
  });
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().stale, true);
  fail = true;
  assert.equal(await layer.update(), true);
  assert.equal(drawn(), 1);
  assert.equal(layer.getStats().error, 'adsb.lol HTTP 502');
  assert.equal(layer.getStats().count, 1);
});

test('observations expire with the window, and disable aborts the request in flight', async () => {
  let pending;
  const { layer, drawn, cells, advance } = harness(
    (anchor, { signal }) =>
      new Promise((resolve, reject) => {
        pending = { resolve };
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
  );
  layer.enable();
  let result = layer.update();
  pending.resolve({
    rows: [row('a1', 1.1, false), row('a2', 1.2, false), row('a3', 1.3, false)],
  });
  assert.equal(await result, true);
  assert.equal(layer.getStats().count, 1);

  advance(31 * 60_000);
  result = layer.update();
  pending.resolve({ rows: [] });
  assert.equal(await result, true);
  assert.equal(layer.getStats().count, 0);
  assert.equal(drawn(), 0);

  result = layer.update();
  layer.disable();
  assert.equal(await result, false);
  assert.equal(cells().shown, false);
});

test('no view anchor means no request, and destroy releases the ground set', async () => {
  let calls = 0;
  const { layer, ground } = harness(
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
  assert.equal(ground.sets(), 0);
  assert.equal(layer.getStats().count, 0);
});

test('a replayed stale snapshot keeps its observation age and expires on time', async () => {
  // The proxy keeps answering with the snapshot it observed at t=1000.
  const { layer, drawn, advance, now } = harness(async () => ({
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
  assert.equal(drawn(), 0);
});

test('cells expire during prolonged fetch failures', async () => {
  let fail = false;
  const { layer, drawn, advance } = harness(async () => {
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
  assert.equal(drawn(), 0);
  assert.equal(layer.getStats().error, 'adsb.lol HTTP 502');
});

test('cells expire while no view anchor is available', async () => {
  let calls = 0;
  const { layer, drawn, advance, setAnchor } = harness(async () => {
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
  assert.equal(drawn(), 0);
  assert.equal(layer.getStats().error, null);
});

test('re-enabling after a long disable does not show cells past the window', async () => {
  const { layer, drawn, advance } = harness(async () => ({
    rows: threeHealthy(),
  }));
  layer.enable();
  await layer.update();
  assert.equal(drawn(), 1);
  layer.disable();
  advance(31 * MIN);
  layer.enable();
  assert.equal(layer.getStats().count, 0);
  assert.equal(drawn(), 0);
});

const threeCells = () => ({
  rows: [row('a1', 50.1, true), row('a2', 50.1, true), row('a3', 50.2, false)],
});

test('an identical snapshot leaves the drawn cells untouched', async () => {
  const { layer, drawn, cells } = harness(async () => threeCells());
  layer.enable();
  await layer.update();
  const first = cells();
  await layer.update();
  assert.equal(drawn(), 1);
  assert.equal(cells().commits, first.commits);
  assert.equal(cells().items, first.items);
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
  const manager = new LayerLifecycle(h.viewer, { engine: h.engine });
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
  h.camera.moveEnd.raiseEvent();
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
  h.camera.changed.raiseEvent();
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
  h.camera.changed.raiseEvent();
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
  h.camera.changed.raiseEvent();
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
    rendererFactory: ({ engine }) =>
      createGnssDisplay(engine, { viewAnchor: () => anchor }),
    now: () => wall,
    monotonicNow: () => mono,
  });
  layer.init(null, { engine: h.engine });
  layer.enable();
  await layer.update();
  wall -= 3600000;
  mono = 3000;
  anchor = { latitude: 51, longitude: 31 };
  h.camera.changed.raiseEvent();
  mono += 600;
  t.mock.timers.tick(600);
  await flush();
  assert.equal(calls, 2);
  layer.destroy();
});

test('the cells stay out of picks', async () => {
  const h = harness(async () => ({ rows: threeHealthy() }));
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.cells().options.pickable, false);
  // A pick at the drawn cell (1° N, 30.2° E) finds nothing of the layer.
  h.engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(30.2, 1.2, 100_000),
  });
  const { width, height } = h.engine.host.size();
  assert.equal(
    h.engine.picker.pick({ x: width / 2, y: height / 2 }),
    undefined,
  );
  h.layer.destroy();
  assert.equal(h.ground.sets(), 0);
});

test('view anchor falls back to rectangle, then nadir, then no camera', () => {
  assert.equal(defaultGnssViewAnchor({}), null);
  const radians = geo.math.toRadians;
  const engine = createFakeEngine({ width: 1000, height: 800 });
  engine.fake.script('pickEllipsoid', undefined);
  engine.fake.script('viewRectangle', {
    west: radians(20),
    south: radians(40),
    east: radians(22),
    north: radians(42),
  });
  engine.camera.pose = () => assert.fail('a rectangle must not read the pose');
  const rectangleAnchor = defaultGnssViewAnchor(engine);
  assert.ok(Math.abs(rectangleAnchor.latitude - 41) < 1e-10);
  assert.ok(Math.abs(rectangleAnchor.longitude - 21) < 1e-10);
  engine.camera = {
    pickEllipsoid: () => assert.fail('an empty canvas has no centre'),
    viewRectangle: () => undefined,
    pose: () => ({
      cartographic: { longitude: radians(21), latitude: radians(41) },
    }),
  };
  engine.host = { size: () => ({ width: 0, height: 0 }) };
  const nadirAnchor = defaultGnssViewAnchor(engine);
  assert.ok(Math.abs(nadirAnchor.latitude - 41) < 1e-10);
  assert.ok(Math.abs(nadirAnchor.longitude - 21) < 1e-10);
  engine.camera.pose = () => ({
    cartographic: { longitude: Number.NaN, latitude: 0 },
  });
  assert.equal(defaultGnssViewAnchor(engine), null);
});

test('an in-flight regional response supplies the next renderer without a new request', async () => {
  let resolve,
    calls = 0;
  const h = harness(() => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  });
  try {
    h.layer.enable();
    const pending = h.layer.update();
    h.layer.detachRenderer();
    assert.equal(h.camera.changed.numberOfListeners, 0);
    resolve({ rows: threeHealthy() });
    assert.equal(await pending, true);
    assert.equal(h.ground.sets(), 0);
    assert.equal(h.layer.getStats().levels.low, 1);
    h.layer.attachRenderer({ engine: h.engine });
    assert.equal(h.drawn(), 1);
    assert.equal(calls, 1);
    assert.equal(h.camera.changed.numberOfListeners, 1);
  } finally {
    h.layer.destroy();
  }
});
