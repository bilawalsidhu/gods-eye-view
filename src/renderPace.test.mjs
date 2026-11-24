import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRenderPace,
  createScreenSpeed,
  paceHzForSpeed,
  PACE_MAX_HZ,
  PACE_MIN_HZ,
  PACE_STEP_PX,
} from './renderPace.js';

/** A pace with fake timers, clock and render calls. */
function makePace() {
  const calls = [];
  const timers = new Map();
  let nextId = 1;
  let nowMs = 0;
  const pace = createRenderPace({
    owner: 'dots',
    render: {
      holdContinuousRender: (owner, options) =>
        calls.push(['hold', owner, options.maxFps]),
      releaseContinuousRender: (owner) => calls.push(['release', owner]),
      governorRequestRender: (owner) => calls.push(['request', owner]),
    },
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    now: () => nowMs,
  });
  return {
    pace,
    calls,
    timers,
    advance(ms) {
      nowMs += ms;
    },
    fire() {
      const [id, timer] = [...timers][0];
      timers.delete(id);
      timer.fn();
      return timer.ms;
    },
  };
}

test('a mark may move half a pixel between draws', () => {
  assert.equal(PACE_STEP_PX, 0.5);
  assert.equal(paceHzForSpeed(1), 2);
  assert.equal(paceHzForSpeed(10), 20);
});

test('slow marks are drawn three times a second, one frame at a time', () => {
  const { pace, calls, timers, fire } = makePace();
  pace.start();
  pace.set(0.2);
  pace.set(0.2);
  // From the starting rate it eases down, never below the floor.
  for (let i = 0; i < 40; i++) pace.set(0.2);
  assert.equal(pace.state().hz, PACE_MIN_HZ);
  assert.equal(pace.state().held, false);
  assert.ok(timers.size === 1, 'one wait out');
  // The wait out from the start runs out, then the next is at the floor.
  fire();
  assert.equal(fire(), 1000 / PACE_MIN_HZ);
  assert.deepEqual(calls.at(-1), ['request', 'dots']);
  assert.ok(!calls.some(([kind]) => kind === 'hold'));
});

test('fast marks hold the loop at a rate the display divides, never above 30', () => {
  const { pace, calls, timers } = makePace();
  pace.start();
  pace.set(13);
  assert.deepEqual(calls.at(-1), ['hold', 'dots', 15]);
  assert.equal(timers.size, 0, 'held: no waits');
  pace.set(18);
  assert.deepEqual(calls.at(-1), ['hold', 'dots', 20]);
  pace.set(500);
  assert.deepEqual(calls.at(-1), ['hold', 'dots', PACE_MAX_HZ]);
  assert.equal(pace.state().hz, PACE_MAX_HZ);
  pace.set(Infinity);
  assert.equal(pace.state().heldFps, PACE_MAX_HZ);
  // The same rate again asks the governor for nothing.
  const before = calls.length;
  pace.set(40);
  assert.equal(calls.length, before);
});

test('the hold is let go below the release rate, not at the hold rate', () => {
  const { pace, calls } = makePace();
  pace.start();
  pace.set(14);
  assert.equal(pace.state().held, true);
  // Down gently: a tenth a frame at most.
  for (let i = 0; i < 2; i++) pace.set(10);
  assert.equal(pace.state().held, true, 'still above the release rate');
  for (let i = 0; i < 20; i++) pace.set(1);
  assert.equal(pace.state().held, false);
  assert.ok(calls.some(([kind]) => kind === 'release'));
});

test('marks a layer moves itself move at the pace, and on every frame while held', () => {
  const { pace, advance, fire } = makePace();
  pace.start();
  assert.equal(pace.take(), true, 'first frame moves');
  assert.equal(pace.take(), false, 'same instant: no move');
  for (let i = 0; i < 40; i++) pace.set(0);
  advance(100);
  assert.equal(pace.take(), false, 'too soon at three a second');
  fire();
  assert.equal(pace.take(), true, 'the wait ended');
  advance(1000 / PACE_MIN_HZ);
  assert.equal(pace.take(), true, 'a third of a second on');
  pace.set(30);
  assert.equal(pace.take(), true);
  assert.equal(pace.take(), true, 'held: every drawn frame');
});

