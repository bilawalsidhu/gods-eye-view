// src/layers/satellites/stationModel.test.mjs — a station's model over the
// rendering part's draw items: it loads once the camera nears its range,
// stands in for the station's dot, the docked companions' dots and the
// tracked dot within that range (a display range on the dots, the model's
// own display condition the other side of it), hides the ring up close, and
// gives everything back when it may not show or is destroyed.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { eciToGeodetic, gstime, propagate, twoline2satrec } from 'satellite.js';
import { createOrbits } from './orbits.js';
import { createRendering } from './rendering.js';
import { createStationModel } from './stationModel.js';
import {
  ISS_MODEL_LOCAL_AXES,
  POINT_STYLES,
  TRACKED_ORBIT_COLOR,
} from './policy.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';

const STATION = 25544;
const COMPANION = 49044;
const STRANGER = 32711;
const ISS = twoline2satrec(
  '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927',
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537',
);
const AT_MS = Date.UTC(2008, 8, 20, 12, 30, 0);
const MAX_M = 1_000_000;
/** The dots the model stands in for draw only beyond the model's range. */
const FAR_RANGE = [MAX_M, Number.MAX_VALUE];

/** A satellite's ECEF position at `atMs`, as a plain `{x, y, z}`. */
function ecef(satrec, atMs) {
  const date = new Date(atMs);
  const geo = eciToGeodetic(propagate(satrec, date).position, gstime(date));
  const c = Cesium.Cartesian3.fromRadians(
    geo.longitude,
    geo.latitude,
    geo.height * 1000,
  );
  return { x: c.x, y: c.y, z: c.z };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const MODEL_SET = 'satellites:station:test';
const MODEL_ITEM = 'station:test';

/**
 * A station model over the real rendering part, a fake draw port (the
 * model is an item of a `models` set on it) and a fake camera port. The
 * station and a companion share an orbit (docked); a stranger's dot sits
 * 500 km off.
 */
function fixture(t) {
  const stationPos = ecef(ISS, AT_MS);
  const strangerPos = { ...stationPos, x: stationPos.x + 500_000 };
  const camera = fakeCameraPort({
    pose: { position: { ...stationPos }, fovy: Math.PI / 3 },
  });
  const viewer = { canvas: { clientHeight: 1000 } };
  const { draw, unbind } = bindFakeDraw(viewer, { camera: camera.port });
  const state = {
    now: () => AT_MS,
    _enabled: true,
    _params: { showPoints: true, showOrbits: true },
    _points: new Map(),
    _orbitPaths: new Map(),
    _catalog: new Map([
      [STATION, { satrec: ISS, group: 'core', name: 'ISS (ZARYA)' }],
      [COMPANION, { satrec: ISS, group: 'core', name: 'ISS (NAUKA)' }],
    ]),
    _viewer: viewer,
    _trackedNorad: null,
    _trackedFrameGeo: null,
    _trackedFrameNumber: -1,
    _dockedCompanions: new Set(),
    _cockpitHiddenPath: null,
    _cockpitSubjectNorad: null,
    _lastPropagation: -Infinity,
    _lastReckonMs: AT_MS,
    _lastRingRotation: -Infinity,
    _lastFocusUpdate: -Infinity,
    _activeFocusCount: 0,
  };
  const parts = {
    orbits: createOrbits({ state: {}, services: {}, parts: {} }),
    tracking: { _getTrackedFramePosition: () => null },
    catalog: { _propagateDenseChunk() {} },
    controls: {
      _classVisible: () => true,
      satelliteVisualsVisible: (enabled, requested) =>
        Boolean(enabled) && Boolean(requested),
    },
  };
  parts.rendering = createRendering({
    state,
    services: {
      focus: {
        focusNowMs: (ms) => ms,
        getFocusTarget: () => null,
        focusPassIsNeeded: () => false,
      },
    },
    parts,
  });
  const updates = [];
  const spec = {
    key: 'test',
    label: 'TEST',
    norad: STATION,
    modelUrl: '/models/test.glb',
    scale: 2,
    minPx: 64,
    maxDistanceM: MAX_M,
    orbitHideM: 50_000,
    cardClearM: 60,
    companionRadiusM: 5_000,
    companionCoarseM: 200_000,
    companionScanMs: 0,
    localAxes: ISS_MODEL_LOCAL_AXES,
    isModule: () => true,
    createArticulation: () => ({
      update: (...args) => updates.push(args),
      reset() {},
    }),
    createTelemetry: null,
    cockpitMount: null,
    hideInCockpit: true,
    syncOrbit: null,
  };
  const model = createStationModel(spec, {
    state,
    parts,
    resolveAsset: (url) => `/assets${url}`,
  });
  parts.stationModels = [model];
  parts.rendering._attach(viewer);
  parts.rendering._addPoint(STATION, stationPos, POINT_STYLES.iss);
  parts.rendering._addPoint(COMPANION, stationPos, POINT_STYLES.iss);
  parts.rendering._addPoint(STRANGER, strangerPos, POINT_STYLES.iss);
  const points = [...draw.sets.keys()].find((id) => id.endsWith(':points'));
  const set = (suffix) => draw.set(points.replace(':points', suffix));
  let frame = 0;
  t.after(() => unbind());
  const f = {
    state,
    parts,
    model,
    updates,
    stationPos,
    strangerPos,
    /** The model's draw set, while it is live. */
    modelSet: () => draw.set(MODEL_SET),
    /** The model's draw item, once asked for. */
    modelItem: () => draw.set(MODEL_SET)?.items.get(MODEL_ITEM),
    cameraAt(metres) {
      camera.setPose({
        position: { ...stationPos, x: stationPos.x + metres },
      });
    },
    tick() {
      parts.rendering._preRenderTick({ frame: ++frame });
    },
    /** Bring the camera into loading range and let the renderer load it. */
    async load() {
      f.cameraAt(MAX_M * 1.4);
      f.tick();
      draw.ready(MODEL_SET, MODEL_ITEM);
      await settle();
    },
    /** The renderer reports the model loaded, or failed to. */
    readyModel: () => draw.ready(MODEL_SET, MODEL_ITEM),
    failModel: () => draw.loadFailed(MODEL_SET, MODEL_ITEM),
    /** Track `noradId`, placing the tracked sample on the station. */
    track(noradId, at) {
      state._trackedNorad = noradId;
      state._trackedFrameGeo = { atMs: AT_MS };
      Object.assign(state._trackedFrameCartesian, at);
      parts.rendering._removeTrackedEntity();
      parts.rendering._addTrackedEntity({ position: () => at });
    },
    drawn: (id) => set(':points').items.get(String(id)),
    trackedDot: () => set(':tracked').items.get(String(state._trackedNorad)),
    ring: (id) => set(':rings').items.get(String(id)),
  };
  return f;
}

test('the model loads once the camera nears its range, measured from the dot as drawn', async (t) => {
  const f = fixture(t);
  f.cameraAt(MAX_M * 5);
  f.tick();
  assert.equal(f.modelSet(), undefined, 'a globe-wide view never asks for it');
  f.cameraAt(MAX_M * 1.4);
  f.tick();
  const item = f.modelItem();
  assert.ok(item, 'one item of a models set of its own');
  assert.equal(item.url, '/assets/models/test.glb');
  assert.deepEqual(
    item.meta,
    { norad: STATION },
    'a click on the model tracks the station',
  );
  assert.equal(item.scale, 2);
  assert.equal(item.minPixelSize, 64);
  assert.deepEqual(item.displayRange, [0, MAX_M], 'drawn within its range');
  assert.equal(item.show, false, 'hidden until posed');
  const writes = f.modelSet().writes;
  f.cameraAt(MAX_M * 5);
  f.tick();
  assert.equal(f.modelSet().writes, writes, 'out of range nothing is sent');
  assert.equal(f.model._hitNorad({ set: MODEL_SET, id: MODEL_ITEM }), STATION);
  assert.equal(f.model._hitNorad({ set: 'other', id: MODEL_ITEM }), null);
  assert.equal(f.model._hitNorad(null), null);
  assert.equal(
    f.model._visualPosition(),
    null,
    'the card keeps the dot until the renderer has the model',
  );
});

test('posed, the model sits on the station with its flight axes as heading, pitch and roll', async (t) => {
  const f = fixture(t);
  await f.load();
  f.cameraAt(20_000);
  f.tick();
  const item = f.modelItem();
  assert.equal(item.show, true);
  assert.ok(Math.abs(item.pos.x - f.stationPos.x) < 1, 'on the station');
  // The renderer places a model by heading, pitch and roll at its position
  // (Cesium's headingPitchRollToFixedFrame): the frame that gives must have
  // the model's local axes where ISS_MODEL_LOCAL_AXES says, zenith away from
  // the Earth and along-track horizontal.
  const { heading, pitch, roll } = item.orientation;
  const at = new Cesium.Cartesian3(item.pos.x, item.pos.y, item.pos.z);
  const m = Cesium.Transforms.headingPitchRollToFixedFrame(
    at,
    new Cesium.HeadingPitchRoll(heading, pitch, roll),
  );
  const column = (c) => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
  const up = Cesium.Cartesian3.normalize(at, new Cesium.Cartesian3());
  const along = (v) => v[0] * up.x + v[1] * up.y + v[2] * up.z;
  const zenith = column(ISS_MODEL_LOCAL_AXES.indexOf('z'));
  assert.ok(
    Math.abs(along(zenith) - 1) < 1e-6,
    'the zenith axis points away from the Earth',
  );
  const track = column(ISS_MODEL_LOCAL_AXES.indexOf('x'));
  assert.ok(Math.abs(along(track)) < 1e-6, 'the along-track axis is level');
  assert.equal(f.updates.length, 1, 'the joints are driven');
  const nodes = f.updates[0][0];
  assert.equal(nodes.ready, true, 'into node poses');
  // What the driver writes to a node is the item's `nodes`, by name, as a
  // column-major matrix the renderer applies to the model's glTF node.
  const turned = new Float64Array(16);
  turned[0] = turned[5] = turned[10] = turned[15] = 1;
  turned[14] = 2.5;
  nodes.getNode('SOLAR_JOINT').matrix = turned;
  f.tick();
  assert.equal(item.nodes, f.model._nodePoses, 'one object for the item');
  assert.deepEqual(Array.from(item.nodes.SOLAR_JOINT), Array.from(turned));
  f.model._destroyStationModel();
  assert.equal(
    Object.keys(f.model._nodePoses).length,
    0,
    'destroyed, every node goes back to its authored pose',
  );
});

test('a station without views on its model hides it while the Cockpit rides the station, its own entry or a docked one', async (t) => {
  const f = fixture(t);
  let held = false;
  f.parts.cockpit = { _cockpitHeld: () => held };
  await f.load();
  f.cameraAt(20);
  // Riding a docked object (the companion shares the orbit).
  f.track(COMPANION, f.stationPos);
  f.tick();
  assert.equal(f.modelItem().show, true, 'outside the Cockpit it draws');
  held = true;
  // Frame after frame: hiding the model gives the docked dots back, and
  // that must not make the layer forget the companion is docked (which
  // showed the model again, and so on, every other frame).
  for (let i = 0; i < 4; i++) {
    f.tick();
    assert.equal(
      f.modelItem().show,
      false,
      `the Cockpit camera would sit inside the hull (tick ${i})`,
    );
    assert.equal(f.model._trackedOnStation(), true, `docked (tick ${i})`);
  }
  assert.equal(f.model._visualPosition(), null);
  // Riding the station itself.
  held = false;
  f.track(STATION, f.stationPos);
  f.tick();
  assert.equal(f.modelItem().show, true);
  held = true;
  f.tick();
  assert.equal(f.modelItem().show, false);
  // A station that mounts the Cockpit camera on its model keeps drawing.
  f.model.spec.hideInCockpit = false;
  f.tick();
  assert.equal(f.modelItem().show, true);
});

test('until the renderer has the model the dots stand at every distance, and stay so when it fails to load', async (t) => {
  const f = fixture(t);
  f.parts.rendering._showOrbitPath(STATION, TRACKED_ORBIT_COLOR);
  f.track(COMPANION, f.stationPos);
  f.cameraAt(MAX_M * 1.4);
  f.tick(); // asks for the model
  f.cameraAt(20_000);
  f.tick();
  f.tick();
  // Loading: nothing is handed over, so the station never goes dark.
  assert.equal(f.modelItem().show, false);
  assert.equal(f.drawn(STATION).displayRange, undefined);
  assert.equal(f.drawn(COMPANION).displayRange, undefined);
  assert.equal(f.trackedDot().displayRange, undefined);
  assert.equal(
    f.ring(STATION).show,
    true,
    'the ring is not hidden for a model not drawn',
  );
  assert.equal(f.model._visualPosition(), null, 'the card keeps the dot');
  assert.equal(f.model._cockpitMount(), null);
  // The load fails: the dots stay at every distance, frame after frame.
  f.failModel();
  for (let i = 0; i < 3; i++) f.tick();
  assert.equal(f.modelItem().show, false);
  assert.equal(f.drawn(STATION).displayRange, undefined);
  assert.equal(f.drawn(COMPANION).displayRange, undefined);
  assert.equal(f.trackedDot().displayRange, undefined);
  // After the retry delay the model is released, and the next frame asks
  // for it again: one transient failure does not cost the session.
  f.model.spec.retryAfterMs = 0;
  f.tick();
  assert.equal(f.modelSet(), undefined, 'released after a failure');
  f.tick();
  assert.ok(f.modelItem(), 'asked for again');
  // That load finishes: the dots are handed over.
  f.readyModel();
  f.tick();
  assert.equal(f.modelItem().show, true);
  assert.deepEqual(f.drawn(STATION).displayRange, FAR_RANGE);
  assert.deepEqual(f.trackedDot().displayRange, FAR_RANGE);
});

test('a model still loading counts as undrawn out of range and is released', (t) => {
  const f = fixture(t);
  f.cameraAt(MAX_M * 1.4);
  f.tick(); // asks for the model, which never answers
  f.cameraAt(MAX_M * 5);
  f.tick();
  assert.ok(f.modelSet(), 'kept for a while');
  f.model.spec.unloadAfterMs = 0;
  f.tick();
  assert.equal(f.modelSet(), undefined);
});

test('turning the layer off, or a while undrawn, releases the model; the next approach asks for it again', async (t) => {
  const f = fixture(t);
  await f.load();
  f.cameraAt(20_000);
  f.tick();
  assert.equal(f.modelItem().show, true);
  // Out of range, within the grace: kept.
  f.cameraAt(MAX_M * 5);
  f.tick();
  assert.ok(f.modelSet(), 'kept for a while');
  // Past it: released, and the dots stand everywhere.
  f.model.spec.unloadAfterMs = 0;
  f.tick();
  assert.equal(f.modelSet(), undefined, 'its set is disposed');
  assert.equal(f.drawn(STATION).displayRange, undefined);
  // The next approach asks for it again.
  f.cameraAt(MAX_M * 1.4);
  f.tick();
  assert.ok(f.modelItem(), 'asked for again');
  f.readyModel();
  f.cameraAt(20_000);
  f.tick();
  assert.equal(f.modelItem().show, true);
  // Turning the layer off releases it at once.
  f.model.spec.unloadAfterMs = 60_000;
  // (The layer's disable asks the model once, as here: no frame runs then.)
  f.state._enabled = false;
  f.model._updateStationModel();
  assert.equal(f.modelSet(), undefined);
  assert.equal(f.drawn(STATION).displayRange, undefined);
});

test('within its range the model stands in for the dots and hides the ring; beyond it the dots draw', async (t) => {
  const f = fixture(t);
  await f.load();
  f.parts.rendering._showOrbitPath(STATION, TRACKED_ORBIT_COLOR);
  f.cameraAt(20_000);
  f.tick();
  assert.equal(f.modelItem().show, true);
  assert.equal(f.updates.length, 1, 'the joints are driven');
  assert.deepEqual(f.drawn(STATION).displayRange, FAR_RANGE);
  assert.deepEqual(
    f.drawn(COMPANION).displayRange,
    FAR_RANGE,
    'docked, by orbit against orbit',
  );
  assert.equal(f.drawn(STRANGER).displayRange, undefined, 'not docked');
  assert.equal(
    f.drawn(STATION).show,
    true,
    'the range alone splits the distances',
  );
  assert.equal(f.model._standsInFor(COMPANION), true);
  assert.equal(f.model._standsInFor(STRANGER), false);
  assert.equal(
    f.ring(STATION).show,
    false,
    'the ring runs off the model up close',
  );
  assert.ok(f.model._visualPosition(), 'the card anchors on the model');
  assert.ok(f.model._cardClearPx() > 0);
  // The tracked dot too, while the tracked satellite is the station (here
  // an object docked to it)…
  f.track(COMPANION, f.stationPos);
  f.tick();
  assert.deepEqual(f.trackedDot().displayRange, FAR_RANGE);
  // …and not once another satellite is tracked.
  f.track(STRANGER, f.strangerPos);
  f.tick();
  assert.equal(f.trackedDot().displayRange, undefined);
  // Beyond its range the model is not drawn and the dots are, by their range.
  f.cameraAt(MAX_M * 2.5);
  f.tick();
  assert.equal(f.modelItem().show, false);
  assert.equal(f.model._visualPosition(), null);
  assert.deepEqual(f.drawn(STATION).displayRange, FAR_RANGE);
  assert.equal(f.ring(STATION).show, true, "back to the layer's orbit toggle");
});

test('the dots and the ring come back when the model may not show, and on destroy', async (t) => {
  const f = fixture(t);
  await f.load();
  f.parts.rendering._showOrbitPath(STATION, TRACKED_ORBIT_COLOR);
  f.track(COMPANION, f.stationPos);
  f.cameraAt(20_000);
  f.tick();
  assert.deepEqual(f.drawn(STATION).displayRange, FAR_RANGE);
  assert.deepEqual(f.trackedDot().displayRange, FAR_RANGE);
  assert.equal(f.ring(STATION).show, false);
  // Points off: the model may not show, so every dot draws at any distance.
  f.state._params.showPoints = false;
  f.tick();
  assert.equal(f.modelItem().show, false);
  assert.equal(f.drawn(STATION).displayRange, undefined);
  assert.equal(f.drawn(COMPANION).displayRange, undefined);
  assert.equal(f.trackedDot().displayRange, undefined);
  assert.equal(f.model._standsInFor(COMPANION), false);
  assert.equal(f.ring(STATION).show, true);
  // Points on again: handed over again.
  f.state._params.showPoints = true;
  f.tick();
  assert.equal(f.modelItem().show, true);
  assert.deepEqual(f.drawn(STATION).displayRange, FAR_RANGE);
  assert.deepEqual(f.drawn(COMPANION).displayRange, FAR_RANGE);
  assert.deepEqual(f.trackedDot().displayRange, FAR_RANGE);
  assert.equal(f.ring(STATION).show, false);
  // Destroyed: the model leaves the scene and the dots are given back.
  f.model._destroyStationModel();
  f.parts.rendering._flushPoints();
  assert.equal(f.modelSet(), undefined, 'its set is disposed');
  assert.equal(f.drawn(STATION).displayRange, undefined);
  assert.equal(f.drawn(COMPANION).displayRange, undefined);
  assert.equal(f.trackedDot().displayRange, undefined);
  assert.equal(f.ring(STATION).show, true);
  assert.equal(f.model._visualPosition(), null);
});
