import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldClock, WORLD_CLOCK_TICK_MS } from './worldClock.js';

function fakeTime() {
  const t = {
    wall: Date.UTC(2026, 10, 1, 12),
    mono: 1_000,
    timers: new Map(),
    nextId: 1,
    advance(ms) {
      t.wall += ms;
      t.mono += ms;
    },
    options: {
      now: () => t.wall,
      monotonicNow: () => t.mono,
      setInterval: (fn, ms) => {
        const id = t.nextId++;
        t.timers.set(id, { fn, ms });
        return id;
      },
      clearInterval: (id) => t.timers.delete(id),
    },
  };
  return t;
}

test('live is the wall clock for every layer', () => {
  const t = fakeTime();
  const clock = createWorldClock(t.options);
  assert.equal(clock.isLive(), true);
  assert.equal(clock.now(), t.wall);
  t.advance(5_000);
  assert.equal(clock.now(), t.wall);
  assert.equal(clock.timeFor('flights')(), t.wall);
  clock.follow('flights');
  assert.equal(clock.timeFor('flights')(), t.wall);
});

test('away from live only following layers move with the cursor', () => {
  const t = fakeTime();
  const clock = createWorldClock(t.options);
  const satellites = clock.timeFor('satellites');
  const flights = clock.timeFor('flights');
  clock.follow('satellites');
  const past = t.wall - 3_600_000;
  clock.seek(past);
  assert.equal(clock.isLive(), false);
  assert.equal(clock.now(), past);
  assert.equal(satellites(), past);
  assert.equal(flights(), t.wall);
  assert.equal(clock.timeFor('satellites'), satellites);
  clock.goLive();
  assert.equal(satellites(), t.wall);
});

test('layers named at creation follow from the start', () => {
  const t = fakeTime();
  const clock = createWorldClock({ ...t.options, follow: ['satellites'] });
  clock.seek(t.wall - 1_000);
  assert.equal(clock.timeFor('satellites')(), t.wall - 1_000);
  assert.equal(clock.timeFor('flights')(), t.wall);
  clock.follow('satellites', false);
  assert.equal(clock.follows('satellites'), false);
});

test('the page clock moves the layers with a time of their own', async () => {
  const { worldClock } = await import('./worldClock.js');
  for (const id of ['sky', 'hud', 'satellites', 'rocket-launches'])
    assert.equal(worldClock.follows(id), true, id);
  for (const id of ['flights', 'military', 'vessels', 'transit'])
    assert.equal(worldClock.follows(id), false, id);
});

test('continuous play advances the cursor at the rate and pause holds it', () => {
  const t = fakeTime();
  const clock = createWorldClock(t.options);
  const start = t.wall - 60_000;
  clock.seek(start);
  clock.play({ rate: 60 });
  t.advance(1_000);
  assert.equal(clock.now(), start + 60_000);
  clock.setRate(120);
  t.advance(1_000);
  assert.equal(clock.now(), start + 180_000);
  clock.pause();
  t.advance(1_000);
  assert.equal(clock.now(), start + 180_000);
  assert.equal(clock.isPlaying(), false);
});

test('play from live starts at now, and goLive returns to the wall clock', () => {
  const t = fakeTime();
  const clock = createWorldClock(t.options);
  const from = t.wall;
  clock.play({ rate: 2 });
  assert.equal(clock.isLive(), false);
  t.advance(1_000);
  assert.equal(clock.now(), from + 2_000);
  clock.goLive();
  assert.equal(clock.isPlaying(), false);
  assert.equal(clock.now(), t.wall);
});

test('subscribers hear changes, and ticks only while playing continuously', () => {
  const t = fakeTime();
  const clock = createWorldClock(t.options);
  const states = [];
  const off = clock.subscribe((state) => states.push(state));
  clock.seek(t.wall - 1_000);
  assert.equal(states.length, 1);
  assert.equal(states[0].live, false);
  assert.equal(t.timers.size, 0);
  clock.play();
  assert.equal(t.timers.size, 1);
  assert.equal([...t.timers.values()][0].ms, WORLD_CLOCK_TICK_MS);
  clock.pause();
  assert.equal(t.timers.size, 0);
  clock.play();
  off();
  assert.equal(t.timers.size, 0);
});

