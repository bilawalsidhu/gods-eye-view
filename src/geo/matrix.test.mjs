// src/geo/matrix.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as m3 from './matrix3.js';
import * as m4 from './matrix4.js';
import * as quat from './quaternion.js';

const arr = (m, n) => Array.from({ length: n }, (_, i) => m[i]);
const sameArr = (ours, theirs, n, label) =>
  assert.deepEqual(arr(ours, n), arr(theirs, n), label);
const close = (a, b, tol, label) =>
  assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b}`);

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

test('matrix4 products, points and inverses equal Cesium', () => {
  sameArr(
    m4.multiply(plain4(T), plain4(U), m4.create()),
    Cesium.Matrix4.multiply(T, U, new Cesium.Matrix4()),
    16,
    'multiply',
  );
  sameArr(
    m4.multiplyTransformation(plain4(T), plain4(U), m4.create()),
    Cesium.Matrix4.multiplyTransformation(T, U, new Cesium.Matrix4()),
    16,
    'multiplyTransformation',
  );
  const p = new Cesium.Cartesian3(1.5, -2, 3);
  const ours = m4.multiplyByPoint(
    plain4(T),
    { x: 1.5, y: -2, z: 3 },
    { x: 0, y: 0, z: 0 },
  );
  const theirs = Cesium.Matrix4.multiplyByPoint(T, p, new Cesium.Cartesian3());
  assert.deepEqual({ ...ours }, { x: theirs.x, y: theirs.y, z: theirs.z });
  const v = m4.multiplyByPointAsVector(
    plain4(T),
    { x: 1.5, y: -2, z: 3 },
    { x: 0, y: 0, z: 0 },
  );
  const cv = Cesium.Matrix4.multiplyByPointAsVector(
    T,
    p,
    new Cesium.Cartesian3(),
  );
  assert.deepEqual({ ...v }, { x: cv.x, y: cv.y, z: cv.z });
  const inv = m4.inverseTransformation(plain4(T), m4.create());
  const cinv = Cesium.Matrix4.inverseTransformation(T, new Cesium.Matrix4());
  for (let i = 0; i < 16; i++) close(inv[i], cinv[i], 1e-12, `inv ${i}`);
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
  sameArr(
    m4.fromUniformScale(2.5, m4.create()),
    Cesium.Matrix4.fromUniformScale(2.5, new Cesium.Matrix4()),
    16,
    'scale',
  );
});

test('matrix3, quaternion and rotation-translation equal Cesium', () => {
  sameArr(
    m3.fromRotationZ(1.1, m3.create()),
    Cesium.Matrix3.fromRotationZ(1.1, new Cesium.Matrix3()),
    9,
    'rotZ',
  );
  const axis = {
    x: 0.2672612419124244,
    y: 0.5345224838248488,
    z: 0.8017837257372732,
  };
  const q = quat.fromAxisAngle(axis, 0.7, quat.create());
  const cq = Cesium.Quaternion.fromAxisAngle(
    new Cesium.Cartesian3(axis.x, axis.y, axis.z),
    0.7,
    new Cesium.Quaternion(),
  );
  assert.deepEqual({ ...q }, { x: cq.x, y: cq.y, z: cq.z, w: cq.w });
  sameArr(
    m3.fromQuaternion(q, m3.create()),
    Cesium.Matrix3.fromQuaternion(cq, new Cesium.Matrix3()),
    9,
    'fromQuaternion',
  );
  const back = quat.fromRotationMatrix(
    m3.fromQuaternion(q, m3.create()),
    quat.create(),
  );
  const cback = Cesium.Quaternion.fromRotationMatrix(
    Cesium.Matrix3.fromQuaternion(cq, new Cesium.Matrix3()),
    new Cesium.Quaternion(),
  );
  for (const k of ['x', 'y', 'z', 'w'])
    close(back[k], cback[k], 1e-15, `q.${k}`);
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
