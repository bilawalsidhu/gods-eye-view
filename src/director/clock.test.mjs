import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackClock } from './clock.js';

const scene = { id: 'scene', shots: [{ id: 'shot' }] };
const shot = scene.shots[0];
const timing = {
  shotIndex: 0,
  totalSec: 4,
  durationSec: 4,
  startElapsedSec: 0,
};
function fixture() {
  const timers = new Map();
  let id = 0,
    now = 0,
    running = true;
  const progress = [];
  const clock = createPlaybackClock({
    isRunning: () => running,
    timingForShot: () => timing,
    onProgress: (value) => progress.push(value),
    now: () => now,
    schedule: (callback) => {
      timers.set(++id, callback);
      return id;
    },
    cancel: (handle) => timers.delete(handle),
  });
  return {
    clock,
    timers,
    progress,
    time: (value) => {
      now = value;
    },
    running: (value) => {
      running = value;
    },
  };
}

test('Stop releases every clock timer and queued callbacks cannot publish later', () => {
  const f = fixture();
  const observed = [];
  f.clock.subscribe((snapshot) => observed.push(snapshot));
  f.clock.startRunProgress(4);
  f.clock.startScene(scene, shot, { cancelled: false });
  f.time(2000);
  for (const tick of f.timers.values()) tick();
  assert.equal(f.clock.snapshot.sceneElapsedSec, 2);
  const stale = [...f.timers.values()];
  f.clock.stop();
  assert.equal(f.clock.activeTimers, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.clock.snapshot.stopped, true);
  const count = observed.length,
    progressCount = f.progress.length;
  f.time(3000);
  for (const tick of stale) tick();
  assert.equal(observed.length, count);
  assert.equal(f.progress.length, progressCount);
});

test('replacing a shot clock rejects the old callback without clearing the replacement', () => {
  const f = fixture();
  f.clock.startScene(scene, shot, {});
  const stale = [...f.timers.values()][0];
  f.time(1000);
  f.clock.startScene(scene, shot, {});
  f.time(2000);
  stale();
  assert.equal(f.clock.snapshot.sceneElapsedSec, 0);
  assert.equal(f.clock.activeTimers, 1);
  [...f.timers.values()][0]();
  assert.equal(f.clock.snapshot.sceneElapsedSec, 1);
  f.clock.destroy();
});

test('direct-load progress finishes once and snapshots cannot mutate the clock', () => {
  const f = fixture();
  f.running(false);
  f.clock.startShotProgress({}, 2, 0.25, 0.75, {
    scene,
    shot,
    sceneElapsedFrom: 1,
    sceneElapsedTo: 3,
  });
  const tick = [...f.timers.values()][0];
  f.time(1000);
  tick();
  assert.equal(f.progress.at(-1), 0.5);
  assert.equal(f.clock.snapshot.sceneElapsedSec, 2);
  const copy = f.clock.snapshot;
  copy.sceneElapsedSec = 99;
  assert.equal(f.clock.snapshot.sceneElapsedSec, 2);
  f.time(2000);
  tick();
  assert.equal(f.progress.at(-1), 0.75);
  assert.equal(f.clock.activeTimers, 0);
  const count = f.progress.length;
  tick();
  assert.equal(f.progress.length, count);
});

test('aborted starts and destruction during initial notification leave no timers or listeners', () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  f.clock.startScene(scene, shot, { signal: controller.signal });
  assert.equal(f.timers.size, 0);
  let calls = 0;
  f.clock.subscribe(() => {
    calls++;
    f.clock.destroy();
  });
  f.clock.startScene(scene, shot, {});
  assert.equal(calls, 1);
  assert.equal(f.clock.activeTimers, 0);
  f.clock.startRunProgress(4);
  f.clock.publish(scene, shot, 1);
  f.clock.subscribe(() => calls++);
  assert.equal(calls, 1);
  assert.equal(f.timers.size, 0);
});

test('Stop, abort and destroy settle long holds immediately and release their deadlines', async () => {
  for (const action of ['stop', 'abort', 'destroy']) {
    const clock = createPlaybackClock({
      isRunning: () => true,
      timingForShot: () => timing,
      onProgress() {},
    });
    const abort = new AbortController();
    const wait = clock.wait(60000, { signal: abort.signal });
    assert.equal(clock.activeTimers, 1);
    if (action === 'abort') abort.abort();
    else clock[action]();
    await wait;
    assert.equal(clock.activeTimers, 0);
    clock.destroy();
  }
});

test('a subscriber can Stop or replace the initial clock without the old start acquiring a timer', () => {
  for (const action of ['stop', 'replace']) {
    const f = fixture();
    let first = true;
    f.clock.subscribe(() => {
      if (!first) return;
      first = false;
      if (action === 'stop') f.clock.stop();
      else f.clock.startScene(scene, { id: 'replacement' }, {});
    });
    f.clock.startScene(scene, shot, {});
    assert.equal(f.timers.size, action === 'stop' ? 0 : 1);
    assert.equal(
      f.clock.snapshot.shotId,
      action === 'stop' ? shot.id : 'replacement',
    );
    f.clock.destroy();
  }
  const f = fixture();
  f.running(false);
  f.clock.subscribe(() => f.clock.stop());
  f.clock.startShotProgress({}, 10, 0, 1, {
    scene,
    shot,
    sceneElapsedFrom: 0,
    sceneElapsedTo: 4,
  });
  assert.equal(f.timers.size, 0);
});
