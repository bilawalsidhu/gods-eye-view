import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as Cesium from 'cesium';
import * as geo from '../geo/index.js';
import { MAP_STACKS } from '../mapStackController.js';
import {
  CABLE_LABEL_DEPTH_DECISION,
  CABLE_OVERLAY_COLLISION_CAPACITY,
  CABLE_OVERLAY_SOURCE_ID,
  CABLE_REFERENCE_LABEL_WINNER_CAP,
  CABLE_STEM_TIP_EPSILON_M,
  CABLE_SWEEP_MOTION_EPSILON_M,
  CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS,
  cableDrapeForEngine,
  cableDrapeForStack,
  cableReferencePriority,
  createCableOverlayEntry,
  createCableOverlayPublisher,
  createCableReferenceSweepGate,
  createTeleGeographySubmarineCableLayer,
  selectCableReferenceLabelWinners,
  updateCableReferenceTip,
} from './telegeographySubmarineCables.js';
import { createCablesDisplay } from '../layers/submarineCables/render/display.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';

test('cable reference winners remain nearest-first and hard-capped', () => {
  const records = Array.from({ length: 300 }, (_, index) => ({
    entity: { id: `reference-${index}` },
    label: `Reference ${index}`,
    visible: true,
    distanceM: 1000 + index,
  }));

  let winners = selectCableReferenceLabelWinners(records);
  assert.equal(winners.length, CABLE_REFERENCE_LABEL_WINNER_CAP);
  assert.equal(winners[0], records[0]);
  assert.equal(winners.at(-1), records[CABLE_REFERENCE_LABEL_WINNER_CAP - 1]);

  for (let index = 0; index < 80; index++) records[index].visible = false;
  winners = selectCableReferenceLabelWinners(records);
  assert.equal(winners.length, CABLE_REFERENCE_LABEL_WINNER_CAP);
  assert.equal(
    winners[0],
    records[80],
    'hidden references release their slots to the next nearest',
  );

  records[90].distanceM = 10_000_000; // beyond the 9,000 km reference range
  winners = selectCableReferenceLabelWinners(records);
  assert.ok(
    !winners.includes(records[90]),
    'out-of-range references never reach the host',
  );
});

test('cable overlay entries satisfy the shared presentation contract', () => {
  const tip = Cesium.Cartesian3.fromDegrees(-40, 35, 2500);
  const record = {
    id: 'cable-reference-0-atlantic-1',
    kind: 'cable',
    label: 'Atlantic Crossing-1',
    tip,
    distanceM: 400_000,
  };
  const entry = createCableOverlayEntry(record);

  assert.equal(entry.id, 'cable-reference-0-atlantic-1');
  assert.equal(
    entry.position,
    tip,
    'entry stays attached to the mutable stem-tip Cartesian',
  );
  assert.equal(entry.variant, 'label');
  assert.equal(entry.title, 'Atlantic Crossing-1');
  assert.equal(entry.accent, '#39d5ff');
  assert.equal(entry.collisionGroup, 'ambient-label');
  assert.equal(entry.paintLane, 'ambient-label');
  assert.equal(
    entry.interactive,
    false,
    'point/stem/line picking remains Cesium-native',
  );
  assert.equal(entry.maxDistance, 9_000_000);
  assert.equal(entry.distanceFadeStartRatio, 0.7);
  assert.deepEqual(
    entry.distanceScale,
    {
      near: 250_000,
      nearValue: 1,
      far: 9_000_000,
      farValue: 0.62,
    },
    'former native scaleByDistance curve is preserved',
  );
  assert.equal(entry.edgeFade, 'keyhole');
  assert.equal(entry.horizonCull, true);
  assert.equal(entry.terrainOcclusion, false);
  assert.equal(entry.verticalOnly, true);
  assert.equal(entry.placement, 'above');

  const landing = createCableOverlayEntry({
    id: 'landing-point-reference-1-lisbon',
    kind: 'landing-point',
    label: 'Lisbon, Portugal',
    tip,
    distanceM: 100_000,
  });
  assert.equal(
    landing.accent,
    '#8fffd2',
    'landing points keep their mint accent',
  );
  assert.equal(landing.interactive, false);
});

