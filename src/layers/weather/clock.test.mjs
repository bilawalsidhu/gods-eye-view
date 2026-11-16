import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWeatherClock,
  RADAR_MAX_GAP_MS,
  REGIONAL_INFRARED_MAX_GAP_MS,
  GLOBAL_INFRARED_MAX_GAP_MS,
  LIGHTNING_MAX_GAP_MS,
  PLAY_WAIT_MS,
  frameSpacingMs,
  atLeastFrameSpacing,
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

test('a feed’s frame spacing is the median of its latest frames', () => {
  assert.equal(frameSpacingMs([]), null);
  assert.equal(frameSpacingMs([time(0)]), null);
  assert.equal(frameSpacingMs([0, 10, 20, 30].map(time)), 10 * 60_000);
  // Out of order, repeated, unparseable, and one late frame among many.
  assert.equal(
    frameSpacingMs([
      time(60),
      time(0),
      'never',
      time(0),
      time(10),
      time(20),
      time(30),
    ]),
    10 * 60_000,
  );
  assert.equal(frameSpacingMs([0, 60, 120].map(time)), 60 * 60_000);
  assert.equal(frameSpacingMs([0, 10, 70, 130]), 60);
  // Only the latest frames count: an hourly start gives way to ten minutes.
  const times = [
    ...[-600, -540, -480, -420, -360, -300, -240, -180, -120, -60],
    ...[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120],
  ].map(time);
  assert.equal(frameSpacingMs(times), 10 * 60_000);
});

test('a product’s gap is at least one and a half of its feed’s frame spacings', (t) => {
  const tenMinutes = [0, 10, 20, 30].map(time);
  const hourly = [0, 60, 120].map(time);
  assert.equal(
    atLeastFrameSpacing(REGIONAL_INFRARED_MAX_GAP_MS, tenMinutes),
    REGIONAL_INFRARED_MAX_GAP_MS,
    'frames minutes apart keep the product’s own gap',
  );
  assert.equal(
    atLeastFrameSpacing(REGIONAL_INFRARED_MAX_GAP_MS, hourly),
    90 * 60_000,
  );
  assert.equal(
    atLeastFrameSpacing(REGIONAL_INFRARED_MAX_GAP_MS, [time(0)]),
    REGIONAL_INFRARED_MAX_GAP_MS,
  );
  assert.equal(
    atLeastFrameSpacing(GLOBAL_INFRARED_MAX_GAP_MS, hourly),
    GLOBAL_INFRARED_MAX_GAP_MS,
  );

  // Selected against it, an hourly feed has a frame all through each hour.
  const { clock } = harness(t);
  const clouds = product(
    'clouds',
    [0, 60, 120],
    atLeastFrameSpacing(REGIONAL_INFRARED_MAX_GAP_MS, hourly),
  );
  clock.register(clouds);
  assert.equal(clock.selectFor('clouds', time(45)), time(0));
  assert.equal(clock.selectFor('clouds', time(119)), time(60));
  assert.equal(clock.selectFor('clouds', time(210)), time(120));
  assert.equal(clock.selectFor('clouds', time(211)), null);
});

const at = (minutes) => Date.parse(time(minutes));

test('history applies per-product selections, including null; live restores unequal newest times', async (t) => {
  const { clock, world } = harness(t);
  const radar = product('radar', [0, 10, 20]);
  const satellite = product('satellite', [5, 15]);
  const lightning = product('lightning', [15]);
  for (const p of [radar, satellite, lightning]) clock.register(p);
  world.seek(at(10));
  await flush();
  assert.deepEqual(
    [radar.shown, satellite.shown, lightning.shown],
    [time(10), time(5), null],
  );
  assert.deepEqual(
    clock.getState().products.map(({ selected }) => selected),
    [time(10), time(5), null],
  );
  world.goLive();
  await flush();
  assert.deepEqual(
    [radar.shown, satellite.shown, lightning.shown],
    [time(20), time(15), time(15)],
  );
  assert.equal(clock.getState().mode, 'latest');
  assert.equal(clock.getState().target, null);
  assert.equal(clock.getState().advancing, false);
});

test('superseded completions cannot commit or notify', async (t) => {
  const { clock, world, timers } = harness(t);
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
  world.seek(at(0));
  await flush();
  world.seek(at(10));
  await flush();
  assert.equal(loads[0].signal.aborted, true);
  loads[1].finish();
  await flush();
  const count = notifications;
  loads[0].finish();
  await flush();
  assert.equal(notifications, count);
  assert.equal(p.shown, time(10));
  assert.equal(clock.getState().target, time(10));
  assert.equal(timers.size, 0);
});

