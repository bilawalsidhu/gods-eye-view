import assert from 'node:assert/strict';
import test from 'node:test';
import * as geo from '../geo/index.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { createCesiumMoversEngine } from '../testSupport/cesiumMoversEngine.mjs';
import { createApplicationFlights } from '../app/layers/flights.js';
import { createApplicationMilitary } from '../app/layers/militaryFlights.js';
import {
  createAircraftDisplay,
  aircraftAtlasLayout,
} from '../layers/aircraft/render/display.js';
import { createSceneServices } from './sceneServices.js';
import { defaultSurface } from './surfaceServices.js';
import * as militaryRegistry from './militaryRegistry.js';
import { getSelectedEntityContext } from './contextStore.js';

const layout = aircraftAtlasLayout();
const settle = () => new Promise((resolve) => setImmediate(resolve));
const height = (position) => geo.cartographic.fromCartesian(position).height;

function fakeHarness() {
  const engine = createFakeEngine();
  return { engine, frame: () => engine.fake.frame() };
}

for (const makeHarness of [fakeHarness, createCesiumMoversEngine]) {
  for (const [layerId, createLayer] of [
    ['flights', createApplicationFlights],
    ['military', createApplicationMilitary],
  ]) {
    test(`${makeHarness.name}: ${layerId} grounded models, follow readout and display floor share their frame`, async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      const previous = {
        window: globalThis.window,
        document: globalThis.document,
        fetch: globalThis.fetch,
      };
      globalThis.window = new EventTarget();
      globalThis.document = {
        body: { classList: { contains: () => false } },
        addEventListener() {},
        removeEventListener() {},
      };
      globalThis.fetch = async () => ({ ok: false });
      const h = makeHarness();
      const { engine } = h;
      engine.surface.sampleHeightDetailed = () => ({
        height: 204.5,
        source: 'tiles',
      });
      engine.surface.tilesLoaded = () => true;
      const publications = [];
      const services = createSceneServices(engine, {
        trackedOverlay: {
          setEntries(source, entries) {
            publications.push(entries[0]);
          },
          setVisible() {},
          clearSource() {},
        },
      });
      services.trackedReadout.init();
      let display;
      let callsign = 'GROUND1';
      const id = layerId === 'flights' ? 'aaa097' : 'bbb197';
      let floor;
      const surface = {
        ...defaultSurface,
        groundFloor: {
          ...defaultSurface.groundFloor,
          cachedGroundFloor: () => floor,
          resolveGroundFloorCellsBounded: async () => {},
        },
        meshFloor: { ...defaultSurface.meshFloor, warmMeshFloorCells() {} },
      };
      const layer = createLayer({
        surface,
        militaryRegistry,
        source: {
          label: 'Fixture aircraft',
          getSnapshot: async () => ({
            source: 'Fixture aircraft',
            complete: true,
            observedAtMs: Date.now(),
            records: [
              {
                id,
                callsign,
                latitude: 30.3,
                longitude: -97.6,
                onGround: true,
                baroAltitudeM: 0,
                courseDeg: 90,
                speedMps: 0,
                positionTimeMs: Date.now(),
                contactTimeMs: Date.now(),
              },
            ],
          }),
        },
        renderer: {
          create: ({ engine }) =>
            (display = createAircraftDisplay(engine, {
              layerId,
              drawAtlas: async () => ({
                canvas: { width: layout.width, height: layout.height },
                cells: layout.cells,
              }),
            })),
        },
      });
      t.after(() => {
        layer.disable();
        layer.destroy();
        services.destroy();
        engine.destroy();
        Object.assign(globalThis, previous);
      });
      engine.camera.setView({
        destination: geo.cartesian3.fromDegrees(-97.6, 30.3, 8000),
        pitch: -Math.PI / 2,
      });
      layer.init(null, { engine });
      layer.enable();
      layer.setParams({ models3d: true });
      await display.whenReady();
      await layer.update();
      floor = 204.5;
      async function frames(n = 6) {
        for (let i = 0; i < n; i++) {
          if (h.viewer)
            h.viewer.scene.frameState.frameNumber =
              (h.viewer.scene.frameState.frameNumber || 0) + 1;
          for (const model of h.loads ?? []) model.ready = true;
          t.mock.timers.tick(250);
          h.frame();
          await settle();
        }
      }
      await frames();
      assert.equal(layer.getAllPositions().length, 1);
      const fleet = layer.qaDrawn().find((row) => row.id === id);
      assert.ok(
        fleet.model?.ready && fleet.model.show,
        'a grounded fleet contact gets a ready, shown model',
      );
      assert.ok(
        height(fleet.model.position) >= 204.5 &&
          height(fleet.model.position) < 217,
        'the fleet model stands on the sampled ground',
      );
      assert.equal(layer.trackById(id, { origin: 'user' }), true);
      await frames();
      const follow = engine.camera.following();
      const native = follow.native;
      assert.equal(services.trackedReadout.activeId(), `${layerId}:${id}`);
      assert.equal(getSelectedEntityContext().id, id);
      const trackedModel = layer
        .qaDrawn()
        .find((row) => row.trackedModel)?.model;
      assert.ok(
        trackedModel?.ready && trackedModel.show,
        'the tracked model owns the visual',
      );
      const cameraPosition = native.gevDisplayPosition();
      assert.ok(cameraPosition);
      if (layerId === 'flights')
        assert.ok(
          height(native.gevDisplayPosition()) < 100,
          'a ready tracked model releases the billboard floor',
        );
      // While the model owns the visual the card sits on it, not on the
      // released billboard floor below it.
      const card = { ...publications.at(-1).position() };
      assert.deepEqual(
        card,
        { ...native.gevVisualPosition() },
        'the card anchors on the tracked model',
      );
      assert.ok(
        height(card) >= 204.5 && height(card) < 217,
        'the card stands with the model on the sampled ground',
      );
      const cached = { ...native.gevDisplayPosition() };
      publications.at(-1).position();
      assert.deepEqual(
        { ...native.gevDisplayPosition() },
        cached,
        'painting never advances the follow sample',
      );
      follow.retarget({ viewFrom: { x: 0, y: 0, z: 178000 } });
      await frames();
      const zoomedOut = layer.qaDrawn().find((row) => row.trackedModel)?.model;
      assert.ok(!zoomedOut?.show, 'zooming out releases the tracked model');
      assert.deepEqual(
        { ...publications.at(-1).position() },
        { ...follow.label.position() },
        'without a model the card uses the follow label cache',
      );
      if (layerId === 'flights')
        assert.ok(
          height(native.gevDisplayPosition()) >= 205.5,
          'the billboard regains its floor',
        );
      assert.equal(services.trackedReadout.activeId(), `${layerId}:${id}`);
      assert.equal(engine.camera.following(), follow);
      callsign = 'GROUND2';
      await layer.update();
      await frames();
      assert.equal(publications.at(-1).title, callsign);
      assert.equal(engine.camera.following(), follow);
      assert.ok(
        Math.abs(layer.getTrackedInfo().altitudeM) < 50,
        'sensor truth is independent of the display floor',
      );
    });
  }
}
