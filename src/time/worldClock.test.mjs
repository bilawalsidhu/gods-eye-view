import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorldClock,
  WORLD_CLOCK_MARK_LABEL_LENGTH,
  WORLD_CLOCK_TICK_MS,
} from './worldClock.js';

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
    markDetails: [{ time: 100 }, { time: 150 }, { time: 200 }],
  });
  off();
  assert.deepEqual(clock.coverage(), {
    start: 50,
    end: 180,
    marks: [],
    markDetails: [],
  });
});

test('marks may carry a label, an id and a kind, and merge in one order', () => {
  const clock = createWorldClock(fakeTime().options);
  clock.register({
    id: 'launches',
    coverage: () => ({
      start: 100,
      end: 300,
      marks: [
        { time: 300, label: ' ARTEMIS II ', id: 'a2', kind: 'launch' },
        100,
        { time: 200, label: 'M6.4 · Fiji', kind: 'earthquake', extra: 1 },
      ],
    }),
  });
  clock.register({
    id: 'others',
    coverage: () => ({
      start: 100,
      end: 300,
      marks: [
        200,
        { time: 200, label: 'M6.4 · Fiji', kind: 'earthquake' },
        { time: 200, label: 'ALPHA', kind: 'launch' },
        { time: 250, label: '', id: 7, kind: null },
        { time: Number.NaN, label: 'never' },
        Number.POSITIVE_INFINITY,
        null,
        'soon',
      ],
    }),
  });
  const covered = clock.coverage();
  assert.deepEqual(covered.marks, [100, 200, 250, 300], 'the times, once each');
  assert.deepEqual(covered.markDetails, [
    { time: 100 },
    // A bare 200 says nothing a labelled mark there does not; alike marks
    // from two sources are one.
    { time: 200, label: 'M6.4 · Fiji', kind: 'earthquake' },
    { time: 200, label: 'ALPHA', kind: 'launch' },
    { time: 250 },
    { time: 300, label: 'ARTEMIS II', id: 'a2', kind: 'launch' },
  ]);
  assert.ok(covered.markDetails.every(Object.isFrozen));
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

test('continuous play runs past every driver, and live keeps the rate chosen', () => {
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
  assert.equal(clock.getRate(), 30);
  assert.equal(clock.now(), t.wall, 'live is the wall clock, whatever the rate');
  // Play with no rate given runs at the one chosen.
  clock.seek(t.wall - 60_000);
  clock.play({ continuous: true });
  t.advance(1_000);
  assert.equal(clock.now(), t.wall - 61_000 + 30_000);
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

test('a seek or a return to live counts as a jump; play does not', () => {
  const t = fakeTime();
  const clock = createWorldClock(t.options);
  assert.equal(clock.getState().jumps, 0);
  clock.seek(t.wall - 60_000);
  assert.equal(clock.getState().jumps, 1);
  clock.seek(t.wall - 60_000);
  assert.equal(clock.getState().jumps, 1, 'the same paused time is no jump');
  clock.play();
  t.advance(1_000);
  t.timers.forEach(({ fn }) => fn());
  assert.equal(clock.getState().jumps, 1, 'playing on is no jump');
  clock.pause();
  clock.setRate(4);
  assert.equal(clock.getState().jumps, 1);
  clock.goLive();
  assert.equal(clock.getState().jumps, 2);
  clock.goLive();
  assert.equal(clock.getState().jumps, 2, 'already live is no jump');
});

test('a mark label longer than the timeline shows is cut, ending in an ellipsis', () => {
  const clock = createWorldClock(fakeTime().options);
  const long = `${'A'.repeat(58)}  BEYOND THE CUT`;
  clock.register({
    id: 'long',
    coverage: () => ({
      start: 1,
      end: 2,
      marks: [
        { time: 1, label: long },
        { time: 2, label: 'B'.repeat(WORLD_CLOCK_MARK_LABEL_LENGTH) },
      ],
    }),
  });
  const [cut, whole] = clock.coverage().markDetails;
  assert.equal(cut.label, `${'A'.repeat(58)}…`);
  assert.ok(cut.label.length <= WORLD_CLOCK_MARK_LABEL_LENGTH);
  assert.equal(whole.label, 'B'.repeat(WORLD_CLOCK_MARK_LABEL_LENGTH));
});

test('a cut label never splits an emoji, and counts it as one character', () => {
  const clock = createWorldClock(fakeTime().options);
  const a = 'A'.repeat(58);
  clock.register({
    id: 'emoji',
    coverage: () => ({
      start: 1,
      end: 3,
      marks: [
        { time: 1, label: `${a}🚀 LIFTOFF` },
        { time: 2, label: `${a}👩‍🚀 CREW` },
        // Sixty characters, though more UTF-16 units: whole.
        { time: 3, label: `${'A'.repeat(59)}🚀` },
      ],
    }),
  });
  const [rocket, crew, whole] = clock.coverage().markDetails;
  assert.equal(rocket.label, `${a}🚀…`);
  assert.equal(crew.label, `${a}👩‍🚀…`);
  assert.equal(whole.label, `${'A'.repeat(59)}🚀`);
  for (const { label } of [rocket, crew, whole])
    assert.equal(label.isWellFormed(), true, 'no lone surrogate');
});

test('marks merge on their whole label, so labels alike up to the cut stay two', () => {
  const clock = createWorldClock(fakeTime().options);
  const stem = 'C'.repeat(WORLD_CLOCK_MARK_LABEL_LENGTH - 1);
  for (const id of ['one', 'two'])
    clock.register({
      id,
      coverage: () => ({
        start: 5,
        end: 5,
        marks: [{ time: 5, label: `${stem}${id === 'one' ? ' FIRST' : ' SECOND'}` }],
      }),
    });
  const covered = clock.coverage();
  assert.deepEqual(covered.marks, [5]);
  assert.equal(covered.markDetails.length, 2);
  for (const mark of covered.markDetails) {
    assert.equal(mark.label, `${stem}…`);
    assert.equal(Object.isFrozen(mark), true);
  }
});
