import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../geo/index.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import {
  aircraftAtlasLayout,
  createAircraftDisplay,
} from './render/display.js';
import flightsLayer, {
  _setTrackedFlightRefreshStateForTest,
  _updateTrackedModelForTest as flightsDriveTrackedModel,
  _trackedBillboardColorForTest as flightsTrackedBillboardColor,
} from '../../data/flights.js';
import militaryFlightsLayer, {
  _setTrackedMilitaryRefreshStateForTest,
  _updateTrackedModelForTest as militaryDriveTrackedModel,
  _trackedBillboardColorForTest as militaryTrackedBillboardColor,
} from '../../data/militaryFlights.js';
import { clearTr3bRegistry } from '../../data/tr3bRegistry.js';
import { applyAircraftModelTreatment } from '../../data/aircraftRecession.js';
import { recordingAircraftRenderer } from '../../testSupport/aircraftRecordingRenderer.mjs';
import { fleetTickFixture } from '../../testSupport/fleetTickFixture.mjs';
import { createFlightState as civilState } from '../flights/state.js';
import { createRendering as civilRendering } from '../flights/rendering.js';
import { createFlightState as militaryState } from '../military/state.js';
import { createRendering as militaryRendering } from '../military/rendering.js';

globalThis.window ??= {
  dispatchEvent: () => true,
  addEventListener() {},
  removeEventListener() {},
};

const layout = aircraftAtlasLayout();
const drawAtlas = async () => ({
  canvas: { width: layout.width, height: layout.height },
  cells: layout.cells,
});

const settle = () => new Promise(setImmediate);

async function displayFixture(t, failures = 1) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const engine = createFakeEngine();
  const attempts = [];
  engine.fake.script('moverFailed', (id, index, attempt) => {
    if (!id.includes('-models-')) return false;
    attempts.push({ index, attempt });
    return index === 0 && attempt <= failures;
  });
  const display = createAircraftDisplay(engine, {
    layerId: 'flights',
    headingOffsetDeg: 180,
    drawAtlas,
  });
  t.after(() => {
    display.destroy();
    engine.destroy();
  });
  await display.whenReady();
  display.fleet.attach();
  return { display, engine, attempts };
}
const spec = (id) => ({
  url: 'airliner.glb',
  minimumPixelSize: 64,
  scale: 1,
  id,
});
const position = geo.cartesian3.fromDegrees(1, 0, 1000);

async function addModel(display, id, tracked = false) {
  const model = await display.models[tracked ? 'loadTracked' : 'loadFleet'](
    spec(id),
  );
  display.models.add(model);
  display.models.setPose(model, position, 0);
  await settle();
  return model;
}

test('a tracked model becomes ready in its original set after the engine retries', async (t) => {
  const { display, attempts } = await displayFixture(t);
  const model = await addModel(display, 'tracked', true);
  const set = model.gevBank.set;
  assert.equal(model.failed, true);
  assert.equal(model.ready, false);
  t.mock.timers.tick(1499);
  assert.equal(attempts.length, 1);
  t.mock.timers.tick(1);
  assert.equal(model.ready, true);
  assert.equal(model.failed, false);
  assert.equal(model.gevBank.set, set);
});

/** A viewer stub inside the tracked model regime. */
function viewerAt(height) {
  const viewer = {
    camera: {
      positionCartographic: { height },
      positionWC: Cesium.Cartesian3.fromDegrees(-97.71, 30.21, 5000),
      frustum: { fovy: Cesium.Math.toRadians(60) },
    },
    scene: {
      canvas: { clientHeight: 900 },
      frameState: { frameNumber: 1 },
      primitives: { length: 0, get() {} },
      sampleHeight: () => undefined,
    },
    trackedEntity: undefined,
    entities: { remove() {} },
  };
  viewer.engine = createFakeEngine();
  viewer.engine.fake.script('sampleHeightDetailed', undefined);
  return viewer;
}

const LAYERS = [
  {
    name: 'flights',
    layer: flightsLayer,
    seed: _setTrackedFlightRefreshStateForTest,
    drive: flightsDriveTrackedModel,
    billboardColor: flightsTrackedBillboardColor,
    meta: { callsign: 'TEST123 ', altitude: 10_668, klass: 'airliner' },
  },
  {
    name: 'military',
    layer: militaryFlightsLayer,
    seed: _setTrackedMilitaryRefreshStateForTest,
    drive: militaryDriveTrackedModel,
    billboardColor: militaryTrackedBillboardColor,
    meta: { callsign: 'TEST123 ', altitudeFt: 35_000, klass: 'fastjet' },
  },
];

