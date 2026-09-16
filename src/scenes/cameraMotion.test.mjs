import test from 'node:test';
import assert from 'node:assert/strict';
import { createCameraMotion } from './cameraMotion.js';
const move = {
  durationSec: 2,
  easing: 'linear',
  from: { lat: 0, lon: 0, alt: 100, heading: 0, pitch: 0, roll: 0 },
  to: { lat: 2, lon: 2, alt: 200, heading: 0, pitch: 0, roll: 0 },
};
function harness(apply) {
  let time = 0;
  let next = 0;
  const frames = new Map();
  const poses = [];
  const owner = createCameraMotion({
    now: () => time,
    requestFrame: (cb) => {
      const id = ++next;
      frames.set(id, cb);
      return id;
    },
    cancelFrame: (id) => frames.delete(id),
    applyPose: (pose) => {
      poses.push(pose);
      return apply?.(pose);
    },
  });
  return {
    owner,
    frames,
    poses,
    tick(ms) {
      time = ms;
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((cb) => cb());
    },
  };
}
test('motion uses the authored curve and releases the frame on completion', async () => {
  const h = harness();
  const done = h.owner.play(move, { cancelled: false });
  assert.deepEqual(h.poses[0], move.from);
  h.tick(1000);
  assert.equal(h.poses.at(-1).alt, 150);
  h.tick(2000);
  assert.equal(await done, true);
  assert.deepEqual(h.poses.at(-1), move.to);
  assert.equal(h.frames.size, 0);
  assert.equal(h.owner.active, false);
});
test('abort and replacement settle immediately and revoke already queued callbacks', async () => {
  const h = harness();
  const abort = new AbortController();
  const first = h.owner.play(move, { signal: abort.signal });
  const stale = [...h.frames.values()][0];
  abort.abort();
  assert.equal(await first, false);
  const second = h.owner.play(move, {});
  const count = h.poses.length;
  stale();
  assert.equal(h.poses.length, count);
  h.owner.destroy();
  assert.equal(await second, false);
  assert.equal(h.frames.size, 0);
  assert.equal(await h.owner.play(move, {}), false);
});
test('synchronous cancellation from pose application schedules no abandoned frame', async () => {
  let owner;
  const h = harness(() => owner.cancel());
  owner = h.owner;
  assert.equal(await owner.play(move, {}), false);
  assert.equal(h.frames.size, 0);
});
test('failed pose application settles and invalid durations cannot schedule a loop', async () => {
  const h = harness(() => {
    throw new Error('camera unavailable');
  });
  await assert.rejects(h.owner.play(move, {}), /camera unavailable/);
  assert.equal(h.frames.size, 0);
  assert.throws(
    () => h.owner.play({ ...move, durationSec: 0 }, {}),
    /duration/,
  );
});
