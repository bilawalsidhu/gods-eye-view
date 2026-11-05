// src/geo/cartographic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as cartographic from './cartographic.js';

test('fromDegrees and fromRadians equal Cesium', () => {
  for (const [lon, lat, h] of [
    [0, 0, 0],
    [-73.9857, 40.7484, 381],
    [139.76, 35.68, -20],
    [180, -90, 1e4],
  ]) {
    const ours = cartographic.fromDegrees(lon, lat, h);
    const theirs = Cesium.Cartographic.fromDegrees(lon, lat, h);
    assert.deepEqual(
      { ...ours },
      {
        longitude: theirs.longitude,
        latitude: theirs.latitude,
        height: theirs.height,
      },
    );
  }
});

test('result objects are reused', () => {
  const out = cartographic.create();
  assert.equal(cartographic.fromDegrees(1, 2, 3, out), out);
  assert.equal(cartographic.clone(out).longitude, out.longitude);
});

const POLAR_RADIUS = 6356752.3142451793;
const sameFields = (ours, theirs, keys, label) => {
  for (const k of keys) {
    assert.ok(
      Object.is(ours[k], theirs[k]),
      `${label}.${k}: ${ours[k]} vs ${theirs[k]}`,
    );
  }
};

test('fromCartesian is undefined at the exact centre, as in Cesium', () => {
  for (const [x, y, z] of [
    [0, 0, 0],
    [-0, -0, -0],
  ]) {
    assert.equal(
      Cesium.Cartographic.fromCartesian(new Cesium.Cartesian3(x, y, z)),
      undefined,
    );
    assert.equal(cartographic.fromCartesian({ x, y, z }), undefined);
  }
});

test('fromCartesian and toCartesian equal Cesium bit for bit at the poles and the antimeridian', () => {
  for (const [x, y, z, label] of [
    [0, 0, POLAR_RADIUS, 'north pole'],
    [0, 0, -POLAR_RADIUS, 'south pole'],
    [-6378137, 0, 0, 'antimeridian, y = +0'],
    [-6378137, -0, 0, 'antimeridian, y = -0'],
    [-6378137, -0, -0, 'antimeridian, y = z = -0'],
  ]) {
    const ours = cartographic.fromCartesian({ x, y, z });
    const theirs = Cesium.Cartographic.fromCartesian(
      new Cesium.Cartesian3(x, y, z),
    );
    sameFields(ours, theirs, ['longitude', 'latitude', 'height'], label);
    sameFields(
      cartographic.toCartesian(ours),
      Cesium.Cartographic.toCartesian(theirs),
      ['x', 'y', 'z'],
      `${label} back`,
    );
  }
  // atan2 keeps the sign of a zero y: +π on one side of the antimeridian, -π on the other.
  assert.equal(
    cartographic.fromCartesian({ x: -6378137, y: 0, z: 0 }).longitude,
    Math.PI,
  );
  assert.equal(
    cartographic.fromCartesian({ x: -6378137, y: -0, z: 0 }).longitude,
    -Math.PI,
  );
});

// layers/streetLevel/view.js passes a Cesium Ellipsoid (scene.globe.ellipsoid),
// which has no public `centerToleranceSquared`; geo then reads Cesium's private
// `_centerToleranceSquared`. This pins that coupling to a Cesium private field:
// if a Cesium upgrade renames it, the centre case below stops matching.
test('fromCartesian with a Cesium Ellipsoid equals Cesium, including the centre', () => {
  const ellipsoid = Cesium.Ellipsoid.WGS84;
  assert.equal(ellipsoid.centerToleranceSquared, undefined);
  assert.equal(typeof ellipsoid._centerToleranceSquared, 'number');
  for (const [x, y, z, label] of [
    [0, 0, 0, 'centre'],
    [0.1, 0.1, 0.1, 'inside the centre tolerance'],
    [6378137, 0, 0, 'equator'],
    [1334000, -4654000, 4138000, 'mid-latitude'],
    [0, 0, POLAR_RADIUS + 500, 'above the north pole'],
  ]) {
    const ours = cartographic.fromCartesian({ x, y, z }, ellipsoid);
    const theirs = Cesium.Cartographic.fromCartesian(
      new Cesium.Cartesian3(x, y, z),
      ellipsoid,
    );
    if (theirs === undefined) {
      assert.equal(ours, undefined, label);
      continue;
    }
    sameFields(ours, theirs, ['longitude', 'latitude', 'height'], label);
  }
});
