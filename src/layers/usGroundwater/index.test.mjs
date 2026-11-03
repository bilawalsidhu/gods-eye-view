import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as Cesium from 'cesium';
import { createUsGroundwaterLayer } from './index.js';
import {
  getContextStore,
  selectEntityContext,
  selectTrackedSubjectContext,
} from '../../data/contextStore.js';
const fixture = JSON.parse(
  fs.readFileSync(
    new URL(
      '../../../fixtures/us-groundwater/v1/expected-pack.json',
      import.meta.url,
    ),
  ),
);

test('hollow marker center uses the bounded record hit area without stealing foreign picks or hidden records', async () => {
  const owned = ownedViewer(() => false);
  owned.viewer.camera.positionCartographic.height = 25000;
  owned.viewer.scene.canvas.clientWidth = 800;
  owned.viewer.scene.canvas.clientHeight = 600;
  let picked;
  owned.viewer.scene.pick = () => picked;
  const firstPosition = Cesium.Cartesian3.fromDegrees(
    fixture.records[0].longitude,
    fixture.records[0].latitude,
  );
  owned.viewer.scene.cartesianToCanvasCoordinates = (position) =>
    Cesium.Cartesian3.equals(position, firstPosition)
      ? new Cesium.Cartesian2(100, 100)
      : new Cesium.Cartesian2(500, 500);
  const actions = new Map();
  const original = Cesium.ScreenSpaceEventHandler.prototype.setInputAction;
  const layer = createUsGroundwaterLayer({
    source: {
      async getSnapshot() {
        return fixture;
      },
    },
  });
  try {
    Cesium.ScreenSpaceEventHandler.prototype.setInputAction = function (
      callback,
      type,
      modifier,
    ) {
      actions.set(type, callback);
      return original.call(this, callback, type, modifier);
    };
    layer.init(owned.viewer);
    await layer.enable();
  } finally {
    Cesium.ScreenSpaceEventHandler.prototype.setInputAction = original;
  }
  try {
    const click = actions.get(Cesium.ScreenSpaceEventType.LEFT_CLICK);
    click({ position: new Cesium.Cartesian2(104, 104) });
    assert.equal(
      owned.viewer.selectedEntity.id,
      `us-groundwater:${fixture.records[0].id}`,
    );
    click({ position: new Cesium.Cartesian2(120, 120) });
    assert.equal(
      owned.viewer.selectedEntity,
      undefined,
      'the hit area is bounded',
    );
    const foreign = { id: 'other-layer:point' };
    picked = { id: foreign };
    owned.viewer.selectedEntity = foreign;
    click({ position: new Cesium.Cartesian2(100, 100) });
    assert.equal(owned.viewer.selectedEntity, foreign);
    picked = undefined;
    owned.viewer.selectedEntity = undefined;
    owned.viewer.camera.positionCartographic.height = 90000;
    click({ position: new Cesium.Cartesian2(100, 100) });
    assert.equal(owned.viewer.selectedEntity, undefined);
    owned.viewer.camera.positionCartographic.height = 25000;
    owned.collection.get(0).show = false;
    click({ position: new Cesium.Cartesian2(100, 100) });
    assert.equal(owned.viewer.selectedEntity, undefined);
  } finally {
    layer.destroy();
  }
});

test('pre-render clears broad-scale well selection without a moveEnd and preserves foreign selection', async () => {
  const owned = ownedViewer(() => false);
  owned.viewer.camera.positionCartographic.height = 25000;
  owned.viewer.scene.preRender = new Cesium.Event();
  const layer = createUsGroundwaterLayer({
    source: {
      async getSnapshot() {
        return fixture;
      },
    },
  });
  layer.init(owned.viewer);
  await layer.enable();
  owned.viewer.selectedEntity = owned.collection.get(0).entities.values[0];
  owned.viewer.camera.positionCartographic.height = 90000;
  owned.viewer.scene.preRender.raiseEvent();
  assert.equal(owned.viewer.selectedEntity, undefined);
  const foreign = { id: 'another-layer' };
  owned.viewer.selectedEntity = foreign;
  owned.viewer.scene.preRender.raiseEvent();
  assert.equal(owned.viewer.selectedEntity, foreign);
  layer.destroy();
  assert.equal(owned.viewer.scene.preRender.numberOfListeners, 0);
});

