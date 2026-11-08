import { readLayerSource } from '../testSupport/readLayerSource.mjs';
// src/data/trackedModelRegime.test.mjs
//
// Zoom-driven 2D↔3D for the TRACKED contact (owner directive 2026-08-19).
//
// Two things are pinned here, and both are behavioural rather than cosmetic:
//
//  1. The POLICY — thresholds and hysteresis — as pure math in
//     trackedModelRegime.js. The enter ceiling is the owner's playtested swap
//     distance, deliberately much NEARER than the fleet ceiling, and the exit
//     ceiling is deliberately higher than the enter ceiling. A regression that
//     collapsed the two thresholds back into one would silently reintroduce
//     billboard↔model flapping for a camera orbiting the boundary, which no
//     unit test would otherwise catch.
//
//  2. The WIRING in both flight layers — that the tracked contact takes its
//     model with the fleet `models3d` toggle OFF (the whole point of the
//     feature), that cockpit and TR-3B suppression survived the rewrite, and
//     that deselecting drops the regime.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trackedModelZoomActive,
  TRACKED_MODEL_ENTER_ALT_M,
  TRACKED_MODEL_EXIT_ALT_M,
  FLEET_MODEL_ALT_CEIL_M,
  TRACKED_MODEL_EXIT_RATIO,
} from './trackedModelRegime.js';
import * as Cesium from 'cesium';
import flightsLayer, {
  _setTrackedFlightRefreshStateForTest,
  _trackedModelRegimeActiveForTest as flightsRegimeActive,
  _updateTrackedModelForTest as flightsDriveTrackedModel,
  _trackedBillboardColorForTest as flightsTrackedBillboardColor,
  _driveFleetModelHandoffForTest as flightsDriveFleetModel,
  _ensureFleetModelForTest as flightsEnsureFleetModel,
  _trackedModelForTest as flightsTrackedModel,
  _modelSetIdsForTest as flightsModelSetIds,
  _iconForTest as flightsIcon,
  _setIconForTest as flightsSetIcon,
} from './flights.js';
import militaryFlightsLayer, {
  _setTrackedMilitaryRefreshStateForTest,
  _trackedModelRegimeActiveForTest as militaryRegimeActive,
  _updateTrackedModelForTest as militaryDriveTrackedModel,
  _trackedBillboardColorForTest as militaryTrackedBillboardColor,
  _driveFleetModelHandoffForTest as militaryDriveFleetModel,
  _ensureFleetModelForTest as militaryEnsureFleetModel,
  _trackedModelForTest as militaryTrackedModel,
  _modelSetIdsForTest as militaryModelSetIds,
  _iconForTest as militaryIcon,
  _setIconForTest as militarySetIcon,
} from './militaryFlights.js';
import { clearTr3bRegistry, setTr3b } from './tr3bRegistry.js';
import { reportMeshFloorCell, _clearMeshFloorCellsForTest } from './groundFloor.js';
import { bindFakeCesiumCamera } from '../testSupport/fakeCameraPort.mjs';
import { fakeDrawPort } from '../testSupport/fakeDrawPort.mjs';

// Sample altitudes are expressed RELATIVE to the band rather than as absolute
// offsets. The thresholds have already been retuned once (1_000_000 → 150_000
// on the owner's playtest), and the fixed ±50 km / ±100 km offsets that were
// fine against a 150 km-wide band silently landed on the WRONG SIDE of the exit
// ceiling against a 22.5 km one. Deriving them keeps the next retune honest.
const BAND_WIDTH_M = TRACKED_MODEL_EXIT_ALT_M - TRACKED_MODEL_ENTER_ALT_M;
/** Strictly between enter and exit: latched → holds, fresh → does not. */
const INSIDE_BAND_M = TRACKED_MODEL_ENTER_ALT_M + BAND_WIDTH_M / 2;
/** Unambiguously past the exit ceiling. */
const FAR_OUTSIDE_M = TRACKED_MODEL_EXIT_ALT_M * 2;
/** Unambiguously below the enter ceiling. */
const WELL_INSIDE_M = TRACKED_MODEL_ENTER_ALT_M / 2;

// ---------------------------------------------------------------------------
// 1. Policy: thresholds + hysteresis math
// ---------------------------------------------------------------------------

test('the tracked 3D takeover sits at the owner-playtested swap distance', () => {
  // Owner playtest 2026-08-20: an earlier 1_000_000 m ceiling "pops to 3D far
  // too early" — 2D still reads correctly at ~600_000 m and the swap belongs at
  // ~150_000 m. These are the numbers the operator judged by eye, so they are
  // pinned literally rather than derived from anything.
  assert.equal(TRACKED_MODEL_ENTER_ALT_M, 150_000);
  assert.equal(trackedModelZoomActive(600_000, false), false,
    'the owner explicitly called 2D correct at ~600 km — it must not model there');
  assert.equal(trackedModelZoomActive(140_000, false), true,
    'inside the ruled swap distance the model owns the visual');
});

test('the tracked contact swaps NEARER than the fleet — a recorded inversion, not a bug', () => {
  // Consequence of the owner's number, spelled out so it cannot be "tidied
  // away": with the DISPLAY-rail 3D toggle ON, camera altitudes between the
  // tracked ceiling and the fleet ceiling draw surrounding contacts as models
  // while the SELECTED one is still a billboard. The fleet pass skips the
  // tracked icao, so nothing double-draws — this is purely an ordering
  // difference. Aligning them is a fleet-side decision, out of scope here.
  assert.equal(FLEET_MODEL_ALT_CEIL_M, 800_000,
    'mirror of MODEL_ALT_CEIL_M in both flight layers');
  assert.ok(TRACKED_MODEL_ENTER_ALT_M < FLEET_MODEL_ALT_CEIL_M,
    'the tracked contact deliberately enters 3D closer in than the fleet does');
  assert.equal(trackedModelZoomActive(FLEET_MODEL_ALT_CEIL_M - 1, false), false,
    'just inside the fleet ceiling the tracked contact is still 2D');
});

