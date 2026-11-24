import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceInactivity } from './inactivity.js';
function fixture() {
  let activity = {
    known: true,
    connected: true,
    held: false,
    inputBusy: false,
    outputBusy: false,
    generationBusy: false,
  };
  let pending = 0,
    expired = 0,
    time = 100,
    serial = 0;
  const timers = new Map();
  const idle = createVoiceInactivity({
    readActivity: () => activity,
    readPending: () => pending,
    onExpire: () => expired++,
    now: () => time,
    setTimer: (fn, delay) => {
      timers.set(++serial, { fn, delay });
      return serial;
    },
    clearTimer: (id) => timers.delete(id),
  });
  return {
    idle,
    activity,
    timers,
    setPending: (n) => (pending = n),
    expired: () => expired,
    fire: () => {
      const entry = [...timers][0];
      timers.delete(entry[0]);
      entry[1].fn();
    },
    tick: (n) => (time += n),
  };
}
test('one clock; quiet arms default five minutes; busy blocks and quiescence rearms', () => {
  const f = fixture();
  assert.equal([...f.timers.values()][0].delay, 300000);
  assert.equal(f.idle.snapshot().deadline, 300100);
  f.activity.outputBusy = true;
  f.idle.update();
  assert.equal(f.timers.size, 0);
  f.activity.outputBusy = false;
  f.tick(200);
  f.idle.update();
  assert.equal(f.idle.snapshot().deadline, 300300);
  f.fire();
  assert.equal(f.expired(), 1);
});
test('actual activity resets but silent unchanged snapshots do not', () => {
  const f = fixture();
  const deadline = f.idle.snapshot().deadline;
  f.tick(1000);
  f.idle.update();
  assert.equal(f.idle.snapshot().deadline, deadline);
  f.idle.update({ activity: true });
  assert.equal(f.idle.snapshot().deadline, deadline + 1000);
});
test('None cancels; invalid values cannot replace setting; explicit retry rearms', () => {
  const f = fixture();
  assert.equal(f.idle.setMinutes(0), true);
  assert.equal(f.timers.size, 0);
  for (const bad of [1.5, -1, 61, '5', NaN])
    assert.equal(f.idle.setMinutes(bad), false);
  assert.equal(f.idle.setMinutes(1), true);
  assert.equal([...f.timers.values()][0].delay, 60000);
});
test('expiry rereads held, unknown and pending counts despite missing update', () => {
  for (const kind of ['held', 'unknown', 'pending']) {
    const f = fixture();
    if (kind === 'held') f.activity.held = true;
    if (kind === 'unknown') f.activity.known = false;
    if (kind === 'pending') f.setPending(2);
    f.fire();
    assert.equal(f.expired(), 0);
  }
});
test('pending siblings and held-before-connect forbid timer; stale callback cannot expire', () => {
  const f = fixture();
  const stale = [...f.timers.values()][0].fn;
  f.setPending(2);
  f.idle.update();
  stale();
  assert.equal(f.expired(), 0);
  f.setPending(1);
  f.idle.update();
  assert.equal(f.timers.size, 0);
  f.setPending(0);
  f.activity.connected = false;
  f.activity.held = true;
  f.idle.update();
  assert.equal(f.timers.size, 0);
  f.activity.connected = true;
  f.idle.update();
  assert.equal(f.timers.size, 0);
  f.activity.held = false;
  f.idle.update();
  assert.equal(f.timers.size, 1);
  f.idle.destroy();
  assert.equal(f.timers.size, 0);
});
