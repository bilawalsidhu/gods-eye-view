import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createLocalAdsbModels } from './models.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import {
  createAircraftDisplay,
  aircraftAtlasLayout,
} from '../aircraft/render/display.js';

test('ground snapping excludes the aircraft by its engine pick id', async () => {
  const position = geo.cartesian3.fromDegrees(0, 0, 0);
  const model = { ready: true };
  const renderer = {
    models: {
      loadFleet: async () => model,
      add() {},
      remove() {},
      destroy() {},
      setPose() {},
    },
    view: {
      camera: {
        positionWC: geo.cartesian3.fromDegrees(0, 0, 100),
        positionCartographic: { height: 100 },
      },
      frustumTester: () => () => true,
      horizon: () => ({ isPointVisible: () => true }),
      engine: {},
    },
  };
  const exclusions = [];
  const models = createLocalAdsbModels({
    renderer,
    color: {},
    resolveAsset: (url) => url,
    groundSnap: {
      heightFor(engine, id, position, exclude) {
        exclusions.push(exclude());
        return 0;
      },
    },
  });
  const markers = new Map([
    [
      'local-adsb:abc123',
      { position, entity: {}, klass: 'airliner', onGround: true },
    ],
  ]);
  models.frame(markers, { models3d: true }, 1000);
  await new Promise(setImmediate);
  models.frame(markers, { models3d: true }, 1100);
  assert.deepEqual(exclusions, [['local-adsb:abc123']]);
  models.destroy();
});

test('a failed model retains its slot and the marker until the engine retry succeeds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const engine = createFakeEngine();
  const attempts = [];
  engine.fake.script('moverFailed', (id, index, attempt) => {
    if (!id.includes('-models-')) return false;
    attempts.push(attempt);
    return attempt === 1;
  });
  const position = geo.cartesian3.fromDegrees(0, 0, 100);
  const layout = aircraftAtlasLayout();
  const display = createAircraftDisplay(engine, {
    layerId: 'local-adsb',
    drawAtlas: async () => ({
      canvas: { width: layout.width, height: layout.height },
      cells: layout.cells,
    }),
  });
  await display.whenReady();
  display.fleet.attach();
  const models = createLocalAdsbModels({
    renderer: {
      models: display.models,
      view: {
        camera: { positionWC: position, positionCartographic: { height: 100 } },
        frustumTester: () => () => true,
        horizon: () => ({ isPointVisible: () => true }),
      },
    },
    color: {},
    resolveAsset: (url) => url,
  });
  const marker = { position, klass: 'airliner' };
  const markers = new Map([['local-adsb:abc123', marker]]);
  try {
    models.frame(markers, { models3d: true }, 1000);
    await new Promise(setImmediate);
    models.frame(markers, { models3d: true }, 1100);
    const set = engine.movers.list().find((row) => row.kind === 'model');
    assert.equal(models.size, 1);
    assert.equal(marker.modelOwnsVisual, false);
    t.mock.timers.tick(1500);
    models.frame(markers, { models3d: true }, 2800);
    assert.equal(models.size, 1);
    assert.equal(marker.modelOwnsVisual, true);
    assert.deepEqual(attempts, [1, 2]);
    assert.equal(
      engine.movers.list().find((row) => row.kind === 'model').id,
      set.id,
    );
  } finally {
    models.destroy();
    display.destroy();
    engine.destroy();
  }
});