test('a driver takes play and pause, and moves the clock with seek', () => {
  const t = fakeTime();
  const clock = createWorldClock(t.options);
  const calls = [];
  const handle = clock.attachDriver({
    play() {
      calls.push('play');
      handle.driven(true, t.wall - 10_000);
    },
    pause() {
      calls.push('pause');
      handle.driven(false);
    },
  });
  clock.play();
  assert.deepEqual(calls, ['play']);
  assert.equal(clock.isPlaying(), true);
  assert.equal(clock.now(), t.wall - 10_000);
  const at = clock.now();
  t.advance(5_000);
  // Stepped, not continuous: the cursor waits for the driver.
  assert.equal(clock.now(), at);
  clock.pause();
  assert.deepEqual(calls, ['play', 'pause']);
  assert.equal(clock.isPlaying(), false);
  clock.play();
  clock.goLive();
  assert.deepEqual(calls, ['play', 'pause', 'play', 'pause']);
  assert.equal(clock.isLive(), true);
  assert.equal(clock.isPlaying(), false);
  assert.equal(handle.detach(), 0);
  clock.play();
  assert.equal(calls.length, 4);
  t.advance(1_000);
  assert.equal(clock.now(), t.wall);
});

test('play goes to the newest driver that can play, pause to the one playing', () => {
  const t = fakeTime();
  const clock = createWorldClock(t.options);
  const calls = [];
  const driver = (name, canPlay) => {
    const handle = clock.attachDriver({
      play() {
        if (!canPlay()) return false;
        calls.push(`${name} play`);
        handle.driven(true);
      },
      pause() {
        calls.push(`${name} pause`);
        handle.driven(false);
      },
    });
    return handle;
  };
  let bCanPlay = false;
  const a = driver('a', () => true);
  const b = driver('b', () => bCanPlay);
  clock.seek(t.wall - 1_000);
  clock.play();
  assert.deepEqual(calls, ['a play']);
  // b starting takes over from a.
  bCanPlay = true;
  b.driven(true);
  assert.deepEqual(calls, ['a play', 'a pause']);
  clock.pause();
  assert.deepEqual(calls, ['a play', 'a pause', 'b pause']);
  assert.equal(clock.isPlaying(), false);
  // A detached driver stops, and the other one plays next.
  clock.play();
  assert.equal(b.detach(), 1);
  assert.equal(clock.isPlaying(), false);
  clock.play();
  assert.equal(calls.at(-1), 'a play');
  assert.equal(a.detach(), 0);
  assert.equal(clock.isPlaying(), false);
});

test('a listener that changes the clock leaves nobody with a stale state', () => {
  const t = fakeTime();
  const clock = createWorldClock(t.options);
  const seen = [];
  clock.subscribe((state) => {
    if (state.timeMs === 0) clock.seek(1_000);
  });
  clock.subscribe((state) => seen.push(state.timeMs));
  clock.seek(0);
  assert.deepEqual(seen, [1_000]);
});

test('holds keep a layer following until every holder releases it', () => {
  const clock = createWorldClock(fakeTime().options);
  const first = clock.hold('radar');
  const second = clock.hold('radar');
  first();
  first();
  assert.equal(clock.follows('radar'), true);
  second();
  assert.equal(clock.follows('radar'), false);
  clock.follow('radar');
  const third = clock.hold('radar');
  third();
  assert.equal(clock.follows('radar'), true);
  assert.deepEqual(clock.getState().following, ['radar']);
});

test('a driver that cannot play leaves continuous playback', () => {
  const t = fakeTime();
  const clock = createWorldClock(t.options);
  clock.attachDriver({ play: () => false, pause() {} });
  clock.seek(t.wall - 10_000);
  clock.play();
  assert.equal(clock.isPlaying(), true);
  t.advance(1_000);
  // Wall and cursor moved the same second at rate 1.
  assert.equal(clock.now(), t.wall - 10_000);
});

test('coverage is the union of the registered sources', () => {
  const clock = createWorldClock(fakeTime().options);
  assert.equal(clock.coverage(), null);
  const off = clock.register({
    id: 'radar',
    coverage: () => ({ start: 100, end: 200, marks: [100, 150, 200] }),
  });
  clock.register({ id: 'satellites', coverage: () => ({ start: 50, end: 180 }) });
  clock.register({ id: 'empty', coverage: () => null });
  assert.deepEqual(clock.coverage(), {
    start: 50,
    end: 200,
    marks: [100, 150, 200],
  });
  off();
  assert.deepEqual(clock.coverage(), { start: 50, end: 180, marks: [] });
});

