import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { MAP_STACKS } from '../mapStackController.js';
import { CABLE_LANDING_REVEALS_PER_FRAME } from '../layers/submarineCables/policy.js';
import { featureParts } from '../layers/submarineCables/geometry.js';
import {
  CABLE_LABEL_DEPTH_DECISION,
  CABLE_OVERLAY_COLLISION_CAPACITY,
  CABLE_OVERLAY_SOURCE_ID,
  CABLE_REFERENCE_LABEL_WINNER_CAP,
  CABLE_STEM_TIP_EPSILON_M,
  CABLE_SWEEP_MOTION_EPSILON_M,
  CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS,
  cableClassificationTypeForScene,
  cableClassificationTypeForStack,
  cableReferencePriority,
  createCableOverlayEntry,
  createCableOverlayPublisher,
  createCableReferenceSweepGate,
  createTeleGeographySubmarineCableLayer,
  selectCableReferenceLabelWinners,
  updateCableReferenceStem,
} from './telegeographySubmarineCables.js';

// A WebGL context reports these limits. Node has none, and Cesium's
// development build refuses to make a render state (which a primitive does as
// it is constructed) while the line-width range is empty.
Cesium.ContextLimits._minimumAliasedLineWidth = 1;
Cesium.ContextLimits._maximumAliasedLineWidth = 1;

