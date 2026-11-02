import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWeatherClock,
  RADAR_MAX_GAP_MS,
  REGIONAL_INFRARED_MAX_GAP_MS,
  GLOBAL_INFRARED_MAX_GAP_MS,
  LIGHTNING_MAX_GAP_MS,
} from './clock.js';

const time = (minutes) =>
  new Date(Date.UTC(2026, 8, 21, 12, minutes)).toISOString();
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function product(id, minutes, maxGapMs = RADAR_MAX_GAP_MS) {
  const p = {
    id,
    maxGapMs,
    times: minutes.map(time),
    shown: null,
    suspended: false,
    calls: [],
    getTimes: () => p.times,
    getShownTime: () => p.shown,
    isSuspended: () => p.suspended,
    async apply(selected, { signal }) {
      p.calls.push({ selected, signal });
      if (signal.aborted) return false;
      p.shown = selected;
      return true;
    },
  };
  return p;
}
function harness(t) {
  let at = Date.parse(time(20));
  const timers = new Map();
  let id = 0;
  const clock = createWeatherClock({
    now: () => at,
    setTimeout(fn, delay) {
      timers.set(++id, { fn, due: at + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  t.after(() => clock.destroy());
  return {
    clock,
    timers,
    tick(ms) {
      at += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due > at) continue;
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

test('union excludes suspended products; nearest selection never uses future or out-of-gap frames', (t) => {
  const { clock } = harness(t);
  const radar = product('radar', [10, 0, 10]);
  const regional = product('regional', [5, 10]);
  const global = product('global', [-180, -60], GLOBAL_INFRARED_MAX_GAP_MS);
  const hidden = product('hidden', [99]);
  hidden.suspended = true;
  for (const p of [radar, regional, global, hidden]) clock.register(p);
  assert.deepEqual(clock.getTimeline(), [-180, -60, 0, 5, 10].map(time));
  assert.equal(clock.selectFor('radar', time(9)), time(0));
  assert.equal(clock.selectFor('radar', time(-1)), null);
  assert.equal(clock.selectFor('radar', time(40)), time(10));
  assert.equal(clock.selectFor('radar', time(41)), null);
  assert.equal(clock.selectFor('global', time(120)), time(-60));
  assert.equal(clock.selectFor('global', time(121)), null);
  assert.equal(clock.selectFor('missing', time(10)), null);
  assert.equal(REGIONAL_INFRARED_MAX_GAP_MS, 30 * 60_000);
  assert.equal(LIGHTNING_MAX_GAP_MS, 30 * 60_000);
});

test('history applies per-product selections, including null; latest restores unequal newest times', async (t) => {
  const { clock } = harness(t);
  const radar = product('radar', [0, 10, 20]);
  const satellite = product('satellite', [5, 15]);
  const lightning = product('lightning', [15]);
  for (const p of [radar, satellite, lightning]) clock.register(p);
  await clock.setTarget(time(10));
  assert.deepEqual(
    [radar.shown, satellite.shown, lightning.shown],
    [time(10), time(5), null],
  );
  assert.deepEqual(
    clock.getState().products.map(({ selected }) => selected),
    [time(10), time(5), null],
  );
  await clock.latest();
  assert.deepEqual(
    [radar.shown, satellite.shown, lightning.shown],
    [time(20), time(15), time(15)],
  );
  assert.equal(clock.getState().mode, 'latest');
  assert.equal(clock.getState().target, null);
  assert.equal(clock.getState().playing, false);
});

test('superseded completions cannot commit, notify or schedule a new playback advance', async (t) => {
  const { clock, timers } = harness(t);
  const p = product('radar', [0, 10, 20]);
  const loads = [];
  p.apply = (selected, { signal }) =>
    new Promise((resolve) => {
      loads.push({
        selected,
        signal,
        finish() {
          if (!signal.aborted) p.shown = selected;
          resolve(!signal.aborted);
        },
      });
    });
  clock.register(p);
  let notifications = 0;
  clock.subscribe(() => notifications++);
  const old = clock.setTarget(time(0));
  await flush();
  const current = clock.setTarget(time(10));
  await flush();
  assert.equal(loads[0].signal.aborted, true);
  loads[1].finish();
  assert.equal(await current, true);
  const count = notifications;
  loads[0].finish();
  assert.equal(await old, false);
  assert.equal(notifications, count);
  assert.equal(p.shown, time(10));
  assert.equal(clock.getState().target, time(10));
  assert.equal(timers.size, 0);
});

test('steps use strict union neighbours from arbitrary targets and clamp at endpoints', async (t) => {
  const { clock } = harness(t);
  clock.register(product('radar', [0, 10, 20]));
  clock.register(product('satellite', [5, 15]));
  await clock.step(-1);
  assert.equal(clock.getState().target, time(15));
  await clock.setTarget(time(12));
  await clock.step(-1);
  assert.equal(clock.getState().target, time(10));
  await clock.setTarget(time(12));
  await clock.step(1);
  assert.equal(clock.getState().target, time(15));
  await clock.setTarget(time(0));
  await clock.step(-1);
  assert.equal(clock.getState().target, time(0));
  await clock.setTarget(time(20));
  await clock.step(1);
  assert.equal(clock.getState().target, time(20));
});

test('playback waits for every product to settle, including rejection, then waits 2000 ms and wraps', async (t) => {
  const { clock, tick, timers } = harness(t);
  const a = product('radar', [0, 10]);
  const b = product('satellite', [5]);
  const loads = [];
  b.apply = () =>
    new Promise((resolve, reject) => loads.push({ resolve, reject }));
  clock.register(a);
  clock.register(b);
  const start = clock.play();
  await flush();
  assert.equal(clock.getState().target, time(10));
  tick(10_000);
  assert.equal(timers.size, 0);
  assert.equal(a.calls.length, 1);
  loads[0].reject(new Error('unavailable'));
  await start;
  assert.equal(timers.size, 1);
  tick(1999);
  assert.equal(clock.getState().target, time(10));
  tick(1);
  await flush();
  assert.equal(clock.getState().target, time(0));
  assert.equal(timers.size, 0);
  tick(10_000);
  assert.equal(clock.getState().target, time(0));
  loads[1].resolve(true);
  await flush();
  tick(2000);
  await flush();
  assert.equal(clock.getState().target, time(5));
  clock.pause();
  loads[2].resolve(false);
  await flush();
  assert.equal(timers.size, 0, 'pausing during a load prevents rescheduling');
});

test('pause cancels a pending advance; playback stops with one time or all products suspended', async (t) => {
  const { clock, tick, timers } = harness(t);
  const p = product('radar', [0, 10]);
  clock.register(p);
  await clock.play();
  await clock.play();
  assert.equal(timers.size, 1);
  clock.pause();
  tick(2000);
  assert.equal(clock.getState().target, time(10));
  assert.equal(timers.size, 0);
  await clock.togglePlay();
  p.times = [time(0)];
  await clock.refresh();
  assert.equal(clock.getState().playing, false);
  await clock.play();
  assert.equal(clock.getState().playing, false);
  p.times = [time(0), time(10)];
  await clock.refresh();
  await clock.play();
  p.suspended = true;
  await clock.refresh();
  assert.equal(clock.getState().playing, false);
  assert.deepEqual(clock.getTimeline(), []);
  assert.equal(timers.size, 0);
});

test('refresh does not apply in latest; history retains its target as expired frames disappear', async (t) => {
  const { clock } = harness(t);
  const p = product('radar', [0, 10]);
  clock.register(p);
  await clock.refresh();
  assert.equal(p.calls.length, 0);
  await clock.setTarget(time(10));
  p.times = [time(0), time(20)];
  await clock.refresh();
  assert.equal(p.shown, time(0));
  p.times = [time(20)];
  await clock.refresh();
  assert.equal(p.shown, null);
  assert.equal(clock.getState().target, time(10));
});

test('registration joins history; unregister and destroy abort work and release subscriptions/timers', async (t) => {
  const { clock, timers, tick } = harness(t);
  const p = product('radar', [0, 10]);
  const unregister = clock.register(p);
  await clock.setTarget(time(0));
  const b = product('satellite', [0, 5]);
  clock.register(b);
  await flush();
  assert.equal(b.shown, time(0));
  await clock.play();
  unregister();
  unregister();
  await flush();
  assert.equal(p.calls.at(-1).signal.aborted, true);
  assert.deepEqual(
    clock.getState().products.map(({ id }) => id),
    ['satellite'],
  );
  let notifications = 0;
  const off = clock.subscribe(() => notifications++);
  clock.pause();
  off();
  const before = notifications;
  await clock.play();
  assert.equal(notifications, before);
  clock.destroy();
  clock.destroy();
  tick(2000);
  assert.equal(timers.size, 0);
  assert.equal(b.calls.at(-1).signal.aborted, true);
  assert.equal(clock.getState().playing, false);
  assert.deepEqual(clock.getTimeline(), []);
  assert.equal(await clock.setTarget(time(5)), false);
});
