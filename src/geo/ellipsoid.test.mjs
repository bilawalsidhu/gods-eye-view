// src/geo/ellipsoid.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { WGS84, create } from './ellipsoid.js';

const close = (a, b, tol, label) =>
  assert.ok(
    Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)),
    `${label}: ${a} vs ${b}`,
  );
const closeVec = (a, b, tol, label) => {
  for (const k of ['x', 'y', 'z']) close(a[k], b[k], tol, `${label}.${k}`);
};

test('WGS84 constants equal Cesium', () => {
  const c = Cesium.Ellipsoid.WGS84;
  for (const k of [
    'radii',
    'radiiSquared',
    'radiiToTheFourth',
    'oneOverRadii',
    'oneOverRadiiSquared',
  ]) {
    closeVec(WGS84[k], c[k], 0, k);
  }
  assert.equal(WGS84.minimumRadius, c.minimumRadius);
  assert.equal(WGS84.maximumRadius, c.maximumRadius);
});

test('result parameters are filled in place and may alias the input', () => {
  const p = { x: 1334762.2, y: -4654869.1, z: 4137287.9 };
  const out = { x: 0, y: 0, z: 0 };
  assert.equal(WGS84.geodeticSurfaceNormal(p, out), out);
  const alias = { ...p };
  WGS84.geodeticSurfaceNormal(alias, alias);
  closeVec(alias, out, 0, 'alias');
});

test('a custom ellipsoid behaves like Cesium', () => {
  const ours = create(10, 20, 30);
  const theirs = new Cesium.Ellipsoid(10, 20, 30);
  const p = { x: 5, y: 7, z: 9 };
  closeVec(
    ours.scaleToGeodeticSurface(p),
    theirs.scaleToGeodeticSurface(new Cesium.Cartesian3(5, 7, 9)),
    1e-12,
    'custom',
  );
});

const sameXyz = (ours, theirs, label) => {
  if (theirs === undefined) return assert.equal(ours, undefined, label);
  for (const k of ['x', 'y', 'z']) {
    assert.ok(
      Object.is(ours[k], theirs[k]),
      `${label}.${k}: ${ours[k]} vs ${theirs[k]}`,
    );
  }
};

test('the centre, the poles and the antimeridian equal Cesium bit for bit', () => {
  const c = Cesium.Ellipsoid.WGS84;
  for (const [x, y, z] of [
    [0, 0, 0],
    [-0, 0, -0],
    [1e-15, 0, 0],
    [0, 0, 6356752.3142451793],
    [0, 0, -6356752.3142451793],
    [-6378137, 0, 0],
    [-6378137, -0, 0],
    [-7e6, -0, 1e5],
  ]) {
    const p = { x, y, z };
    const cp = new Cesium.Cartesian3(x, y, z);
    const label = `(${Object.is(x, -0) ? '-0' : x}, ${Object.is(y, -0) ? '-0' : y}, ${z})`;
    sameXyz(
      WGS84.geodeticSurfaceNormal(p),
      c.geodeticSurfaceNormal(cp),
      `normal ${label}`,
    );
    sameXyz(
      WGS84.scaleToGeodeticSurface(p),
      c.scaleToGeodeticSurface(cp),
      `scale ${label}`,
    );
    const ours = WGS84.cartesianToCartographic(p);
    const theirs = c.cartesianToCartographic(cp);
    if (theirs === undefined) {
      assert.equal(ours, undefined, label);
      continue;
    }
    for (const k of ['longitude', 'latitude', 'height']) {
      assert.ok(
        Object.is(ours[k], theirs[k]),
        `${label}.${k}: ${ours[k]} vs ${theirs[k]}`,
      );
    }
  }
  assert.equal(WGS84.geodeticSurfaceNormal({ x: 0, y: 0, z: 0 }), undefined);
  assert.equal(WGS84.cartesianToCartographic({ x: 0, y: 0, z: 0 }), undefined);
  assert.equal(WGS84.scaleToGeodeticSurface({ x: 0, y: 0, z: 0 }), undefined);
});