test('canvas resize reflows a selected card without refetching or changing record identity', async () => {
  const owned = ownedViewer(() => false);
  owned.viewer.camera.positionCartographic.height = 25000;
  owned.viewer.scene.canvas.clientWidth = 1440;
  owned.viewer.scene.preRender = new Cesium.Event();
  let reads = 0;
  const layer = createUsGroundwaterLayer({
    source: {
      async getSnapshot() {
        reads++;
        return fixture;
      },
    },
  });
  layer.init(owned.viewer);
  await layer.enable();
  const first = owned.collection.get(0).entities.values[0];
  assert.equal(
    first.gevWellRecordLabel,
    first.id.slice('us-groundwater:'.length),
  );
  owned.viewer.selectedEntity = first;
  owned.viewer.scene.canvas.clientWidth = 390;
  owned.viewer.scene.preRender.raiseEvent();
  const replacement = owned.viewer.selectedEntity;
  assert.equal(replacement.id, first.id);
  assert.notEqual(replacement, first);
  assert.ok(
    replacement.gevLabelModel.details.every((line) => line.length <= 49),
  );
  assert.equal(reads, 1);
  layer.destroy();
});

test('viewport refresh retains the current well by ID and clears it when absent', async () => {
  const owned = ownedViewer(() => false);
  owned.viewer.camera.positionCartographic.height = 25000;
  const selections = [];
  let next = fixture;
  const layer = createUsGroundwaterLayer({
    source: {
      viewport: true,
      async getSnapshot() {
        return next;
      },
    },
    validatePack: (value) => value,
    onSelect: (value) => selections.push(value),
  });
  layer.init(owned.viewer);
  assert.equal(await layer.enable(), true);
  const data = owned.collection.get(0);
  const entity = data.entities.values[0];
  owned.viewer.selectedEntity = entity;
  owned.viewer.camera.moveEnd.raiseEvent();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(owned.viewer.selectedEntity.id, entity.id);
  assert.notEqual(owned.viewer.selectedEntity, entity);
  assert.equal(selections.at(-1).id, entity.id.slice('us-groundwater:'.length));
  const other = { id: 'other-layer:selection' };
  owned.viewer.selectedEntity = other;
  owned.viewer.camera.moveEnd.raiseEvent();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    owned.viewer.selectedEntity,
    other,
    'never steal a newer foreign selection',
  );
  owned.viewer.selectedEntity = data.entities.getById(entity.id);
  owned.viewer.camera.positionCartographic.height = 250000;
  owned.viewer.camera.moveEnd.raiseEvent();
  assert.equal(
    owned.viewer.selectedEntity,
    undefined,
    'zooming out clears detail immediately',
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    data.show,
    false,
    'unindexed snapshots also hide their graphics above 50km',
  );
  owned.viewer.camera.positionCartographic.height = 25000;
  owned.viewer.selectedEntity = data.entities.getById(entity.id);
  next = { ...fixture, records: [] };
  owned.viewer.camera.moveEnd.raiseEvent();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(owned.viewer.selectedEntity, undefined);
  assert.equal(selections.at(-1), null);
  layer.destroy();
});