test('stopping lets the hold go and ends the waits; a stopped pace moves every frame', () => {
  const { pace, calls, timers } = makePace();
  pace.start();
  pace.set(25);
  pace.stop();
  assert.deepEqual(calls.at(-1), ['release', 'dots']);
  assert.equal(timers.size, 0);
  pace.set(25);
  assert.equal(pace.state().held, false, 'set does nothing once stopped');
  assert.equal(pace.take(), true);
  assert.equal(pace.take(), true);
});

/** A camera at `z` metres up the z axis looking down it, 60° field. */
function poseAt(z) {
  return {
    position: { x: 0, y: 0, z },
    direction: { x: 0, y: 0, z: -1 },
    fovy: Math.PI / 3,
  };
}

test('screen speed: a move across the view axis, from its angle at the eye', () => {
  const speed = createScreenSpeed();
  assert.equal(speed.begin(poseAt(1000), 1000), true);
  // 10 m sideways at 1 km ahead, over one second.
  speed.add({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  const focal = 500 / Math.tan(Math.PI / 6);
  // Measured at the move's end: 10 m off-axis, a hair off-centre.
  const px = speed.pxPerSec(1);
  assert.ok(Math.abs(px - (10 / 1000) * focal) / px < 0.001, `${px}`);
  assert.ok(Math.abs(speed.pxPerSec(2) - px / 2) < 1e-9);
});

test('screen speed: the fastest mark counts, marks behind or far off-axis do not', () => {
  const speed = createScreenSpeed();
  speed.begin(poseAt(1000), 1000);
  speed.add({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  speed.add({ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 });
  // Behind the eye.
  speed.add({ x: 0, y: 0, z: 2000 }, { x: 500, y: 0, z: 2000 });
  // 80° off the axis.
  speed.add({ x: 5000, y: 0, z: 900 }, { x: 5500, y: 0, z: 900 });
  const focal = 500 / Math.tan(Math.PI / 6);
  assert.ok(Math.abs(speed.pxPerSec(1) - (5 / 1000) * focal) < 0.01);
});

test('screen speed: a mark moving with the eye stands still on screen', () => {
  const speed = createScreenSpeed();
  speed.begin(poseAt(1000), 1000, { x: 7, y: 0, z: 0 });
  speed.add({ x: 0, y: 0, z: 0 }, { x: 7, y: 0, z: 0 });
  assert.equal(speed.pxPerSec(1), 0);
});

test('screen speed: no camera, no reading', () => {
  const speed = createScreenSpeed();
  assert.equal(speed.begin(null, 900), false);
  speed.add({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  assert.equal(speed.pxPerSec(1), 0);
});

test('a need of ten a second, once held, falls back to single frames at ten', () => {
  const { pace, timers } = makePace();
  pace.start();
  pace.set(30);
  for (let i = 0; i < 40; i++) pace.set(10);
  assert.equal(pace.state().held, false);
  assert.equal(Math.round(pace.state().hz), 10);
  assert.equal(timers.size, 1);
});

test('a mark read over less time counts at the speed it moves, not slower', () => {
  const speed = createScreenSpeed();
  const pose = {
    position: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    fovy: Math.PI / 3,
  };
  // 100 m a second, 10 km ahead: read over a full second, and over 50 ms.
  speed.begin(pose, 900);
  speed.add({ x: 0, y: 0, z: -10_000 }, { x: 100, y: 0, z: -10_000 });
  const full = speed.pxPerSec(1);
  speed.begin(pose, 900);
  speed.add({ x: 0, y: 0, z: -10_000 }, { x: 5, y: 0, z: -10_000 }, 20);
  assert.ok(full > 0);
  assert.ok(Math.abs(speed.pxPerSec(1) - full) < 1e-3 * full);
});
