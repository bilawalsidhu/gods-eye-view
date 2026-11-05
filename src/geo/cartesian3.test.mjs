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

test('magnitudeSquared equals Cesium', () => {
  for (const a of SAMPLES) {
    assert.equal(
      c3.magnitudeSquared(asPlain(a)),
      C.magnitudeSquared(asCesium(a)),
    );
  }
});

test('fromRadians and fromDegreesArray equal Cesium', () => {
  for (const [lon, lat, h] of [
    [0, 0, 0],
    [-73.9857, 40.7484, 381],
    [139.76, 35.68, -20],
    [180, -90, 1e4],
    [12.5, 89.999999, 1],
  ]) {
    const lr = [Cesium.Math.toRadians(lon), Cesium.Math.toRadians(lat), h];
    same(c3.fromRadians(...lr), C.fromRadians(...lr), 'fromRadians');
  }
  const flat = [-74, 40.7, -73.9, 40.8, -73.8, 40.9];
  c3.fromDegreesArray(flat).forEach((p, i) =>
    same(p, C.fromDegreesArray(flat)[i], `array ${i}`),
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