for (const fixture of LAYERS)
  for (const failures of [1, 3])
    test(`${fixture.name}: tracked fallback survives ${failures} failed attempts without replacing the handle`, async (t) => {
      clearTr3bRegistry();
      fixture.layer.setParams({ models3d: false });
      const { engine, display, attempts } = await displayFixture(t, failures);
      const viewer = viewerAt(30_000);
      viewer.engine = engine;
      let handles = 0;
      const removed = [];
      const billboard = {
        position: geo.cartesian3.fromDegrees(-97.71, 30.21, 10_668),
        color: null,
        show: true,
        rotation: 0,
      };
      fixture.seed({
        renderer: () =>
          recordingAircraftRenderer(engine, {
            view: { camera: viewer.camera, scene: viewer.scene },
            fleet: { shown: true },
            models: {
              ...display.models,
              loadTracked: (spec) => {
                handles++;
                return display.models.loadTracked(spec);
              },
              remove: (model) => {
                removed.push(model);
                display.models.remove(model);
              },
            },
          }),
        icao24: 'abc123',
        entity: null,
        billboard,
        billboardCollection: { show: true, remove() {} },
        viewer,
        tracked: true,
        meta: { ...fixture.meta, onGround: false },
      });
      try {
        fixture.drive();
        await settle();
        fixture.drive();
        assert.equal(fixture.billboardColor().alpha, 1);
        for (let frame = 0; frame < 5; frame++) {
          t.mock.timers.tick(1500);
          fixture.drive();
          await settle();
        }
        assert.equal(handles, 1);
        assert.equal(removed.length, 0);
        assert.equal(attempts.length, failures === 3 ? 3 : 2);
        if (failures === 3) assert.equal(fixture.billboardColor().alpha, 1);
        else
          assert.equal(
            fixture.billboardColor().alpha,
            0,
            'the recovered model owns the visual',
          );
      } finally {
        fixture.layer.stopTracking();
      }
    });

test('a failed fleet model does not reload healthy aircraft when another joins its class', async (t) => {
  const { display, attempts } = await displayFixture(t);
  const first = await addModel(display, 'a');
  const healthy = await addModel(display, 'b');
  const set = first.gevBank.set;
  const next = await addModel(display, 'c');
  assert.equal(first.failed, true);
  assert.equal(healthy.ready, true);
  assert.equal(next.ready, true);
  assert.equal(next.gevBank.set, set);
  t.mock.timers.tick(1500);
  assert.equal(first.ready, true);
  assert.deepEqual(attempts, [
    { index: 0, attempt: 1 },
    { index: 1, attempt: 1 },
    { index: 2, attempt: 1 },
    { index: 0, attempt: 2 },
  ]);
});

for (const [name, createFlightState, createRendering] of [
  ['flights', civilState, civilRendering],
  ['military', militaryState, militaryRendering],
])
  for (const inView of [true, false])
    test(`${name}: the fleet retains a failed model through recovery (${inView ? 'in view' : 'beyond the horizon'})`, async (t) => {
      const { display } = await displayFixture(t);
      const fleet = fleetTickFixture({
        createFlightState,
        createRendering(options) {
          options.services.recession.applyAircraftModelTreatment =
            applyAircraftModelTreatment;
          return createRendering(options);
        },
      });
      Object.assign(fleet.flightState._renderer.models, display.models);
      if (inView)
        fleet.camera.positionWC = geo.cartesian3.fromDegrees(1, 0, 100);
      fleet.flightState._models3dEnabled = true;
      const model = await addModel(display, fleet.id);
      fleet.flightState._models.set(fleet.id, model);
      fleet.tick();
      assert.equal(fleet.flightState._models.get(fleet.id), model);
      assert.equal(fleet.billboard.show, inView);
      assert.equal(model.ready, false);
      t.mock.timers.tick(1500);
      fleet.tick();
      assert.equal(fleet.flightState._models.get(fleet.id), model);
      assert.equal(model.ready, true);
      assert.equal(model.show, inView);
      if (inView) assert.equal(fleet.billboard.show, false);
      assert.deepEqual(fleet.removed, []);
    });

test('removing failed handles retains the shared bank and retries a replacement identity', async (t) => {
  const { display, engine } = await displayFixture(t);
  const first = await addModel(display, 'a');
  const second = await addModel(display, 'b');
  const set = first.gevBank.set;
  display.models.remove(first);
  display.models.remove(second);
  await settle();
  assert.equal(set.count(), 0);
  assert.equal(set.isDestroyed(), false);
  const next = await addModel(display, 'c');
  assert.equal(next.gevBank.set, set);
  assert.equal(next.failed, true);
  t.mock.timers.tick(1500);
  assert.equal(next.ready, true);
  assert.equal(
    engine.movers.list().filter((row) => row.kind === 'model').length,
    1,
  );
});