test('cable reference priority is nearest-first and sweep-stable', () => {
  assert.ok(cableReferencePriority(1_000) > cableReferencePriority(1_000_000));
  assert.ok(
    cableReferencePriority(1_000_000) > cableReferencePriority(8_000_000),
  );
  assert.equal(
    cableReferencePriority(500_000),
    cableReferencePriority(500_000 + 10_000),
    '50 km quantization keeps slow camera drift from reshuffling ranks',
  );
  assert.equal(
    cableReferencePriority(undefined),
    cableReferencePriority(9_000_000),
    'missing distances rank like the range edge instead of jumping the queue',
  );
});

test('cable overlay publisher owns the production show/publish/hide lifecycle', () => {
  const calls = [];
  const publisher = createCableOverlayPublisher({
    host: {
      setVisible: (...args) => calls.push(['visible', ...args]),
      setEntries: (...args) => calls.push(['entries', ...args]),
      clearSource: (...args) => calls.push(['clear', ...args]),
    },
  });

  publisher.publish([{ id: 'ignored-before-show' }]);
  publisher.show();
  publisher.show();
  publisher.publish([{ id: 'cable-1' }]);
  publisher.hide();
  publisher.publish([{ id: 'dropped-while-hidden' }]);
  publisher.hide();

  assert.deepEqual(calls[0], ['visible', CABLE_OVERLAY_SOURCE_ID, true]);
  assert.deepEqual(calls[1].slice(0, 3), [
    'entries',
    CABLE_OVERLAY_SOURCE_ID,
    [{ id: 'cable-1' }],
  ]);
  assert.deepEqual(calls[1][3], {
    cohortLimit: CABLE_REFERENCE_LABEL_WINNER_CAP,
    collisionCapacity: CABLE_OVERLAY_COLLISION_CAPACITY,
    moving: false,
  });
  assert.deepEqual(calls[2], ['clear', CABLE_OVERLAY_SOURCE_ID]);
  assert.deepEqual(calls[3], ['visible', CABLE_OVERLAY_SOURCE_ID, false]);
  assert.equal(
    calls.length,
    4,
    'hidden publishers drop late publishes; repeat hide is a no-op',
  );

  // The production teardown (layer.destroy) is hide(): the publisher stays
  // reusable for the layer's supported re-init-after-destroy contract. There
  // is intentionally no permanent-destroy method to test.
  assert.equal(publisher.destroy, undefined);
  publisher.show();
  publisher.publish([{ id: 'cable-2' }]);
  assert.deepEqual(calls[4], ['visible', CABLE_OVERLAY_SOURCE_ID, true]);
  assert.deepEqual(calls[5].slice(0, 3), [
    'entries',
    CABLE_OVERLAY_SOURCE_ID,
    [{ id: 'cable-2' }],
  ]);
});

test('cable paths drape on exactly the active surface on every stack', () => {
  // Photorealistic tiles render with the globe hidden: 3D tiles only.
  assert.equal(cableDrapeForStack('photoreal'), 'tiles');
  // Every globe stack renders imagery on the shown globe: terrain only.
  for (const stackId of ['bing-aerial', 'bing-labels', 'esri-imagery', 'osm']) {
    assert.equal(
      cableDrapeForStack(stackId),
      'terrain',
      `${stackId} must drape on terrain so cables stay visible there`,
    );
  }
  // Unknown stack → both: visible on every surface, the shipped fallback.
  // A TRUTHY unknown id must reach it too — "not photoreal" is not the same
  // claim as "renders on the globe", and asserting terrain for an id this
  // module has never heard of would hide the cables on a future 3D-tile
  // stack instead of degrading to the documented safe behavior.
  for (const unknown of [
    'some-future-stack',
    'photoreal-v2',
    '',
    undefined,
    null,
  ])
    assert.equal(cableDrapeForStack(unknown), 'both', String(unknown));

  // Every id that actually ships must be a KNOWN id: a stack added to
  // MAP_STACKS without a mapping here silently loses its halved command set,
  // so the omission fails loudly instead of degrading quietly.
  for (const stack of MAP_STACKS) {
    assert.notEqual(
      cableDrapeForStack(stack.id),
      'both',
      `MAP_STACKS id '${stack.id}' has no cable drape mapping`,
    );
  }

  // Boot fires no stack event; the first drape comes from the engine:
  // photoreal tiles shown ⇔ the globe hidden.
  const engine = (photoreal) => {
    const globe = createFakeEngine();
    globe.maps.photorealActive = () => photoreal;
    return globe;
  };
  assert.equal(cableDrapeForEngine(engine(true)), 'tiles');
  assert.equal(cableDrapeForEngine(engine(false)), 'terrain');
  assert.equal(cableDrapeForEngine(null), 'both');
});

