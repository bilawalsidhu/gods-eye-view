import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { MAP_STACKS } from '../mapStackController.js';
import { fromDegrees, toLonLatH } from '../geo/ellipsoid.js';
import { bindRenderer } from '../render/rendererOf.js';
// A viewer with no renderer bound reads its globe through the unbound port.
import '../render/cesium/globe.js';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import { fakeCameraPort } from '../testSupport/fakeCameraPort.mjs';
import { fakeSceneFrame } from '../testSupport/fakeCesiumScene.mjs';
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
  const tip = fromDegrees(-40, 35, 2500);
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
    'point/stem/line picking stays with the renderer',
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

test('cable ground lines drape on exactly the active surface on every stack', () => {
  // Photorealistic tiles render with the globe hidden — the tiles only.
  assert.equal(cableClassificationTypeForStack('photoreal'), 'tiles');
  // Every globe stack renders imagery on the shown globe — terrain only.
  for (const stackId of ['bing-aerial', 'bing-labels', 'esri-imagery', 'osm']) {
    assert.equal(
      cableClassificationTypeForStack(stackId),
      'terrain',
      `${stackId} must drape on terrain so cables stay visible there`,
    );
  }
  // Unknown stack → both: visible on every surface, the shipped fallback.
  // A TRUTHY unknown id must reach it too — "not photoreal" is not the same
  // claim as "renders on the globe", and asserting terrain for an id this
  // module has never heard of would hide the cables on a future 3D-tile
  // stack instead of degrading to the documented safe behavior.
  for (const id of ['some-future-stack', 'photoreal-v2', '', undefined, null])
    assert.equal(cableClassificationTypeForStack(id), 'both');

  // Every id that actually ships must be a KNOWN id: a stack added to
  // MAP_STACKS without a mapping here silently loses its halved command set,
  // so the omission fails loudly instead of degrading quietly.
  for (const stack of MAP_STACKS) {
    assert.notEqual(
      cableClassificationTypeForStack(stack.id),
      'both',
      `MAP_STACKS id '${stack.id}' has no cable surface mapping`,
    );
  }

  // Boot fires no stack event; the initial value derives from live scene
  // state exactly like the height-datum listeners: photoreal ⇔ globe hidden.
  let globeShown = false;
  const host = {};
  const unbind = bindRenderer(host, {
    globe: { isGlobeVisible: () => globeShown },
  });
  assert.equal(cableClassificationTypeForScene(host), 'tiles');
  globeShown = true;
  assert.equal(cableClassificationTypeForScene(host), 'terrain');
  unbind();
  assert.equal(cableClassificationTypeForScene(null), 'both');
  // A scene that cannot say whether the globe is shown: every surface.
  const other = {};
  const unbindOther = bindRenderer(other, { globe: {} });
  assert.equal(cableClassificationTypeForScene(other), 'both');
  unbindOther();
  // A viewer of its own with no renderer bound reads its globe through the
  // unbound port; with no globe it gives no reading.
  assert.equal(
    cableClassificationTypeForScene({ scene: { globe: { show: false } } }),
    'tiles',
  );
  assert.equal(
    cableClassificationTypeForScene({ scene: { globe: { show: true } } }),
    'terrain',
  );
  assert.equal(cableClassificationTypeForScene({ scene: {} }), 'both');
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

test('stems re-size only on real tip changes, moving the tip in place', () => {
  const lon = -40;
  const lat = 35;
  const tip = fromDegrees(lon, lat, 2500);
  const record = {
    base: fromDegrees(lon, lat, 0),
    tip,
    reference: { lon, lat },
  };
  const canvasHeight = 900;
  const fov = Math.PI / 3;
  const camera = Cesium.Cartesian3.fromDegrees(-40, 35, 500_000);

  assert.equal(
    updateCableReferenceStem(record, camera, canvasHeight, fov),
    true,
  );
  assert.equal(record.tip, tip, 'the overlay entry keeps its anchor object');
  const sized = { ...record.tip };

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
  assert.deepEqual({ ...record.tip }, sized);

  const moved = Cesium.Cartesian3.add(
    camera,
    new Cesium.Cartesian3(0, 0, 400_000),
    new Cesium.Cartesian3(),
  );
  assert.equal(
    updateCableReferenceStem(record, moved, canvasHeight, fov),
    true,
  );
  assert.notDeepEqual({ ...record.tip }, sized);

  // Stem height honors the shipped 700 m..85 km clamp.
  const { height } = toLonLatH(record.tip);
  assert.ok(height >= 700 && height <= 85_000);
});

test('the depth decision is the dated Option-2 host migration, superseding Option 1', () => {
  assert.deepEqual(CABLE_LABEL_DEPTH_DECISION, {
    option: 2,
    decidedAt: '2026-08-18',
    supersedes: '2026-08-02',
    depthTested: false,
  });
});

test('cables create no native labels and reach no renderer but through its ports', () => {
  const files = [
    'rendering.js',
    'overlay.js',
    'surface.js',
    'ingestion.js',
    'interaction.js',
    'geometry.js',
    'lifecycle.js',
    'policy.js',
    'state.js',
    'pin.js',
  ];
  for (const file of files) {
    const code = readFileSync(
      new URL('../layers/submarineCables/' + file, import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(code, /from 'cesium'/, `${file} imports no Cesium`);
    assert.doesNotMatch(code, /render\/cesium\//, `${file} skips the adapter`);
  }
  assert.match(
    readFileSync(
      new URL('../app/layers/overlayHost.js', import.meta.url),
      'utf8',
    ),
    /setOverlayEntries/,
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

const abortError = () =>
  Object.assign(new Error('The operation was aborted'), {
    name: 'AbortError',
  });

/**
 * A source whose fetches stay PENDING until the test releases them, honoring
 * the abort signal like real fetch (reject with AbortError on abort). Load
 * lifecycle races are sequenced deterministically through it.
 */
function deferredSource(payload = {}) {
  const pending = [];
  return {
    pending,
    source: {
      label: 'TeleGeography',
      fetch(signal) {
        return new Promise((resolve, reject) => {
          const entry = {
            settled: false,
            release() {
              if (entry.settled) return;
              entry.settled = true;
              resolve({
                cables: payload.cables ?? CABLE_FIXTURE,
                landingPoints: payload.landingPoints ?? LANDING_FIXTURE,
              });
            },
          };
          if (signal?.aborted) {
            entry.settled = true;
            reject(abortError());
            return;
          }
          signal?.addEventListener(
            'abort',
            () => {
              if (entry.settled) return;
              entry.settled = true;
              reject(abortError());
            },
            { once: true },
          );
          pending.push(entry);
        });
      },
    },
    releaseAll() {
      for (const entry of pending.splice(0)) entry.release();
    },
  };
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

const settle = async () => {
  for (let i = 0; i < 8; i++)
    await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * A cable layer on a viewer double with a fake draw port and camera port
 * bound, as the application binds its renderer. Not loaded until a test
 * enables it (`load()` enables and waits).
 */
function createCableHarness({
  source = deferredSource().source,
  mapStackEventTarget = null,
} = {}) {
  const hostCalls = [];
  // The sweep gate's motion-fallback clock is FROZEN here and advanced only by
  // the tests that exercise it, so every other harness test observes the pure
  // event-dirty behavior with no wall-clock coupling.
  let clockMs = 0;
  let clickHandler = null;
  const layer = createTeleGeographySubmarineCableLayer({
    overlayHost: {
      setVisible: (...args) => hostCalls.push(['visible', ...args]),
      setEntries: (...args) => hostCalls.push(['entries', ...args]),
      clearSource: (...args) => hostCalls.push(['clear', ...args]),
    },
    inputFor: () => ({
      onClick: (fn) => {
        clickHandler = fn;
        return () => {
          if (clickHandler === fn) clickHandler = null;
        };
      },
    }),
    source,
    mapStackEventTarget,
    sweepClock: () => clockMs,
  });
  const preRender = new Set();
  const viewer = {
    scene: {
      canvas: { clientHeight: 900 },
      requestRender() {},
      preRender: {
        addEventListener: (fn) => {
          preRender.add(fn);
          return () => preRender.delete(fn);
        },
      },
    },
  };
  const camera = fakeCameraPort({
    pose: {
      position: fromDegrees(-40, 35, 4_500_000),
      fovy: Math.PI / 3,
      aspectRatio: 1,
      heading: 0.25,
    },
  });
  const flights = [];
  camera.port.cancelFlight = () => flights.push('cancel');
  camera.port.flyTo = (destination, options) =>
    flights.push({ destination, options });
  const { draw } = bindFakeDraw(viewer, {
    camera: camera.port,
    frame: fakeSceneFrame(viewer),
  });
  layer.init(viewer);
  /** The layer's live set named `name` (`lines`, `pins`, …). */
  const set = (name) =>
    [...draw.sets.values()].find(
      (record) => !record.disposed && record.spec.id.endsWith(`:${name}`),
    );
  return {
    layer,
    viewer,
    draw,
    set,
    hostCalls,
    flights,
    setEye(lon, lat, height) {
      camera.setPose({ position: fromDegrees(lon, lat, height) });
    },
    moveEnd: () => camera.emit('moveEnd'),
    raiseSweep() {
      for (const fn of preRender) fn();
    },
    advanceClock(ms) {
      clockMs += ms;
    },
    click(drawHit) {
      clickHandler?.({ drawHit, pick: null });
    },
    async load() {
      layer.enable(viewer);
      source.releaseAll?.();
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const stats = layer.getStats();
        if (stats.count > 0 || stats.error) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(layer.getStats().error, null, 'harness load must succeed');
    },
  };
}

/** A loaded harness over the fixtures (or `source`). */
async function loadedHarness(options = {}) {
  const deferred = deferredSource();
  const env = createCableHarness({ source: deferred.source, ...options });
  env.layer.enable(env.viewer);
  deferred.releaseAll();
  await settle();
  assert.equal(env.layer.getStats().error, null, 'harness load must succeed');
  return env;
}

test('a real enabled cable layer draws its sets, publishes host entries and has zero native labels', async () => {
  const env = await loadedHarness();
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
  assert.equal(env.layer.getStats().referenceLabelCount, 2);

  // Each set id is the layer's own, and nothing draws text.
  const ids = [...env.draw.sets.keys()];
  assert.deepEqual(
    ids.map((id) => id.replace(/^submarine-cables:\d+:/, '')),
    ['lines', 'fills', 'pins', 'stems', 'references'],
  );
  assert.equal(env.set('lines').items.size, 1);
  assert.equal(env.set('pins').items.size, 1);
  assert.equal(env.set('stems').items.size, 2);
  assert.equal(env.set('references').items.size, 2);
  assert.ok(ids.every((id) => env.draw.set(id).show));

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
  assert.ok(
    ids.every((id) => env.draw.set(id).items.size === 0),
    'hidden items are not free; disable must clear the sets',
  );

  env.layer.destroy();
  assert.ok(
    ids.every((id) => env.draw.sets.get(id).disposed),
    'destroy must dispose every set',
  );
});

test('cables, landing pins and references draw as their entities did', async () => {
  const env = await loadedHarness();
  assert.deepEqual(env.set('lines').spec.clampTo, 'both');
  assert.equal(env.set('pins').spec.blend, 'translucent');
  assert.equal(env.set('pins').spec.horizonCull, true);
  assert.equal(env.set('references').spec.blend, 'translucent');

  const [line] = env.set('lines').items.values();
  assert.equal(line.mode, 'draped');
  assert.equal(line.widthPx, 2.5);
  assert.deepEqual(line.style, {
    kind: 'solid',
    color: [0x39 / 255, 0xd5 / 255, 1, 0.92],
  });
  assert.equal(line.clampTo, undefined, 'cable lines follow the stack');
  // Along the rhumb line, as GeoJSON lines were, in steps under 10 km.
  const ends = [line.positions[0], line.positions.at(-1)].map(toLonLatH);
  assert.ok(
    Math.abs(ends[0].lon + 40) < 1e-9 && Math.abs(ends[0].lat - 35) < 1e-9,
  );
  assert.ok(
    Math.abs(ends[1].lon + 30) < 1e-9 && Math.abs(ends[1].lat - 40) < 1e-9,
  );
  assert.ok(line.positions.length > 100);
  const rhumb = new Cesium.EllipsoidRhumbLine(
    Cesium.Cartographic.fromDegrees(-40, 35),
    Cesium.Cartographic.fromDegrees(-30, 40),
  );
  const middle = toLonLatH(
    line.positions[Math.floor(line.positions.length / 2)],
  );
  const along = rhumb.findIntersectionWithLongitude(
    Cesium.Math.toRadians(middle.lon),
  );
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(along.latitude) - middle.lat) < 1e-6,
  );

  const [pin] = env.set('pins').items.values();
  assert.deepEqual(pin.pos, { lon: -9.1, lat: 38.7, height: 0 });
  assert.equal(pin.height, 'clampGround');
  assert.deepEqual(pin.size, [6, 6]);
  assert.equal(pin.anchor, 'bottom');
  assert.ok(pin.image.svg?.includes('fill="rgb(143,255,210)"'));

  const [cableStem, landingStem] = env.set('stems').items.values();
  assert.equal(cableStem.mode, '3d');
  assert.equal(cableStem.widthPx, 2);
  assert.equal(landingStem.widthPx, 2.4);
  assert.equal(cableStem.style.color[3], 0.58);
  assert.equal(landingStem.style.color[3], 0.68);
  const [cablePoint, landingPoint] = env.set('references').items.values();
  assert.equal(cablePoint.pixelSize, 7);
  assert.equal(landingPoint.pixelSize, 8);
  assert.equal(cablePoint.color[3], 0.84);
  assert.equal(landingPoint.color[3], 0.94);
  assert.deepEqual(cablePoint.outlineColor, [0, 0, 0, 0.65]);
  assert.equal(cablePoint.outlineWidth, 1);
  assert.equal(cablePoint.disableDepthTest, undefined, 'depth-tested');
  env.layer.destroy();
});

test('a map-stack change re-drapes the cable lines once, and destroy detaches the listener', async () => {
  const listeners = new Map();
  const eventTarget = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => {
      if (listeners.get(name) === fn) listeners.delete(name);
    },
  };
  const env = await loadedHarness({ mapStackEventTarget: eventTarget });
  // The harness scene has no globe → both at init (safe unknown fallback).
  assert.equal(env.set('lines').spec.clampTo, 'both');
  const listener = listeners.get('gev:map-stack-changed');
  assert.equal(typeof listener, 'function', 'init must subscribe');

  listener({ detail: { activeId: 'photoreal', status: 'ready' } });
  assert.equal(env.set('lines').spec.clampTo, 'tiles');
  listener({ detail: { activeId: 'osm', status: 'ready' } });
  assert.equal(env.set('lines').spec.clampTo, 'terrain');
  assert.equal(env.set('fills').spec.clampTo, 'both', 'fills never followed');

  env.layer.destroy();
  assert.equal(
    listeners.has('gev:map-stack-changed'),
    false,
    'destroy must detach the stack listener',
  );
});

test('a click on a cable, pin, stem or reference flies to its reference; others do nothing', async () => {
  const env = await loadedHarness();
  const [lineId] = env.set('lines').items.keys();
  const [pinId] = env.set('pins').items.keys();
  const [cableRef, landingRef] = env.set('references').items.keys();
  const flyTargets = () =>
    env.flights
      .filter((flight) => flight !== 'cancel')
      .map((flight) => flight.destination);

  env.click({ set: env.set('lines').spec.id, id: lineId });
  env.click({ set: env.set('pins').spec.id, id: pinId });
  env.click({ set: env.set('stems').spec.id, id: cableRef });
  env.click({ set: env.set('references').spec.id, id: landingRef });
  assert.deepEqual(flyTargets(), [
    { lon: -35, lat: 37.5, height: 6500 },
    { lon: -9.1, lat: 38.7, height: 6500 },
    { lon: -35, lat: 37.5, height: 6500 },
    { lon: -9.1, lat: 38.7, height: 6500 },
  ]);
  const flight = env.flights.find((entry) => entry !== 'cancel');
  assert.deepEqual(flight.options, {
    orientation: { heading: 0.25, pitch: (-52 * Math.PI) / 180, roll: 0 },
    durationS: 1.35,
    easing: 'cubicInOut',
  });
  assert.equal(env.flights[0], 'cancel', 'a running flight is cancelled');

  env.flights.length = 0;
  env.click({ set: 'other-layer:lines', id: lineId });
  env.click({ set: env.set('lines').spec.id, id: 'gone' });
  env.click(null);
  env.layer.disable();
  env.click({ set: env.set('lines').spec.id, id: lineId });
  assert.deepEqual(env.flights, [], 'foreign, stale and disabled clicks');
  env.layer.destroy();
});

test('stems never redraw mid-drag; exactly one redraw lands on moveEnd', async () => {
  const env = await loadedHarness();
  env.raiseSweep(); // initial sizing at the parked camera
  const stems = env.set('stems');
  const before = stems.writes;

  // Mid-drag: the camera moves every tick and frames keep rendering, but no
  // moveEnd fires. However long this goes on, the stems must never be
  // redrawn — each redraw rebuilt the stems, and its frames were the hitch.
  for (let tick = 0; tick < 30; tick++) {
    env.setEye(-40, 35, 4_500_000 + 100_000 * (tick + 1));
    env.raiseSweep();
  }
  assert.equal(
    stems.writes,
    before,
    'render ticks without moveEnd never redraw',
  );

  // The gesture ends close over the cable's reference point (inside the
  // 700 m..85 km stem clamp band, so the re-size is a real tip change):
  // one moveEnd, one sweep, exactly one redraw.
  env.setEye(-35, 37.5, 400_000);
  env.moveEnd();
  env.raiseSweep();
  assert.equal(stems.writes, before + 1, 'moveEnd re-sizes the stems once');
  env.raiseSweep();
  assert.equal(stems.writes, before + 1, 'the next frame does not re-run');
  env.layer.destroy();
});

test('a tracked camera that never emits moveEnd is swept by the motion fallback', async () => {
  const env = await loadedHarness();
  // 400 km keeps the stem inside the 700 m..85 km clamp band, so a sweep is
  // observable as a real tip re-size.
  env.setEye(-35, 37.5, 400_000);
  env.raiseSweep(); // initial sizing at the tracking handoff
  const stems = env.set('stems');
  const before = stems.writes;
  const frameMs = 1000 / 60;
  const trackFrames = (from, to) => {
    for (let frame = from; frame < to; frame++) {
      env.advanceClock(frameMs);
      env.setEye(-35, 37.5, 400_000 + 200 * (frame + 1));
      env.raiseSweep();
    }
  };
  trackFrames(0, 60);
  assert.equal(
    stems.writes,
    before,
    'inside the probe window a tracked camera still costs no redraws',
  );
  trackFrames(60, 130);
  assert.equal(
    stems.writes,
    before + 1,
    'the tracked camera earns exactly one fallback sweep per window',
  );
  const parkFrames = (count) => {
    for (let frame = 0; frame < count; frame++) {
      env.advanceClock(frameMs);
      env.raiseSweep();
    }
  };
  parkFrames(240);
  assert.equal(
    stems.writes,
    before + 2,
    'a stopped camera settles its residual motion in one further sweep',
  );
  parkFrames(3600);
  assert.equal(stems.writes, before + 2, 'then a parked camera costs nothing');
  env.layer.destroy();
});

test('an unchanged cohort never republishes, so a parked camera stays governor-idle', async () => {
  const env = await loadedHarness();
  const publishCount = () =>
    env.hostCalls.filter(([type]) => type === 'entries').length;

  env.raiseSweep();
  assert.equal(publishCount(), 1, 'first sweep publishes the cohort');
  env.moveEnd();
  env.raiseSweep();
  env.moveEnd();
  env.raiseSweep();
  assert.equal(publishCount(), 1, 'identical cohorts are skipped');

  env.setEye(-40, 35, 6_500_000);
  env.moveEnd();
  env.raiseSweep();
  assert.equal(publishCount(), 2, 'a changed cohort publishes');

  env.layer.disable();
  env.layer.enable(env.viewer);
  await settle();
  env.raiseSweep();
  assert.equal(
    publishCount(),
    3,
    're-enable republishes after the hide cleared the source',
  );
  env.layer.destroy();
});

test('a toggle-off clears every set and a toggle-on redraws them without refetching', async () => {
  let reads = 0;
  const [cable] = CABLE_FIXTURE.features;
  const secondPiece = {
    ...cable,
    geometry: {
      type: 'GeometryCollection',
      geometries: [
        {
          type: 'LineString',
          coordinates: [
            [-30, 40],
            [-12, 39],
          ],
        },
      ],
    },
  };
  const collected = {
    ...secondPiece,
    properties: { id: 'reference-less', name: 'Reference-less cable' },
  };
  const source = {
    label: 'Test cable directory',
    async fetch(signal) {
      signal.throwIfAborted();
      reads += 1;
      return {
        cables: { ...CABLE_FIXTURE, features: [cable, secondPiece, collected] },
        landingPoints: LANDING_FIXTURE,
      };
    },
  };
  const env = createCableHarness({ source });
  await env.load();
  assert.equal(env.layer.source, source.label);
  assert.equal(reads, 1);
  const before = env.layer.getStats().count;
  assert.equal(before, 3);
  const records = new Map(
    env.layer.getAnalystRecords().map((record) => [record.id, record]),
  );
  assert.ok(
    records
      .get('cable:ac1')
      .parts.some(({ lon, lat }) => lon === -12 && lat === 39),
  );
  assert.ok(records.has('cable:reference-less'));
  env.layer.disable();
  assert.equal(env.set('lines').items.size, 0);
  env.layer.enable(env.viewer);
  await settle();
  assert.equal(reads, 1, 'the redraw must not touch the network');
  assert.equal(env.layer.getStats().count, before);
  assert.equal(env.set('lines').items.size, 3, 'all pieces are redrawn');
  assert.equal(env.set('references').items.size, 2, 'references are redrawn');
  env.layer.destroy();
});

test('an abort landing at the post-fetch boundary stops the stale load before it draws', async () => {
  const deferred = deferredSource();
  const env = createCableHarness({ source: deferred.source });
  try {
    env.layer.enable(env.viewer);
    // Release A's fetches and abort in the SAME frame: A's continuation runs
    // with ownership already lost, and the post-fetch owns() check is the guard.
    deferred.releaseAll();
    env.layer.disable();
    env.layer.enable(env.viewer);
    const writes = env.set('lines').writes;
    await settle();
    assert.equal(env.set('lines').writes, writes, 'stale load A must not draw');
    assert.equal(env.set('lines').items.size, 0);
    deferred.releaseAll();
    await settle();
    assert.equal(env.set('lines').writes, writes + 1, 'load B alone draws');
    assert.equal(env.set('lines').items.size, 1);
    assert.equal(env.layer.getStats().count, 2);
  } finally {
    env.layer.destroy();
  }
});

test('a direct destroy of a published layer clears and hides its host source', async () => {
  const env = await loadedHarness();
  env.raiseSweep();
  assert.ok(env.hostCalls.some(([type]) => type === 'entries'));
  env.hostCalls.length = 0;
  // Destroy DIRECTLY — no disable() first. The publisher teardown must
  // still clear the published source and hide it; skipping it would leave
  // a visible overlay source with orphan labels.
  env.layer.destroy();
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
});

test("a stale aborted load never clobbers the next load's lifecycle (A/B/C toggle race)", async () => {
  const deferred = deferredSource();
  const env = createCableHarness({ source: deferred.source });
  try {
    env.layer.enable(env.viewer);
    assert.equal(deferred.pending.length, 1, 'load A is in flight');
    // Abort A and immediately start B before A's rejection lands.
    env.layer.disable();
    env.layer.enable(env.viewer);
    const writes = env.set('lines').writes;
    await settle(); // A's stale catch/finally runs here, after B began.
    // C: the layer still reports a load in flight, so update() must not
    // start a third load.
    void env.layer.update(env.viewer);
    await settle();
    assert.equal(
      deferred.pending.filter((entry) => !entry.settled).length,
      1,
      "only load B's fetch remains in flight — no duplicate load C",
    );
    deferred.releaseAll();
    await settle();
    assert.equal(env.set('lines').writes, writes + 1, 'drawn exactly once');
    assert.equal(env.layer.getStats().error, null);
    assert.equal(env.layer.getStats().count, 2);
  } finally {
    env.layer.destroy();
  }
});

test('destroy mid-load stays clean and a re-enabled layer reloads exactly once', async () => {
  const deferred = deferredSource();
  const env = createCableHarness({ source: deferred.source });
  try {
    env.layer.enable(env.viewer);
    assert.equal(deferred.pending.length, 1);
    const first = env.set('lines');
    env.layer.destroy();
    assert.equal(first.disposed, true);
    const firstWrites = first.writes;
    // Legacy contract: the layer supports re-init after destroy. Enable D
    // before A's aborted rejection lands.
    env.layer.enable(env.viewer);
    await settle();
    void env.layer.update(env.viewer);
    await settle();
    assert.equal(
      deferred.pending.filter((entry) => !entry.settled).length,
      1,
      "only load D's fetch remains in flight",
    );
    deferred.releaseAll();
    await settle();
    assert.equal(first.writes, firstWrites, 'the destroyed load drew nothing');
    assert.equal(env.set('lines').writes, 1, 'the re-enable drew once');
    assert.equal(env.layer.getStats().count, 2);
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

/** What a click on each item of a set names. */
const picksOf = (env, name) =>
  [...env.set(name).items.keys()].map((id) => {
    let info = null;
    const before = env.flights.length;
    env.click({ set: env.set(name).spec.id, id });
    if (env.flights.length > before) info = env.flights.at(-1).destination;
    return info;
  });

test('multipart cables keep their own styling, picking and culling on every segment', async () => {
  const features = multipartCableFixture();
  const before = JSON.stringify(features);
  const env = createCableHarness({ source: geometrySource(features) });
  await env.load();
  const lines = [...env.set('lines').items.values()];
  assert.equal(lines.length, 4);
  for (const [index, line] of lines.entries()) {
    const feature = features[index < 3 ? 0 : 1];
    const hex = Number.parseInt(feature.properties.color.slice(1), 16);
    assert.deepEqual(line.style.color, [
      ((hex >> 16) & 255) / 255,
      ((hex >> 8) & 255) / 255,
      (hex & 255) / 255,
      0.92,
    ]);
    assert.equal(line.widthPx, 2.5);
  }
  assert.deepEqual(picksOf(env, 'lines'), [
    { lon: -40, lat: 35, height: 6500 },
    { lon: -40, lat: 35, height: 6500 },
    { lon: -40, lat: 35, height: 6500 },
    { lon: 140, lat: -35, height: 6500 },
  ]);
  // Culled by the feature's reference: Beta is on the far side.
  assert.deepEqual(
    lines.map((line) => line.show),
    [true, true, true, false],
  );
  env.raiseSweep();
  assert.deepEqual(
    [...env.set('lines').items.values()].map((line) => line.show),
    [true, true, true, false],
  );
  // Turning the globe brings Beta round and sends Alpha away: only the
  // lines that changed are sent.
  env.setEye(140, -35, 4_500_000);
  env.moveEnd();
  const writes = env.set('lines').writes;
  env.raiseSweep();
  assert.equal(env.set('lines').writes, writes + 1);
  assert.deepEqual(
    [...env.set('lines').items.values()].map((line) => line.show),
    [false, false, false, true],
  );
  assert.equal(env.set('references').items.size, 2, 'one per feature');
  assert.equal(JSON.stringify(features), before, 'features stay unchanged');
  env.layer.destroy();
});

test('landing geometry keeps every pick, its GeoJSON styling and one reference per feature', async () => {
  const features = multipartCableFixture();
  features[1].properties.stroke = '#00ff00';
  features[1].properties['stroke-width'] = 4;
  const env = createCableHarness({ source: geometrySource([], features) });
  await env.load();
  const lines = [...env.set('lines').items.values()];
  assert.equal(lines.length, 4);
  assert.ok(lines.every((line) => line.clampTo === 'both'));
  assert.deepEqual(lines[0].style.color, [0x8f / 255, 1, 0xd2 / 255, 0.9]);
  assert.equal(lines[0].widthPx, 2);
  assert.deepEqual(lines[3].style.color, [0, 1, 0, 1]);
  assert.equal(lines[3].widthPx, 4);
  assert.equal(env.set('references').items.size, 2);
  assert.ok(
    [...env.set('references').items.keys()].every((id) =>
      id.startsWith('landing-point-reference-'),
    ),
  );
  env.layer.destroy();
});

test('polygons and reference-less features draw as the GeoJSON loader drew them', async () => {
  const square = (lon, lat, height) =>
    [
      [lon, lat],
      [lon + 1, lat],
      [lon + 1, lat + 1],
      [lon, lat + 1],
      [lon, lat],
    ].map((c) => (height === undefined ? c : [...c, height]));
  const landings = [
    {
      type: 'Feature',
      properties: { id: 'plain', name: 'Plain' },
      geometry: { type: 'Polygon', coordinates: [square(-40, 35)] },
    },
    {
      type: 'Feature',
      properties: { id: 'red', name: 'Red', fill: '#ff0000' },
      geometry: { type: 'Polygon', coordinates: [square(-38, 35)] },
    },
    {
      type: 'Feature',
      properties: { id: 'solid', name: 'Solid', 'fill-opacity': 1 },
      geometry: { type: 'Polygon', coordinates: [square(-36, 35)] },
    },
    {
      type: 'Feature',
      properties: { id: 'raised', name: 'Raised', stroke: '#0000ff' },
      geometry: { type: 'Polygon', coordinates: [square(-34, 35, 500)] },
    },
    {
      type: 'Feature',
      properties: { name: 'Collection' },
      geometry: {
        type: 'GeometryCollection',
        geometries: [
          {
            type: 'LineString',
            coordinates: [
              [-30, 35],
              [-29, 36],
            ],
          },
        ],
      },
    },
  ];
  const env = createCableHarness({ source: geometrySource([], landings) });
  await env.load();
  const fills = [...env.set('fills').items.values()];
  assert.equal(fills.length, 4);
  const landing = [0x8f / 255, 1, 0xd2 / 255];
  // The fill keeps the source's alpha; fill-opacity replaces it.
  assert.deepEqual(fills[0].fill, [...landing, 0.35]);
  assert.deepEqual(fills[1].fill, [1, 0, 0, 0.35]);
  assert.deepEqual(fills[2].fill, [...landing, 1]);
  assert.ok(fills.slice(0, 3).every((fill) => fill.height === 'clampGround'));
  // Heights keep a polygon off the ground, outlined in its stroke.
  assert.equal(fills[3].height, 'absolute');
  assert.equal(fills[3].geometry.perPositionHeight, true);
  assert.equal(fills[3].lit, true);
  assert.deepEqual(fills[3].outline, [0, 0, 1, 1]);
  assert.equal(fills[3].geometry.rings[0].length, 5);
  // A feature with no reference still draws, unpicked and with no reference.
  const lines = [...env.set('lines').items.values()];
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].style.color, [...landing, 0.9]);
  assert.equal(env.set('references').items.size, 4);
  assert.deepEqual(picksOf(env, 'lines'), [null]);
  env.layer.destroy();
});

test('reference ids follow the features, missing and repeated ids included', async () => {
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
  const env = createCableHarness({ source: geometrySource(features) });
  await env.load();
  assert.deepEqual(
    [...env.set('references').items.keys()],
    [
      'cable-reference-0-alpha',
      'cable-reference-1-alpha_2',
      'cable-reference-2-cable-2',
      'cable-reference-3-alpha',
    ],
  );
  assert.equal(env.set('lines').items.size, 6);
  env.layer.destroy();
});

test('every bundled cable segment is drawn with its source feature', async () => {
  const { features } = JSON.parse(
    readFileSync(
      new URL(
        './local_data/telegeography_submarine_cables/cable-geo.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const expandedFeatures = features.flatMap((feature) =>
    feature.geometry.coordinates.map(() => feature),
  );
  assert.ok(expandedFeatures.length > features.length);
  const env = createCableHarness({ source: geometrySource(features) });
  await env.load();
  const lineSet = env.set('lines');
  assert.equal(lineSet.items.size, expandedFeatures.length);
  const destinations = picksOf(env, 'lines');
  for (const [index, feature] of expandedFeatures.entries()) {
    assert.deepEqual(destinations[index], {
      lon: feature.properties.coordinates[0],
      lat: feature.properties.coordinates[1],
      height: 6500,
    });
  }
  assert.equal(env.set('references').items.size, features.length);
  env.layer.destroy();
});
