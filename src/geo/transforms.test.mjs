// src/geo/transforms.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as transforms from './transforms.js';

test('headingPitchRollToFixedFrame keeps Cesium argument order (result is the fifth argument)', () => {
  const origin = Cesium.Cartesian3.fromDegrees(-73.9857, 40.7484, 381);
  const hpr = new Cesium.HeadingPitchRoll(0.7, -0.2, 0.1);
  const out = Array.from({ length: 16 }, () => 0);
  const ours = transforms.headingPitchRollToFixedFrame(
    { x: origin.x, y: origin.y, z: origin.z },
    hpr,
    Cesium.Ellipsoid.WGS84,
    undefined,
    out,
  );
  assert.equal(ours, out);
  const theirs = Cesium.Transforms.headingPitchRollToFixedFrame(
    origin,
    hpr,
    Cesium.Ellipsoid.WGS84,
    undefined,
    new Cesium.Matrix4(),
  );
  assert.deepEqual(
    Array.from(ours),
    Array.from({ length: 16 }, (_, i) => theirs[i]),
  );
  let calledWith;
  const frame = (o, e, r) => {
    calledWith = [o, e, r];
    return transforms.eastNorthUpToFixedFrame(o, e, r);
  };
  transforms.headingPitchRollToFixedFrame(
    { x: origin.x, y: origin.y, z: origin.z },
    hpr,
    undefined,
    frame,
    out,
  );
  assert.equal(calledWith[2], out);
});

// WGS84 polar radius: {0, 0, ±b} has x = y = 0 exactly, so it takes Cesium's pole branch.
const POLAR_RADIUS = 6356752.3142451793;
const sameMatrix = (ours, theirs, label) => {
  for (let i = 0; i < 16; i++) {
    assert.ok(
      Object.is(ours[i], theirs[i]),
      `${label} [${i}]: ${ours[i]} vs ${theirs[i]}`,
    );
  }
};

test('eastNorthUpToFixedFrame equals Cesium bit for bit at the centre and the exact poles', () => {
  for (const [x, y, z, branch] of [
    [0, 0, 0, 'centre'],
    [-0, 0, -0, 'centre (-0)'],
    [1e-15, -1e-15, 1e-15, 'within EPSILON14 of the centre'],
    [0, 0, POLAR_RADIUS, 'north pole'],
    [0, 0, -POLAR_RADIUS, 'south pole'],
    [1e-15, -0, -5, 'south pole within EPSILON14'],
  ]) {
    const ours = transforms.eastNorthUpToFixedFrame({ x, y, z });
    const theirs = Cesium.Transforms.eastNorthUpToFixedFrame(
      new Cesium.Cartesian3(x, y, z),
    );
    sameMatrix(ours, theirs, branch);
    const hpr = new Cesium.HeadingPitchRoll(0.3, -0.2, 0.1);
    sameMatrix(
      transforms.headingPitchRollToFixedFrame({ x, y, z }, hpr),
      Cesium.Transforms.headingPitchRollToFixedFrame(
        new Cesium.Cartesian3(x, y, z),
        hpr,
      ),
      `hpr ${branch}`,
    );
  }
  // The centre uses the fixed degenerate frame; the pole frame flips north and up with the sign of z.
  const centre = transforms.eastNorthUpToFixedFrame({ x: 0, y: 0, z: 0 });
  assert.deepEqual(
    Array.from(centre.slice(0, 11)),
    [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1],
  );
  const south = transforms.eastNorthUpToFixedFrame({
    x: 0,
    y: 0,
    z: -POLAR_RADIUS,
  });
  assert.deepEqual(
    Array.from(south.slice(0, 11)),
    [0, 1, 0, 0, 1, -0, -0, 0, -0, -0, -1],
  );
});