test('cable reference sweep gate is dirty-only — no timer path', () => {
  const gate = createCableReferenceSweepGate();
  assert.equal(gate.shouldRun(), true, 'initial dirtiness covers enable/load');
  // However many frames render, an un-dirtied gate never runs the sweep —
  // the former 500 ms timer path is gone.
  for (let frame = 0; frame < 200; frame++) {
    assert.equal(gate.shouldRun(), false);
  }
  gate.markDirty();
  assert.equal(gate.shouldRun(), true, 'moveEnd dirtiness runs exactly once');
  assert.equal(gate.shouldRun(), false);
  gate.reset();
  assert.equal(gate.shouldRun(), true, 'reset restores the initial dirtiness');
});

test('the sweep gate falls back to motion probes for cameras that never emit moveEnd', () => {
  let clock = 0;
  const frameMs = 1000 / 60;
  const origin = Cesium.Cartesian3.fromDegrees(-40, 35, 4_500_000);
  const camera = { positionWC: Cesium.Cartesian3.clone(origin) };
  const gate = createCableReferenceSweepGate({ now: () => clock });
  const runFrames = (count, step = () => {}) => {
    let sweeps = 0;
    for (let frame = 0; frame < count; frame++) {
      clock += frameMs;
      step(frame);
      if (gate.shouldRun(camera)) sweeps++;
    }
    return sweeps;
  };

  assert.equal(
    gate.shouldRun(camera),
    true,
    'initial dirtiness still covers enable/load',
  );

  // PARKED: 100 s of frames on a camera that never moves must cost ZERO
  // sweeps — the fallback is motion-aware, not a reinstated timer.
  assert.equal(
    runFrames(6000),
    0,
    'a parked camera costs zero sweeps however long frames flow',
  );

  // Sub-epsilon jitter is not motion either: the probe compares against the
  // last SWEPT position, so numeric noise can never accumulate into a sweep.
  const jitter = runFrames(6000, (frame) => {
    camera.positionWC = Cesium.Cartesian3.add(
      origin,
      new Cesium.Cartesian3(
        0,
        0,
        (frame % 2) * (CABLE_SWEEP_MOTION_EPSILON_M / 10),
      ),
      new Cesium.Cartesian3(),
    );
  });
  assert.equal(jitter, 0, 'sub-epsilon camera jitter never earns a sweep');

  // TRACKING: a follow camera advances every frame and never emits moveEnd.
  // The sweep must land inside one probe window instead of starving forever.
  const timedGate = createCableReferenceSweepGate({ now: () => clock });
  const timedCamera = { positionWC: Cesium.Cartesian3.clone(origin) };
  assert.equal(timedGate.shouldRun(timedCamera), true, 'the gate starts dirty');
  const trackingStart = clock;
  let sweepAt = null;
  for (let frame = 0; frame < 600 && sweepAt === null; frame++) {
    clock += frameMs;
    timedCamera.positionWC = Cesium.Cartesian3.add(
      origin,
      new Cesium.Cartesian3(0, 0, 12 * (frame + 1)), // ~0.7 km/s: a tracked jet
      new Cesium.Cartesian3(),
    );
    if (timedGate.shouldRun(timedCamera)) sweepAt = clock;
  }
  assert.notEqual(
    sweepAt,
    null,
    'a continuously moving camera must not starve the sweep',
  );
  assert.ok(
    sweepAt - trackingStart <= CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS + frameMs,
    `the fallback sweep must land inside one probe window (landed at ${sweepAt - trackingStart} ms)`,
  );
  assert.ok(
    sweepAt - trackingStart >= CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS,
    'and never sooner — the probe stays bounded to one sample per window',
  );

  // moveEnd still wins immediately: an event-dirtied gate does not wait for
  // the probe window it is sitting inside.
  timedGate.markDirty();
  assert.equal(
    timedGate.shouldRun(timedCamera),
    true,
    'moveEnd dirtiness bypasses the probe window',
  );
  assert.equal(
    timedGate.shouldRun(timedCamera),
    false,
    'and still runs exactly once',
  );

  // A gate called without a camera keeps the pure dirty-only contract.
  const cameraless = createCableReferenceSweepGate({ now: () => clock });
  assert.equal(cameraless.shouldRun(), true);
  clock += CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS * 10;
  assert.equal(
    cameraless.shouldRun(),
    false,
    'no camera state means no motion fallback',
  );
});