test('enter and exit thresholds are ASYMMETRIC — the anti-flap band', () => {
  assert.equal(TRACKED_MODEL_EXIT_RATIO, 1.15);
  assert.equal(TRACKED_MODEL_EXIT_ALT_M, 172_500);
  assert.equal(TRACKED_MODEL_EXIT_ALT_M, TRACKED_MODEL_ENTER_ALT_M * TRACKED_MODEL_EXIT_RATIO,
    'the exit ceiling stays derived from enter, so retuning enter carries the band with it');
  assert.ok(TRACKED_MODEL_EXIT_ALT_M > TRACKED_MODEL_ENTER_ALT_M,
    'a single shared threshold is exactly the flapping bug this prevents');
});

test('the regime enters at the enter ceiling and leaves only past the exit ceiling', () => {
  // Coming in from far out: nothing below the enter ceiling → still 2D.
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_EXIT_ALT_M + 1, false), false);
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_ENTER_ALT_M + 1, false), false);
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_ENTER_ALT_M, false), false,
    'the ceiling itself is still outside — the regime is strictly below it');
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_ENTER_ALT_M - 1, false), true);

  // Already inside: the model holds the visual all the way out to the exit ceiling.
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_ENTER_ALT_M + 1, true), true,
    'crossing back over the ENTER ceiling must not hand back — that is the flap');
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_EXIT_ALT_M - 1, true), true);
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_EXIT_ALT_M, true), false);
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_EXIT_ALT_M + 1, true), false);
});

test('an orbit sitting AT the boundary never flaps', () => {
  // Simulate a camera loitering on the enter ceiling with orbital
  // wobble. Under a single threshold this alternates every sample.
  let active = trackedModelZoomActive(TRACKED_MODEL_ENTER_ALT_M - BAND_WIDTH_M / 4, false);
  assert.equal(active, true, 'the orbit begins inside the regime');
  let transitions = 0;
  for (let i = 0; i < 40; i++) {
    const wobble = (i % 2 === 0 ? 1 : -1) * (BAND_WIDTH_M / 8);
    const next = trackedModelZoomActive(TRACKED_MODEL_ENTER_ALT_M + wobble, active);
    if (next !== active) transitions++;
    active = next;
  }
  assert.equal(transitions, 0, 'the hysteresis band absorbs boundary wobble entirely');
  assert.equal(active, true);
});

test('a missing camera height reads as infinitely far out, never as "zoomed in"', () => {
  for (const height of [undefined, null, NaN, Infinity]) {
    assert.equal(trackedModelZoomActive(height, false), false);
    assert.equal(trackedModelZoomActive(height, true), false,
      'a torn-down viewer must not latch the model on');
  }
});

// ---------------------------------------------------------------------------
// 2. Wiring: both flight layers
// ---------------------------------------------------------------------------

const ICAO = 'abc123';

/** `stopTracking()` is the real deselect path, and it announces the clear on
 *  `window`. Give it somewhere to land so the test drives production code
 *  rather than a stand-in. */
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { dispatchEvent() { return true; }, addEventListener() {}, removeEventListener() {} };
}

/** A viewer stub whose camera altitude the test can move between evaluations.
 *  Its renderer has a fake draw port (`viewer.draw`) the layer's model sets
 *  are made on, and a query port whose height samples are `sampleHeight`'s. */
function viewerAtHeight(height, { tilesLoaded = true, sampleHeight = () => undefined } = {}) {
  const tileset = { show: true, tilesLoaded };
  const draw = fakeDrawPort();
  const viewer = {
    camera: {
      positionCartographic: { height },
      positionWC: Cesium.Cartesian3.fromDegrees(-97.71, 30.21, 5000),
      frustum: { fovy: Cesium.Math.toRadians(60) },
    },
    scene: {
      canvas: { clientHeight: 900 },
      frameState: { frameNumber: 1 },
      primitives: { length: 1, get() { return tileset; } },
      sampleHeight,
    },
    tileset,
    draw,
    trackedEntity: undefined,
    entities: { remove() {} },
  };
  return bindFakeCesiumCamera(viewer, {
    draw,
    query: { sampleHeightNow: () => sampleHeight() },
    canvas: viewer.scene.canvas,
  });
}

/** The layer's fleet or tracked models set in the viewer's fake draw port. */
function modelSet(fixture, viewer, which) {
  return viewer.draw.set(fixture.modelSetIds()[which]);
}

/** Where a model record places its model (its placement's translation). */
function placedAt(record) {
  return new Cesium.Cartesian3(record.matrix[12], record.matrix[13], record.matrix[14]);
}

/** A billboard with a real position, so the tracked-model driver has somewhere
 *  to put a model when it gets one (dead reckoning yields nothing without a
 *  fix history, and the driver falls back to this). */
function contactBillboard() {
  return {
    position: Cesium.Cartesian3.fromDegrees(-97.71, 30.21, 10_668),
    color: null,
    show: true,
    rotation: 0,
  };
}

/** A contact's icon row, read and written the way these tests read a
 *  billboard: where it is drawn and whether the layer shows it. */
function iconView(icao24, readIcon, setIcon) {
  return {
    get position() {
      return readIcon(icao24)?.position;
    },
    set position(position) {
      setIcon(icao24, { position });
    },
    get show() {
      return readIcon(icao24)?.shown === true;
    },
    set show(shown) {
      setIcon(icao24, { shown });
    },
  };
}

