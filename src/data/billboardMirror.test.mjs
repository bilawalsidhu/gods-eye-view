import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  addBillboard,
  billboardState,
  mirrorBillboard,
  setBillboard,
} from './billboardMirror.js';

const SIZE = Object.freeze({ width: 20, height: 20 });

function fakeCollection() {
  return { add: (options) => ({ ...options }) };
}

test('an added billboard is mirrored with Cesium defaults for unset fields', () => {
  const position = Cesium.Cartesian3.fromDegrees(10, 20, 30);
  const bb = addBillboard(fakeCollection(), { position, width: 20, height: 24 });
  const state = billboardState(bb);
  assert.equal(state.show, true);
  assert.equal(state.scale, 1);
  assert.equal(state.rotation, 0);
  assert.equal(state.width, 20);
  assert.equal(state.height, 24);
  assert.ok(Cesium.Cartesian3.equals(state.position, position));
  assert.notEqual(state.position, position, 'the mirror keeps its own copy');
});

test('writes reach both the billboard and the mirror', () => {
  const bb = addBillboard(fakeCollection(), SIZE);
  setBillboard(bb, 'show', false);
  setBillboard(bb, 'scale', 0.5);
  assert.equal(bb.show, false);
  assert.equal(billboardState(bb).show, false);
  assert.equal(billboardState(bb).scale, 0.5);
});

test('a reused scratch position does not move the mirror', () => {
  const bb = addBillboard(fakeCollection(), SIZE);
  const scratch = Cesium.Cartesian3.fromDegrees(1, 2, 3);
  setBillboard(bb, 'position', scratch);
  const written = Cesium.Cartesian3.clone(scratch);
  Cesium.Cartesian3.fromDegrees(50, 50, 50, undefined, scratch);
  assert.ok(Cesium.Cartesian3.equals(billboardState(bb).position, written));
});

test('writing no position keeps the last one, as Cesium does', () => {
  const position = Cesium.Cartesian3.fromDegrees(1, 2, 3);
  const bb = addBillboard(fakeCollection(), { ...SIZE, position });
  setBillboard(bb, 'position', undefined);
  assert.ok(Cesium.Cartesian3.equals(billboardState(bb).position, position));
});

test('the mirror answers from Core, not from the billboard', () => {
  const bb = addBillboard(fakeCollection(), { ...SIZE, show: true });
  bb.show = false; // a write that bypassed the mirror
  assert.equal(billboardState(bb).show, true);
});

test('a billboard Core did not add can be mirrored from its fields', () => {
  const bb = mirrorBillboard({ show: false, scale: 2 });
  assert.equal(billboardState(bb).show, false);
  assert.equal(billboardState(bb).scale, 2);
  assert.equal(billboardState(bb).position, undefined, 'none was pushed');
  assert.equal(billboardState(null), null);
  assert.equal(mirrorBillboard(null), null);
});

test('a billboard without explicit dimensions is refused', () => {
  // Unset, Cesium reports the image's size, which the mirror cannot know.
  assert.throws(() => addBillboard(fakeCollection(), {}), TypeError);
  assert.throws(() => addBillboard(fakeCollection(), { width: 20 }), TypeError);
});