test('cable reference winners remain nearest-first and hard-capped', () => {
  const records = Array.from({ length: 300 }, (_, index) => ({
    id: `reference-${index}`,
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

test('cable ground lines classify against exactly the active surface on every stack', () => {
  // Photorealistic tiles render with the globe hidden — 3D-tile pass only.
  assert.equal(
    cableClassificationTypeForStack('photoreal'),
    Cesium.ClassificationType.CESIUM_3D_TILE,
  );
  // Every globe stack renders imagery on the shown globe — terrain pass only.
  for (const stackId of ['bing-aerial', 'bing-labels', 'esri-imagery', 'osm']) {
    assert.equal(
      cableClassificationTypeForStack(stackId),
      Cesium.ClassificationType.TERRAIN,
      `${stackId} must classify against terrain so cables stay visible there`,
    );
  }
  // Unknown stack → BOTH: visible on every surface, the shipped fallback.
  // A TRUTHY unknown id must reach it too — "not photoreal" is not the same
  // claim as "renders on the globe", and asserting TERRAIN for an id this
  // module has never heard of would hide the cables on a future 3D-tile
  // stack instead of degrading to the documented safe behavior.
  assert.equal(
    cableClassificationTypeForStack('some-future-stack'),
    Cesium.ClassificationType.BOTH,
  );
  assert.equal(
    cableClassificationTypeForStack('photoreal-v2'),
    Cesium.ClassificationType.BOTH,
  );
  assert.equal(
    cableClassificationTypeForStack(''),
    Cesium.ClassificationType.BOTH,
  );
  assert.equal(
    cableClassificationTypeForStack(undefined),
    Cesium.ClassificationType.BOTH,
  );
  assert.equal(
    cableClassificationTypeForStack(null),
    Cesium.ClassificationType.BOTH,
  );

  // Every id that actually ships must be a KNOWN id: a stack added to
  // MAP_STACKS without a mapping here silently loses its halved command set,
  // so the omission fails loudly instead of degrading quietly.
  for (const stack of MAP_STACKS) {
    assert.notEqual(
      cableClassificationTypeForStack(stack.id),
      Cesium.ClassificationType.BOTH,
      `MAP_STACKS id '${stack.id}' has no cable classification mapping`,
    );
  }

  // Boot fires no stack event; the initial value derives from live scene
  // state exactly like the height-datum listeners: photoreal ⇔ globe hidden.
  assert.equal(
    cableClassificationTypeForScene({ globe: { show: false } }),
    Cesium.ClassificationType.CESIUM_3D_TILE,
  );
  assert.equal(
    cableClassificationTypeForScene({ globe: { show: true } }),
    Cesium.ClassificationType.TERRAIN,
  );
  assert.equal(
    cableClassificationTypeForScene(null),
    Cesium.ClassificationType.BOTH,
  );
});

test('a map-stack change re-classifies the cable lines in place, and destroy detaches the listener', async () => {
  const listeners = new Map();
  const eventTarget = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => {
      if (listeners.get(name) === fn) listeners.delete(name);
    },
  };
  const env = await createRealCableLayerHarness({
    mapStackEventTarget: eventTarget,
  });
  const { lines } = env.parts();

  // The harness scene has no globe → BOTH at init (safe unknown fallback).
  assert.equal(lines.classificationType, Cesium.ClassificationType.BOTH);
  const listener = listeners.get('gev:map-stack-changed');
  assert.equal(
    typeof listener,
    'function',
    'init must subscribe to the stack event',
  );

  const built = env.built();
  listener({ detail: { activeId: 'photoreal', status: 'ready' } });
  assert.equal(
    lines.classificationType,
    Cesium.ClassificationType.CESIUM_3D_TILE,
  );

  listener({ detail: { activeId: 'osm', status: 'ready' } });
  assert.equal(lines.classificationType, Cesium.ClassificationType.TERRAIN);
  assert.equal(env.parts().lines, lines, 'the same primitive, re-classified');
  assert.equal(env.built(), built, 'a stack switch builds nothing');

  env.layer.destroy(env.viewer);
  assert.equal(
    listeners.has('gev:map-stack-changed'),
    false,
    'destroy must detach the stack listener',
  );
});

test('markers and reference tips each draw in a single translucent pass', async () => {
  // Every marker is translucent (alpha < 1), so Cesium's default
  // OPAQUE_AND_TRANSLUCENT blend would draw each collection twice.
  const env = await createRealCableLayerHarness({
    source: geometrySource(multipartCableFixture(), landingPointFixture(3)),
  });
  try {
    const { markers, points } = env.parts();
    assert.equal(markers.length, 3);
    assert.equal(markers.blendOption, Cesium.BlendOption.TRANSLUCENT);
    assert.equal(points.length, 5, 'two cable and three landing references');
    assert.equal(points.blendOption, Cesium.BlendOption.TRANSLUCENT);
  } finally {
    env.layer.destroy(env.viewer);
  }
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

function makeStemRecord(lon = -40, lat = 35) {
  const base = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
  const tip = Cesium.Cartesian3.fromDegrees(lon, lat, 2500);
  const moves = [];
  return {
    record: {
      point: {
        set position(value) {
          moves.push(Cesium.Cartesian3.clone(value));
        },
      },
      base,
      tip,
      nextTip: Cesium.Cartesian3.clone(tip),
      reference: { lon, lat },
    },
    moves,
    tip,
  };
}

test('a stem tip moves in place, and only on a real tip change', () => {
  const { record, moves, tip } = makeStemRecord();
  const canvasHeight = 900;
  const fov = Math.PI / 3;
  const camera = Cesium.Cartesian3.fromDegrees(-40, 35, 500_000);

  assert.equal(
    updateCableReferenceStem(record, camera, canvasHeight, fov),
    true,
  );
  assert.equal(moves.length, 1, 'the tip point follows');
  assert.equal(record.tip, tip, 'the same Cartesian the label entry holds');
  assert.ok(Cesium.Cartesian3.equals(moves[0], tip));

  // Sub-epsilon camera noise must not move anything.
  const jitter = Cesium.Cartesian3.add(
    camera,
    new Cesium.Cartesian3(CABLE_STEM_TIP_EPSILON_M / 10, 0, 0),
    new Cesium.Cartesian3(),
  );
  assert.equal(
    updateCableReferenceStem(record, jitter, canvasHeight, fov),
    false,
  );
  assert.equal(moves.length, 1);

  // A real camera move does.
  const moved = Cesium.Cartesian3.add(
    camera,
    new Cesium.Cartesian3(0, 0, 400_000),
    new Cesium.Cartesian3(),
  );
  assert.equal(
    updateCableReferenceStem(record, moved, canvasHeight, fov),
    true,
  );
  assert.equal(moves.length, 2);
  assert.equal(record.tip, tip);

  // Stem height honors the shipped 700 m..85 km clamp.
  const tipCarto = Cesium.Cartographic.fromCartesian(record.tip);
  assert.ok(tipCarto.height >= 700 && tipCarto.height <= 85_000);
});

test('the depth decision is the dated Option-2 host migration, superseding Option 1', () => {
  assert.deepEqual(CABLE_LABEL_DEPTH_DECISION, {
    option: 2,
    decidedAt: '2026-08-18',
    supersedes: '2026-08-02',
    depthTested: false,
  });
});

test('cables create no native labels and no per-frame geometry callbacks', () => {
  const source = [
    '../../data/telegeographySubmarineCables.js',
    '../../app/layers/submarineCables.js',
    '../../app/layers/overlayHost.js',
    'rendering.js',
    'overlay.js',
    'surface.js',
    'ingestion.js',
    'interaction.js',
    'geometry.js',
    'lifecycle.js',
  ]
    .map((file) =>
      readFileSync(
        new URL('../layers/submarineCables/' + file, import.meta.url),
        'utf8',
      ),
    )
    .join('\n');
  assert.doesNotMatch(
    source,
    /new Cesium\.LabelGraphics/,
    'reverting to native labels must fail this pin',
  );
  assert.doesNotMatch(
    source,
    /new Cesium\.CallbackProperty/,
    'reverting to per-frame stem callbacks must fail this pin',
  );
  assert.match(
    source,
    /setOverlayEntries/,
    'labels must flow through the shared world-overlay host',
  );
  assert.match(source, /record\.point\.position = record\.tip;/);
  assert.doesNotMatch(
    source,
    /new Cesium\.CustomDataSource|GeoJsonDataSource\.load|dataSources\.add|new Cesium\.Entity|entities\.add/,
    'reverting to an entity per feature must fail this pin',
  );
  assert.doesNotMatch(
    source,
    /new Cesium\.PolylineCollection/,
    'a PolylineCollection serializes every polyline material on every frame',
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
// Node has no `document`, so Point features (whose GeoJSON default marker
// needs a canvas PinBuilder) cannot load here. Landing references only need
// `properties.coordinates`, so a line geometry exercises the same path.
const LANDING_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'lisbon',
      properties: {
        id: 'lisbon',
        name: 'Lisbon, Portugal',
        coordinates: [-9.1, 38.7],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [-9.1, 38.7],
          [-9.05, 38.72],
        ],
      },
    },
  ],
};

function fixtureForUrl(url) {
  return String(url).includes('landing-point')
    ? LANDING_FIXTURE
    : CABLE_FIXTURE;
}

/**
 * A scene stub with the two primitive collections the layer draws into. Like
 * Cesium's, a collection destroys what it removes. `built` counts every add,
 * so a test can tell "the same primitives" from "rebuilt ones". The height
 * methods are what a ground-clamped billboard asks of its scene; `heights`
 * counts them.
 */
function makeStubScene(listeners) {
  const collection = () => {
    const items = [];
    return {
      items,
      built: 0,
      add(primitive) {
        this.built += 1;
        items.push(primitive);
        return primitive;
      },
      remove(primitive) {
        const index = items.indexOf(primitive);
        if (index < 0) return false;
        items.splice(index, 1);
        if (!primitive.isDestroyed()) primitive.destroy();
        return true;
      },
    };
  };
  const heights = { reads: 0, watches: 0 };
  return {
    canvas: { clientHeight: 900 },
    requestRender() {},
    pick() {
      return null;
    },
    preRender: {
      addEventListener: (fn) => {
        listeners.preRender.add(fn);
        return () => listeners.preRender.delete(fn);
      },
    },
    primitives: collection(),
    groundPrimitives: collection(),
    frameState: { mode: Cesium.SceneMode.SCENE3D },
    heights,
    getHeight() {
      heights.reads += 1;
      return 0;
    },
    updateHeight() {
      heights.watches += 1;
      return () => {};
    },
  };
}

function makeStubViewer(listeners) {
  const flights = [];
  return {
    flights,
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(-40, 35, 4_500_000),
      frustum: { fov: Math.PI / 3 },
      moveEnd: {
        addEventListener: (fn) => {
          listeners.moveEnd.add(fn);
          return () => listeners.moveEnd.delete(fn);
        },
      },
      heading: 0,
      cancelFlight() {},
      flyTo(options) {
        flights.push(options);
      },
    },
    scene: makeStubScene(listeners),
  };
}

/** What the layer has in a stub scene, by kind. */
function sceneParts(scene) {
  const of = (collection, type) =>
    collection.items.filter((primitive) => primitive instanceof type);
  return {
    lines: of(scene.groundPrimitives, Cesium.GroundPolylinePrimitive)[0],
    markers: of(scene.primitives, Cesium.BillboardCollection)[0],
    points: of(scene.primitives, Cesium.PointPrimitiveCollection)[0],
    stems: of(scene.primitives, Cesium.Primitive),
  };
}

const sceneSize = (scene) =>
  scene.primitives.items.length + scene.groundPrimitives.items.length;
const sceneBuilt = (scene) =>
  scene.primitives.built + scene.groundPrimitives.built;

/** Node has no GPU, so nothing becomes ready by itself: say a primitive is. */
function markReady(primitive) {
  Object.defineProperty(primitive, 'ready', { value: true });
}

/**
 * Harness whose fetches stay PENDING until the test releases them, honoring
 * the abort signal like real fetch (reject with AbortError on abort). Load
 * lifecycle races are sequenced deterministically through it.
 */
function createDeferredCableLayerHarness(options = {}) {
  const hostCalls = [];
  const listeners = { preRender: new Set(), moveEnd: new Set() };
  const pendingFetches = [];
  const abortError = () =>
    Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options = {}) =>
    new Promise((resolve, reject) => {
      const entry = {
        url: String(url),
        settled: false,
        release() {
          if (entry.settled) return;
          entry.settled = true;
          resolve({ ok: true, json: async () => fixtureForUrl(url) });
        },
      };
      const signal = options?.signal;
      if (signal) {
        if (signal.aborted) {
          entry.settled = true;
          reject(abortError());
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            if (entry.settled) return;
            entry.settled = true;
            reject(abortError());
          },
          { once: true },
        );
      }
      pendingFetches.push(entry);
    });

  const layer = createTeleGeographySubmarineCableLayer({
    overlayHost: {
      setVisible: (...args) => hostCalls.push(['visible', ...args]),
      setEntries: (...args) => hostCalls.push(['entries', ...args]),
      clearSource: (...args) => hostCalls.push(['clear', ...args]),
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction() {},
      destroy() {},
    }),
    ...options,
  });
  const viewer = makeStubViewer(listeners);
  layer.init(viewer);

  return {
    layer,
    viewer,
    hostCalls,
    listeners,
    pendingFetches,
    /** Primitives now in the scene, and how many were ever added. */
    size: () => sceneSize(viewer.scene),
    built: () => sceneBuilt(viewer.scene),
    raiseSweep() {
      for (const fn of listeners.preRender) fn();
    },
    releaseAll() {
      for (const entry of [...pendingFetches]) entry.release();
      pendingFetches.length = 0;
    },
    async settle() {
      // Drain the microtask/timer interleave the load path spans.
      for (let i = 0; i < 8; i++)
        await new Promise((resolve) => setTimeout(resolve, 0));
    },
    cleanup() {
      globalThis.fetch = originalFetch;
    },
  };
}

// The fixture's two lines are one ground primitive, and its two references
// one point collection; their stems are built by the first sweep.
const LOADED_PRIMITIVES = 2;

test('an abort landing at the post-fetch boundary stops the stale load before anything is built', async () => {
  const env = createDeferredCableLayerHarness();
  try {
    env.layer.enable(env.viewer);
    // Release A's fetches and abort in the SAME frame: A's continuation runs
    // with ownership already lost, and the post-fetch owns() check is the guard.
    env.releaseAll();
    env.layer.disable();
    env.layer.enable(env.viewer);
    await env.settle();
    assert.equal(env.built(), 0, 'stale load A must build nothing');

    env.releaseAll();
    await env.settle();
    assert.equal(env.built(), LOADED_PRIMITIVES, 'load B alone builds');
    assert.equal(env.size(), LOADED_PRIMITIVES);
    assert.equal(env.layer.getStats().count, 2);
  } finally {
    env.layer.destroy(env.viewer);
    env.cleanup();
  }
});

test('a destroy in the same turn as the fetch result leaves zero primitives', async () => {
  const env = createDeferredCableLayerHarness();
  try {
    env.layer.enable(env.viewer);
    // The fetch is the load's only await. A destroy that lands before its
    // continuation runs must leave nothing behind for that continuation to
    // add: there is no later point at which the load could add anything.
    env.releaseAll();
    env.layer.destroy(env.viewer);
    await env.settle();
    assert.equal(env.built(), 0, 'the destroyed load built nothing');
    assert.equal(env.size(), 0);

    // The layer still honors its re-init contract afterwards.
    env.layer.enable(env.viewer);
    env.releaseAll();
    await env.settle();
    assert.equal(
      env.size(),
      LOADED_PRIMITIVES,
      're-enable after the raced destroy loads cleanly',
    );
    assert.equal(env.layer.getStats().count, 2);
  } finally {
    env.layer.destroy(env.viewer);
    env.cleanup();
  }
});

test('a build that fails part-way leaves nothing in the scene and reports the error', async () => {
  // The lines are added to the scene before the markers are made; a failure
  // while making the markers must take the lines back out.
  const originalWarn = console.warn;
  console.warn = () => {};
  const env = await createRealCableLayerHarness({
    source: geometrySource(multipartCableFixture(), landingPointFixture(2)),
    createMarkerImage: () => {
      throw new Error('no canvas');
    },
    expectError: true,
  });
  try {
    assert.equal(env.layer.getStats().error, 'no canvas');
    assert.equal(env.built() > 0, true, 'the lines had been added');
    assert.equal(env.size(), 0, 'and were removed again');
    env.raiseSweep();
    assert.equal(env.size(), 0, 'a sweep of a failed load draws nothing');
  } finally {
    console.warn = originalWarn;
    env.layer.destroy(env.viewer);
  }
});

test('a direct destroy of a published layer clears and hides its host source', async () => {
  const env = createDeferredCableLayerHarness();
  try {
    env.layer.enable(env.viewer);
    env.releaseAll();
    await env.settle();
    assert.equal(env.size(), LOADED_PRIMITIVES, 'layer is fully loaded');
    // Drive the sweep through the layer's real preRender listener so the
    // host actually holds published cable entries.
    env.raiseSweep();
    assert.ok(
      env.hostCalls.some(([type]) => type === 'entries'),
      'sweep must publish before the direct destroy',
    );
    env.hostCalls.length = 0;

    // Destroy DIRECTLY — no disable() first. The publisher teardown must
    // still clear the published source and hide it; skipping it would leave
    // a visible overlay source with orphan labels.
    env.layer.destroy(env.viewer);
    assert.ok(
      env.hostCalls.some(
        ([type, id]) => type === 'clear' && id === CABLE_OVERLAY_SOURCE_ID,
      ),
      'direct destroy must clear the published host source',
    );
    assert.deepEqual(
      env.hostCalls.at(-1),
      ['visible', CABLE_OVERLAY_SOURCE_ID, false],
      'direct destroy must hide the host source after clearing it',
    );
    assert.equal(env.size(), 0, 'and every primitive is gone');
  } finally {
    env.cleanup();
  }
});

test("a stale aborted load never clobbers the next load's lifecycle (A/B/C toggle race)", async () => {
  const env = createDeferredCableLayerHarness();
  try {
    // A: enable starts a load whose fetches stay pending.
    env.layer.enable(env.viewer);
    assert.equal(
      env.pendingFetches.length,
      2,
      'load A has two fetches in flight',
    );

    // Abort A and immediately start B before A\'s rejection lands.
    env.layer.disable();
    env.layer.enable(env.viewer);
    await env.settle(); // A\'s stale catch/finally runs here, after B began.

    // C: with A\'s stale completion having cleared nothing it does not own,
    // the layer still reports a load in flight, so update() must not start a
    // third load.
    void env.layer.update(env.viewer);
    await env.settle();
    const inFlight = env.pendingFetches.filter(
      (entry) => !entry.settled,
    ).length;
    assert.equal(
      inFlight,
      2,
      "only load B's two fetches remain in flight — no duplicate load C",
    );

    // Releasing everything must produce exactly one set of primitives.
    env.releaseAll();
    await env.settle();
    assert.equal(
      env.built(),
      LOADED_PRIMITIVES,
      'exactly one set of primitives is built',
    );
    assert.equal(env.size(), LOADED_PRIMITIVES);
    const stats = env.layer.getStats();
    assert.equal(stats.error, null);
    assert.equal(stats.count, 2, 'one cable + one landing point loaded once');
  } finally {
    env.layer.destroy(env.viewer);
    env.cleanup();
  }
});

test('destroy mid-load stays clean and a re-enabled layer reloads exactly once', async () => {
  const env = createDeferredCableLayerHarness();
  try {
    // Destroy while load A\'s fetches are still in flight.
    env.layer.enable(env.viewer);
    assert.equal(env.pendingFetches.length, 2);
    env.layer.destroy(env.viewer);

    // Legacy contract: the layer supports re-init after destroy. Enable D
    // before A\'s aborted rejection lands.
    env.layer.enable(env.viewer);
    await env.settle(); // A\'s stale finally runs here.

    // A\'s stale completion must not have cleared D\'s in-flight lifecycle:
    // update() must not start a duplicate load E.
    void env.layer.update(env.viewer);
    await env.settle();
    const inFlight = env.pendingFetches.filter(
      (entry) => !entry.settled,
    ).length;
    assert.equal(inFlight, 2, "only load D's two fetches remain in flight");

    env.releaseAll();
    await env.settle();
    assert.equal(
      env.built(),
      LOADED_PRIMITIVES,
      'the destroyed load built nothing; the re-enable built once',
    );
    assert.equal(env.size(), LOADED_PRIMITIVES);
    assert.equal(env.layer.getStats().count, 2);
  } finally {
    env.layer.destroy(env.viewer);
    env.cleanup();
  }
});

async function createRealCableLayerHarness({
  source,
  mapStackEventTarget = null,
  createMarkerImage,
  expectError = false,
} = {}) {
  const hostCalls = [];
  // The sweep gate's motion-fallback clock is FROZEN here and advanced only by
  // the tests that exercise it, so every other harness test observes the pure
  // event-dirty behavior with no wall-clock coupling.
  let clockMs = 0;
  const clicks = [];
  // Node has no canvas for Cesium's PinBuilder; the marker image is a seam.
  const markerImages = [];
  const layer = createTeleGeographySubmarineCableLayer({
    overlayHost: {
      setVisible: (...args) => hostCalls.push(['visible', ...args]),
      setEntries: (...args) => hostCalls.push(['entries', ...args]),
      clearSource: (...args) => hostCalls.push(['clear', ...args]),
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction(action) {
        clicks.push(action);
      },
      destroy() {},
    }),
    createMarkerImage:
      createMarkerImage ??
      ((color) => {
        const image = { width: 6, height: 6, color: color.toCssHexString() };
        markerImages.push(image);
        return image;
      }),
    ...(source ? { source } : {}),
    mapStackEventTarget,
    sweepClock: () => clockMs,
  });

  const listeners = { preRender: new Set(), moveEnd: new Set() };
  const viewer = makeStubViewer(listeners);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => fixtureForUrl(url),
  });
  try {
    layer.init(viewer);
    layer.enable(viewer);
    // enable() fires load() without awaiting it (legacy contract); poll the
    // layer's own stats until the load settles.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const stats = layer.getStats();
      if (!stats.loading && (stats.count > 0 || stats.error)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!expectError)
      assert.equal(layer.getStats().error, null, 'harness load must succeed');
  } finally {
    globalThis.fetch = originalFetch;
  }
  const raiseSweep = () => {
    for (const fn of listeners.preRender) fn();
  };
  const advanceClock = (ms) => {
    clockMs += ms;
  };
  return {
    layer,
    viewer,
    hostCalls,
    markerImages,
    raiseSweep,
    listeners,
    advanceClock,
    parts: () => sceneParts(viewer.scene),
    size: () => sceneSize(viewer.scene),
    built: () => sceneBuilt(viewer.scene),
    /** Stem primitives ever built (each is one rebuild of every stem). */
    stemBuilds: () => viewer.scene.primitives.built - stemBuildBase(viewer),
    /** A left click at `position`, through the layer's own handler. */
    click(position = { x: 1, y: 1 }) {
      for (const action of clicks) action({ position });
    },
  };
}

