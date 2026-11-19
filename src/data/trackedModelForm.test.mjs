import { readLayerSource } from '../testSupport/readLayerSource.mjs';
// src/data/trackedModelForm.test.mjs
//
// The TRACKED contact's form and size: selecting an aircraft changes its
// colour, never its size or form. The tracked model draws exactly when the
// fleet's own model rule would draw the contact (3D on, below the ceiling, a
// place in the nearest-first cap), at the fleet's scale and minimum pixel
// size; otherwise the tracked icon carries it, drawn as its fleet icon is.
// Both flight layers are pinned, with cockpit and TR-3B suppression, the
// load-failure budget and the grounded snap.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import flightsLayer, {
  _setTrackedFlightRefreshStateForTest,
  _trackedModelRegimeActiveForTest as flightsRegimeActive,
  _updateTrackedModelForTest as flightsDriveTrackedModel,
  _trackedBillboardColorForTest as flightsTrackedBillboardColor,
  _driveFleetModelHandoffForTest as flightsDriveFleetModel,
  _ensureFleetModelForTest as flightsEnsureFleetModel,
  _trackedModelForTest as flightsTrackedModel,
  _trackedIconLookForTest as flightsTrackedIconLook,
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
  _trackedIconLookForTest as militaryTrackedIconLook,
  _modelSetIdsForTest as militaryModelSetIds,
  _iconForTest as militaryIcon,
  _setIconForTest as militarySetIcon,
} from './militaryFlights.js';
import { clearTr3bRegistry, setTr3b } from './tr3bRegistry.js';
import {
  reportMeshFloorCell,
  _clearMeshFloorCellsForTest,
} from './groundFloor.js';
import { bindFakeCesiumCamera } from '../testSupport/fakeCameraPort.mjs';
import { fakeDrawPort } from '../testSupport/fakeDrawPort.mjs';
import { loadFleetModelSet } from './fleetModels.js';
import { aircraftLayerModelSpec } from '../layers/flights/modelSpec.js';
import { fetchPublicFile } from '../testSupport/fleetGlb.mjs';

// The layers draw only once the fleet model set has loaded; load it from disk.
const _silentInfo = console.info;
console.info = () => {};
await loadFleetModelSet({ fetchImpl: fetchPublicFile });
console.info = _silentInfo;
const FLIGHTS_META = Object.freeze({ typeCode: 'A320', klass: 'airliner' });
const MILITARY_META = Object.freeze({ typeCode: 'F16', klass: 'fastjet' });

// ---------------------------------------------------------------------------
// Both flight layers
// ---------------------------------------------------------------------------

const ICAO = 'abc123';

