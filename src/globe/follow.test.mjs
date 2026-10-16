import assert from 'node:assert/strict';
import test from 'node:test';
import * as geo from '../geo/index.js';
import { createEngineEvent } from './contract.js';
import {
  MIN_FOLLOW_RANGE_M,
  createFollowController,
  enuOffset,
  followPose,
} from './follow.js';

const { cartesian3 } = geo;

function harness() {
  let pose = {
    position: cartesian3.fromDegrees(0, 0, 1e7),
    direction: cartesian3.create(-1, 0, 0),
    up: cartesian3.create(0, 0, 1),
  };
  const commanded = createEngineEvent();
  const frame = createEngineEvent();
  let renders = 0;
  const controller = createFollowController({
    camera: { pose: () => pose, commanded },
    aim: (next) => {
      pose = next;
    },
    frame,
    requestRender: () => renders++,
  });
  return {
    controller,
    frame: () => frame.raiseEvent(),
    pose: () => pose,
    move: (next) => {
      pose = next;
    },
    command: () => commanded.raiseEvent(),
    renders: () => renders,
  };
}

const target0 = cartesian3.fromDegrees(-74, 40.7, 1000);

test('the follow pose looks at the target from its ENU offset', () => {
  const pose = followPose(target0, cartesian3.create(0, -400, 300), 150);
  assert.ok(Math.abs(cartesian3.distance(pose.position, target0) - 500) < 1e-6);
  const back = enuOffset(target0, pose.position);
  assert.ok(Math.abs(back.y + 400) < 1e-6 && Math.abs(back.z - 300) < 1e-6);
  const toTarget = cartesian3.normalize(
    cartesian3.subtract(target0, pose.position, cartesian3.create()),
    cartesian3.create(),
  );
  assert.ok(cartesian3.dot(toTarget, pose.direction) > 1 - 1e-12);
  assert.ok(Math.abs(cartesian3.dot(pose.up, pose.direction)) < 1e-12);
  // Inside the minimum range: pushed out along the same direction.
  const near = followPose(target0, cartesian3.create(0, -30, 40), 150);
  assert.ok(Math.abs(cartesian3.distance(near.position, target0) - 150) < 1e-6);
});

test('a follow carries the camera with the target, keeps user changes, ends on a command', () => {
  const h = harness();
  let target = target0;
  const changes = [];
  h.controller.followChanged.addEventListener((handle) => changes.push(handle));
  const handle = h.controller.follow({
    position: () => target,
    viewFrom: cartesian3.create(0, -400, 300),
  });
  assert.equal(h.controller.following(), handle);
  h.frame();
  assert.ok(
    Math.abs(cartesian3.distance(h.pose().position, target) - 500) < 1e-6,
  );
  // The target moves 250 m east: the camera moves with it.
  target = cartesian3.fromDegrees(-74 + 250 / 84_400, 40.7, 1000);
  h.frame();
  assert.ok(
    Math.abs(cartesian3.distance(h.pose().position, target) - 500) < 1e-3,
  );
  // The user zooms in to 100 m: kept at the minimum range (150 m).
  const pose = h.pose();
  h.move({
    ...pose,
    position: cartesian3.add(
      pose.position,
      cartesian3.multiplyByScalar(pose.direction, 400, cartesian3.create()),
      cartesian3.create(),
    ),
  });
  h.frame();
  assert.ok(
    Math.abs(
      cartesian3.distance(h.pose().position, target) - MIN_FOLLOW_RANGE_M,
    ) < 1e-3,
  );
  assert.ok(h.renders() >= 3, 'a follow keeps frames coming');
  h.command();
  assert.equal(h.controller.following(), null);
  assert.deepEqual(changes, [handle, null]);
  const before = h.pose();
  h.frame();
  assert.equal(h.pose(), before, 'no more steps after the end');
});

test('stop ends the follow; a new follow replaces the old one', () => {
  const h = harness();
  const first = h.controller.follow({
    position: () => target0,
    viewFrom: () => cartesian3.create(0, -1000, 500),
  });
  const second = h.controller.follow({
    position: () => target0,
    viewFrom: cartesian3.create(500, 0, 500),
  });
  assert.equal(h.controller.following(), second);
  first.stop();
  assert.equal(
    h.controller.following(),
    second,
    'a stale handle stops nothing',
  );
  second.stop();
  assert.equal(h.controller.following(), null);
  assert.throws(
    () => h.controller.follow({ position: 1, viewFrom: {} }),
    TypeError,
  );
});