// The marker and point collections are added once, at load; every later add
// to scene.primitives is a stem primitive.
function stemBuildBase(viewer) {
  const { markers, points } = sceneParts(viewer.scene);
  return Number(Boolean(markers)) + Number(Boolean(points));
}

/** Landing points as real GeoJSON Points, all in view of the harness camera. */
function landingPointFixture(count) {
  return Array.from({ length: count }, (_, i) => ({
    type: 'Feature',
    id: `landing-${i}`,
    properties: { id: `landing-${i}`, name: `Landing ${i}` },
    geometry: {
      type: 'Point',
      coordinates: [-45 + (i % 20) * 0.5, 30 + Math.floor(i / 20)],
    },
  }));
}

/**
 * Stand in for the ready line primitive's per-line attributes: Node never
 * builds the geometry, so the show flags the layer writes land here.
 */
function fakeLineAttributes(lines) {
  const attributes = new Map(
    lines.geometryInstances.map((instance) => [
      instance.id,
      { show: Uint8Array.from(instance.attributes.show.value) },
    ]),
  );
  lines.getGeometryInstanceAttributes = (id) => attributes.get(id);
  markReady(lines);
  return () =>
    lines.geometryInstances.map((instance) =>
      Boolean(attributes.get(instance.id).show[0]),
    );
}