test('reference tips move only on real changes, sized for the stem target and clamped', () => {
  const lon = -40;
  const lat = 35;
  const tip = Cesium.Cartesian3.fromDegrees(lon, lat, 2500);
  const record = {
    base: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
    tip,
    nextTip: Cesium.Cartesian3.clone(tip),
    reference: { lon, lat },
  };
  const canvasHeight = 900;
  const fov = Math.PI / 3;
  const camera = Cesium.Cartesian3.fromDegrees(-40, 35, 500_000);

  assert.equal(
    updateCableReferenceTip(record, camera, canvasHeight, fov),
    true,
  );
  assert.equal(record.tip, tip, 'the tip is moved in place');
  const height = Cesium.Cartographic.fromCartesian(record.tip).height;
  // ~66 px at 500 km: 500 km × 2·tan(30°)/900 × 66.
  assert.ok(
    Math.abs(height - (500_000 * 2 * Math.tan(fov / 2) * 66) / 900) < 1,
  );

  // Sub-epsilon camera noise moves nothing.
  const jitter = Cesium.Cartesian3.add(
    camera,
    new Cesium.Cartesian3(CABLE_STEM_TIP_EPSILON_M / 10, 0, 0),
    new Cesium.Cartesian3(),
  );
  assert.equal(
    updateCableReferenceTip(record, jitter, canvasHeight, fov),
    false,
  );

  // A real camera move does.
  const moved = Cesium.Cartesian3.add(
    camera,
    new Cesium.Cartesian3(0, 0, 400_000),
    new Cesium.Cartesian3(),
  );
  assert.equal(updateCableReferenceTip(record, moved, canvasHeight, fov), true);

  // Tip height honors the shipped 700 m..85 km clamp.
  const far = Cesium.Cartesian3.fromDegrees(-40, 35, 20_000_000);
  updateCableReferenceTip(record, far, canvasHeight, fov);
  assert.ok(
    Math.abs(Cesium.Cartographic.fromCartesian(record.tip).height - 85_000) < 1,
  );
  const close = Cesium.Cartesian3.fromDegrees(-40, 35, 100);
  updateCableReferenceTip(record, close, canvasHeight, fov);
  assert.ok(
    Math.abs(Cesium.Cartographic.fromCartesian(record.tip).height - 700) < 1,
  );
});

test('the depth decision is the dated Option-2 host migration, superseding Option 1', () => {
  assert.deepEqual(CABLE_LABEL_DEPTH_DECISION, {
    option: 2,
    decidedAt: '2026-08-18',
    supersedes: '2026-08-02',
    depthTested: false,
  });
});

test('cables create no native labels, no per-frame callbacks and no engine imports', () => {
  const directory = new URL('../layers/submarineCables/', import.meta.url);
  const files = [
    ...readdirSync(directory)
      .filter((file) => file.endsWith('.js'))
      .map((file) => new URL(file, directory)),
    ...readdirSync(new URL('render/', directory))
      .filter((file) => file.endsWith('.js'))
      .map((file) => new URL(`render/${file}`, directory)),
    new URL('../app/layers/submarineCables.js', import.meta.url),
    new URL('../app/layers/overlayHost.js', import.meta.url),
    new URL('./telegeographySubmarineCables.js', import.meta.url),
  ];
  const source = files.map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(source, /from 'cesium'|from 'three'|@navaramap/);
  assert.doesNotMatch(
    source,
    /\bnew \w+\.(?:LabelGraphics|CallbackProperty)\b/,
  );
  assert.match(
    source,
    /setEntries/,
    'labels must flow through the shared world-overlay host',
  );
});