const LAYERS = [
  {
    name: 'flights',
    layer: flightsLayer,
    regimeActive: flightsRegimeActive,
    driveTrackedModel: flightsDriveTrackedModel,
    driveFleetModel: flightsDriveFleetModel,
    ensureFleetModel: flightsEnsureFleetModel,
    trackedModel: flightsTrackedModel,
    modelSetIds: flightsModelSetIds,
    trackedBillboardColor: flightsTrackedBillboardColor,
    bellyM: 6.719,
    seed({ viewer, tracked = true, icao24 = ICAO, onGround = false, models = [] }) {
      const billboard = contactBillboard();
      _setTrackedFlightRefreshStateForTest({
        icao24,
        entity: null,
        icon: billboard,
        iconLayer: { show: true, remove() {} },
        viewer,
        tracked,
        models,
        draw: viewer.draw,
        meta: { callsign: 'TEST123 ', altitude: 10_668, klass: 'airliner', onGround },
      });
      return iconView(icao24, flightsIcon, flightsSetIcon);
    },
  },
  {
    name: 'militaryFlights',
    layer: militaryFlightsLayer,
    regimeActive: militaryRegimeActive,
    driveTrackedModel: militaryDriveTrackedModel,
    driveFleetModel: militaryDriveFleetModel,
    ensureFleetModel: militaryEnsureFleetModel,
    trackedModel: militaryTrackedModel,
    modelSetIds: militaryModelSetIds,
    trackedBillboardColor: militaryTrackedBillboardColor,
    bellyM: 5.631 * 0.8,
    seed({ viewer, tracked = true, icao24 = ICAO, onGround = false, models = [] }) {
      const billboard = contactBillboard();
      _setTrackedMilitaryRefreshStateForTest({
        icao24,
        entity: null,
        icon: billboard,
        iconLayer: { show: true, remove() {} },
        viewer,
        tracked,
        models,
        draw: viewer.draw,
        meta: { callsign: 'TEST123 ', altitudeFt: 35_000, klass: 'fastjet', onGround },
      });
      return iconView(icao24, militaryIcon, militarySetIcon);
    },
  },
];