test('a real enabled cable layer publishes host entries and has zero native labels', async () => {
  const env = await createRealCableLayerHarness();
  env.raiseSweep();

  const publishes = env.hostCalls.filter(([type]) => type === 'entries');
  assert.ok(publishes.length > 0, 'sweep must publish to the shared host');
  const [, sourceId, entries, options] = publishes.at(-1);
  assert.equal(sourceId, CABLE_OVERLAY_SOURCE_ID);
  assert.equal(entries.length, 2, 'one cable + one landing point reference');
  assert.ok(entries.every((entry) => entry.variant === 'label'));
  assert.deepEqual(options, {
    cohortLimit: CABLE_REFERENCE_LABEL_WINNER_CAP,
    collisionCapacity: CABLE_OVERLAY_COLLISION_CAPACITY,
    moving: false,
  });

  const { points } = env.parts();
  assert.equal(points.length, 2, 'one reference tip per feature');
  assert.ok(
    env.viewer.scene.primitives.items.every(
      (primitive) => !(primitive instanceof Cesium.LabelCollection),
    ),
    'no native label collection',
  );
  // The label entry holds the very Cartesian the stem tip is moved in.
  const tips = entries.map((entry) => entry.position);
  for (let i = 0; i < points.length; i++)
    assert.ok(
      tips.some((tip) => Cesium.Cartesian3.equals(tip, points.get(i).position)),
      'each label sits on a reference tip',
    );

  const stats = env.layer.getStats();
  assert.equal(stats.referenceLabelCount, 2);

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

  env.layer.destroy(env.viewer);
  assert.equal(env.size(), 0, 'destroy must remove every primitive');
});