const CABLE_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'ac1',
      properties: { id: 'ac1', name: 'Atlantic Crossing-1' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [-40, 35],
          [-30, 40],
        ],
      },
    },
  ],
};
const LANDING_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'lisbon',
      properties: { id: 'lisbon', name: 'Lisbon, Portugal' },
      geometry: { type: 'Point', coordinates: [-9.1, 38.7] },
    },
  ],
};
const fixtureSource = (label = 'Test cable directory', payload) => {
  const source = {
    label,
    reads: 0,
    async fetch(signal) {
      signal.throwIfAborted();
      source.reads += 1;
      return (
        payload ?? { cables: CABLE_FIXTURE, landingPoints: LANDING_FIXTURE }
      );
    },
  };
  return source;
};

/**
 * The facade's layer on the fake engine, enabled and loaded, the camera
 * over the Atlantic; `sweep()` runs one preRender.
 */
async function createLayerHarness({ source = fixtureSource() } = {}) {
  const hostCalls = [];
  const overlayHost = {
    setVisible: (...args) => hostCalls.push(['visible', ...args]),
    setEntries: (...args) => hostCalls.push(['entries', ...args]),
    clearSource: (...args) => hostCalls.push(['clear', ...args]),
  };
  const engine = createFakeEngine();
  // What the paths set was given at its last commit.
  let paths = null;
  const createSet = engine.ground.createSet.bind(engine.ground);
  engine.ground.createSet = (options) => {
    const set = createSet(options);
    const replace = set.replace;
    set.replace = (items) => {
      replace(items);
      paths = { options, items };
    };
    return set;
  };
  const flights = [];
  engine.camera.flyTo = (options) => flights.push(options);
  const look = (lon, lat, height) =>
    engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(lon, lat, height),
    });
  look(-40, 35, 4_500_000);
  const layer = createTeleGeographySubmarineCableLayer({
    source,
    createDisplay: (engine) =>
      createCablesDisplay(engine, { overlayHost, sweepClock: () => 0 }),
  });
  layer.init(null, { engine });
  await layer.enable();
  assert.equal(layer.getStats().error, null, 'harness load must succeed');
  const drawn = () => ({
    ground: engine.ground.list().length,
    movers: engine.movers.list().length,
    lines: engine.lines.list().length,
  });
  return {
    engine,
    look,
    flights,
    paths: () => (engine.ground.list().length ? paths : undefined),
    moveEnd: () => engine.fake.emit('camera.moveEnd'),
    /** A click on the paths set's item `instance`. */
    clickPath(instance) {
      engine.fake.script('pick', {
        id: paths.items[instance].pickId,
        owner: paths.options.id,
        instance,
      });
      engine.fake.input('click', { position: { x: 100, y: 100 } });
      engine.fake.unscript('pick');
    },
    layer,
    source,
    hostCalls,
    drawn,
    sweep: () => engine.fake.emit('frames.preRender', 0),
    publishCount: () => hostCalls.filter(([type]) => type === 'entries').length,
  };
}

test('a real enabled cable layer publishes host entries and draws through the engine', async () => {
  const env = await createLayerHarness();
  env.sweep();

  const publishes = env.hostCalls.filter(([type]) => type === 'entries');
  assert.equal(publishes.length, 1, 'sweep must publish to the shared host');
  const [, sourceId, entries, options] = publishes.at(-1);
  assert.equal(sourceId, CABLE_OVERLAY_SOURCE_ID);
  assert.equal(entries.length, 2, 'one cable + one landing point reference');
  assert.ok(entries.every((entry) => entry.variant === 'label'));
  assert.deepEqual(options, {
    cohortLimit: CABLE_REFERENCE_LABEL_WINNER_CAP,
    collisionCapacity: CABLE_OVERLAY_COLLISION_CAPACITY,
    moving: false,
  });
  assert.deepEqual(env.drawn(), { ground: 1, movers: 3, lines: 1 });
  assert.equal(
    env.engine.lines.list()[0].points,
    4,
    'both stems share the batch',
  );
  const stats = env.layer.getStats();
  assert.equal(stats.referenceLabelCount, 2);
  assert.equal(stats.count, 2);

  env.layer.disable();
  assert.ok(
    env.hostCalls.some(
      ([type, id]) => type === 'clear' && id === CABLE_OVERLAY_SOURCE_ID,
    ),
    'disable must clear the host source',
  );
  assert.deepEqual(
    env.hostCalls.at(-1),
    ['visible', CABLE_OVERLAY_SOURCE_ID, false],
    'disable must hide the host source after clearing it',
  );
  assert.deepEqual(env.drawn(), { ground: 0, movers: 0, lines: 0 });
  env.layer.destroy();
});

