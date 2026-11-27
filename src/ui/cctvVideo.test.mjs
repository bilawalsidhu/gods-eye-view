import test from 'node:test';
import assert from 'node:assert/strict';
import { createCctvVideoSurface } from './cctvVideo.js';
test('second surface uses shared decoder, caps draws, clears switch and cancels teardown', () => {
  let callback;
  let draws = 0;
  let clears = 0;
  let cancelled = 0;
  const canvas = {
    width: 1,
    height: 1,
    getContext: () => ({ drawImage: () => draws++, clearRect: () => clears++ }),
  };
  let v = {
    readyState: 2,
    videoWidth: 1920,
    videoHeight: 1080,
    currentTime: 1,
  };
  const surface = createCctvVideoSurface(canvas, () => v, {
    requestFrame: (fn) => {
      callback = fn;
      return 1;
    },
    cancelFrame: () => cancelled++,
  });
  callback(0);
  callback(20);
  callback(80);
  assert.equal(draws, 1);
  assert.equal(canvas.width, 640);
  v = { ...v };
  callback(160);
  assert.equal(draws, 2);
  assert.equal(clears, 2);
  surface.stop();
  callback(200);
  assert.equal(cancelled, 1);
  assert.equal(draws, 2);
});

test('the surface says when it waits, plays and stalls', () => {
  let callback;
  const states = [];
  const canvas = {
    width: 1,
    height: 1,
    getContext: () => ({ drawImage() {}, clearRect() {} }),
  };
  let video = { readyState: 0, videoWidth: 0, videoHeight: 0, currentTime: 0 };
  const surface = createCctvVideoSurface(canvas, () => video, {
    requestFrame: (fn) => {
      callback = fn;
      return 1;
    },
    cancelFrame() {},
    onState: (state) => states.push(state),
    stallMs: 1000,
  });
  callback(0);
  // It starts out waiting, so the caller hears only of changes.
  assert.deepEqual(states, [], 'nothing decoded yet');
  Object.assign(video, { readyState: 4, videoWidth: 640, videoHeight: 360 });
  video.currentTime = 1;
  callback(100);
  assert.deepEqual(states, ['playing']);
  callback(900);
  assert.deepEqual(states, ['playing'], 'within the stall window');
  callback(1200);
  assert.deepEqual(states, ['playing', 'stalled']);
  video.currentTime = 2;
  callback(1300);
  assert.deepEqual(states, ['playing', 'stalled', 'playing']);
  // Another decoder clears the canvas: waiting again for its first frame.
  video = { readyState: 0, videoWidth: 0, videoHeight: 0, currentTime: 0 };
  callback(1400);
  assert.deepEqual(states, ['playing', 'stalled', 'playing', 'waiting']);
  surface.stop();
});

test('a stalled surface looks for a new frame once a second, not on every animation frame', () => {
  let callback;
  let requests = 0;
  let pending = null;
  const canvas = {
    width: 1,
    height: 1,
    getContext: () => ({ drawImage() {}, clearRect() {} }),
  };
  const video = {
    readyState: 4,
    videoWidth: 640,
    videoHeight: 360,
    currentTime: 1,
  };
  const states = [];
  const surface = createCctvVideoSurface(canvas, () => video, {
    requestFrame: (fn) => {
      requests++;
      callback = fn;
      return 1;
    },
    cancelFrame() {},
    onState: (state) => states.push(state),
    stallMs: 1000,
    setTimer: (fn, ms) => {
      pending = { fn, ms };
      return 7;
    },
    clearTimer: () => (pending = null),
  });
  callback(0);
  callback(1200);
  assert.deepEqual(states, ['playing', 'stalled']);
  const before = requests;
  assert.equal(pending?.ms, 1000, 'one check a second while stalled');
  callback(1300);
  assert.equal(requests, before, 'no animation frame asked for meanwhile');
  video.currentTime = 2;
  pending.fn();
  assert.equal(requests, before + 1);
  callback(2400);
  assert.deepEqual(states, ['playing', 'stalled', 'playing']);
  surface.stop();
  assert.equal(pending, null, 'stop clears the pending check');
});
