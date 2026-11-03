import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWeatherClock,
  RADAR_MAX_GAP_MS,
  REGIONAL_INFRARED_MAX_GAP_MS,
  GLOBAL_INFRARED_MAX_GAP_MS,
  LIGHTNING_MAX_GAP_MS,
  PLAY_WAIT_MS,
} from './clock.js';
import { createWorldClock } from '../../time/worldClock.js';

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
  let mono = 0;
  const world = createWorldClock({
    now: () => at,
    monotonicNow: () => mono,
    setInterval: () => 0,
    clearInterval() {},
  });
  const clock = createWeatherClock({
    world,
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
    world,
    timers,
    tick(ms) {
      at += ms;
      mono += ms;
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

test('the weather time is the world time, both ways', async (t) => {
  const { clock, world } = harness(t);
  const radar = product('radar', [0, 10, 20]);
  clock.register(radar);
  assert.equal(world.follows('radar'), true);
  await clock.setTarget(time(10));
  assert.equal(world.isLive(), false);
  assert.equal(world.now(), Date.parse(time(10)));
  world.seek(Date.parse(time(3)));
  await flush();
  assert.equal(clock.getState().target, time(3));
  assert.equal(radar.shown, time(0));
  world.goLive();
  await flush();
  assert.equal(clock.getState().mode, 'latest');
  assert.equal(radar.shown, time(20));
});

test('world play and pause drive the weather replay', async (t) => {
  const { clock, world, tick } = harness(t);
  const radar = product('radar', [0, 10, 20]);
  clock.register(radar);
  world.seek(Date.parse(time(0)));
  await flush();
  world.play();
  assert.equal(clock.getState().playing, true);
  assert.equal(world.isPlaying(), true);
  tick(2000);
  await flush();
  assert.equal(radar.shown, time(10));
  assert.equal(world.now(), Date.parse(time(10)));
  world.pause();
  assert.equal(clock.getState().playing, false);
  clock.play();
  assert.equal(world.isPlaying(), true);
  clock.pause();
  assert.equal(world.isPlaying(), false);
  clock.play();
  world.goLive();
  await flush();
  assert.equal(clock.getState().playing, false);
  assert.equal(clock.getState().mode, 'latest');
});

test('a moving world re-applies frames only when a product changes frame', async (t) => {
  const { clock, world } = harness(t);
  const radar = product('radar', [0, 10, 20]);
  clock.register(radar);
  world.seek(Date.parse(time(0)));
  await flush();
  const applied = radar.calls.length;
  world.seek(Date.parse(time(0)) + 60_000);
  await flush();
  assert.equal(radar.calls.length, applied);
  assert.equal(
    clock.getState().target,
    new Date(Date.parse(time(1))).toISOString(),
  );
  world.seek(Date.parse(time(11)));
  await flush();
  assert.equal(radar.calls.length, applied + 1);
  assert.equal(radar.shown, time(10));
});

test('a world without frames to step plays on its own', async (t) => {
  const { clock, world, tick } = harness(t);
  world.seek(Date.parse(time(0)));
  world.play();
  assert.equal(clock.getState().playing, false);
  tick(1000);
  assert.equal(world.now(), Date.parse(time(0)) + 1000);
});

function worldAt(at) {
  return createWorldClock({
    now: () => at,
    monotonicNow: () => 0,
    setInterval: () => 0,
    clearInterval() {},
  });
}

test('weather clocks sharing a world hand play over, and the last leaves it live', async () => {
  const world = worldAt(Date.parse(time(20)));
  const a = createWeatherClock({ world, now: () => Date.parse(time(20)) });
  const b = createWeatherClock({ world, now: () => Date.parse(time(20)) });
  const radarA = product('radar', [0, 10, 20]);
  const radarB = product('radar', [0, 10, 20]);
  a.register(radarA);
  b.register(radarB);
  await a.play();
  assert.equal(world.isPlaying(), true);
  world.pause();
  assert.equal(a.getState().playing, false);
  assert.equal(world.isPlaying(), false);
  await a.play();
  world.goLive();
  assert.equal(a.getState().playing, false);
  b.destroy();
  assert.equal(world.follows('radar'), true);
  world.seek(Date.parse(time(0)));
  world.play();
  assert.equal(a.getState().playing, true);
  a.destroy();
  assert.equal(world.follows('radar'), false);
  assert.equal(world.isLive(), true);
  assert.equal(world.isPlaying(), false);
});

test('pausing from inside the first playing notice stops the world too', async (t) => {
  const { clock, world } = harness(t);
  clock.register(product('radar', [0, 10, 20]));
  const off = clock.subscribe((state) => {
    if (state.playing) {
      off();
      clock.pause();
    }
  });
  await clock.play();
  assert.equal(clock.getState().playing, false);
  assert.equal(world.isPlaying(), false);
});

test('a step holds a world that was playing on its own', async (t) => {
  const { clock, world } = harness(t);
  world.seek(Date.parse(time(0)));
  world.play();
  clock.register(product('radar', [0, 10, 20]));
  await clock.step(1);
  assert.equal(world.isPlaying(), false);
  assert.equal(world.now(), Date.parse(time(10)));
});

test('a target superseded from a listener resolves false', async (t) => {
  const { clock } = harness(t);
  const radar = product('radar', [0, 10, 20]);
  clock.register(radar);
  await flush();
  let redirected = false;
  clock.subscribe((state) => {
    if (state.target === time(0) && !redirected) {
      redirected = true;
      void clock.setTarget(time(10));
    }
  });
  assert.equal(await clock.setTarget(time(0)), false);
  assert.equal(radar.shown, time(10));
});

test('each product’s frames are world clock coverage, and support the timeline while shown', (t) => {
  const { clock, world } = harness(t);
  assert.equal(world.coverage(), null);
  assert.equal(world.getState().supported, false);
  const radar = product('radar', [0, 10]);
  const unregister = clock.register(radar);
  clock.register(product('lightning', [5]));
  assert.deepEqual(world.coverage(), {
    start: Date.parse(time(0)),
    end: Date.parse(time(10)),
    marks: [0, 5, 10].map((m) => Date.parse(time(m))),
  });
  assert.equal(world.getState().supported, true);
  unregister();
  assert.deepEqual(world.coverage().marks, [Date.parse(time(5))]);
  clock.destroy();
  assert.equal(world.coverage(), null);
  assert.equal(world.getState().supported, false);
});

test('a suspended product keeps its coverage, so the way back to live stays', (t) => {
  const { clock, world } = harness(t);
  const radar = product('radar', [0, 10]);
  clock.register(radar);
  radar.suspended = true;
  void clock.refresh();
  assert.equal(world.getState().supported, true);
  assert.deepEqual(
    world.coverage().marks,
    [0, 10].map((m) => Date.parse(time(m))),
  );
});

test('new frames reach the world clock through refresh', (t) => {
  const { clock, world } = harness(t);
  const radar = product('radar', []);
  clock.register(radar);
  const supported = [];
  world.subscribe((state) => supported.push(state.supported));
  assert.equal(world.getState().supported, false);
  radar.times = [time(0)];
  void clock.refresh();
  assert.equal(supported.at(-1), true);
});

test('a clock destroyed while it registers a product lets go of it', (t) => {
  const { clock, world } = harness(t);
  const off = world.subscribe(() => {
    off();
    clock.destroy();
  });
  const unregister = clock.register(product('radar', [0, 10]));
  unregister();
  assert.equal(world.follows('radar'), false);
  assert.equal(world.coverage(), null);
  assert.equal(world.getState().supported, false);
});

// A radar whose frames load only when the test says.
function slowRadar(minutes) {
  const radar = product('radar', minutes);
  radar.loads = [];
  radar.apply = (selected, { signal }) =>
    new Promise((resolve) => {
      radar.loads.push({
        selected,
        signal,
        done() {
          radar.shown = selected;
          resolve(true);
        },
      });
    });
  return radar;
}

test('play stops at the next frame, not past it, until it shows', async (t) => {
  const { clock, world, tick } = harness(t);
  const radar = slowRadar([0, 10, 20]);
  clock.register(radar);
  world.seek(Date.parse(time(1)));
  await flush();
  radar.loads.at(-1).done();
  await flush();
  world.play({ rate: 3_600, continuous: true });
  world.coverageChanged();
  tick(1_000);
  assert.equal(
    world.now(),
    Date.parse(time(10)),
    'an hour on, but held at the frame',
  );
});

test('playing, a frame loads as play goes on, and play holds at the next until it shows', async (t) => {
  const { clock, world, tick } = harness(t);
  const radar = slowRadar([0, 10, 20, 30]);
  clock.register(radar);
  world.seek(Date.parse(time(9)));
  await flush();
  radar.loads.at(-1).done();
  await flush();
  world.play({ rate: 60, continuous: true });
  // Into the next frame (the page's frames tell of it): it loads as play goes on.
  tick(2_000);
  world.coverageChanged();
  await flush();
  assert.equal(radar.loads.at(-1).selected, time(10));
  assert.equal(
    world.getState().buffering,
    false,
    'no hold for the frame play is at',
  );
  // At the frame after while that one still loads, play holds there.
  tick(10_000);
  world.coverageChanged();
  await flush();
  assert.equal(world.now(), Date.parse(time(20)));
  assert.equal(world.getState().buffering, true);
  assert.equal(
    radar.loads.at(-1).selected,
    time(10),
    'the frame before still loads',
  );
  tick(5_000);
  assert.equal(world.now(), Date.parse(time(20)), 'held while it loads');
  radar.loads.at(-1).done();
  await flush();
  assert.equal(
    radar.loads.at(-1).selected,
    time(20),
    'and on to the next once it shows',
  );
  assert.equal(world.getState().buffering, false);
  tick(1_000);
  assert.equal(world.now(), Date.parse(time(20)) + 60_000);

  // A scrub aborts what loads and loads where the hand is, with no wait.
  world.pause();
  world.seek(Date.parse(time(30)));
  await flush();
  const scrubbed = radar.loads.at(-1);
  world.seek(Date.parse(time(0)));
  await flush();
  assert.equal(scrubbed.signal.aborted, true);
  assert.equal(radar.loads.at(-1).selected, time(0));
  assert.equal(world.getState().buffering, false);
});

test('a frame that never comes holds play only so long', async (t) => {
  const { clock, world, tick } = harness(t);
  const radar = slowRadar([0, 10, 20]);
  clock.register(radar);
  world.seek(Date.parse(time(9)));
  await flush();
  radar.loads.at(-1).done();
  await flush();
  world.play({ rate: 60, continuous: true });
  tick(2_000);
  world.coverageChanged();
  await flush();
  tick(10_000);
  world.coverageChanged();
  await flush();
  assert.equal(world.getState().buffering, true);
  const stuck = radar.loads.at(-1);
  tick(PLAY_WAIT_MS);
  await flush();
  assert.equal(world.getState().buffering, false, 'play goes on without it');
  assert.equal(stuck.signal.aborted, true);
  assert.equal(radar.loads.at(-1).selected, time(20), 'loading where play is');
});

test('held at the next frame, a scrub back to the one loading lets play go', async (t) => {
  const { clock, world, tick } = harness(t);
  const radar = slowRadar([0, 10, 20]);
  clock.register(radar);
  world.seek(Date.parse(time(9)));
  await flush();
  radar.loads.at(-1).done();
  await flush();
  world.play({ rate: 60, continuous: true });
  tick(2_000);
  world.coverageChanged();
  await flush();
  tick(10_000);
  world.coverageChanged();
  await flush();
  assert.equal(world.getState().buffering, true);
  world.pause();
  world.seek(Date.parse(time(11)));
  await flush();
  world.play({ rate: 60, continuous: true });
  assert.equal(
    world.getState().buffering,
    false,
    'no hold for the frame it is at',
  );
  const at = world.now();
  tick(1_000);
  assert.equal(world.now(), at + 60_000);
});

test('a frame in flight as play starts loads as it goes on; a refresh does not hold', async (t) => {
  const { clock, world } = harness(t);
  const radar = slowRadar([0, 10, 20]);
  clock.register(radar);
  world.seek(Date.parse(time(5)));
  await flush();
  world.play({ continuous: true });
  assert.equal(world.getState().buffering, false);
  radar.loads.at(-1).done();
  await flush();
  void clock.refresh();
  await flush();
  assert.equal(world.getState().buffering, false, 'the same frames, no hold');
  radar.loads.at(-1).done();
});

test('weather clocks sharing a world gate it each on their own', async (t) => {
  let mono = 0;
  const world = createWorldClock({
    now: () => Date.parse(time(30)),
    monotonicNow: () => mono,
    setInterval: () => 0,
    clearInterval() {},
  });
  const a = createWeatherClock({ world, now: () => Date.parse(time(30)) });
  const b = createWeatherClock({ world, now: () => Date.parse(time(30)) });
  t.after(() => {
    a.destroy();
    b.destroy();
  });
  a.register(product('radar', [0, 10]));
  b.register(product('clouds', [0, 15]));
  world.seek(Date.parse(time(1)));
  await flush();
  world.play({ rate: 3_600, continuous: true });
  world.coverageChanged();
  b.destroy();
  world.coverageChanged();
  mono += 1_000;
  assert.equal(
    world.now(),
    Date.parse(time(10)),
    'the other clock’s gate stays',
  );
});

test('played through, listeners hear of frames as they change, and of play stopping', async (t) => {
  const { clock, world, tick } = harness(t);
  const radar = product('radar', [0, 10, 20]);
  clock.register(radar);
  world.seek(Date.parse(time(1)));
  await flush();
  world.play({ rate: 60, continuous: true });
  await flush();
  const heard = [];
  clock.subscribe((state) => heard.push(state));
  // Seconds of world time within one frame: nothing new to show.
  for (let i = 0; i < 5; i++) {
    tick(100);
    world.coverageChanged();
  }
  await flush();
  assert.equal(heard.length, 0);
  world.pause();
  await flush();
  assert.equal(heard.at(-1)?.advancing, false, 'heard play stop');
});