test('the clock has no time controls of its own; the world clock moves time', (t) => {
  const { clock, world } = harness(t);
  for (const name of [
    'setTarget',
    'step',
    'latest',
    'play',
    'pause',
    'togglePlay',
  ])
    assert.equal(clock[name], undefined, name);
  assert.equal(clock.world, world);
});

test('refresh does not apply in latest; history retains its target as expired frames disappear', async (t) => {
  const { clock, world } = harness(t);
  const p = product('radar', [0, 10]);
  clock.register(p);
  await clock.refresh();
  assert.equal(p.calls.length, 0);
  world.seek(at(10));
  await flush();
  p.times = [time(0), time(20)];
  await clock.refresh();
  assert.equal(p.shown, time(0));
  p.times = [time(20)];
  await clock.refresh();
  assert.equal(p.shown, null);
  assert.equal(clock.getState().target, time(10));
});

test('registration joins history; unregister and destroy abort work and release subscriptions/timers', async (t) => {
  const { clock, world, timers } = harness(t);
  const p = product('radar', [0, 10]);
  const unregister = clock.register(p);
  world.seek(at(0));
  await flush();
  const b = product('satellite', [0, 5]);
  clock.register(b);
  await flush();
  assert.equal(b.shown, time(0));
  world.seek(at(5));
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
  off();
  world.seek(at(0));
  await flush();
  assert.equal(notifications, 0);
  world.seek(at(5));
  clock.destroy();
  clock.destroy();
  await flush();
  assert.equal(timers.size, 0);
  assert.equal(b.calls.at(-1).signal.aborted, true);
  assert.deepEqual(clock.getTimeline(), []);
});

test('the weather time is the world time', async (t) => {
  const { clock, world } = harness(t);
  const radar = product('radar', [0, 10, 20]);
  clock.register(radar);
  assert.equal(world.follows('radar'), true);
  world.seek(at(3));
  await flush();
  assert.equal(clock.getState().mode, 'history');
  assert.equal(clock.getState().target, time(3));
  assert.equal(radar.shown, time(0));
  world.goLive();
  await flush();
  assert.equal(clock.getState().mode, 'latest');
  assert.equal(radar.shown, time(20));
});

test('world play runs the world on its own at its rate; weather does not drive it', async (t) => {
  const { clock, world, tick } = harness(t);
  const radar = product('radar', [0, 10, 20]);
  clock.register(radar);
  world.seek(at(0));
  await flush();
  world.play({ rate: 60 });
  assert.equal(world.getState().stepping, false);
  assert.equal(clock.getState().advancing, true);
  tick(5_000);
  assert.equal(world.now(), at(5), 'five minutes on at a minute a second');
  tick(10_000);
  await flush();
  assert.equal(world.now(), at(10), 'held at the next frame');
  world.pause();
  assert.equal(clock.getState().advancing, false);
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

function worldAt(at) {
  return createWorldClock({
    now: () => at,
    monotonicNow: () => 0,
    setInterval: () => 0,
    clearInterval() {},
  });
}

test('weather clocks sharing a world: the last one destroyed leaves it live', () => {
  const world = worldAt(Date.parse(time(20)));
  const a = createWeatherClock({ world, now: () => Date.parse(time(20)) });
  const b = createWeatherClock({ world, now: () => Date.parse(time(20)) });
  a.register(product('radar', [0, 10, 20]));
  b.register(product('radar', [0, 10, 20]));
  world.seek(Date.parse(time(0)));
  world.play();
  b.destroy();
  assert.equal(world.follows('radar'), true);
  assert.equal(world.isLive(), false);
  assert.equal(world.isPlaying(), true);
  a.destroy();
  assert.equal(world.follows('radar'), false);
  assert.equal(world.isLive(), true);
  assert.equal(world.isPlaying(), false);
});

test('each product’s frames span world clock coverage, with no marks, and support the timeline while shown', (t) => {
  const { clock, world } = harness(t);
  assert.equal(world.coverage(), null);
  assert.equal(world.getState().supported, false);
  const radar = product('radar', [0, 10]);
  const unregister = clock.register(radar);
  clock.register(product('lightning', [5]));
  assert.deepEqual(world.coverage(), {
    start: Date.parse(time(0)),
    end: Date.parse(time(10)),
    marks: [],
    markDetails: [],
  });
  assert.equal(world.getState().supported, true);
  unregister();
  assert.deepEqual(world.coverage(), {
    start: Date.parse(time(5)),
    end: Date.parse(time(5)),
    marks: [],
    markDetails: [],
  });
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
  assert.deepEqual(world.coverage(), {
    start: Date.parse(time(0)),
    end: Date.parse(time(10)),
    marks: [],
    markDetails: [],
  });
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