for (const fixture of LAYERS) {
  test(`${fixture.name}: production fleet admission keeps the model HIDDEN until it is ready and placed`, () => {
    clearTr3bRegistry();
    fixture.layer.stopTracking();
    fixture.layer.setParams({ models3d: true });

    const viewer = viewerAtHeight(30_000, { tilesLoaded: false });
    const position = Cesium.Cartesian3.fromDegrees(-97.71, 30.21, 10_668);

    try {
      const loadingIcao = fixture.name === 'flights' ? 'a0f201' : 'b0f201';
      const billboard = fixture.seed({
        viewer,
        tracked: false,
        icao24: loadingIcao,
        onGround: true,
      });
      const admitted = fixture.ensureFleetModel(loadingIcao);
      assert.ok(admitted, 'the production fleet admission records a model');
      assert.equal(admitted.ready, false, 'nothing has loaded yet');
      assert.equal(admitted.show, false, 'admission records the model hidden until it is placed');
      assert.equal(billboard.show, true, 'the 2D billboard owns the cold loading state');

      const nearby = fixture.layer.getNearby(billboard.position, 1_000, 50)
        .find((object) => object.icao24 === loadingIcao);
      assert.ok(nearby, 'fleet proximity retains the billboard-owned loading contact');
      assert.ok(Cesium.Cartesian3.equalsEpsilon(nearby.position, billboard.position, 0, 1e-6),
        'fleet proximity stays at the billboard rather than the unplaced model');

      fixture.driveFleetModel({ icao24: loadingIcao, position, course: 92 });
      const fleet = modelSet(fixture, viewer, 'fleet');
      const item = fleet.items.get(loadingIcao);
      assert.ok(item, 'the model set loads the contact from its first write');
      assert.equal(item.show, false, 'and draws nothing while there is no safe placement');
      assert.equal(admitted.show, false);
      assert.equal(billboard.show, true, 'cold terrain preserves the same visible 2D owner');

      // A load that never finishes (a missing or broken GLB) never fires
      // `ready`, so the billboard stays the visual for as long as it lasts.
      viewer.draw.ready(fleet.spec.id, 'someone-else');
      assert.equal(admitted.ready, false, 'another item loading does not ready this one');
      fixture.driveFleetModel({ icao24: loadingIcao, position, course: 92 });
      assert.equal(billboard.show, true, 'an unready model leaves the 2D owner visible');
      assert.ok(fixture.layer.getNearby(billboard.position, 1_000, 50)
        .some((object) => object.icao24 === loadingIcao),
      'an unready model leaves the contact in the billboard proximity cohort');

      viewer.draw.ready(fleet.spec.id, loadingIcao);
      assert.equal(admitted.ready, true, "the set's ready marks the contact's model loaded");
    } finally {
      fixture.layer.setParams({ models3d: false });
      fixture.layer.stopTracking();
    }
  });

  test(`${fixture.name}: a tracked model that fails to load is retried within a per-selection budget`, () => {
    clearTr3bRegistry();
    fixture.layer.stopTracking();
    fixture.layer.setParams({ models3d: false });
    const realNow = Date.now;
    const realWarn = console.warn;
    const warnings = [];
    let now = 7_000_000;
    Date.now = () => now;
    console.warn = (...args) => warnings.push(args.join(' '));
    const viewer = viewerAtHeight(30_000);
    const icao24 = fixture.name === 'flights' ? 'a0f401' : 'b0f401';
    try {
      fixture.seed({ viewer, icao24 });
      fixture.driveTrackedModel();
      let tracked = modelSet(fixture, viewer, 'tracked');
      const fail = () => viewer.draw.loadFailed(tracked.spec.id, icao24, '404');
      assert.ok(tracked.items.has(icao24), 'the tracked model loads');
      for (let attempt = 1; attempt <= 3; attempt++) {
        fail();
        fixture.driveTrackedModel();
        assert.equal(tracked.items.has(icao24), false, `failure ${attempt}: let go`);
        assert.equal(fixture.trackedModel(), null);
        assert.equal(fixture.trackedBillboardColor()[3], 1, 'the icon carries the contact');
        now += 1499;
        fixture.driveTrackedModel();
        assert.equal(tracked.items.has(icao24), false, 'not before the backoff');
        now += 1;
        fixture.driveTrackedModel();
        assert.equal(tracked.items.has(icao24), attempt < 3,
          attempt < 3 ? 'loaded again after the backoff' : 'given up after the third failure');
      }
      assert.equal(warnings.length, 1, 'giving up is said once');
      now += 60_000;
      fixture.driveTrackedModel();
      assert.equal(tracked.items.has(icao24), false, 'the selection stays 2D');

      // A new selection of the same contact starts with a full budget.
      fixture.layer.stopTracking();
      fixture.seed({ viewer, icao24 });
      fixture.driveTrackedModel();
      tracked = modelSet(fixture, viewer, 'tracked');
      assert.ok(tracked.items.has(icao24), 'reselected, it loads again');
      // A failure the renderer recovers from before the driver runs keeps it.
      const recovered = fixture.trackedModel();
      fail();
      viewer.draw.ready(tracked.spec.id, icao24);
      fixture.driveTrackedModel();
      assert.equal(fixture.trackedModel(), recovered, 'a model that loaded after all is kept');
      assert.ok(tracked.items.has(icao24));
      fixture.layer.stopTracking();
      fixture.seed({ viewer, icao24 });
      fixture.driveTrackedModel();
      tracked = modelSet(fixture, viewer, 'tracked');
      // And a good load retires the failures counted so far.
      fail();
      fixture.driveTrackedModel();
      now += 1500;
      fixture.driveTrackedModel();
      viewer.draw.ready(tracked.spec.id, icao24);
      fixture.driveTrackedModel();
      assert.equal(fixture.trackedModel()?.ready, true);
      fail();
      fixture.driveTrackedModel();
      now += 1500;
      fixture.driveTrackedModel();
      fail();
      fixture.driveTrackedModel();
      now += 1500;
      fixture.driveTrackedModel();
      assert.ok(tracked.items.has(icao24), 'two failures after a good load are under the budget');
    } finally {
      Date.now = realNow;
      console.warn = realWarn;
      fixture.layer.stopTracking();
    }
  });

  test(`${fixture.name}: the IR boost restyles a drawn model in place, flat white and unlit`, () => {
    clearTr3bRegistry();
    fixture.layer.stopTracking();
    fixture.layer.setParams({ models3d: true, irBoost: false });
    const viewer = viewerAtHeight(30_000);
    const position = Cesium.Cartesian3.fromDegrees(-97.71, 30.21, 10_668);
    const icao24 = fixture.name === 'flights' ? 'a0f301' : 'b0f301';
    try {
      fixture.seed({ viewer, tracked: false, icao24 });
      const record = fixture.ensureFleetModel(icao24);
      const fleet = modelSet(fixture, viewer, 'fleet');
      viewer.draw.ready(fleet.spec.id, icao24);
      fixture.driveFleetModel({ icao24, position, course: 92 });
      const normal = fleet.items.get(icao24);
      assert.equal(normal.shading, 'pbr');
      assert.equal(normal.show, true);
      assert.ok(normal.colorBlend.amount < 1, 'the asset keeps a hint of its own colour');

      fixture.layer.setParams({ irBoost: true });
      fixture.driveFleetModel({ icao24, position, course: 92 });
      const boosted = fleet.items.get(icao24);
      assert.notEqual(boosted, normal, 'the boost writes the item again');
      assert.equal(boosted.shading, 'unlit');
      assert.deepEqual(boosted.tint, [1, 1, 1, 1]);
      assert.deepEqual(boosted.colorBlend, { mode: 'mix', amount: 1 });
      assert.equal(fixture.ensureFleetModel(icao24), record, 'the same model restyles; nothing reloads');
      assert.equal(boosted.url, normal.url);
    } finally {
      fixture.layer.setParams({ models3d: false, irBoost: false });
      fixture.layer.stopTracking();
    }
  });

  test(`${fixture.name}: grounded fleet handoff waits through terrain load and keeps one visual owner`, () => {
    clearTr3bRegistry();
    fixture.layer.stopTracking();

    const realNow = Date.now;
    let now = 4_000_000;
    Date.now = () => now;
    let sampleCalls = 0;
    const sampledHeight = 187.5;
    const viewer = viewerAtHeight(30_000, {
      tilesLoaded: false,
      sampleHeight: () => { sampleCalls++; return sampledHeight; },
    });
    const icao24 = fixture.name === 'flights' ? 'a0f101' : 'b0f101';
    const model = {
      modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      ready: true,
      show: true,
    };
    const position = Cesium.Cartesian3.fromDegrees(-97.71, 30.21, 10_668);

    try {
      const billboard = fixture.seed({
        viewer,
        tracked: false,
        icao24,
        onGround: true,
        models: [[icao24, model]],
      });
      billboard.show = false;

      let ownsVisual = fixture.driveFleetModel({ icao24, position, course: 92 });
      assert.equal(ownsVisual, false, 'cold terrain cannot transfer ownership to 3D');
      assert.equal(model.show, false, 'the ready primitive is hidden until ground resolves');
      assert.equal(billboard.show, true, 'the 2D contact returns in the same handoff turn');
      assert.ok(model.show || billboard.show, 'the contact never has both visuals hidden');
      assert.equal(sampleCalls, 0, 'cold tiles do not force sampleHeight');

      now += 1000;
      viewer.tileset.tilesLoaded = true;
      ownsVisual = fixture.driveFleetModel({ icao24, position, course: 92 });
      assert.equal(ownsVisual, false, 'the miss backoff remains in force before two seconds');
      assert.equal(sampleCalls, 0, 'backoff prevents an early synchronous sample');
      assert.ok(model.show || billboard.show, 'backoff still leaves a visible owner');

      now += 1500;
      ownsVisual = fixture.driveFleetModel({ icao24, position, course: 92 });
      assert.equal(ownsVisual, true, 'the model takes over after a valid terrain sample');
      assert.equal(sampleCalls, 1, 'the settled terrain is sampled exactly once');
      assert.equal(model.show, true);
      assert.equal(billboard.show, false);
      assert.ok(model.show || billboard.show, 'successful handoff keeps a visible owner');
      const placed = placedAt(model);
      const placedHeight = Cesium.Cartographic.fromCartesian(placed).height;
      assert.ok(Math.abs(placedHeight - (sampledHeight + fixture.bellyM)) < 0.001,
        `placement uses the exact ${fixture.bellyM} m asset-measured belly offset`);

      viewer.tileset.tilesLoaded = false;
      const datumShifted = Cesium.Cartesian3.fromDegrees(-97.71, 30.21, -500);
      ownsVisual = fixture.driveFleetModel({ icao24, position: datumShifted, course: 92 });
      assert.equal(ownsVisual, true,
        'a poll-time vertical datum change does not invalidate a stationary snap');
      assert.equal(sampleCalls, 1, 'the height-normalized cache does not resample vertically');
      assert.ok(model.show || billboard.show, 'datum transition keeps a visible owner');

      // Taxi past the 50 m resample threshold while the tiles are gone. The old
      // snap stops being the direct answer, but it is still a MEASUREMENT of
      // ground this contact was standing on ~96 m ago, so it is held: hiding the
      // model here would pop a taxiing aircraft from 3D to 2D for a whole retry
      // backoff (2–30 s), which is the one thing the gate must not introduce.
      const taxied = Cesium.Cartesian3.fromDegrees(-97.709, 30.21, -500);
      ownsVisual = fixture.driveFleetModel({ icao24, position: taxied, course: 92 });
      assert.equal(ownsVisual, true,
        'a taxi-invalidated snap is HELD through the resample outage, not dropped');
      assert.equal(model.show, true, 'no 3D→2D pop while the resample is backing off');
      assert.equal(billboard.show, false);
      assert.equal(sampleCalls, 1, 'and the hold costs no extra synchronous sample');
      const held = placedAt(model);
      assert.ok(Math.abs(Cesium.Cartographic.fromCartesian(held).height
        - (sampledHeight + fixture.bellyM)) < 0.001,
      'the hold places the model on the last MEASURED floor, not on the feed altitude');

      // Past the drift bound the memory stops describing anywhere this contact
      // has been, so it is dropped rather than stretched and the gate takes over.
      const farTaxied = Cesium.Cartesian3.fromDegrees(-97.707, 30.21, -500); // ~289 m out
      ownsVisual = fixture.driveFleetModel({ icao24, position: farTaxied, course: 92 });
      assert.equal(ownsVisual, false,
        'past HELD_SNAP_MAX_DRIFT_M the hold is released and the model is withheld');
      assert.equal(model.show, false);
      assert.equal(billboard.show, true);
      assert.ok(model.show || billboard.show, 'release returns atomically to 2D');

      const failedIcao = fixture.name === 'flights' ? 'a0f102' : 'b0f102';
      const failedBillboard = fixture.seed({
        viewer,
        tracked: false,
        icao24: failedIcao,
        onGround: true,
        models: [],
      });
      failedBillboard.show = false;
      ownsVisual = fixture.driveFleetModel({
        icao24: failedIcao,
        position,
        course: 92,
      });
      assert.equal(ownsVisual, false, 'a missing/failed model never claims ownership');
      assert.equal(failedBillboard.show, true, 'load failure keeps the billboard visible');
    } finally {
      Date.now = realNow;
      fixture.layer.stopTracking();
    }
  });

  test(`${fixture.name}: a held snap is dropped when measured ground contradicts it`, () => {
    // Adversarial review 2026-08-23, reproduced verbatim. The drift bound asks
    // "how far has the contact travelled", which is only a PROXY for "does this
    // value still describe the ground here" — and 202 m of taxi onto a surface
    // 30 m higher fits inside it. Because a miss PRESERVES the hold, nothing in
    // the retry path corrects that: the model stays buried for as long as the
    // resample keeps missing, which on the OSM fallback is forever.
    //
    // A at 120 m → taxi 202 m to B, whose measured skin is 150 m → resample
    // misses. The held 120 m must NOT be used to place a model at B.
    clearTr3bRegistry();
    fixture.layer.stopTracking();
    fixture.layer.setParams({ models3d: false });
    _clearMeshFloorCellsForTest();

    const realNow = Date.now;
    let now = 5_000_000;
    Date.now = () => now;
    let sampleCalls = 0;
    let sampled = 120;
    const viewer = viewerAtHeight(30_000, {
      tilesLoaded: true,
      sampleHeight: () => { sampleCalls++; return sampled; },
    });
    const icao24 = fixture.name === 'flights' ? 'a0f103' : 'b0f103';
    const model = {
      modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      ready: true,
      show: true,
    };
    /** Height (m) the model's matrix currently places it at. */
    const placedHeightM = () => Cesium.Cartographic.fromCartesian(
      placedAt(model),
    ).height;

    const LAT = 30.21;
    const A_LON = -97.71;
    // ~202 m east at this latitude: past MOVE_INVALIDATE_M (50 m) so the snap is
    // demoted, and INSIDE HELD_SNAP_MAX_DRIFT_M (250 m) so the bound alone does
    // not catch it — that is the whole point of the repro.
    const B_LON = -97.7079;
    const B_GROUND_M = 150;

    try {
      const billboard = fixture.seed({
        viewer,
        tracked: false,
        icao24,
        onGround: true,
        models: [[icao24, model]],
      });
      billboard.show = false;

      const atA = Cesium.Cartesian3.fromDegrees(A_LON, LAT, 0);
      const atB = Cesium.Cartesian3.fromDegrees(B_LON, LAT, 0);
      const taxiM = Cesium.Cartesian3.distance(
        Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(atA, new Cesium.Cartesian3()),
        Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(atB, new Cesium.Cartesian3()),
      );
      assert.ok(taxiM > 50 && taxiM < 250,
        `the repro must sit INSIDE the drift bound to be a repro (taxi ${taxiM.toFixed(1)} m)`);

      // A: the snap resolves and the model takes the visual.
      let ownsVisual = fixture.driveFleetModel({ icao24, position: atA, course: 92 });
      assert.equal(ownsVisual, true, 'a measured snap at A hands the visual to the model');
      assert.equal(sampleCalls, 1);
      assert.ok(Math.abs(placedHeightM() - (sampled + fixture.bellyM)) < 0.001,
        'the model stands on the measured 120 m at A');

      // Something measures B's surface — the mesh-floor cells the billboard
      // chain and meshFloorSampler share. This is the fresh evidence.
      reportMeshFloorCell(LAT, B_LON, B_GROUND_M);

      // B, with the resample missing: tiles gone, so no sample can land.
      viewer.tileset.tilesLoaded = false;
      now += 60_000;
      ownsVisual = fixture.driveFleetModel({ icao24, position: atB, course: 92 });
      assert.equal(sampleCalls, 1, 'the missing resample fires no new sample');
      assert.equal(ownsVisual, false,
        'a held measurement contradicted by measured ground must not place the model');
      assert.equal(model.show, false, 'nothing is drawn 30 m under the apron');
      assert.equal(billboard.show, true, 'the floored 2D billboard is the honest fallback');
      assert.ok(model.show || billboard.show, 'the release is atomic — never both hidden');

      // "If the contact remains at B, misses can preserve that burial forever."
      // They cannot: the hold is gone, so every later miss re-answers COLD.
      for (let i = 0; i < 5; i++) {
        now += 60_000;
        assert.equal(fixture.driveFleetModel({ icao24, position: atB, course: 92 }), false,
          'repeated misses must not resurrect the dropped hold');
        assert.equal(model.show, false);
      }

      // And when evidence does arrive, it is B's ground the model stands on.
      sampled = B_GROUND_M;
      viewer.tileset.tilesLoaded = true;
      now += 60_000;
      ownsVisual = fixture.driveFleetModel({ icao24, position: atB, course: 92 });
      assert.equal(ownsVisual, true, 'a fresh sample at B restores the model');
      assert.equal(sampleCalls, 2);
      assert.ok(Math.abs(placedHeightM() - (B_GROUND_M + fixture.bellyM)) < 0.001,
        "the restored model stands on B's 150 m, not on the stale 120 m");

      // The rule is ONE-SIDED, and this is the half that keeps it useful. Roll
      // on to C, where the measured cell reads BELOW the held value, and let the
      // resample miss again. A cell under a real sample is the floor chain's
      // expected error — cells latch once over ~111 m, borrowed neighbours lean
      // lowest, the display clamp only ever raises — so it is not evidence of
      // burial and must NOT cost the contact its model. A two-sided rule fails
      // here, and did: on the track-regression rig a planted cell sat 66.7 m
      // below a real sample at the same spot.
      const C_LON = -97.7064; // ~144 m further on, still inside the drift bound
      const atC = Cesium.Cartesian3.fromDegrees(C_LON, LAT, 0);
      const rollM = Cesium.Cartesian3.distance(
        Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(atB, new Cesium.Cartesian3()),
        Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(atC, new Cesium.Cartesian3()),
      );
      assert.ok(rollM > 50 && rollM < 250,
        `the downhill leg must also sit inside the bound (roll ${rollM.toFixed(1)} m)`);
      reportMeshFloorCell(LAT, C_LON, B_GROUND_M - 50); // measured LOWER than the hold
      viewer.tileset.tilesLoaded = false;
      now += 60_000;
      ownsVisual = fixture.driveFleetModel({ icao24, position: atC, course: 92 });
      assert.equal(ownsVisual, true,
        'a cell reading BELOW the hold is the floor chain under-reading, not burial — the hold stands');
      assert.equal(model.show, true, 'the contact keeps its model through a downhill taxi');
      assert.ok(Math.abs(placedHeightM() - (B_GROUND_M + fixture.bellyM)) < 0.001,
        'and it keeps standing on the measurement it actually has');
    } finally {
      Date.now = realNow;
      fixture.layer.stopTracking();
      _clearMeshFloorCellsForTest();
    }
  });

  test(`${fixture.name}: grounded tracked model waits for a valid terrain snap with no visual gap`, () => {
    clearTr3bRegistry();
    fixture.layer.stopTracking();
    fixture.layer.setParams({ models3d: false });

    const realNow = Date.now;
    let now = 3_000_000;
    Date.now = () => now;
    let sampleCalls = 0;
    let sampledHeight = undefined;
    const viewer = viewerAtHeight(30_000, {
      tilesLoaded: false,
      sampleHeight: () => { sampleCalls++; return sampledHeight; },
    });
    const icao24 = fixture.name === 'flights' ? 'a0f001' : 'b0f001';

    try {
      const billboard = fixture.seed({
        viewer,
        onGround: true,
        icao24,
      });

      fixture.driveTrackedModel();
      const model = fixture.trackedModel();
      const tracked = modelSet(fixture, viewer, 'tracked');
      assert.ok(model, 'the driver records the tracked model');
      assert.deepEqual([...tracked.items.keys()], [icao24],
        'the tracked set loads the one model for the contact');
      assert.equal(model.ready, false, 'the model is still loading');
      assert.equal(model.show, false, 'the loading model is drawn hidden, not zero-scaled');
      assert.equal(tracked.items.get(icao24).show, false);
      const baseScale = model.scale;
      assert.equal(fixture.trackedBillboardColor()[3], 1,
        'the tracked billboard remains opaque while the model lacks safe placement');
      assert.equal(sampleCalls, 0, 'cold tiles do not force a synchronous sample');
      const loadingDetection = fixture.layer.getDetectableObjects({ maxCount: 50 })
        .find((object) => object.sourceId === (fixture.name === 'flights' ? 'a0f001' : 'b0f001'));
      assert.ok(loadingDetection, 'the tracked billboard remains detectable while its model loads');
      assert.ok(Cesium.Cartesian3.equalsEpsilon(
        loadingDetection.position,
        billboard.position,
        0,
        1e-6,
      ), 'a hidden tracked model cannot steal the detection anchor');
      billboard.show = false; // tracking hides the fleet sprite; the tracked entity remains the 2D owner
      const loadingNearby = fixture.layer.getNearby(billboard.position, 1_000, 50)
        .find((object) => object.icao24 === (fixture.name === 'flights' ? 'a0f001' : 'b0f001'));
      assert.ok(loadingNearby, 'the tracked contact remains in proximity while its model loads');
      assert.ok(Cesium.Cartesian3.equalsEpsilon(
        loadingNearby.position,
        billboard.position,
        0,
        1e-6,
      ), 'a hidden tracked model cannot steal the proximity position');

      now += 1000;
      viewer.tileset.tilesLoaded = true;
      sampledHeight = 187.5;
      fixture.driveTrackedModel();
      assert.equal(sampleCalls, 0, 'the tracked path honors the same retry backoff before sampling');
      assert.equal(model.show, false, 'retry backoff keeps the unplaced primitive hidden');
      assert.equal(fixture.trackedBillboardColor()[3], 1,
        'retry backoff leaves the tracked billboard opaque');

      now += 1500;
      fixture.driveTrackedModel();
      assert.equal(sampleCalls, 1, 'the first settled turn samples once');
      assert.equal(model.show, false, 'terrain alone does not reveal an unready model');
      assert.equal(fixture.trackedBillboardColor()[3], 1,
        'the billboard retains ownership until GPU readiness too');

      assert.equal(model.scale, baseScale, 'its scale is left to the pixel-cap driver');
      viewer.draw.ready(tracked.spec.id, icao24);
      fixture.driveTrackedModel();
      assert.equal(model.show, true, 'the model appears only after its snapped matrix is written');
      assert.equal(tracked.items.get(icao24).show, true);
      assert.equal(fixture.trackedBillboardColor()[3], 0,
        'the billboard becomes transparent only when the model actually owns the visual');
      const placed = placedAt(model);
      const placedHeight = Cesium.Cartographic.fromCartesian(placed).height;
      assert.ok(Math.abs(placedHeight - (sampledHeight + fixture.bellyM)) < 0.001,
        `tracked placement uses the exact ${fixture.bellyM} m asset-measured belly offset`);

      viewer.tileset.tilesLoaded = false;
      sampledHeight = undefined;
      billboard.position = Cesium.Cartesian3.fromDegrees(-97.71, 30.21, -500);
      fixture.driveTrackedModel();
      assert.equal(model.show, true,
        'a successful cached snap survives a poll-time vertical datum change');
      assert.equal(sampleCalls, 1,
        'a stationary vertical-only change does not consume another terrain sample');

      // Taxi past the resample threshold with the tiles gone: the tracked model
      // holds its last measured floor rather than handing the operator's own
      // selection back to a 2D glyph for a retry backoff.
      billboard.position = Cesium.Cartesian3.fromDegrees(-97.709, 30.21, -500);
      fixture.driveTrackedModel();
      assert.equal(model.show, true,
        'a taxi-invalidated tracked snap is HELD through the resample outage');
      assert.equal(fixture.trackedBillboardColor()[3], 0,
        'the model still owns the visual, so the billboard stays transparent');
      assert.equal(sampleCalls, 1, 'the hold costs no extra synchronous sample');

      // Past the drift bound the memory is released and the gate takes over.
      billboard.position = Cesium.Cartesian3.fromDegrees(-97.707, 30.21, -500);
      fixture.driveTrackedModel();
      assert.equal(model.show, false,
        'past HELD_SNAP_MAX_DRIFT_M the hold is released and the model is withheld');
      assert.equal(fixture.trackedBillboardColor()[3], 1,
        'there is no invisible-owner gap while the replacement snap is unavailable');
    } finally {
      Date.now = realNow;
      fixture.layer.stopTracking();
    }
  });

  test(`${fixture.name}: the tracked contact goes 3D with the fleet 3D toggle OFF`, () => {
    clearTr3bRegistry();
    fixture.layer.setParams({ models3d: false });
    assert.equal(fixture.layer.getParams().models3d, false, 'the fleet toggle really is off');

    // Zoomed out past the ceiling → the billboard still owns the visual.
    fixture.seed({ viewer: viewerAtHeight(INSIDE_BAND_M) });
    assert.equal(fixture.regimeActive(), false);

    // Zoom in past the ceiling → the model takes over, toggle untouched.
    fixture.seed({ viewer: viewerAtHeight(WELL_INSIDE_M) });
    assert.equal(fixture.regimeActive(), true,
      'zoom-driven 2D↔3D is DEFAULT for the tracked contact');
    assert.equal(fixture.layer.getParams().models3d, false,
      'and it never arms the fleet toggle as a side effect');
  });

  test(`${fixture.name}: the tracked regime is hysteretic across a live zoom in/out`, () => {
    clearTr3bRegistry();
    fixture.layer.setParams({ models3d: false });
    const viewer = viewerAtHeight(FAR_OUTSIDE_M);
    fixture.seed({ viewer });
    assert.equal(fixture.regimeActive(), false, 'starts far out, in 2D');

    // Zoom in through the boundary.
    viewer.camera.positionCartographic.height = TRACKED_MODEL_ENTER_ALT_M - 1;
    assert.equal(fixture.regimeActive(), true, '3D at the enter ceiling');

    // Drift back over the ENTER ceiling — must HOLD (this is the flap guard).
    viewer.camera.positionCartographic.height = INSIDE_BAND_M;
    assert.equal(fixture.regimeActive(), true, 'the exit band holds the model');

    // Zoom all the way back out — the billboard returns.
    viewer.camera.positionCartographic.height = TRACKED_MODEL_EXIT_ALT_M + 1;
    assert.equal(fixture.regimeActive(), false, 'past the exit ceiling, 2D returns');

    // And a second round trip behaves identically (no stuck latch).
    viewer.camera.positionCartographic.height = TRACKED_MODEL_ENTER_ALT_M - 1;
    assert.equal(fixture.regimeActive(), true);
    viewer.camera.positionCartographic.height = TRACKED_MODEL_EXIT_ALT_M + 1;
    assert.equal(fixture.regimeActive(), false);
  });

  test(`${fixture.name}: deselect + re-track the SAME contact re-enters at the ENTER ceiling`, () => {
    // The regression this pins: a deselect followed by a same-turn re-track of
    // the SAME icao (Contacts re-entry, a cross-layer round trip back to this
    // layer) never makes `_trackedIcao` observably change, so the predicate's
    // icao-change guard never fires. The reset therefore has to live in the
    // PRODUCTION teardown — which is why nothing below touches a test-only
    // latch reset; the seam re-seeds state but deliberately leaves the latches
    // alone, and `stopTracking()` is the real deselect path.
    clearTr3bRegistry();
    fixture.layer.setParams({ models3d: false });

    // Latch the regime on close in...
    const viewer = viewerAtHeight(TRACKED_MODEL_ENTER_ALT_M - 1);
    fixture.seed({ viewer });
    assert.equal(fixture.regimeActive(), true);

    // ...drift into the hysteresis band, where the model legitimately holds.
    viewer.camera.positionCartographic.height = INSIDE_BAND_M;
    assert.equal(fixture.regimeActive(), true, 'the ORIGINAL selection still holds in the band');

    // Deselect through the production path, then re-track the SAME contact.
    fixture.layer.stopTracking();
    fixture.seed({ viewer }); // same icao, still inside the band
    assert.equal(fixture.regimeActive(), false,
      'a re-tracked contact must pass the ENTER ceiling again, not inherit the exit band');

    // And it still enters normally once actually zoomed in.
    viewer.camera.positionCartographic.height = TRACKED_MODEL_ENTER_ALT_M - 1;
    assert.equal(fixture.regimeActive(), true);
    fixture.layer.stopTracking();
  });

  test(`${fixture.name}: a converted TR-3B never takes the model, at any zoom`, () => {
    clearTr3bRegistry();
    fixture.layer.setParams({ models3d: false });
    const viewer = viewerAtHeight(1); // as zoomed in as it gets
    fixture.seed({ viewer });
    assert.equal(fixture.regimeActive(), true, 'control: an unconverted contact does model');

    setTr3b(ICAO, true);
    fixture.seed({ viewer });
    assert.equal(fixture.regimeActive(), false,
      'there is no TR-3B GLB — the triangle billboard stays the visual all the way in');

    setTr3b(ICAO, false);
    fixture.seed({ viewer });
    assert.equal(fixture.regimeActive(), true, 'un-converting restores the handoff');
    clearTr3bRegistry();
  });

  test(`${fixture.name}: deselecting drops the regime even zoomed all the way in`, () => {
    clearTr3bRegistry();
    fixture.layer.setParams({ models3d: false });
    const viewer = viewerAtHeight(1);
    fixture.seed({ viewer });
    assert.equal(fixture.regimeActive(), true);

    fixture.seed({ viewer, tracked: false }); // nothing selected
    assert.equal(fixture.regimeActive(), false,
      'with no selection there is no tracked model to own the visual');
  });

  test(`${fixture.name}: turning the fleet toggle ON does not disturb the tracked regime`, () => {
    clearTr3bRegistry();
    const viewer = viewerAtHeight(WELL_INSIDE_M);
    fixture.seed({ viewer });
    fixture.layer.setParams({ models3d: true });
    assert.equal(fixture.regimeActive(), true);
    fixture.layer.setParams({ models3d: false });
    assert.equal(fixture.regimeActive(), true,
      'the fleet toggle owns the FLEET; the selected contact is independent of it');
  });
}