/** `stopTracking()` is the real deselect path, and it announces the clear on
 *  `window`. Give it somewhere to land so the test drives production code
 *  rather than a stand-in. */
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    dispatchEvent() {
      return true;
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

/** A viewer stub whose camera altitude the test can move between evaluations.
 *  Its renderer has a fake draw port (`viewer.draw`) the layer's model sets
 *  are made on, a globe whose drawn tiles settle as `viewer.tileset` says, and
 *  a query port whose height samples are `sampleHeight`'s. */
function viewerAtHeight(
  height,
  { tilesLoaded = true, sampleHeight = () => undefined, eye } = {},
) {
  const tileset = { show: true, tilesLoaded };
  const draw = fakeDrawPort();
  const viewer = {
    camera: {
      positionCartographic: { height },
      positionWC: eye ?? Cesium.Cartesian3.fromDegrees(-97.71, 30.21, 5000),
      frustum: { fovy: Cesium.Math.toRadians(60) },
    },
    scene: {
      canvas: { clientHeight: 900 },
      frameState: { frameNumber: 1 },
      sampleHeight,
    },
    tileset,
    draw,
    trackedEntity: undefined,
    entities: { remove() {} },
  };
  return bindFakeCesiumCamera(viewer, {
    draw,
    globe: { isSettled: (kind) => kind !== 'tiles' || tileset.tilesLoaded },
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
  return new Cesium.Cartesian3(
    record.matrix[12],
    record.matrix[13],
    record.matrix[14],
  );
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
    trackedIconLook: flightsTrackedIconLook,
    /** How far a grounded A320 stands its origin above the ground (scaled wheel clearance). */
    bellyM: aircraftLayerModelSpec(FLIGHTS_META).bellyM,
    seed({
      viewer,
      tracked = true,
      icao24 = ICAO,
      onGround = false,
      models = [],
      trackedModelEligible = true,
    }) {
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
        trackedModelEligible,
        meta: {
          callsign: 'TEST123 ',
          altitude: 10_668,
          ...FLIGHTS_META,
          onGround,
        },
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
    trackedIconLook: militaryTrackedIconLook,
    bellyM: aircraftLayerModelSpec(MILITARY_META).bellyM,
    seed({
      viewer,
      tracked = true,
      icao24 = ICAO,
      onGround = false,
      models = [],
      trackedModelEligible = true,
    }) {
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
        trackedModelEligible,
        meta: {
          callsign: 'TEST123 ',
          altitudeFt: 35_000,
          ...MILITARY_META,
          onGround,
        },
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
      assert.equal(
        admitted.show,
        false,
        'admission records the model hidden until it is placed',
      );
      assert.equal(
        billboard.show,
        true,
        'the 2D billboard owns the cold loading state',
      );

      const nearby = fixture.layer
        .getNearby(billboard.position, 1_000, 50)
        .find((object) => object.icao24 === loadingIcao);
      assert.ok(
        nearby,
        'fleet proximity retains the billboard-owned loading contact',
      );
      assert.ok(
        Cesium.Cartesian3.equalsEpsilon(
          nearby.position,
          billboard.position,
          0,
          1e-6,
        ),
        'fleet proximity stays at the billboard rather than the unplaced model',
      );

      fixture.driveFleetModel({ icao24: loadingIcao, position, course: 92 });
      const fleet = modelSet(fixture, viewer, 'fleet');
      const item = fleet.items.get(loadingIcao);
      assert.ok(item, 'the model set loads the contact from its first write');
      assert.equal(
        item.show,
        false,
        'and draws nothing while there is no safe placement',
      );
      assert.equal(admitted.show, false);
      assert.equal(
        billboard.show,
        true,
        'cold terrain preserves the same visible 2D owner',
      );

      // A load that never finishes (a missing or broken GLB) never fires
      // `ready`, so the billboard stays the visual for as long as it lasts.
      viewer.draw.ready(fleet.spec.id, 'someone-else');
      assert.equal(
        admitted.ready,
        false,
        'another item loading does not ready this one',
      );
      fixture.driveFleetModel({ icao24: loadingIcao, position, course: 92 });
      assert.equal(
        billboard.show,
        true,
        'an unready model leaves the 2D owner visible',
      );
      assert.ok(
        fixture.layer
          .getNearby(billboard.position, 1_000, 50)
          .some((object) => object.icao24 === loadingIcao),
        'an unready model leaves the contact in the billboard proximity cohort',
      );

      viewer.draw.ready(fleet.spec.id, loadingIcao);
      assert.equal(
        admitted.ready,
        true,
        "the set's ready marks the contact's model loaded",
      );
    } finally {
      fixture.layer.setParams({ models3d: false });
      fixture.layer.stopTracking();
    }
  });

  test(`${fixture.name}: a tracked model that fails to load is retried within a per-selection budget`, () => {
    clearTr3bRegistry();
    fixture.layer.stopTracking();
    fixture.layer.setParams({ models3d: true });
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
        assert.equal(
          tracked.items.has(icao24),
          false,
          `failure ${attempt}: let go`,
        );
        assert.equal(fixture.trackedModel(), null);
        assert.equal(
          fixture.trackedBillboardColor()[3],
          1,
          'the icon carries the contact',
        );
        now += 1499;
        fixture.driveTrackedModel();
        assert.equal(
          tracked.items.has(icao24),
          false,
          'not before the backoff',
        );
        now += 1;
        fixture.driveTrackedModel();
        assert.equal(
          tracked.items.has(icao24),
          attempt < 3,
          attempt < 3
            ? 'loaded again after the backoff'
            : 'given up after the third failure',
        );
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
      assert.equal(
        fixture.trackedModel(),
        recovered,
        'a model that loaded after all is kept',
      );
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
      assert.ok(
        tracked.items.has(icao24),
        'two failures after a good load are under the budget',
      );
    } finally {
      Date.now = realNow;
      console.warn = realWarn;
      fixture.layer.setParams({ models3d: false });
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
      assert.deepEqual(
        normal.colorBlend,
        { mode: 'highlight' },
        'an ordinary model draws its mesh in its own colours',
      );
      assert.deepEqual([...normal.tint], [1, 1, 1, 1]);

      fixture.layer.setParams({ irBoost: true });
      fixture.driveFleetModel({ icao24, position, course: 92 });
      const boosted = fleet.items.get(icao24);
      assert.notEqual(boosted, normal, 'the boost writes the item again');
      assert.equal(boosted.shading, 'unlit');
      assert.deepEqual(boosted.tint, [1, 1, 1, 1]);
      assert.deepEqual(boosted.colorBlend, { mode: 'mix', amount: 1 });
      assert.equal(
        fixture.ensureFleetModel(icao24),
        record,
        'the same model restyles; nothing reloads',
      );
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
      sampleHeight: () => {
        sampleCalls++;
        return sampledHeight;
      },
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

      let ownsVisual = fixture.driveFleetModel({
        icao24,
        position,
        course: 92,
      });
      assert.equal(
        ownsVisual,
        false,
        'cold terrain cannot transfer ownership to 3D',
      );
      assert.equal(
        model.show,
        false,
        'the ready primitive is hidden until ground resolves',
      );
      assert.equal(
        billboard.show,
        true,
        'the 2D contact returns in the same handoff turn',
      );
      assert.ok(
        model.show || billboard.show,
        'the contact never has both visuals hidden',
      );
      assert.equal(sampleCalls, 0, 'cold tiles do not force sampleHeight');

      // Streaming tiles are not a miss, so they earn no retry backoff: the
      // first frame after the tiles settle samples and hands over.
      now += 100;
      viewer.tileset.tilesLoaded = true;
      ownsVisual = fixture.driveFleetModel({ icao24, position, course: 92 });
      assert.equal(
        ownsVisual,
        true,
        'the model takes over on the first settled frame',
      );
      assert.equal(
        sampleCalls,
        1,
        'the settled terrain is sampled exactly once',
      );
      assert.equal(model.show, true);
      assert.equal(billboard.show, false);
      assert.ok(
        model.show || billboard.show,
        'successful handoff keeps a visible owner',
      );
      const placed = placedAt(model);
      const placedHeight = Cesium.Cartographic.fromCartesian(placed).height;
      assert.ok(
        Math.abs(placedHeight - (sampledHeight + fixture.bellyM)) < 0.001,
        `placement uses the exact ${fixture.bellyM} m asset-measured belly offset`,
      );

      viewer.tileset.tilesLoaded = false;
      const datumShifted = Cesium.Cartesian3.fromDegrees(-97.71, 30.21, -500);
      ownsVisual = fixture.driveFleetModel({
        icao24,
        position: datumShifted,
        course: 92,
      });
      assert.equal(
        ownsVisual,
        true,
        'a poll-time vertical datum change does not invalidate a stationary snap',
      );
      assert.equal(
        sampleCalls,
        1,
        'the height-normalized cache does not resample vertically',
      );
      assert.ok(
        model.show || billboard.show,
        'datum transition keeps a visible owner',
      );

      // Taxi past the 50 m resample threshold while the tiles are gone. The old
      // snap stops being the direct answer, but it is still a MEASUREMENT of
      // ground this contact was standing on ~96 m ago, so it is held: hiding the
      // model here would pop a taxiing aircraft from 3D to 2D until the tiles
      // return, which is the one thing the gate must not introduce.
      const taxied = Cesium.Cartesian3.fromDegrees(-97.709, 30.21, -500);
      ownsVisual = fixture.driveFleetModel({
        icao24,
        position: taxied,
        course: 92,
      });
      assert.equal(
        ownsVisual,
        true,
        'a taxi-invalidated snap is HELD through the resample outage, not dropped',
      );
      assert.equal(
        model.show,
        true,
        'no 3D→2D pop while the resample waits for tiles',
      );
      assert.equal(billboard.show, false);
      assert.equal(
        sampleCalls,
        1,
        'and the hold costs no extra synchronous sample',
      );
      const held = placedAt(model);
      assert.ok(
        Math.abs(
          Cesium.Cartographic.fromCartesian(held).height -
            (sampledHeight + fixture.bellyM),
        ) < 0.001,
        'the hold places the model on the last MEASURED floor, not on the feed altitude',
      );

      // Past the drift bound the memory stops describing anywhere this contact
      // has been, so it is dropped rather than stretched and the gate takes over.
      const farTaxied = Cesium.Cartesian3.fromDegrees(-97.707, 30.21, -500); // ~289 m out
      ownsVisual = fixture.driveFleetModel({
        icao24,
        position: farTaxied,
        course: 92,
      });
      assert.equal(
        ownsVisual,
        false,
        'past HELD_SNAP_MAX_DRIFT_M the hold is released and the model is withheld',
      );
      assert.equal(model.show, false);
      assert.equal(billboard.show, true);
      assert.ok(
        model.show || billboard.show,
        'release returns atomically to 2D',
      );

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
      assert.equal(
        ownsVisual,
        false,
        'a missing/failed model never claims ownership',
      );
      assert.equal(
        failedBillboard.show,
        true,
        'load failure keeps the billboard visible',
      );
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
      sampleHeight: () => {
        sampleCalls++;
        return sampled;
      },
    });
    const icao24 = fixture.name === 'flights' ? 'a0f103' : 'b0f103';
    const model = {
      modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      ready: true,
      show: true,
    };
    /** Height (m) the model's matrix currently places it at. */
    const placedHeightM = () =>
      Cesium.Cartographic.fromCartesian(placedAt(model)).height;

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
        Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(
          atA,
          new Cesium.Cartesian3(),
        ),
        Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(
          atB,
          new Cesium.Cartesian3(),
        ),
      );
      assert.ok(
        taxiM > 50 && taxiM < 250,
        `the repro must sit INSIDE the drift bound to be a repro (taxi ${taxiM.toFixed(1)} m)`,
      );

      // A: the snap resolves and the model takes the visual.
      let ownsVisual = fixture.driveFleetModel({
        icao24,
        position: atA,
        course: 92,
      });
      assert.equal(
        ownsVisual,
        true,
        'a measured snap at A hands the visual to the model',
      );
      assert.equal(sampleCalls, 1);
      assert.ok(
        Math.abs(placedHeightM() - (sampled + fixture.bellyM)) < 0.001,
        'the model stands on the measured 120 m at A',
      );

      // Something measures B's surface — the mesh-floor cells the billboard
      // chain and meshFloorSampler share. This is the fresh evidence.
      reportMeshFloorCell(LAT, B_LON, B_GROUND_M);

      // B, with the resample missing: tiles gone, so no sample can land.
      viewer.tileset.tilesLoaded = false;
      now += 60_000;
      ownsVisual = fixture.driveFleetModel({
        icao24,
        position: atB,
        course: 92,
      });
      assert.equal(sampleCalls, 1, 'the missing resample fires no new sample');
      assert.equal(
        ownsVisual,
        false,
        'a held measurement contradicted by measured ground must not place the model',
      );
      assert.equal(model.show, false, 'nothing is drawn 30 m under the apron');
      assert.equal(
        billboard.show,
        true,
        'the floored 2D billboard is the honest fallback',
      );
      assert.ok(
        model.show || billboard.show,
        'the release is atomic — never both hidden',
      );

      // "If the contact remains at B, misses can preserve that burial forever."
      // They cannot: the hold is gone, so every later miss re-answers COLD.
      for (let i = 0; i < 5; i++) {
        now += 60_000;
        assert.equal(
          fixture.driveFleetModel({ icao24, position: atB, course: 92 }),
          false,
          'repeated misses must not resurrect the dropped hold',
        );
        assert.equal(model.show, false);
      }

      // And when evidence does arrive, it is B's ground the model stands on.
      sampled = B_GROUND_M;
      viewer.tileset.tilesLoaded = true;
      now += 60_000;
      ownsVisual = fixture.driveFleetModel({
        icao24,
        position: atB,
        course: 92,
      });
      assert.equal(ownsVisual, true, 'a fresh sample at B restores the model');
      assert.equal(sampleCalls, 2);
      assert.ok(
        Math.abs(placedHeightM() - (B_GROUND_M + fixture.bellyM)) < 0.001,
        "the restored model stands on B's 150 m, not on the stale 120 m",
      );

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
        Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(
          atB,
          new Cesium.Cartesian3(),
        ),
        Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(
          atC,
          new Cesium.Cartesian3(),
        ),
      );
      assert.ok(
        rollM > 50 && rollM < 250,
        `the downhill leg must also sit inside the bound (roll ${rollM.toFixed(1)} m)`,
      );
      reportMeshFloorCell(LAT, C_LON, B_GROUND_M - 50); // measured LOWER than the hold
      viewer.tileset.tilesLoaded = false;
      now += 60_000;
      ownsVisual = fixture.driveFleetModel({
        icao24,
        position: atC,
        course: 92,
      });
      assert.equal(
        ownsVisual,
        true,
        'a cell reading BELOW the hold is the floor chain under-reading, not burial — the hold stands',
      );
      assert.equal(
        model.show,
        true,
        'the contact keeps its model through a downhill taxi',
      );
      assert.ok(
        Math.abs(placedHeightM() - (B_GROUND_M + fixture.bellyM)) < 0.001,
        'and it keeps standing on the measurement it actually has',
      );
    } finally {
      Date.now = realNow;
      fixture.layer.stopTracking();
      _clearMeshFloorCellsForTest();
    }
  });

  test(`${fixture.name}: grounded tracked model waits for a valid terrain snap with no visual gap`, () => {
    clearTr3bRegistry();
    fixture.layer.stopTracking();
    fixture.layer.setParams({ models3d: true });

    const realNow = Date.now;
    let now = 3_000_000;
    Date.now = () => now;
    let sampleCalls = 0;
    let sampledHeight = undefined;
    const viewer = viewerAtHeight(30_000, {
      tilesLoaded: false,
      sampleHeight: () => {
        sampleCalls++;
        return sampledHeight;
      },
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
      assert.deepEqual(
        [...tracked.items.keys()],
        [icao24],
        'the tracked set loads the one model for the contact',
      );
      assert.equal(model.ready, false, 'the model is still loading');
      assert.equal(
        model.show,
        false,
        'the loading model is drawn hidden, not zero-scaled',
      );
      assert.equal(tracked.items.get(icao24).show, false);
      const baseScale = model.scale;
      assert.equal(
        fixture.trackedBillboardColor()[3],
        1,
        'the tracked billboard remains opaque while the model lacks safe placement',
      );
      assert.equal(
        sampleCalls,
        0,
        'cold tiles do not force a synchronous sample',
      );
      const loadingDetection = fixture.layer
        .getDetectableObjects({ maxCount: 50 })
        .find(
          (object) =>
            object.sourceId ===
            (fixture.name === 'flights' ? 'a0f001' : 'b0f001'),
        );
      assert.ok(
        loadingDetection,
        'the tracked billboard remains detectable while its model loads',
      );
      assert.ok(
        Cesium.Cartesian3.equalsEpsilon(
          loadingDetection.position,
          billboard.position,
          0,
          1e-6,
        ),
        'a hidden tracked model cannot steal the detection anchor',
      );
      billboard.show = false; // tracking hides the fleet sprite; the tracked entity remains the 2D owner
      const loadingNearby = fixture.layer
        .getNearby(billboard.position, 1_000, 50)
        .find(
          (object) =>
            object.icao24 ===
            (fixture.name === 'flights' ? 'a0f001' : 'b0f001'),
        );
      assert.ok(
        loadingNearby,
        'the tracked contact remains in proximity while its model loads',
      );
      assert.ok(
        Cesium.Cartesian3.equalsEpsilon(
          loadingNearby.position,
          billboard.position,
          0,
          1e-6,
        ),
        'a hidden tracked model cannot steal the proximity position',
      );

      // Streaming tiles earned no backoff, so the first settled turn samples.
      now += 100;
      viewer.tileset.tilesLoaded = true;
      sampledHeight = 187.5;
      fixture.driveTrackedModel();
      assert.equal(sampleCalls, 1, 'the first settled turn samples once');
      assert.equal(
        model.show,
        false,
        'terrain alone does not reveal an unready model',
      );
      assert.equal(
        fixture.trackedBillboardColor()[3],
        1,
        'the billboard retains ownership until GPU readiness too',
      );

      assert.equal(
        model.scale,
        baseScale,
        'its scale is left to the pixel-cap driver',
      );
      viewer.draw.ready(tracked.spec.id, icao24);
      fixture.driveTrackedModel();
      assert.equal(
        model.show,
        true,
        'the model appears only after its snapped matrix is written',
      );
      assert.equal(tracked.items.get(icao24).show, true);
      assert.equal(
        fixture.trackedBillboardColor()[3],
        0,
        'the billboard becomes transparent only when the model actually owns the visual',
      );
      const placed = placedAt(model);
      const placedHeight = Cesium.Cartographic.fromCartesian(placed).height;
      assert.ok(
        Math.abs(placedHeight - (sampledHeight + fixture.bellyM)) < 0.001,
        `tracked placement uses the exact ${fixture.bellyM} m asset-measured belly offset`,
      );

      viewer.tileset.tilesLoaded = false;
      sampledHeight = undefined;
      billboard.position = Cesium.Cartesian3.fromDegrees(-97.71, 30.21, -500);
      fixture.driveTrackedModel();
      assert.equal(
        model.show,
        true,
        'a successful cached snap survives a poll-time vertical datum change',
      );
      assert.equal(
        sampleCalls,
        1,
        'a stationary vertical-only change does not consume another terrain sample',
      );

      // Taxi past the resample threshold with the tiles gone: the tracked model
      // holds its last measured floor rather than handing the operator's own
      // selection back to a 2D glyph until the tiles return.
      billboard.position = Cesium.Cartesian3.fromDegrees(-97.709, 30.21, -500);
      fixture.driveTrackedModel();
      assert.equal(
        model.show,
        true,
        'a taxi-invalidated tracked snap is HELD through the resample outage',
      );
      assert.equal(
        fixture.trackedBillboardColor()[3],
        0,
        'the model still owns the visual, so the billboard stays transparent',
      );
      assert.equal(
        sampleCalls,
        1,
        'the hold costs no extra synchronous sample',
      );

      // Past the drift bound the memory is released and the gate takes over.
      billboard.position = Cesium.Cartesian3.fromDegrees(-97.707, 30.21, -500);
      fixture.driveTrackedModel();
      assert.equal(
        model.show,
        false,
        'past HELD_SNAP_MAX_DRIFT_M the hold is released and the model is withheld',
      );
      assert.equal(
        fixture.trackedBillboardColor()[3],
        1,
        'there is no invisible-owner gap while the replacement snap is unavailable',
      );
    } finally {
      Date.now = realNow;
      fixture.layer.stopTracking();
    }
  });

  test(`${fixture.name}: the tracked contact draws as a model exactly when the fleet would`, () => {
    clearTr3bRegistry();
    try {
      fixture.layer.setParams({ models3d: true });
      const viewer = viewerAtHeight(30_000);
      fixture.seed({ viewer, trackedModelEligible: true });
      assert.equal(
        fixture.regimeActive(),
        true,
        'a place in the fleet cap: a model',
      );
      fixture.seed({ viewer, trackedModelEligible: false });
      assert.equal(
        fixture.regimeActive(),
        false,
        'no place in the fleet cap: its icon, however close the camera',
      );

      // The fleet's own regime: 3D on and the camera below the ceiling.
      fixture.seed({
        viewer: viewerAtHeight(900_000),
        trackedModelEligible: true,
      });
      assert.equal(
        fixture.regimeActive(),
        false,
        'above the fleet ceiling: its icon',
      );
      fixture.layer.setParams({ models3d: false });
      fixture.seed({ viewer, trackedModelEligible: true });
      assert.equal(
        fixture.regimeActive(),
        false,
        'with 3D off the fleet draws icons, and so does the selected contact',
      );
    } finally {
      fixture.layer.setParams({ models3d: false });
      fixture.layer.stopTracking();
    }
  });

  test(`${fixture.name}: selecting a contact keeps the form its fleet visual had`, () => {
    clearTr3bRegistry();
    try {
      fixture.layer.setParams({ models3d: true });
      const viewer = viewerAtHeight(30_000);
      // A contact the fleet drew as a model stays a model...
      fixture.seed({
        viewer,
        models: [[ICAO, { ready: true }]],
        trackedModelEligible: null,
      });
      assert.equal(
        fixture.regimeActive(),
        true,
        'a fleet model: the tracked model',
      );
      // ...and one it drew as an icon stays an icon.
      fixture.layer.stopTracking();
      fixture.seed({ viewer, models: [], trackedModelEligible: null });
      assert.equal(
        fixture.regimeActive(),
        false,
        'a fleet icon: the tracked icon',
      );
    } finally {
      fixture.layer.setParams({ models3d: false });
      fixture.layer.stopTracking();
    }
  });

  test(`${fixture.name}: the fleet model keeps drawing the selected contact until its tracked model draws`, () => {
    clearTr3bRegistry();
    try {
      fixture.layer.setParams({ models3d: true });
      const viewer = viewerAtHeight(30_000);
      const position = Cesium.Cartesian3.fromDegrees(-97.71, 30.21, 10_668);
      fixture.seed({
        viewer,
        models: [
          [
            ICAO,
            {
              ready: true,
              show: true,
              modelMatrix: Cesium.Matrix4.fromTranslation(position),
            },
          ],
        ],
        trackedModelEligible: null,
      });
      fixture.driveTrackedModel();
      const tracked = fixture.trackedModel();
      assert.ok(tracked, 'the tracked model loads');
      assert.equal(tracked.ready, false);
      assert.ok(
        fixture.ensureFleetModel(ICAO),
        'the fleet model is kept while it loads',
      );
      assert.equal(
        fixture.trackedBillboardColor()[3],
        0,
        'and it is the visual: the tracked icon stays clear, no icon flash',
      );

      viewer.draw.ready(modelSet(fixture, viewer, 'tracked').spec.id, ICAO);
      fixture.driveTrackedModel();
      const kept = fixture.ensureFleetModel(ICAO);
      assert.ok(kept, 'once the tracked model draws, the fleet model is kept');
      assert.equal(kept.ready, true, 'loaded');
      assert.equal(kept.show, false, 'but hidden: one model draws the contact');
      assert.equal(
        fixture.trackedBillboardColor()[3],
        0,
        'the tracked model is the visual',
      );
    } finally {
      fixture.layer.setParams({ models3d: false });
      fixture.layer.stopTracking();
    }
  });

  test(`${fixture.name}: deselecting hands the contact straight back to its loaded fleet model, with no icon flash`, () => {
    clearTr3bRegistry();
    try {
      fixture.layer.setParams({ models3d: true });
      const viewer = viewerAtHeight(30_000);
      const position = Cesium.Cartesian3.fromDegrees(-97.71, 30.21, 10_668);
      const icon = fixture.seed({
        viewer,
        models: [
          [
            ICAO,
            {
              ready: true,
              show: true,
              modelMatrix: Cesium.Matrix4.fromTranslation(position),
            },
          ],
        ],
        trackedModelEligible: null,
      });
      fixture.driveTrackedModel();
      viewer.draw.ready(modelSet(fixture, viewer, 'tracked').spec.id, ICAO);
      fixture.driveTrackedModel();
      assert.equal(
        fixture.trackedModel().ready,
        true,
        'the tracked model draws',
      );
      icon.show = false; // as selecting it hides it

      fixture.layer.stopTracking();
      const fleetItem = modelSet(fixture, viewer, 'fleet').items.get(ICAO);
      assert.equal(
        fleetItem?.show,
        true,
        'the kept fleet model draws the contact in the same frame',
      );
      assert.equal(icon.show, false, 'and its icon never shows');
      assert.equal(
        modelSet(fixture, viewer, 'tracked').items.has(ICAO),
        false,
        'the tracked model is gone',
      );
    } finally {
      fixture.layer.setParams({ models3d: false });
      fixture.layer.stopTracking();
    }
  });

  test(`${fixture.name}: deselecting shows the icon only when no fleet model is loaded`, () => {
    clearTr3bRegistry();
    try {
      fixture.layer.setParams({ models3d: true });
      const viewer = viewerAtHeight(30_000);
      // Selected as an icon: no fleet model at all.
      let icon = fixture.seed({
        viewer,
        models: [],
        trackedModelEligible: null,
      });
      fixture.layer.stopTracking();
      assert.equal(icon.show, true, 'no fleet model: the icon');

      // A fleet model still loading when it is deselected.
      icon = fixture.seed({
        viewer,
        models: [[ICAO, { ready: false, show: false }]],
        trackedModelEligible: null,
      });
      fixture.layer.stopTracking();
      assert.equal(icon.show, true, 'a fleet model not loaded yet: the icon');
      assert.notEqual(
        modelSet(fixture, viewer, 'fleet').items.get(ICAO)?.show,
        true,
        'and the model stays hidden until it loads',
      );

      // 3D turned off meanwhile: the icon, and the fleet model goes.
      icon = fixture.seed({
        viewer,
        models: [[ICAO, { ready: true, show: false }]],
        trackedModelEligible: null,
      });
      fixture.layer.setParams({ models3d: false });
      fixture.layer.stopTracking();
      assert.equal(icon.show, true, '3D off: the icon');
      assert.equal(fixture.ensureFleetModel(ICAO), null, 'no fleet model kept');
    } finally {
      fixture.layer.setParams({ models3d: false });
      fixture.layer.stopTracking();
    }
  });

  test(`${fixture.name}: the tracked model draws at the fleet's scale and minimum pixel size, even up close`, () => {
    clearTr3bRegistry();
    try {
      fixture.layer.setParams({ models3d: true });
      const position = Cesium.Cartesian3.fromDegrees(-97.71, 30.21, 10_668);
      // The eye 120 m off the aircraft: the old tracked pixel cap shrank it here.
      const viewer = viewerAtHeight(30_000, {
        eye: Cesium.Cartesian3.fromDegrees(-97.71, 30.211, 10_668),
      });
      const icao24 = fixture.name === 'flights' ? 'a0f501' : 'b0f501';

      // The fleet's model of the contact, unselected.
      fixture.seed({ viewer, tracked: false, icao24 });
      const fleetRecord = fixture.ensureFleetModel(icao24);
      fixture.driveFleetModel({ icao24, position });
      const fleetSet = modelSet(fixture, viewer, 'fleet');
      viewer.draw.ready(fleetSet.spec.id, icao24);
      fixture.driveFleetModel({ icao24, position });
      const fleetItem = fleetSet.items.get(icao24);
      assert.ok(fleetRecord && fleetItem);

      // The same contact selected.
      fixture.seed({ viewer, icao24 });
      fixture.driveTrackedModel();
      const trackedSet = modelSet(fixture, viewer, 'tracked');
      viewer.draw.ready(trackedSet.spec.id, icao24);
      fixture.driveTrackedModel();
      const trackedItem = trackedSet.items.get(icao24);
      assert.equal(fixture.trackedModel().ready, true);
      assert.equal(trackedItem.show, true);
      assert.equal(trackedItem.url, fleetItem.url, 'the same model');
      assert.equal(trackedItem.scale, fleetItem.scale, 'the same scale');
      assert.equal(
        trackedItem.minPixelSize,
        fleetItem.minPixelSize,
        'the same minimum pixel size',
      );
      assert.deepEqual(trackedItem.tint, fleetItem.tint, 'the same colour');
      assert.deepEqual(
        trackedItem.colorBlend,
        fleetItem.colorBlend,
        'the same colour blend',
      );
    } finally {
      fixture.layer.setParams({ models3d: false });
      fixture.layer.stopTracking();
    }
  });

  test(`${fixture.name}: the tracked icon is drawn as its fleet icon is`, () => {
    clearTr3bRegistry();
    try {
      const viewer = viewerAtHeight(30_000);
      fixture.seed({ viewer });
      const { tracked, fleet } = fixture.trackedIconLook(ICAO);
      assert.equal(tracked.image, fleet.image, 'the same glyph');
      assert.deepEqual(
        tracked.imageLod,
        fleet.imageLod,
        'the same close-up glyph',
      );
      assert.deepEqual(
        [tracked.sprite.width, tracked.sprite.height],
        fleet.size,
        'the same size',
      );
      assert.equal(tracked.sprite.scale, fleet.scale, 'the same scale');
      assert.deepEqual(
        tracked.sprite.scaleByDistance,
        fleet.scaleByDistance,
        'the same scale by distance',
      );
      assert.deepEqual(tracked.color, fleet.color, 'the same colour');
      // A landing changes the fleet icon's scale, and the tracked one's with it.
      fixture.seed({ viewer, onGround: true });
      const grounded = fixture.trackedIconLook(ICAO);
      assert.notEqual(grounded.fleet.scale, fleet.scale);
      assert.equal(grounded.tracked.sprite.scale, grounded.fleet.scale);
    } finally {
      fixture.layer.stopTracking();
    }
  });

  test(`${fixture.name}: a converted TR-3B never takes the model`, () => {
    clearTr3bRegistry();
    try {
      fixture.layer.setParams({ models3d: true });
      const viewer = viewerAtHeight(1); // as zoomed in as it gets
      fixture.seed({ viewer });
      assert.equal(
        fixture.regimeActive(),
        true,
        'control: an unconverted contact does model',
      );

      setTr3b(ICAO, true);
      fixture.seed({ viewer });
      assert.equal(
        fixture.regimeActive(),
        false,
        'there is no TR-3B GLB — the triangle billboard stays the visual all the way in',
      );

      setTr3b(ICAO, false);
      fixture.seed({ viewer });
      assert.equal(
        fixture.regimeActive(),
        true,
        'un-converting restores the handoff',
      );
    } finally {
      clearTr3bRegistry();
      fixture.layer.setParams({ models3d: false });
      fixture.layer.stopTracking();
    }
  });

  test(`${fixture.name}: deselecting drops the tracked model`, () => {
    clearTr3bRegistry();
    try {
      fixture.layer.setParams({ models3d: true });
      const viewer = viewerAtHeight(1);
      fixture.seed({ viewer });
      assert.equal(fixture.regimeActive(), true);

      fixture.seed({ viewer, tracked: false }); // nothing selected
      assert.equal(
        fixture.regimeActive(),
        false,
        'with no selection there is no tracked model to own the visual',
      );
    } finally {
      fixture.layer.setParams({ models3d: false });
      fixture.layer.stopTracking();
    }
  });
}

