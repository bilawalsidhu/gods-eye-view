#!/usr/bin/env node
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import * as Cesium from 'cesium';
import { acquireAircraftSurface } from '../src/data/aircraftSurface.js';
import { ViewportBillboardCollection } from '../src/data/viewportBillboards.js';

// Real native objects, without WebGL: hidden pinned residents still exercise
// surface ownership and Cesium's update queue. GPU performance is a separate gate.
assert.equal(typeof globalThis.gc, 'function', 'run with node --expose-gc');
globalThis.document = {};
const count =
  Number(process.argv[process.argv.indexOf('--count') + 1]) || 10000;
const action = process.argv.includes('--remove-all') ? 'removeAll' : 'hide';
const viewer = {
  gevAircraftSurfaceEnabled: () => true,
  camera: {
    viewMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
    frustum: { projectionMatrix: Cesium.Matrix4.IDENTITY },
  },
  scene: {
    mode: Cesium.SceneMode.SCENE3D,
    canvas: { clientWidth: 1000, clientHeight: 1000 },
    preRender: new Cesium.Event(),
    postRender: new Cesium.Event(),
  },
};
const sibling = acquireAircraftSurface(viewer);
const fleet = new ViewportBillboardCollection(viewer, {
  isPinned: () => true,
  screenSpaceEnabled: () => true,
  createCollection() {
    const collection = new Cesium.BillboardCollection();
    collection.update = () => {};
    return collection;
  },
});
for (let i = 0; i < count; i++)
  fleet.add({ id: String(i), position: new Cesium.Cartesian3(), show: false });
fleet.update({});
for (let i = 0; i < count; i++)
  fleet.get(i).position = new Cesium.Cartesian3(0.1, 0, 0);
const native = new WeakRef(fleet._collection);
const residents = Array.from(
  { length: count },
  (_, i) => new WeakRef(fleet._collection.get(i)),
);
const queuedBefore = fleet._collection._billboardsToUpdate.length;
assert.equal(queuedBefore, count);
if (action === 'hide') fleet.show = false;
else fleet.removeAll();
// WeakRef targets stay alive until the end of their current JS job.
for (let i = 0; i < 8; i++) {
  await setImmediate();
  globalThis.gc();
}
const retainedResidents = residents.filter(
  (ref) => ref.deref() !== undefined,
).length;
const result = {
  action,
  contacts: count,
  queuedBefore,
  retainedNativeCollections: native.deref() ? 1 : 0,
  retainedNativeResidents: retainedResidents,
  logicalContacts: fleet.length,
  heapUsedAfterGc: process.memoryUsage().heapUsed,
};
console.log(JSON.stringify(result));
try {
  if (process.argv.includes('--check')) {
    assert.equal(result.retainedNativeCollections, 0);
    assert.equal(result.retainedNativeResidents, 0);
    assert.equal(result.logicalContacts, action === 'hide' ? count : 0);
    if (action === 'hide') {
      assert.equal(fleet.get(0).id, '0');
      fleet.show = true;
      fleet.update({});
      assert.equal(
        fleet.renderedCount,
        count,
        're-enable readmits the logical contacts',
      );
    }
  }
} finally {
  fleet.destroy();
  sibling.release();
}
