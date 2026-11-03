import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { mirrorModel, modelState, setModel } from './modelMirror.js';

function fakeModel() {
  return { show: true, modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY) };
}

test('a model has no mirror until Core writes to it', () => {
  assert.equal(modelState(fakeModel()), null);
  assert.equal(modelState(null), null);
});

test('the first write starts from Cesium defaults for the other fields', () => {
  const model = fakeModel();
  setModel(model, 'show', false);
  assert.equal(model.show, false);
  assert.equal(modelState(model).show, false);
  assert.ok(Cesium.Matrix4.equals(modelState(model).modelMatrix, Cesium.Matrix4.IDENTITY));
});

test('a matrix is copied into both the model and the mirror, never shared', () => {
  const model = fakeModel();
  const own = model.modelMatrix;
  const scratch = Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(1, 2, 3));
  setModel(model, 'modelMatrix', scratch);
  assert.equal(model.modelMatrix, own, "written into the model's own matrix");
  assert.ok(Cesium.Matrix4.equals(model.modelMatrix, scratch));
  assert.notEqual(modelState(model).modelMatrix, scratch);
  Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(9, 9, 9), scratch);
  assert.deepEqual(
    Cesium.Matrix4.getTranslation(modelState(model).modelMatrix, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(1, 2, 3),
    'reusing the scratch moves neither copy',
  );
  assert.ok(!Cesium.Matrix4.equals(model.modelMatrix, scratch));
});

test('the mirror answers from Core, not from the model', () => {
  const model = fakeModel();
  setModel(model, 'show', true);
  model.show = false; // a write that bypassed the mirror
  assert.equal(modelState(model).show, true);
});

test("a model without its own matrix yet gets a copy, not the caller's", () => {
  const model = { show: true };
  const matrix = Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(1, 2, 3));
  setModel(model, 'modelMatrix', matrix);
  assert.notEqual(model.modelMatrix, matrix);
  assert.ok(Cesium.Matrix4.equals(model.modelMatrix, matrix));
});

test('a model Core did not write can be mirrored from its fields', () => {
  const matrix = Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(4, 5, 6));
  const model = mirrorModel({ show: false, modelMatrix: matrix });
  assert.equal(modelState(model).show, false);
  assert.ok(Cesium.Matrix4.equals(modelState(model).modelMatrix, matrix));
  assert.notEqual(modelState(model).modelMatrix, matrix);
  assert.equal(modelState(mirrorModel({})).show, true, 'Cesium shows by default');
  assert.equal(mirrorModel(null), null);
});

test('fields outside the mirror are refused', () => {
  assert.throws(() => setModel({}, 'scale', 2), TypeError);
});
