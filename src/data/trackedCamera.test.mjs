import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { followViewFrom, keptViewFrom } from './trackedCamera.js';
import { followFramingEye } from '../render/camera/followTransition.js';
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

/** Heading, radians clockwise from north, of a framing eye's up in its frame. */
const framedHeading = (offset) => {
  const { up } = followFramingEye(offset);
  return Math.atan2(up.x, up.y);
};

test("a followed view from straight down keeps the camera's heading, not the target's bearing", () => {
  // The camera 60 km up, straight down, heading north; the target 40 km to
  // the west-north-west of the point under it.
  const under = fromDegrees(-122.38, 37.62, 0);
  const eye = framePoint(eastNorthUp(under), { x: 0, y: 0, z: 60_000 });
  const direction = normalize(
    frameVector(eastNorthUp(under), { x: 0, y: 0, z: -1 }),
  );
  const at = framePoint(eastNorthUp(under), { x: -37_000, y: 15_000, z: 0 });
  const pose = { position: eye, direction, heading: 0 };
  // Kept as it is, the view leans only as the Earth curves, towards the eye:
  // the framing would face the target's bearing.
  const kept = keptViewFrom(pose, at);
  assert.ok(Math.abs(framedHeading(kept)) > 1, 'kept: turned');
  const followed = followViewFrom(pose, at);
  assert.ok(Math.abs(framedHeading(followed)) < 1e-9, 'followed: still north');
  assert.ok(
    Math.abs(magnitude(followed) - magnitude(kept)) < 1e-6,
    'its range',
  );
  for (const heading of [Math.PI / 2, 2.5]) {
    const turned = followViewFrom({ ...pose, heading }, at);
    const h = framedHeading(turned);
    assert.ok(
      Math.abs(Math.atan2(Math.sin(h - heading), Math.cos(h - heading))) < 1e-9,
      `heading ${heading} kept, not ${h}`,
    );
  }
});

test("a followed view keeps its range and its tilt to the target's horizon", () => {
  const at = fromDegrees(-122.2, 37.7, 600);
  const enu = eastNorthUp(at);
  const eye = framePoint(enu, { x: 300, y: -1600, z: 1100 });
  const direction = normalize(frameVector(enu, { x: -250, y: 1600, z: -1150 }));
  const kept = keptViewFrom({ position: eye, direction }, at);
  const followed = followViewFrom(
    { position: eye, direction, heading: 0.1 },
    at,
  );
  assert.ok(Math.abs(magnitude(followed) - magnitude(kept)) < 1e-6);
  assert.ok(Math.abs(followed.z - kept.z) < 1e-6, 'the same tilt');
  assert.ok(
    Math.abs(framedHeading(followed) - 0.1) < 1e-9,
    "the pose's heading",
  );
  // A pose with no heading keeps the view as it is.
  assert.deepEqual(followViewFrom({ position: eye, direction }, at), kept);
  assert.equal(followViewFrom(null, at), null);
});