test('both layers reset the per-selection tracked-model state', async () => {
  for (const name of ['flights.js', 'militaryFlights.js']) {
    const source = readLayerSource(new URL(`./${name}`, import.meta.url));
    // The reset must be reachable from the real teardown, not only a test seam.
    assert.match(source, /(?:parts\.\w+\.)?_releaseTrackedModel\(\s*,?\s*\);\n\s*(?:parts\.\w+\.)?_resetTrackedSelectionState\(\s*,?\s*\);/,
      `${name}: deselect clears the per-selection latches in the production path`);
    assert.match(source, /(?:(?:flightState|state)\.)?_trackedIcao\s*=\s*icao24;\n\s*(?:parts\.\w+\.)?_resetTrackedSelectionState\(\s*,?\s*\);/,
      `${name}: selecting a contact starts from a clean per-selection state`);
  }
});

test('the tracked regime never consults the fleet models3d toggle', async () => {
  for (const name of ['flights.js', 'militaryFlights.js']) {
    const source = readLayerSource(new URL(`./${name}`, import.meta.url));
    const regime = /^([ \t]*)function _trackedModelRegimeActive\b[\s\S]*?\n\1\}/m.exec(source)?.[0];
    assert.ok(regime, `${name}: _trackedModelRegimeActive is defined`);
    assert.doesNotMatch(regime, /(?:(?:flightState|state)\.)?_models3dEnabled|(?:parts\.\w+\.)?_modelRegimeActive\(\s*,?\s*\)/,
      `${name}: the tracked contact's handoff is default-on, not gated on the fleet toggle`);
    assert.match(regime, /trackedModelZoomActive\(/,
      `${name}: the tracked contact uses the shared hysteretic zoom policy`);
    // The FLEET must still obey the toggle — the budget decision stays the operator's.
    const fleet = /^([ \t]*)function _modelRegimeActive\b[\s\S]*?\n\1\}/m.exec(source)?.[0];
    assert.match(fleet, /if\s*\(\s*!(?:(?:flightState|state)\.)?_models3dEnabled,?\s*\)\s*return\s*false;/,
      `${name}: the fleet regime still obeys the DISPLAY-rail 3D toggle`);
  }
});