test('a deferred refresh does not reclaim a newer foreign context selection', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { dispatchEvent() {} };
  try {
    const owned = ownedViewer(() => false);
    let finish;
    let reads = 0;
    const layer = createUsGroundwaterLayer({
      source: {
        viewport: true,
        getSnapshot() {
          if (++reads === 1) return Promise.resolve(fixture);
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
      validatePack: (value) => value,
    });
    layer.init(owned.viewer);
    assert.equal(await layer.enable(), true);
    const entity = owned.collection.get(0).entities.values[0];
    owned.viewer.selectedEntity = entity;
    selectEntityContext(entity);
    owned.viewer.camera.moveEnd.raiseEvent();
    await new Promise((resolve) => setImmediate(resolve));
    selectTrackedSubjectContext({ id: 'foreign:1', layerId: 'flights' });
    finish(fixture);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getContextStore().selectedEntityId, 'foreign:1');
    assert.notEqual(owned.viewer.selectedEntity?.id, entity.id);
    layer.destroy();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

function ownedViewer(rejectAdd) {
  const collection = new Cesium.DataSourceCollection();
  const attempts = [];
  const listeners = new Set();
  const moveEnd = new Cesium.Event();
  const canvas = {
    disableRootEvents: true,
    onwheel: null,
    addEventListener(type, listener) {
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.delete(listener);
    },
  };
  return {
    collection,
    attempts,
    listeners,
    viewer: {
      dataSources: {
        async add(source) {
          attempts.push(source);
          if (rejectAdd(attempts.length))
            throw new Error('Owned attach failure');
          return collection.add(source);
        },
        remove(source, destroy) {
          return collection.remove(source, destroy);
        },
      },
      camera: {
        computeViewRectangle: () =>
          Cesium.Rectangle.fromDegrees(-125, 24, -66, 50),
        positionWC: Cesium.Cartesian3.fromDegrees(-96, 38, 9500000),
        positionCartographic: { height: 9500000 },
        moveEnd,
      },
      scene: { canvas },
    },
  };
}

test('every rejected cached attachment stays failed with no visible or retained graphics', async () => {
  const owned = ownedViewer(() => true);
  let reads = 0;
  const layer = createUsGroundwaterLayer({
    source: {
      async getSnapshot() {
        reads++;
        return fixture;
      },
    },
  });
  layer.init(owned.viewer);
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(await layer.enable(), false);
    assert.equal(owned.attempts.length, attempt);
    assert.equal(new Set(owned.attempts).size, attempt);
    assert.equal(layer.getStats().visible, 0);
    assert.match(layer.getStats().error, /Owned attach failure/);
    assert.equal(layer.update(), false);
    assert.equal(owned.collection.length, 0);
    assert.equal(owned.listeners.size, 0);
    assert.equal(owned.viewer.camera.moveEnd.numberOfListeners, 0);
  }
  assert.equal(reads, 1);
  layer.destroy();
});

test('successful attachment retry clears the error and owns exactly one real Cesium source', async () => {
  const owned = ownedViewer((attempt) => attempt === 1);
  let reads = 0;
  const layer = createUsGroundwaterLayer({
    source: {
      async getSnapshot() {
        reads++;
        return fixture;
      },
    },
  });
  layer.init(owned.viewer);
  assert.equal(await layer.enable(), false);
  assert.match(layer.getStats().error, /Owned attach failure/);
  assert.equal(await layer.enable(), true);
  assert.equal(reads, 1);
  assert.equal(owned.attempts.length, 2);
  assert.notEqual(owned.attempts[0], owned.attempts[1]);
  assert.equal(layer.getStats().error, null);
  assert.equal(layer.getStats().visible, 6);
  assert.equal(owned.collection.length, 1);
  assert(owned.listeners.size > 0);
  assert.equal(
    owned.viewer.camera.moveEnd.numberOfListeners,
    2,
    'one viewport watcher and one record visibility watcher',
  );
  layer.destroy();
  assert.equal(owned.collection.length, 0);
  assert.equal(owned.listeners.size, 0);
  assert.equal(owned.viewer.camera.moveEnd.numberOfListeners, 0);
});

test('disable during asynchronous Cesium add removes a late-owned data source', async () => {
  let finishAdd;
  let started;
  const addStarted = new Promise((resolve) => {
    started = resolve;
  });
  const removed = [];
  const viewer = {
    camera: ownedViewer(() => false).viewer.camera,
    dataSources: {
      add(source) {
        started();
        return new Promise((resolve) => {
          finishAdd = () => resolve(source);
        });
      },
      remove(source) {
        removed.push(source);
        return true;
      },
    },
  };
  const layer = createUsGroundwaterLayer({
    source: {
      async getSnapshot() {
        return fixture;
      },
    },
  });
  layer.init(viewer);
  const enabled = layer.enable();
  await addStarted;
  assert.equal(layer.update(), false);
  assert.equal(layer.getStats().visible, 0);
  layer.disable();
  finishAdd();
  assert.equal(await enabled, false);
  assert.equal(removed.length, 2);
  assert.equal(removed[0], removed[1]);
  assert.equal(layer.getStats().visible, 0);
  layer.destroy();
});

test('disable cancels pending acquisition and rejects late results without allocating graphics', async () => {
  let resolve;
  let signal;
  let calls = 0;
  const selected = [];
  const layer = createUsGroundwaterLayer({
    source: {
      getSnapshot(options) {
        calls++;
        signal = options.signal;
        return new Promise((r) => {
          resolve = r;
        });
      },
    },
    onSelect: (value) => selected.push(value),
  });
  layer.init(ownedViewer(() => false).viewer);
  const a = layer.enable();
  const b = layer.enable();
  await Promise.resolve();
  assert.equal(calls, 1);
  layer.disable();
  assert(signal.aborted);
  resolve(fixture);
  assert.equal(await a, false);
  assert.equal(await b, false);
  assert.equal(layer.getStats().count, 0);
  assert.deepEqual(layer.getRecords(), []);
  assert.deepEqual(selected, [null]);
  layer.destroy();
});

test('destroy is permanent; failed acquisition remains retryable with no entities', async () => {
  let calls = 0;
  const layer = createUsGroundwaterLayer({
    source: {
      async getSnapshot() {
        calls++;
        throw new Error('fixture unavailable');
      },
    },
  });
  layer.init(ownedViewer(() => false).viewer);
  assert.equal(await layer.enable(), false);
  assert.match(layer.getStats().error, /unavailable/);
  assert.equal(await layer.enable(), false);
  assert.equal(calls, 2);
  layer.destroy();
  layer.destroy();
  await assert.rejects(layer.enable(), /not available/);
});

test('a synchronously throwing source reports failure instead of a pending promise leak', async () => {
  let calls = 0;
  const layer = createUsGroundwaterLayer({
    source: {
      getSnapshot() {
        calls++;
        throw new Error('sync failure');
      },
    },
  });
  layer.init(ownedViewer(() => false).viewer);
  assert.equal(await layer.enable(), false);
  assert.equal(await layer.enable(), false);
  assert.equal(calls, 2);
  layer.destroy();
});
