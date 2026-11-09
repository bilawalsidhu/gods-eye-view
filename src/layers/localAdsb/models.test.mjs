import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createLocalAdsbModels } from './models.js';

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

test('a failed model frees its slot and leaves the marker visible', async () => {
  const position = geo.cartesian3.fromDegrees(0, 0, 100);
  const removed = [];
  let loads = 0;
  const renderer = {
    models: {
      loadFleet: async () => ({ failed: loads++ === 0, ready: loads > 1 }),
      add() {},
      remove: (model) => removed.push(model),
      destroy() {},
      setPose() {},
    },
    view: {
      camera: { positionWC: position, positionCartographic: { height: 100 } },
      frustumTester: () => () => true,
      horizon: () => ({ isPointVisible: () => true }),
    },
  };
  const models = createLocalAdsbModels({
    renderer,
    color: {},
    resolveAsset: (url) => url,
  });
  const marker = { position, klass: 'airliner' };
  const markers = new Map([['local-adsb:abc123', marker]]);
  try {
    models.frame(markers, { models3d: true }, 1000);
    await new Promise(setImmediate);
    models.frame(markers, { models3d: true }, 1100);
    assert.equal(models.size, 0);
    assert.equal(removed.length, 1);
    assert.equal(marker.modelOwnsVisual, false);
    models.frame(markers, { models3d: true }, 2700);
    await new Promise(setImmediate);
    models.frame(markers, { models3d: true }, 2800);
    assert.equal(models.size, 1);
    assert.equal(marker.modelOwnsVisual, true);
  } finally {
    models.destroy();
  }
});