test('seek refuses anything but epoch ms and rate must be positive', () => {
  const clock = createWorldClock(fakeTime().options);
  assert.throws(() => clock.seek(Number.NaN), TypeError);
  assert.throws(() => clock.setRate(0), RangeError);
});

test('seek refuses a time no Date can hold', () => {
  const clock = createWorldClock(fakeTime().options);
  assert.throws(() => clock.seek(8.8e15), TypeError);
  clock.seek(-8.64e15);
  assert.equal(clock.now(), -8.64e15);
});

test('only a followed layer with time to show supports the timeline', () => {
  const clock = createWorldClock(fakeTime().options);
  let span = null;
  const states = [];
  clock.subscribe((state) => states.push(state.supported));
  const off = clock.register({ id: 'satellites', coverage: () => span });
  span = { start: 0, end: 10 };
  clock.coverageChanged();
  assert.equal(clock.isSupported(), false, 'covered but not followed');
  clock.follow('satellites');
  assert.equal(clock.isSupported(), true);
  assert.equal(states.at(-1), true);
  span = null;
  clock.coverageChanged();
  assert.equal(states.at(-1), false);
  span = { start: 0, end: 10 };
  off();
  assert.equal(clock.isSupported(), false);
  assert.equal(states.at(-1), false);
});

test('a coverage that throws counts as none', (t) => {
  t.mock.method(console, 'error', () => {});
  const clock = createWorldClock(fakeTime().options);
  clock.follow('broken');
  clock.register({
    id: 'broken',
    coverage() {
      throw new Error('no');
    },
  });
  assert.equal(clock.getState().supported, false);
  assert.equal(clock.coverage(), null);
});

test('continuous play runs past every driver, and live resets the rate', () => {
  const t = fakeTime();
  const clock = createWorldClock(t.options);
  const calls = [];
  clock.attachDriver({ play: () => calls.push('play'), pause() {} });
  clock.seek(t.wall - 60_000);
  clock.play({ rate: 30, continuous: true });
  assert.deepEqual(calls, []);
  t.advance(1_000);
  assert.equal(clock.now(), t.wall - 61_000 + 30_000);
  clock.goLive();
  assert.equal(clock.getRate(), 1);
});

test('continuous play holds while a layer waits, and goes on from there', () => {
  const t = fakeTime();
  const clock = createWorldClock(t.options);
  const start = t.wall - 600_000;
  clock.seek(start);
  clock.play({ rate: 60, continuous: true });
  t.advance(1_000);
  assert.equal(clock.now(), start + 60_000);
  const release = clock.wait('radar');
  const other = clock.wait('clouds');
  assert.equal(clock.getState().buffering, true);
  t.advance(5_000);
  assert.equal(clock.now(), start + 60_000, 'held while loading');
  release();
  release();
  t.advance(1_000);
  assert.equal(clock.now(), start + 60_000, 'held until every layer is ready');
  other();
  assert.equal(clock.getState().buffering, false);
  t.advance(1_000);
  assert.equal(clock.now(), start + 120_000, 'on from where it held');
});

test('a seek still moves a waiting clock', () => {
  const t = fakeTime();
  const clock = createWorldClock(t.options);
  clock.seek(t.wall - 600_000);
  clock.play({ continuous: true });
  const release = clock.wait('radar');
  clock.seek(t.wall - 60_000);
  assert.equal(clock.now(), t.wall - 60_000);
  release();
});

test('playing, listeners hear of the time every animation frame', () => {
  const t = fakeTime();
  const frames = new Map();
  let nextFrame = 1;
  const clock = createWorldClock({
    ...t.options,
    requestFrame: (fn) => {
      frames.set(nextFrame, fn);
      return nextFrame++;
    },
    cancelFrame: (id) => frames.delete(id),
  });
  const heard = [];
  clock.subscribe((state) => heard.push(state.timeMs));
  const start = t.wall - 60_000;
  clock.seek(start);
  clock.play({ rate: 60 });
  assert.equal(t.timers.size, 0, 'no ticks with frames to go by');
  assert.equal(frames.size, 1);
  const runFrame = () => {
    const [[id, fn]] = frames;
    frames.delete(id);
    fn();
  };
  heard.length = 0;
  for (let i = 0; i < 3; i++) {
    t.advance(16);
    runFrame();
  }
  assert.deepEqual(heard, [start + 960, start + 1_920, start + 2_880]);
  clock.pause();
  assert.equal(frames.size, 0);
});
