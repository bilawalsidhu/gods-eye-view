import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { keptViewFrom } from './trackedCamera.js';
import {
  distance,
  eastNorthUp,
  framePoint,
  frameVector,
  fromDegrees,
  magnitude,
  normalize,
  scale,
} from '../geo/index.js';
import { clampFollowEye as clampTrackedCameraPosition } from '../render/cesium/follow.js';

test('tracked camera origin crossing returns to the prior side at the minimum range', () => {
  const camera = {
    position: new Cesium.Cartesian3(0, 500, -300),
    direction: new Cesium.Cartesian3(0, -1, 0),
  };
  const previous = new Cesium.Cartesian3(0, -1000, 600);
  assert.equal(clampTrackedCameraPosition(camera, previous, 150), true);
  assert.ok(Cesium.Cartesian3.dot(camera.position, previous) > 0);
  assert.ok(
    Math.abs(Cesium.Cartesian3.magnitude(camera.position) - 150) < 1e-9,
  );
});

test('tracked camera clamps a too-close approach along the current sight line', () => {
  const camera = {
    position: new Cesium.Cartesian3(0, -80, 0),
    direction: new Cesium.Cartesian3(0, 1, 0),
  };
  const previous = new Cesium.Cartesian3(0, -200, 0);
  assert.equal(clampTrackedCameraPosition(camera, previous, 150), true);
  assert.ok(Math.abs(camera.position.x) === 0);
  assert.equal(camera.position.y, -150);
  assert.ok(Math.abs(camera.position.z) === 0);
});

test('tracked camera leaves a safe approach unchanged', () => {
  const camera = {
    position: new Cesium.Cartesian3(0, -800, 500),
    direction: Cesium.Cartesian3.normalize(
      new Cesium.Cartesian3(0, 800, -500),
      new Cesium.Cartesian3(),
    ),
  };
  const previous = Cesium.Cartesian3.clone(camera.position);
  const before = Cesium.Cartesian3.clone(camera.position);
  assert.equal(clampTrackedCameraPosition(camera, previous, 150), false);
  assert.deepEqual(camera.position, before);
});

test('a kept view follows from the eye: its own view direction at its own range', () => {
  const at = fromDegrees(-122.2, 37.7, 600);
  const enu = eastNorthUp(at);
  // An eye 2 km off, looking a little beside the target.
  const eye = framePoint(enu, { x: 300, y: -1600, z: 1100 });
  const direction = normalize(frameVector(enu, { x: -250, y: 1600, z: -1150 }));
  const viewFrom = keptViewFrom({ position: eye, direction }, at);
  assert.ok(Math.abs(magnitude(viewFrom) - distance(eye, at)) < 1e-6);
  // Followed from there, the eye looks the way it looked.
  const followedLook = normalize(frameVector(enu, scale(viewFrom, -1)));
  assert.ok(distance(followedLook, direction) < 1e-12);
});

test('a kept view needs an eye apart from the target', () => {
  const at = fromDegrees(-122.2, 37.7, 600);
  assert.equal(keptViewFrom(null, at), null);
  assert.equal(
    keptViewFrom({ position: at, direction: { x: 0, y: 0, z: -1 } }, at),
    null,
  );
});
