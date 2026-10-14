// src/geo/cartesian3.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as c3 from './cartesian3.js';

const C = Cesium.Cartesian3;
const SAMPLES = [
  [1, 2, 3],
  [-4.5, 0.25, 1e6],
  [0, 0, 0],
  [6378137, -1e-3, 42],
  [1e-12, -1e-12, 3],
];
const asCesium = ([x, y, z]) => new C(x, y, z);
const asPlain = ([x, y, z]) => ({ x, y, z });
const same = (ours, theirs, label) =>
  assert.deepEqual(
    { x: ours.x, y: ours.y, z: ours.z },
    { x: theirs.x, y: theirs.y, z: theirs.z },
    label,
  );

test('binary vector ops equal Cesium bit for bit', () => {
  for (const a of SAMPLES)
    for (const b of SAMPLES) {
      for (const op of ['add', 'subtract', 'cross', 'multiplyComponents']) {
        same(
          c3[op](asPlain(a), asPlain(b), c3.create()),
          C[op](asCesium(a), asCesium(b), new C()),
          `${op}`,
        );
      }
      assert.equal(
        c3.dot(asPlain(a), asPlain(b)),
        C.dot(asCesium(a), asCesium(b)),
      );
      assert.equal(
        c3.distance(asPlain(a), asPlain(b)),
        C.distance(asCesium(a), asCesium(b)),
      );
      assert.equal(
        c3.distanceSquared(asPlain(a), asPlain(b)),
        C.distanceSquared(asCesium(a), asCesium(b)),
      );
      same(
        c3.lerp(asPlain(a), asPlain(b), 0.3, c3.create()),
        C.lerp(asCesium(a), asCesium(b), 0.3, new C()),
        'lerp',
      );
      same(
        c3.midpoint(asPlain(a), asPlain(b), c3.create()),
        C.midpoint(asCesium(a), asCesium(b), new C()),
        'midpoint',
      );
      assert.equal(
        c3.equalsEpsilon(asPlain(a), asPlain(b), 1e-7),
        C.equalsEpsilon(asCesium(a), asCesium(b), 1e-7),
      );
    }
});

test('unary ops and scalars equal Cesium', () => {
  for (const a of SAMPLES) {
    assert.equal(c3.magnitude(asPlain(a)), C.magnitude(asCesium(a)));
    assert.equal(
      c3.magnitudeSquared(asPlain(a)),
      C.magnitudeSquared(asCesium(a)),
    );
    same(
      c3.negate(asPlain(a), c3.create()),
      C.negate(asCesium(a), new C()),
      'negate',
    );
    same(
      c3.multiplyByScalar(asPlain(a), 2.5, c3.create()),
      C.multiplyByScalar(asCesium(a), 2.5, new C()),
      'mul',
    );
    same(
      c3.divideByScalar(asPlain(a), 4, c3.create()),
      C.divideByScalar(asCesium(a), 4, new C()),
      'div',
    );
    if (C.magnitude(asCesium(a)) !== 0) {
      same(
        c3.normalize(asPlain(a), c3.create()),
        C.normalize(asCesium(a), new C()),
        'normalize',
      );
    }
  }
});

test('geodetic constructors equal Cesium', () => {
  for (const [lon, lat, h] of [
    [0, 0, 0],
    [-73.9857, 40.7484, 381],
    [139.76, 35.68, -20],
    [180, -90, 1e4],
    [12.5, 89.999999, 1],
  ]) {
    same(
      c3.fromDegrees(lon, lat, h),
      C.fromDegrees(lon, lat, h),
      `fromDegrees ${lon},${lat}`,
    );
    const lr = [Cesium.Math.toRadians(lon), Cesium.Math.toRadians(lat), h];
    same(c3.fromRadians(...lr), C.fromRadians(...lr), 'fromRadians');
  }
  const flat = [-74, 40.7, -73.9, 40.8, -73.8, 40.9];
  c3.fromDegreesArray(flat).forEach((p, i) =>
    same(p, C.fromDegreesArray(flat)[i], `array ${i}`),
  );
  const heights = [-74, 40.7, 10, -73.9, 40.8, 20];
  c3.fromDegreesArrayHeights(heights).forEach((p, i) =>
    same(p, C.fromDegreesArrayHeights(heights)[i], `heights ${i}`),
  );
});

test('result aliasing works like Cesium and creators reuse result', () => {
  const a = { x: 1, y: 2, z: 3 };
  c3.add(a, a, a);
  assert.deepEqual({ ...a }, { x: 2, y: 4, z: 6 });
  const out = c3.create();
  assert.equal(c3.fromDegrees(1, 2, 3, undefined, out), out);
  assert.ok(Object.isFrozen(c3.ZERO));
});

test('plain results are accepted by Cesium functions (duck typing)', () => {
  const p = c3.fromDegrees(-73.9857, 40.7484, 381);
  const carto = Cesium.Cartographic.fromCartesian(p);
  assert.ok(Math.abs(Cesium.Math.toDegrees(carto.latitude) - 40.7484) < 1e-9);
  assert.ok(
    Cesium.Cartesian3.equals(
      Cesium.Cartesian3.clone(p),
      C.fromDegrees(-73.9857, 40.7484, 381),
    ),
  );
});

test('normalize throws on a zero or NaN vector, as Cesium does when run from source', () => {
  for (const [x, y, z] of [
    [0, 0, 0],
    [-0, 0, -0],
    [Number.NaN, 1, 2],
  ]) {
    assert.throws(
      () => C.normalize(new C(x, y, z), new C()),
      /normalized result is not a number/,
    );
    assert.throws(
      () => c3.normalize({ x, y, z }, c3.create()),
      /normalized result is not a number/,
    );
  }
});