test('stems never rebuild mid-drag; exactly one rebuild lands on moveEnd', async () => {
  const env = await createRealCableLayerHarness();
  env.raiseSweep(); // initial sizing at the parked camera
  const stemRebuilds = () => env.stemBuilds() - 1;
  assert.equal(stemRebuilds(), 0, 'the first sweep builds the stems once');

  // Mid-drag: the camera moves every tick and frames keep rendering, but no
  // moveEnd fires. However long this goes on, the stems must never be
  // rebuilt — a stem cannot change length without new geometry, and a
  // rebuild per frame was the felt hitch.
  const camera = env.viewer.camera.positionWC;
  for (let tick = 0; tick < 30; tick++) {
    env.viewer.camera.positionWC = Cesium.Cartesian3.add(
      camera,
      new Cesium.Cartesian3(0, 0, 100_000 * (tick + 1)),
      new Cesium.Cartesian3(),
    );
    env.raiseSweep(); // preRender fires every frame during a drag
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(
    stemRebuilds(),
    0,
    'render ticks without moveEnd must never rebuild the stems',
  );

  // The gesture ends close over the cable's reference point (inside the
  // 700 m..85 km stem clamp band, so the re-size is a real tip change):
  // one moveEnd, one sweep, exactly one rebuild.
  env.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
    -35,
    37.5,
    400_000,
  );
  for (const fn of env.listeners.moveEnd) fn();
  env.raiseSweep();
  assert.equal(stemRebuilds(), 1, 'moveEnd re-sizes the stems exactly once');
  env.raiseSweep();
  assert.equal(stemRebuilds(), 1, 'the next frame does not re-run the sweep');

  // A moveEnd that changes nothing builds nothing.
  for (const fn of env.listeners.moveEnd) fn();
  env.raiseSweep();
  assert.equal(stemRebuilds(), 1, 'an unchanged sweep keeps the stems');

  env.layer.destroy(env.viewer);
});

test('rebuilt stems replace the shown ones only once their geometry is ready', async () => {
  const env = await createRealCableLayerHarness();
  let renderRequests = 0;
  env.viewer.scene.requestRender = () => {
    renderRequests++;
  };
  env.raiseSweep();
  const [first] = env.parts().stems;
  assert.equal(env.parts().stems.length, 1);
  assert.equal(first.show, false, 'hidden while it builds');
  assert.equal(first.geometryInstances.length, 2, 'one stem per reference');
  assert.deepEqual(
    first.geometryInstances.map((instance) => instance.geometry._width),
    [2, 2.4],
    'cable and landing stem widths',
  );
  assert.ok(first.appearance instanceof Cesium.PolylineColorAppearance);
  assert.equal(first.appearance.translucent, true);

  renderRequests = 0;
  env.raiseSweep();
  assert.ok(renderRequests > 0, 'frames are asked for until it is ready');
  markReady(first);
  env.raiseSweep();
  assert.equal(first.show, true, 'shown once ready');
  renderRequests = 0;
  env.raiseSweep();
  assert.equal(renderRequests, 0, 'settled stems ask for no frames');

  // A camera move re-sizes the stems: the shown ones stay until the
  // replacement is ready.
  env.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
    -35,
    37.5,
    400_000,
  );
  for (const fn of env.listeners.moveEnd) fn();
  env.raiseSweep();
  const [, second] = env.parts().stems;
  assert.deepEqual(env.parts().stems, [first, second]);
  assert.equal(first.show, true);
  assert.equal(second.show, false);

  // Superseded before it was ready: it is dropped, never shown.
  env.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
    -35,
    37.5,
    300_000,
  );
  for (const fn of env.listeners.moveEnd) fn();
  env.raiseSweep();
  const [, third] = env.parts().stems;
  assert.deepEqual(env.parts().stems, [first, third]);
  assert.equal(second.isDestroyed(), true);

  markReady(third);
  env.raiseSweep();
  assert.deepEqual(env.parts().stems, [third], 'the old stems are removed');
  assert.equal(third.show, true);
  assert.equal(first.isDestroyed(), true);

  // Every reference over the horizon: no stems at all.
  env.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
    140,
    -35,
    4_500_000,
  );
  for (const fn of env.listeners.moveEnd) fn();
  env.raiseSweep();
  assert.deepEqual(env.parts().stems, []);

  env.layer.destroy(env.viewer);
});

