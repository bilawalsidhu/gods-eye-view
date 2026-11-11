import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldClock } from './worldClock.js';
import {
  createSnapshotTimeline,
  SNAPSHOT_RETRY_MS,
  SNAPSHOT_WAIT_MS,
} from './snapshotTimeline.js';

const STEP = 10_000;
const WALL = Date.UTC(2026, 10, 1, 12);

function harness({ timeline = true, coverage } = {}) {
  const t = {
    wall: WALL,
    mono: 1_000,
    timers: new Map(),
    nextId: 1,
  };
  const clock = createWorldClock({
    now: () => t.wall,
    monotonicNow: () => t.mono,
    setInterval: () => 0,
    clearInterval: () => {},
    requestFrame: null,
    cancelFrame: null,
  });
  let span =
    coverage === undefined ? { start: WALL - 3_600_000, end: WALL } : coverage;
  const coverageListeners = new Set();
  const source = {
    getSnapshot() {},
    ...(timeline && {
      timeline: {
        coverage: () => span,
        stepMs: STEP,
        subscribe(listener) {
          coverageListeners.add(listener);
          return () => coverageListeners.delete(listener);
        },
      },
    }),
  };
  const calls = [];
  const pending = [];
  const timers = {
    setTimeout: (fn, ms) => {
      const id = t.nextId++;
      t.timers.set(id, { fn, at: t.mono + ms });
      return id;
    },
    clearTimeout: (id) => t.timers.delete(id),
  };
  const follower = createSnapshotTimeline({
    id: 'flights',
    clock,
    source: () => source,
    load: (atMs, { signal, replace }) =>
      new Promise((resolve, reject) => {
        calls.push({ type: 'load', atMs, replace });
        pending.push({ atMs, replace, signal, resolve, reject });
      }),
    clear: () => calls.push({ type: 'clear' }),
    resumeLive: () => calls.push({ type: 'live' }),
    now: () => t.mono,
    ...timers,
  });
  return {
    t,
    clock,
    follower,
    calls,
    pending,
    setCoverage(next) {
      span = next;
      for (const listener of coverageListeners) listener();
    },
    coverageListeners,
    advance(ms) {
      t.wall += ms;
      t.mono += ms;
      for (const [id, timer] of [...t.timers]) {
        if (timer.at > t.mono) continue;
        t.timers.delete(id);
        timer.fn();
      }
    },
    async answer(index = 0, value = true) {
      pending.splice(index, 1)[0].resolve(value);
      await flush();
    },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const loads = (calls) => calls.filter((call) => call.type === 'load');

test('a source with no timeline never follows the clock nor asks for a time', async () => {
  const h = harness({ timeline: false });
  h.follower.start();
  assert.equal(h.follower.timeline, null);
  assert.equal(h.clock.follows('flights'), false);
  assert.equal(h.clock.coverage(), null);
  h.clock.seek(WALL - 600_000);
  h.clock.play();
  h.advance(30_000);
  h.clock.goLive();
  await flush();
  assert.equal(h.follower.active(), false);
  assert.deepEqual(h.calls, []);
  h.follower.stop();
});

test('at the live edge a layer with a timeline only follows and registers', async () => {
  const h = harness();
  h.follower.start();
  await flush();
  assert.equal(h.clock.follows('flights'), true);
  assert.deepEqual(h.clock.coverage(), {
    start: WALL - 3_600_000,
    end: WALL,
    marks: [],
  });
  assert.equal(h.follower.active(), false);
  assert.deepEqual(h.calls, []);
  h.follower.stop();
  assert.equal(h.clock.follows('flights'), false);
  assert.equal(h.clock.coverage(), null);
});

test('a seek asks for the step at or before the time, holding play while it loads', async () => {
  const h = harness();
  h.follower.start();
  const at = WALL - 600_000 + 4_321;
  h.clock.seek(at);
  await flush();
  assert.equal(h.follower.active(), true);
  assert.deepEqual(loads(h.calls), [
    { type: 'load', atMs: WALL - 600_000, replace: true },
  ]);
  h.clock.play();
  h.advance(2_000);
  assert.equal(h.clock.now(), at, 'play waits on the snapshot');
  assert.equal(h.clock.getState().buffering, true);
  await h.answer();
  assert.equal(h.clock.getState().buffering, false);
  h.follower.stop();
});

test('a seek back replaces the contacts and an older answer is dropped', async () => {
  const h = harness();
  h.follower.start();
  h.clock.seek(WALL - 600_000);
  await flush();
  const first = h.pending[0];
  h.clock.seek(WALL - 1_200_000);
  await flush();
  assert.equal(first.signal.aborted, true, 'the older load is cancelled');
  first.resolve(true);
  await flush();
  assert.deepEqual(
    loads(h.calls).map(({ atMs, replace }) => [atMs, replace]),
    [
      [WALL - 600_000, true],
      [WALL - 1_200_000, true],
    ],
  );
  await h.answer(1);
  // Going backwards in time is a jump too, even without a seek.
  h.clock.seek(WALL - 1_300_000);
  await flush();
  assert.equal(loads(h.calls).at(-1).replace, true);
  h.follower.stop();
});

test('playing on asks for the next step and play does not pass it unloaded', async () => {
  const h = harness();
  h.follower.start();
  const at = WALL - 600_000;
  h.clock.seek(at);
  await flush();
  await h.answer();
  h.clock.play();
  h.advance(100);
  // A tick: the clock tells its listeners as play goes on.
  h.clock.coverageChanged();
  await flush();
  assert.deepEqual(loads(h.calls).at(-1), {
    type: 'load',
    atMs: at + STEP,
    replace: false,
  });
  h.advance(STEP * 2);
  assert.equal(h.clock.now(), at + STEP, 'gated at the step still loading');
  h.clock.coverageChanged();
  assert.equal(h.clock.getState().buffering, true);
  await h.answer(h.pending.length - 1);
  assert.equal(h.clock.getState().buffering, false);
  assert.deepEqual(loads(h.calls).at(-1), {
    type: 'load',
    atMs: at + 2 * STEP,
    replace: false,
  });
  // A step that never comes holds play for at most SNAPSHOT_WAIT_MS.
  h.advance(STEP * 2);
  h.clock.coverageChanged();
  assert.equal(h.clock.getState().buffering, true);
  h.advance(SNAPSHOT_WAIT_MS);
  assert.equal(h.clock.getState().buffering, false);
  h.advance(1_000);
  assert.ok(h.clock.now() > at + 2 * STEP, 'play went on without it');
  h.follower.stop();
});

test('a failed snapshot clears the time and is asked again later', async () => {
  const h = harness();
  h.follower.start();
  h.clock.seek(WALL - 600_000);
  await flush();
  await h.answer(0, false);
  assert.deepEqual(h.calls.at(-1), { type: 'clear' });
  assert.equal(loads(h.calls).length, 1);
  h.advance(SNAPSHOT_RETRY_MS);
  await flush();
  assert.equal(loads(h.calls).length, 2);
  assert.equal(loads(h.calls)[1].replace, true);
  h.follower.stop();
});

test('outside coverage the layer is cleared and nothing loads; unknown coverage waits', async () => {
  const h = harness({ coverage: null });
  h.follower.start();
  h.clock.seek(WALL - 600_000);
  await flush();
  assert.deepEqual(h.calls, [], 'no coverage yet: nothing loads or clears');
  h.setCoverage({ start: WALL - 3_600_000, end: WALL });
  await flush();
  assert.deepEqual(loads(h.calls), [
    { type: 'load', atMs: WALL - 600_000, replace: true },
  ]);
  await h.answer();
  h.clock.seek(WALL - 7_200_000);
  await flush();
  assert.deepEqual(h.calls.at(-1), { type: 'clear' });
  assert.equal(loads(h.calls).length, 1);
  h.follower.stop();
  assert.equal(h.coverageListeners.size, 0);
});

test('back at live the layer is cleared and polls at once', async () => {
  const h = harness();
  h.follower.start();
  h.clock.seek(WALL - 600_000);
  await flush();
  const inflight = h.pending[0];
  h.clock.goLive();
  await flush();
  assert.equal(inflight.signal.aborted, true);
  assert.deepEqual(h.calls.slice(-2), [{ type: 'clear' }, { type: 'live' }]);
  assert.equal(h.follower.active(), false);
  h.follower.stop();
});

test('a load the source drops for a newer one is no failure: nothing clears, it is asked again', async () => {
  const h = harness();
  h.follower.start();
  h.clock.seek(WALL - 600_000);
  await flush();
  h.pending
    .shift()
    .reject(new DOMException('Superseded by a newer request', 'AbortError'));
  await flush();
  assert.equal(
    h.calls.some((call) => call.type === 'clear'),
    false,
    'the layer keeps what it shows',
  );
  assert.equal(loads(h.calls).length, 1);
  h.advance(SNAPSHOT_RETRY_MS);
  await flush();
  assert.equal(loads(h.calls).length, 2, 'the time is asked for again');
  assert.equal(loads(h.calls)[1].replace, true);
  h.follower.stop();
});

test('a layer never has two loads out: the older is aborted before a newer starts', async () => {
  const h = harness();
  h.follower.start();
  const live = () => h.pending.filter(({ signal }) => !signal.aborted).length;
  h.clock.seek(WALL - 600_000);
  await flush();
  await h.answer();
  h.clock.play();
  await flush();
  assert.equal(live(), 1, 'the next step loads');
  h.follower.reload();
  await flush();
  assert.equal(live(), 1, 'a reload drops it first');
  h.clock.seek(WALL - 900_000);
  await flush();
  assert.equal(live(), 1, 'a seek drops it first');
  assert.equal(h.pending.length, 3);
  h.follower.stop();
  assert.equal(live(), 0);
});

test('a source that tells of a better answer has the paused time loaded again, not a playing one', async () => {
  const h = harness();
  h.follower.start();
  const at = WALL - 600_000;
  h.clock.seek(at);
  await flush();
  await h.answer();
  const before = loads(h.calls).length;
  for (const listener of h.coverageListeners) listener();
  await flush();
  assert.equal(loads(h.calls).length, before + 1);
  assert.equal(loads(h.calls).at(-1).atMs, at);
  await h.answer(h.pending.length - 1);
  h.clock.play();
  const playing = loads(h.calls).length;
  for (const listener of h.coverageListeners) listener();
  await flush();
  assert.ok(
    loads(h.calls)
      .slice(playing)
      .every((call) => call.atMs !== at),
    'playing, the time shown is not loaded again',
  );
  h.clock.goLive();
  await flush();
  const live = loads(h.calls).length;
  for (const listener of h.coverageListeners) listener();
  await flush();
  assert.equal(loads(h.calls).length, live, 'live, nothing is loaded');
  h.follower.stop();
});