test('with engine gestures, drag orbits at the same range and wheel stops at the floor', () => {
  let pose = {
    position: cartesian3.fromDegrees(0, 0, 1e7),
    direction: cartesian3.create(-1, 0, 0),
    up: cartesian3.create(0, 0, 1),
  };
  const commanded = createEngineEvent();
  const frame = createEngineEvent();
  let handlers = null;
  let suspended = 0;
  const controller = createFollowController({
    camera: { pose: () => pose, commanded },
    aim: (next) => {
      pose = next;
    },
    frame,
    requestRender: () => {},
    gestures: (next) => {
      handlers = next;
      suspended++;
      return () => {
        handlers = null;
        suspended--;
      };
    },
  });
  const handle = controller.follow({
    position: () => target0,
    viewFrom: cartesian3.create(0, -1000, 500),
  });
  assert.equal(suspended, 1, 'the engine gestures are taken');
  frame.raiseEvent();
  const range = () => cartesian3.distance(pose.position, target0);
  const start = range();
  handlers.orbit(0.8, 0.3);
  frame.raiseEvent();
  assert.ok(Math.abs(range() - start) < 1e-6 * start, 'orbit keeps the range');
  const offset = enuOffset(target0, pose.position);
  assert.ok(Math.abs(offset.x) > 100, 'the heading turned');
  // A camera move nobody commanded (the engine's own controller) is not
  // read back while the gestures are the follow's.
  pose = { ...pose, position: cartesian3.fromDegrees(10, 10, 1e6) };
  frame.raiseEvent();
  assert.ok(Math.abs(range() - start) < 1e-6 * start);
  for (let i = 0; i < 40; i++) {
    handlers.zoom(0.5);
    frame.raiseEvent();
    assert.ok(range() >= MIN_FOLLOW_RANGE_M - 1e-6, `range ${range()}`);
  }
  assert.ok(Math.abs(range() - MIN_FOLLOW_RANGE_M) < 1e-6, 'at the floor');
  // Pitch stays above the target's horizon and short of straight down.
  handlers.orbit(0, 10);
  frame.raiseEvent();
  const up = enuOffset(target0, pose.position);
  assert.ok(up.z > 0 && up.z < MIN_FOLLOW_RANGE_M, 'pitch clamped');
  handle.stop();
  assert.equal(suspended, 0, 'the gestures are given back');
});

test('a still target and offset request no renders', () => {
  const h = harness();
  h.controller.follow({
    position: () => target0,
    viewFrom: cartesian3.create(0, -1000, 500),
  });
  h.frame();
  h.frame();
  const settled = h.renders();
  for (let i = 0; i < 5; i++) h.frame();
  assert.equal(h.renders(), settled, 'idle while nothing moves');
});

test('a dolly moves along the offset as Cesium zoom3D, never inside the floor', async () => {
  const { dollyOffset } = await import('./follow.js');
  const offset = cartesian3.create(0, -1000, 0);
  // Five times the window ratio of the distance above the floor (closing).
  const closer = dollyOffset(offset, 0.05, 150);
  assert.ok(
    Math.abs(cartesian3.magnitude(closer) - (1000 - 5 * 850 * 0.05)) < 1e-9,
  );
  const away = dollyOffset(offset, -0.05, 150);
  assert.ok(
    Math.abs(cartesian3.magnitude(away) - (1000 + 5 * 1000 * 0.05)) < 1e-9,
  );
  // At most a tenth per move, and never through the floor.
  const capped = dollyOffset(offset, 0.5, 150);
  assert.ok(
    Math.abs(cartesian3.magnitude(capped) - (1000 - 5 * 850 * 0.1)) < 1e-9,
  );
  let near = cartesian3.create(0, -160, 0);
  for (let i = 0; i < 20; i++) near = dollyOffset(near, 0.1, 150);
  assert.ok(cartesian3.magnitude(near) >= 150);
});