test('a tracked camera that never emits moveEnd is swept by the motion fallback', async () => {
  const env = await createRealCableLayerHarness();
  // Tracking hands over a mid-altitude follow camera. 400 km keeps the stem
  // inside the 700 m..85 km clamp band, so a sweep is observable as a real
  // tip re-size (at the harness's 4,500 km parking altitude every stem sits
  // pinned at the 85 km clamp and no sweep could be distinguished).
  env.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
    -35,
    37.5,
    400_000,
  );
  env.raiseSweep(); // initial sizing at the tracking handoff
  const stemRebuilds = () => env.stemBuilds() - 1;

  // Entity tracking / orbit: the follow camera advances every frame and
  // moveEnd NEVER fires. Frames are simulated at 60 Hz on the harness clock.
  const origin = env.viewer.camera.positionWC;
  const frameMs = 1000 / 60;
  const trackFrames = (from, to) => {
    for (let frame = from; frame < to; frame++) {
      env.advanceClock(frameMs);
      env.viewer.camera.positionWC = Cesium.Cartesian3.add(
        origin,
        new Cesium.Cartesian3(0, 0, 200 * (frame + 1)),
        new Cesium.Cartesian3(),
      );
      env.raiseSweep();
    }
  };

  // Inside the first probe window the sweep stays event-dirty-only, so the
  // stems are not rebuilt mid-motion (the shipped tradeoff).
  trackFrames(0, 60);
  assert.equal(
    stemRebuilds(),
    0,
    'inside the probe window a tracked camera still costs no rebuilds',
  );

  // Past the window the fallback fires — exactly once, not per frame.
  trackFrames(60, 130);
  assert.equal(
    stemRebuilds(),
    1,
    'the tracked camera earns exactly one fallback sweep per window',
  );

  // Tracking stops but frames keep rendering. The motion accumulated since
  // the last fallback sweep settles in exactly ONE further sweep...
  const parkFrames = (count) => {
    for (let frame = 0; frame < count; frame++) {
      env.advanceClock(frameMs);
      env.raiseSweep();
    }
  };
  parkFrames(240); // 4 s parked: two full probe windows
  assert.equal(
    stemRebuilds(),
    2,
    'a stopped camera settles its residual motion in one further sweep',
  );

  // ...and the parked camera then costs zero sweeps for as long as it sits.
  parkFrames(3600); // 60 s parked
  assert.equal(
    stemRebuilds(),
    2,
    'a settled parked camera never spends another sweep',
  );

  env.layer.destroy(env.viewer);
});

test('an unchanged cohort never republishes, so a parked camera stays governor-idle', async () => {
  const env = await createRealCableLayerHarness();
  const publishCount = () =>
    env.hostCalls.filter(([type]) => type === 'entries').length;

  env.raiseSweep();
  assert.equal(publishCount(), 1, 'first sweep publishes the cohort');

  // moveEnd with an unchanged camera re-arms the sweep; the identical winner
  // set must NOT reach the host again (each publish costs a requested render).
  for (const fn of env.listeners.moveEnd) fn();
  env.raiseSweep();
  for (const fn of env.listeners.moveEnd) fn();
  env.raiseSweep();
  assert.equal(publishCount(), 1, 'identical cohorts are skipped');

  // A real camera move changes distances beyond the 50 km priority quantum,
  // so the next sweep publishes again.
  env.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
    -40,
    35,
    6_500_000,
  );
  for (const fn of env.listeners.moveEnd) fn();
  env.raiseSweep();
  assert.equal(publishCount(), 2, 'a changed cohort publishes');

  // disable → enable must force a republish even when the cohort is identical
  // (the hide cleared the host source).
  env.layer.disable();
  env.layer.enable(env.viewer);
  await new Promise((resolve) => setTimeout(resolve, 10));
  env.raiseSweep();
  assert.equal(
    publishCount(),
    3,
    're-enable republishes after the hide cleared the source',
  );

  env.layer.destroy(env.viewer);
});