test('both layers reset the per-selection tracked-model state', async () => {
  for (const name of ['flights.js', 'militaryFlights.js']) {
    const source = readLayerSource(new URL(`./${name}`, import.meta.url));
    // The reset must be reachable from the real teardown, not only a test seam.
    assert.match(
      source,
      /(?:parts\.\w+\.)?_releaseTrackedModel\(\s*,?\s*\);\n\s*(?:parts\.\w+\.)?_resetTrackedSelectionState\(\s*,?\s*\);/,
      `${name}: deselect clears the per-selection state in the production path`,
    );
    assert.match(
      source,
      /(?:(?:flightState|state)\.)?_trackedIcao\s*=\s*icao24;\n\s*(?:parts\.\w+\.)?_resetTrackedSelectionState\(\s*,?\s*\);/,
      `${name}: selecting a contact starts from a clean per-selection state`,
    );
  }
});

test('the tracked model follows the fleet model rule, and the fleet the 3D toggle', async () => {
  for (const name of ['flights.js', 'militaryFlights.js']) {
    const source = readLayerSource(new URL(`./${name}`, import.meta.url));
    const regime =
      /^([ \t]*)function _trackedModelRegimeActive\b[\s\S]*?\n\1\}/m.exec(
        source,
      )?.[0];
    assert.ok(regime, `${name}: _trackedModelRegimeActive is defined`);
    assert.match(
      regime,
      /_trackedModelEligible === true/,
      `${name}: the tracked contact takes its place in the fleet cap`,
    );
    assert.match(
      regime,
      /(?:parts\.\w+\.)?_modelRegimeActive\(\s*\)/,
      `${name}: and the fleet's regime`,
    );
    const fleet = /^([ \t]*)function _modelRegimeActive\b[\s\S]*?\n\1\}/m.exec(
      source,
    )?.[0];
    assert.match(
      fleet,
      /if\s*\(\s*!(?:(?:flightState|state)\.)?_models3dEnabled,?\s*\)\s*return\s*false;/,
      `${name}: the fleet regime still obeys the DISPLAY-rail 3D toggle`,
    );
  }
});