test('a direct destroy of a published layer clears and hides its host source', async () => {
  const env = await createLayerHarness();
  env.sweep();
  assert.equal(env.publishCount(), 1);
  env.hostCalls.length = 0;
  // Destroy DIRECTLY — no disable() first.
  env.layer.destroy();
  assert.deepEqual(env.hostCalls, [
    ['clear', CABLE_OVERLAY_SOURCE_ID],
    ['visible', CABLE_OVERLAY_SOURCE_ID, false],
  ]);
  assert.deepEqual(env.drawn(), { ground: 0, movers: 0, lines: 0 });
});

test('an unchanged cohort never republishes, so a parked camera stays governor-idle', async () => {
  const env = await createLayerHarness();
  env.sweep();
  assert.equal(env.publishCount(), 1, 'first sweep publishes the cohort');

  // moveEnd with an unchanged camera re-arms the sweep; the identical winner
  // set must NOT reach the host again (each publish costs a requested render).
  env.moveEnd();
  env.sweep();
  env.moveEnd();
  env.sweep();
  assert.equal(env.publishCount(), 1, 'identical cohorts are skipped');

  // A real camera move changes distances beyond the 50 km priority quantum.
  env.look(-40, 35, 6_500_000);
  env.moveEnd();
  env.sweep();
  assert.equal(env.publishCount(), 2, 'a changed cohort publishes');

  // disable → enable republishes an identical cohort: the hide cleared the
  // host source.
  env.layer.disable();
  await env.layer.enable();
  env.sweep();
  assert.equal(env.publishCount(), 3, 're-enable republishes');
  env.layer.destroy();
});

test('a toggle-off releases everything drawn and a toggle-on rebuilds it without refetching', async () => {
  const env = await createLayerHarness();
  assert.deepEqual(env.drawn(), { ground: 1, movers: 3, lines: 0 });
  env.layer.disable();
  assert.deepEqual(env.drawn(), { ground: 0, movers: 0, lines: 0 });
  await env.layer.enable();
  assert.equal(env.source.reads, 1, 'the rebuild must not touch the network');
  assert.equal(env.layer.getStats().error, null);
  assert.deepEqual(env.drawn(), { ground: 1, movers: 3, lines: 0 });
  assert.equal(env.layer.getStats().count, 2);
  env.layer.destroy();
  assert.deepEqual(env.drawn(), { ground: 0, movers: 0, lines: 0 });
});

test('another GeoJSON source renders with its own label and rebuilds from accepted cache', async () => {
  const env = await createLayerHarness({ source: fixtureSource() });
  try {
    assert.equal(env.layer.source, 'Test cable directory');
    assert.equal(env.source.reads, 1);
    env.layer.disable();
    await env.layer.enable();
    assert.equal(env.layer.getStats().count, 2);
    assert.equal(env.paths().items.length, 1);
    assert.equal(env.source.reads, 1);
  } finally {
    env.layer.destroy();
  }
});

function multipartCableFixture() {
  return [
    {
      type: 'Feature',
      properties: {
        id: 'alpha',
        name: 'Alpha cable',
        color: '#ff0000',
        coordinates: [-40, 35],
      },
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [-40, 35],
            [-39, 36],
          ],
          [
            [-38, 37],
            [-37, 38],
          ],
          [
            [-36, 39],
            [-35, 40],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: {
        id: 'beta',
        name: 'Beta cable',
        color: '#0000ff',
        coordinates: [140, -35],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [140, -35],
          [141, -34],
        ],
      },
    },
  ];
}

const geometrySource = (cables, landingPoints = []) =>
  fixtureSource('Multipart test source', {
    cables: { type: 'FeatureCollection', features: cables },
    landingPoints: { type: 'FeatureCollection', features: landingPoints },
  });

const near = (actual, expected, label) =>
  actual.forEach((value, index) =>
    assert.ok(Math.abs(value - expected[index]) < 1e-6, label),
  );
const cssRgba = (css, alpha) => {
  const color = Cesium.Color.fromCssColorString(css);
  return [color.red, color.green, color.blue, alpha];
};