test('a toggle-off hides the primitives and a toggle-on shows the same ones without refetching or rebuilding', async () => {
  const env = await createRealCableLayerHarness();
  env.raiseSweep();
  markReady(env.parts().stems[0]);
  env.raiseSweep();
  const shown = () => {
    const { lines, points, stems } = env.parts();
    return [lines.show, points.show, ...stems.map((stem) => stem.show)];
  };
  const { lines, points, stems } = env.parts();
  const built = env.built();
  assert.deepEqual(shown(), [true, true, true]);
  assert.equal(env.layer.getStats().count, 2);

  // Any fetch after this point is a bug: nothing is loaded twice.
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error('unexpected refetch');
  };
  try {
    env.layer.disable();
    assert.deepEqual(
      shown(),
      [false, false],
      'a hidden primitive is skipped by the scene: disable hides, it does not free',
    );
    assert.equal(env.parts().lines, lines);
    assert.equal(env.parts().points, points);
    // Stems are sized for the view; kept ones would show stale on enable.
    assert.equal(stems[0].isDestroyed(), true, 'only the stems are dropped');
    env.raiseSweep();
    assert.deepEqual(shown(), [false, false], 'a frame while off');
    assert.equal(env.built(), built, 'and builds nothing');

    env.layer.enable(env.viewer);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(shown(), [true, true]);
    env.raiseSweep();
    assert.equal(fetches, 0, 're-enable must not touch the network');
    assert.equal(env.layer.getStats().error, null);
    assert.equal(env.parts().lines, lines, 'the very same lines');
    assert.equal(env.parts().points, points, 'and reference tips');
    assert.equal(env.built(), built + 1, 'only the stems are redrawn');
    assert.equal(env.parts().stems.length, 1);
    assert.equal(env.layer.getStats().count, 2);

    env.layer.destroy(env.viewer);
    assert.equal(env.size(), 0);
    assert.ok(lines.isDestroyed() && points.isDestroyed());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('another GeoJSON source renders with its own label and is read once', async () => {
  let reads = 0;
  const source = {
    label: 'Test cable directory',
    async fetch(signal) {
      signal.throwIfAborted();
      reads += 1;
      return { cables: CABLE_FIXTURE, landingPoints: LANDING_FIXTURE };
    },
  };
  const env = await createRealCableLayerHarness({ source });
  try {
    assert.equal(env.layer.source, source.label);
    assert.equal(reads, 1);
    assert.equal(env.size(), LOADED_PRIMITIVES);
    env.layer.disable();
    env.layer.enable(env.viewer);
    for (let i = 0; i < 8; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(env.layer.getStats().count, 2);
    assert.equal(env.size(), LOADED_PRIMITIVES);
    assert.equal(reads, 1);
  } finally {
    env.layer.destroy(env.viewer);
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

function geometrySource(cables, landingPoints = []) {
  return {
    label: 'Multipart test source',
    async fetch() {
      return {
        cables: { type: 'FeatureCollection', features: cables },
        landingPoints: { type: 'FeatureCollection', features: landingPoints },
      };
    },
  };
}

const lineLabels = (env) =>
  env.parts().lines.geometryInstances.map((instance) => instance.id.label);
const referenceIds = (env) => {
  const { points } = env.parts();
  return Array.from(
    { length: points.length },
    (_, i) => points.get(i).id.featureId,
  );
};

test('multipart association accepts frozen provider collections without modifying properties', async () => {
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
  const env = await createRealCableLayerHarness({
    source: { label: 'Frozen multipart source', fetch: async () => payload },
  });
  try {
    const part = ['Alpha cable', 'Alpha cable', 'Alpha cable', 'Beta cable'];
    assert.deepEqual(lineLabels(env), [...part, ...part]);
    assert.deepEqual(
      env.parts().lines.geometryInstances.map((instance) => instance.id.kind),
      [...Array(4).fill('cable'), ...Array(4).fill('landing-point')],
    );
    assert.equal(env.parts().points.length, 4);
    assert.deepEqual(payload, before);
  } finally {
    env.layer.destroy(env.viewer);
  }
});

test('multipart cables retain their own styling, picking and culling on every segment', async () => {
  const features = multipartCableFixture();
  const before = JSON.stringify(features);
  const env = await createRealCableLayerHarness({
    source: geometrySource(features),
  });
  try {
    const { lines } = env.parts();
    const instances = lines.geometryInstances;
    assert.equal(instances.length, 4);
    assert.equal(new Set(instances.map((instance) => instance.id)).size, 4);
    for (const [index, instance] of instances.entries()) {
      const feature = features[index < 3 ? 0 : 1];
      const info = instance.id;
      assert.equal(info.label, feature.properties.name);
      assert.equal(info.kind, 'cable');
      assert.deepEqual(info.reference, {
        lon: feature.properties.coordinates[0],
        lat: feature.properties.coordinates[1],
      });
      assert.deepEqual(
        [...instance.attributes.color.value],
        Cesium.Color.fromCssColorString(feature.properties.color)
          .withAlpha(0.92)
          .toBytes(),
      );
      assert.ok(instance.geometry instanceof Cesium.GroundPolylineGeometry);
      assert.equal(instance.geometry.width, 2.5);
      assert.equal(instance.geometry.arcType, Cesium.ArcType.RHUMB);
      // A float attribute beside the width keeps 2.5 px from being stored as
      // a byte (2 px): the entity display's lines carried this one too.
      assert.equal(
        instance.attributes.distanceDisplayCondition.componentDatatype,
        Cesium.ComponentDatatype.FLOAT,
      );
    }

    // Picking: a click on any segment flies to its cable's reference.
    for (const instance of instances) {
      env.viewer.scene.pick = () => ({ primitive: lines, id: instance.id });
      env.click();
      const flight = env.viewer.flights.at(-1);
      assert.ok(
        Cesium.Cartesian3.equalsEpsilon(
          flight.destination,
          Cesium.Cartesian3.fromDegrees(
            instance.id.reference.lon,
            instance.id.reference.lat,
            6500,
          ),
          1e-9,
        ),
      );
    }
    const flights = env.viewer.flights.length;
    assert.equal(flights, 4);
    // A pick that is not one of the layer's own records is not acted on,
    // whatever it looks like.
    env.viewer.scene.pick = () => ({
      id: { kind: 'cable', reference: { lon: 1, lat: 2 }, label: 'Foreign' },
    });
    env.click();
    env.viewer.scene.pick = () => null;
    env.click();
    assert.equal(env.viewer.flights.length, flights);

    // Culling: each segment follows its cable's reference over the horizon.
    // The show flags are written once the line geometry is ready.
    env.raiseSweep();
    const shows = fakeLineAttributes(lines);
    assert.deepEqual(shows(), [true, true, true, true], 'not written yet');
    env.raiseSweep();
    assert.deepEqual(shows(), [true, true, true, false]);
    env.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
      140,
      -35,
      4_500_000,
    );
    for (const fn of env.listeners.moveEnd) fn();
    env.raiseSweep();
    assert.deepEqual(shows(), [false, false, false, true]);

    assert.equal(env.parts().points.length, 2, 'one reference per feature');
    assert.equal(
      JSON.stringify(features),
      before,
      'source features stay unchanged',
    );
  } finally {
    env.layer.destroy(env.viewer);
  }
});

test('multipart association supports missing and repeated IDs', async () => {
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
  const env = await createRealCableLayerHarness({
    source: geometrySource(features),
  });
  try {
    assert.deepEqual(lineLabels(env), [
      'Alpha cable',
      'Alpha cable',
      'Alpha cable',
      'Beta cable',
      'Generated cable',
      'Repeated ID cable',
    ]);
    assert.deepEqual(referenceIds(env), [
      'alpha',
      'alpha_2',
      'cable-2',
      'alpha',
    ]);
  } finally {
    env.layer.destroy(env.viewer);
  }
});

test('multipart landing geometry keeps every pick with one reference per feature', async () => {
  const features = multipartCableFixture();
  const env = await createRealCableLayerHarness({
    source: geometrySource([], features),
  });
  try {
    const instances = env.parts().lines.geometryInstances;
    assert.deepEqual(lineLabels(env), [
      'Alpha cable',
      'Alpha cable',
      'Alpha cable',
      'Beta cable',
    ]);
    assert.ok(
      instances.every((instance) => instance.id.kind === 'landing-point'),
    );
    // Landing lines keep the GeoJSON stroke: the landing colour, 2 px.
    assert.ok(instances.every((instance) => instance.geometry.width === 2));
    assert.equal(env.parts().points.length, 2);
  } finally {
    env.layer.destroy(env.viewer);
  }
});

test('every geometry type a feature can carry is drawn as lines and markers', () => {
  const feature = (geometry) => ({ type: 'Feature', geometry });
  assert.deepEqual(
    featureParts(feature({ type: 'Point', coordinates: [1, 2] })),
    { lines: [], points: [[1, 2]] },
  );
  assert.deepEqual(
    featureParts(
      feature({
        type: 'MultiPoint',
        coordinates: [
          [1, 2, 30],
          ['x', 2],
          [3, 4],
        ],
      }),
    ),
    {
      lines: [],
      points: [
        [1, 2, 30],
        [3, 4],
      ],
    },
    'a height is kept; a position that is not numbers is skipped',
  );
  const line = [
    [0, 0],
    [1, 1],
  ];
  assert.deepEqual(
    featureParts(feature({ type: 'LineString', coordinates: line })),
    { lines: [line], points: [] },
  );
  assert.deepEqual(
    featureParts(
      feature({ type: 'MultiLineString', coordinates: [line, [[5, 5]], line] }),
    ),
    { lines: [line, line], points: [] },
    'a part with fewer than two positions is not a line',
  );
  assert.deepEqual(
    featureParts(
      feature({
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [9, 9] },
          { type: 'LineString', coordinates: line },
          {
            type: 'Polygon',
            coordinates: [[...line, [1, 0], [0, 0]]],
          },
        ],
      }),
    ),
    { lines: [line], points: [[9, 9]] },
    'polygons are not drawn',
  );
  assert.deepEqual(featureParts(null), { lines: [], points: [] });
  assert.deepEqual(featureParts(feature(null)), { lines: [], points: [] });
});

test('every bundled cable segment is associated with its source feature', async () => {
  const { features } = JSON.parse(
    readFileSync(
      new URL(
        './local_data/telegeography_submarine_cables/cable-geo.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  // Some bundled features share a cable ID but have different references.
  const expandedFeatures = features.flatMap((feature) =>
    feature.geometry.coordinates.map(() => feature),
  );
  assert.ok(expandedFeatures.length > features.length);
  const env = await createRealCableLayerHarness({
    source: geometrySource(features),
  });
  try {
    const instances = env.parts().lines.geometryInstances;
    assert.equal(instances.length, expandedFeatures.length);
    for (const [index, instance] of instances.entries()) {
      const feature = expandedFeatures[index];
      assert.equal(instance.id.label, feature.properties.name);
      assert.deepEqual(instance.id.reference, {
        lon: feature.properties.coordinates[0],
        lat: feature.properties.coordinates[1],
      });
    }
    assert.equal(env.parts().points.length, features.length);
    assert.equal(env.built(), LOADED_PRIMITIVES, 'in two primitives');
  } finally {
    env.layer.destroy(env.viewer);
  }
});

test('the bundled landing points are one billboard collection of small pins', async () => {
  const { features } = JSON.parse(
    readFileSync(
      new URL(
        './local_data/telegeography_submarine_cables/landing-point-geo.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const env = await createRealCableLayerHarness({
    source: geometrySource([], features),
  });
  try {
    const { markers, points } = env.parts();
    assert.equal(markers.length, features.length);
    assert.equal(points.length, features.length);
    assert.deepEqual(
      env.markerImages,
      [{ width: 6, height: 6, color: '#8fffd2' }],
      'one image for every landing marker, in the landing colour',
    );
    for (let i = 0; i < markers.length; i += 97) {
      const marker = markers.get(i);
      assert.equal(marker.id.kind, 'landing-point');
      assert.equal(marker.id.label, features[i].properties.name);
      assert.equal(marker.verticalOrigin, Cesium.VerticalOrigin.BOTTOM);
      assert.equal(
        marker.disableDepthTestDistance,
        undefined,
        'depth tested, as the entity display left it',
      );
      assert.equal(marker.show, false, 'hidden until it is on the ground');
    }
    assert.equal(env.viewer.scene.heights.reads, 0, 'no height read at load');
  } finally {
    env.layer.destroy(env.viewer);
  }
});

test('landing markers are put on the ground a few per frame, once each', async () => {
  const count = CABLE_LANDING_REVEALS_PER_FRAME * 2 + 10;
  const env = await createRealCableLayerHarness({
    source: geometrySource([], landingPointFixture(count)),
  });
  try {
    let renderRequests = 0;
    env.viewer.scene.requestRender = () => {
      renderRequests++;
    };
    const { heights } = env.viewer.scene;
    const { markers } = env.parts();
    const all = Array.from({ length: markers.length }, (_, i) =>
      markers.get(i),
    );
    const shown = () => all.filter((marker) => marker.show).length;
    const clamped = () =>
      all.filter(
        (marker) =>
          marker.heightReference === Cesium.HeightReference.CLAMP_TO_GROUND,
      ).length;
    assert.equal(all.length, count);
    assert.equal(shown(), 0, 'nothing is shown before the first sweep');
    assert.equal(heights.reads, 0, 'and no terrain height has been read');

    env.raiseSweep();
    assert.equal(shown(), CABLE_LANDING_REVEALS_PER_FRAME);
    assert.equal(heights.reads, CABLE_LANDING_REVEALS_PER_FRAME);
    assert.ok(renderRequests > 0, 'another frame is asked for');
    env.raiseSweep();
    assert.equal(shown(), CABLE_LANDING_REVEALS_PER_FRAME * 2);
    assert.equal(heights.reads, CABLE_LANDING_REVEALS_PER_FRAME * 2);
    env.raiseSweep();
    assert.equal(shown(), count, 'every visible marker ends up shown');
    assert.equal(clamped(), count, 'on the ground');
    assert.equal(heights.reads, count, 'one height read per marker');
    assert.equal(
      heights.watches,
      count,
      'Cesium follows the terrain from here',
    );

    // Markers over the horizon are hidden at once...
    env.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
      140,
      -35,
      4_500_000,
    );
    for (const fn of env.listeners.moveEnd) fn();
    env.raiseSweep();
    assert.equal(shown(), 0);

    // ...and back in view they all show in the same frame: a marker is put
    // on the ground once, so showing it again reads nothing.
    env.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
      -40,
      35,
      4_500_000,
    );
    for (const fn of env.listeners.moveEnd) fn();
    env.raiseSweep();
    assert.equal(shown(), count);

    // So does a disable and enable.
    env.layer.disable();
    assert.equal(markers.show, false);
    env.layer.enable(env.viewer);
    await new Promise((resolve) => setTimeout(resolve, 10));
    env.raiseSweep();
    assert.equal(markers.show, true);
    assert.equal(shown(), count);
    assert.equal(heights.reads, count, 'no marker was read twice');
    assert.equal(heights.watches, count);
    assert.equal(env.parts().markers, markers, 'the same collection');
  } finally {
    env.layer.destroy(env.viewer);
  }
});
