// src/geo/matrix.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as m3 from './matrix3.js';
import * as m4 from './matrix4.js';

const arr = (m, n) => Array.from({ length: n }, (_, i) => m[i]);
const sameArr = (ours, theirs, n, label) =>
  assert.deepEqual(arr(ours, n), arr(theirs, n), label);

const T = Cesium.Matrix4.fromTranslationQuaternionRotationScale(
  new Cesium.Cartesian3(10, -20, 30),
  Cesium.Quaternion.fromAxisAngle(
    Cesium.Cartesian3.normalize(
      new Cesium.Cartesian3(1, 2, 3),
      new Cesium.Cartesian3(),
    ),
    0.7,
  ),
  new Cesium.Cartesian3(1, 1, 1),
);
const U = Cesium.Matrix4.fromRotationTranslation(
  Cesium.Matrix3.fromRotationZ(1.1),
  new Cesium.Cartesian3(5, 6, 7),
);
const plain4 = (m) => arr(m, 16);

test('matrix4 getters, equals and IDENTITY equal Cesium', () => {
  const t = m4.getTranslation(plain4(T), { x: 0, y: 0, z: 0 });
  assert.deepEqual({ ...t }, { x: 10, y: -20, z: 30 });
  sameArr(
    m4.getMatrix3(plain4(T), m3.create()),
    Cesium.Matrix4.getMatrix3(T, new Cesium.Matrix3()),
    9,
    'getMatrix3',
  );
  assert.ok(m4.equals(m4.clone(plain4(T)), plain4(T)));
  assert.ok(Object.isFrozen(m4.IDENTITY));
});

test('matrix3 and rotation-translation equal Cesium', () => {
  sameArr(
    m3.fromRotationZ(1.1, m3.create()),
    Cesium.Matrix3.fromRotationZ(1.1, new Cesium.Matrix3()),
    9,
    'rotZ',
  );
  const mv = m3.multiplyByVector(
    m3.fromRotationZ(1.1, m3.create()),
    { x: 1, y: 2, z: 3 },
    { x: 0, y: 0, z: 0 },
  );
  const cmv = Cesium.Matrix3.multiplyByVector(
    Cesium.Matrix3.fromRotationZ(1.1, new Cesium.Matrix3()),
    new Cesium.Cartesian3(1, 2, 3),
    new Cesium.Cartesian3(),
  );
  assert.deepEqual({ ...mv }, { x: cmv.x, y: cmv.y, z: cmv.z });
  const col = m3.getColumn(m3.fromRotationZ(1.1, m3.create()), 1, {
    x: 0,
    y: 0,
    z: 0,
  });
  const ccol = Cesium.Matrix3.getColumn(
    Cesium.Matrix3.fromRotationZ(1.1, new Cesium.Matrix3()),
    1,
    new Cesium.Cartesian3(),
  );
  assert.deepEqual({ ...col }, { x: ccol.x, y: ccol.y, z: ccol.z });
  sameArr(
    m4.fromRotationTranslation(
      m3.fromRotationZ(1.1, m3.create()),
      { x: 5, y: 6, z: 7 },
      m4.create(),
    ),
    U,
    16,
    'fromRotationTranslation',
  );
});