test('multipart cables keep their own colour, width and pick on every segment, one reference per feature', async () => {
  const features = multipartCableFixture();
  const before = JSON.stringify(features);
  const env = await createLayerHarness({ source: geometrySource(features) });
  try {
    const items = env.paths().items;
    assert.equal(items.length, 4);
    for (const [index, item] of items.entries()) {
      const feature = features[index < 3 ? 0 : 1];
      near(item.color, cssRgba(feature.properties.color, 0.92), feature.id);
      assert.equal(item.widthPx, 2.5);
    }
    assert.deepEqual(
      items.map((item) => item.pickId),
      [
        'cable-reference-0-alpha',
        'cable-reference-0-alpha',
        'cable-reference-0-alpha',
        'cable-reference-1-beta',
      ],
    );
    // Every segment flies to its own feature's reference.
    for (const instance of [0, 2, 3]) env.clickPath(instance);
    const references = env.flights.map((flight) => {
      const place = geo.cartographic.fromCartesian(flight.destination);
      return [
        Math.round(geo.math.toDegrees(place.longitude)),
        Math.round(geo.math.toDegrees(place.latitude)),
      ];
    });
    assert.deepEqual(references, [
      [-40, 35],
      [-40, 35],
      [140, -35],
    ]);
    assert.equal(
      env.engine.movers
        .list()
        .find(({ id }) => id === `${CABLE_OVERLAY_SOURCE_ID}-cable-tips`).count,
      2,
      'one reference per feature',
    );
    assert.equal(JSON.stringify(features), before, 'features stay unchanged');
  } finally {
    env.layer.destroy();
  }
});

test('frozen provider collections are drawn without being modified', async () => {
  const payload = {
    cables: { type: 'FeatureCollection', features: multipartCableFixture() },
    landingPoints: {
      type: 'FeatureCollection',
      features: multipartCableFixture(),
    },
  };
  const before = structuredClone(payload);
  const freeze = (value) => {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  freeze(payload);
  const env = await createLayerHarness({
    source: fixtureSource('Frozen multipart source', payload),
  });
  try {
    // Landing lines draw as paths too (the GeoJSON stroke): 4 + 4.
    assert.equal(env.paths().items.length, 8);
    assert.deepEqual(payload, before);
  } finally {
    env.layer.destroy();
  }
});

test('missing and repeated IDs still give every feature its own reference', async () => {
  const features = multipartCableFixture();
  features[1].id = 'alpha_2';
  delete features[1].properties.id;
  const generated = structuredClone(features[1]);
  delete generated.id;
  generated.properties.name = 'Generated cable';
  features.push(generated);
  const repeated = structuredClone(features[1]);
  repeated.properties.id = 'alpha';
  repeated.properties.name = 'Repeated ID cable';
  features.push(repeated);
  const env = await createLayerHarness({ source: geometrySource(features) });
  try {
    const items = env.paths().items;
    assert.deepEqual(
      [...new Set(items.map((item) => item.pickId))],
      [
        'cable-reference-0-alpha',
        'cable-reference-1-alpha_2',
        'cable-reference-2-cable-2',
        'cable-reference-3-alpha',
      ],
      'the repeated provider ID keeps its own reference',
    );
    env.look(140, -35, 4_500_000);
    env.moveEnd();
    env.sweep();
    const [, , entries] = env.hostCalls
      .filter(([type]) => type === 'entries')
      .at(-1);
    assert.deepEqual(entries.map((entry) => entry.title).sort(), [
      'Beta cable',
      'Generated cable',
      'Repeated ID cable',
    ]);
  } finally {
    env.layer.destroy();
  }
});

test('multipart landing geometry keeps every pick with one reference per feature', async () => {
  const features = multipartCableFixture();
  const env = await createLayerHarness({
    source: geometrySource([], features),
  });
  try {
    const items = env.paths().items;
    assert.equal(items.length, 4);
    assert.ok(
      items.every((item) => item.pickId.startsWith('landing-point-reference-')),
    );
    assert.equal(new Set(items.map((item) => item.pickId)).size, 2);
    near(items[0].color, cssRgba('#8fffd2', 0.9), 'the GeoJSON landing stroke');
    assert.equal(items[0].widthPx, 2);
  } finally {
    env.layer.destroy();
  }
});
