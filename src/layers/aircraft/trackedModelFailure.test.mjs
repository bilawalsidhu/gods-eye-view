// A tracked aircraft's glTF that the engine fails to load: the glyph stays
// the visual, the load is tried again after the backoff in a new mover set
// (a set does not load a failed glTF again), and a contact gives up after its
// failure budget.
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
import { recordingAircraftRenderer } from '../../testSupport/aircraftRecordingRenderer.mjs';

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

test('a failed tracked model loads again in a new set once it is removed', async (t) => {
  const engine = createFakeEngine();
  t.after(() => engine.destroy());
  const display = createAircraftDisplay(engine, {
    layerId: 'flights',
    headingOffsetDeg: 180,
    drawAtlas,
  });
  t.after(() => display.destroy());
  await display.whenReady();
  display.fleet.attach();
  const failing = new Set();
  engine.fake.script('moverFailed', (id) => failing.has(id));
  const spec = { url: 'plane.glb', minimumPixelSize: 64, scale: 1, id: 'abc' };

  const first = await display.models.loadTracked(spec);
  display.models.add(first);
  const failedSet = first.gevBank.set.id;
  assert.equal(first.failed, false);
  failing.add(failedSet);
  assert.equal(first.failed, true, 'the engine reports the failed load');
  display.models.remove(first);

  const retry = await display.models.loadTracked(spec);
  display.models.add(retry);
  assert.notEqual(retry.gevBank.set.id, failedSet, 'a new set loads it again');
  assert.equal(retry.failed, false);
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
  viewer.engine = {
    isDestroyed: () => false,
    surface: { tilesLoaded: () => true, sampleHeightDetailed: () => undefined },
  };
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

for (const fixture of LAYERS) {
  test(`${fixture.name}: a tracked model the engine fails to load is retried, then given up`, async () => {
    clearTr3bRegistry();
    fixture.layer.setParams({ models3d: false });
    const realNow = Date.now;
    const realWarn = console.warn;
    let now = 1_000_000;
    Date.now = () => now;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    let loads = 0;
    const removed = [];
    const viewer = viewerAt(30_000);
    try {
      const billboard = {
        position: Cesium.Cartesian3.fromDegrees(-97.71, 30.21, 10_668),
        color: null,
        show: true,
        rotation: 0,
      };
      fixture.seed({
        renderer: () =>
          recordingAircraftRenderer(viewer.engine, {
            view: { camera: viewer.camera, scene: viewer.scene },
            fleet: { shown: true },
            models: {
              live: () => true,
              loadTracked: async (spec) => {
                loads++;
                return {
                  spec,
                  failed: true,
                  ready: false,
                  show: false,
                  modelMatrix: geo.matrix4.create(),
                };
              },
              add() {},
              remove: (model) => removed.push(model),
              destroy() {},
              setPose: () => geo.matrix4.create(),
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
      for (let frame = 0; frame < 30; frame++) {
        fixture.drive();
        await Promise.resolve();
        await Promise.resolve();
        now += 2000; // past the retry backoff
      }
      assert.ok(loads > 1, `the failed load is tried again (${loads})`);
      assert.ok(loads <= 3, `within the failure budget (${loads})`);
      assert.equal(removed.length, loads, 'each failed model leaves the scene');
      assert.equal(warnings.length, 1, 'the give-up is announced once');
      assert.equal(
        fixture.billboardColor().alpha,
        1,
        'the tracked glyph stays the visual',
      );
    } finally {
      Date.now = realNow;
      console.warn = realWarn;
      fixture.layer.stopTracking();
    }
  });
}
