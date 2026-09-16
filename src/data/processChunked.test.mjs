import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { processChunked, processChunkedSync } from './processChunked.js';

/**
 * Deterministic requestIdleCallback stand-in: callbacks are queued instead of
 * scheduled, and each pump() call drives one slice with a caller-controlled
 * timeRemaining() budget. This lets the tests exercise the real drain loop
 * (multi-slice yields, empty budgets, completion) without fake timers.
 */
function installIdleQueue() {
  const queue = [];
  const optsHistory = [];
  let nextId = 1;
  const original = globalThis.requestIdleCallback;
  globalThis.requestIdleCallback = (fn, opts) => {
    const id = nextId++;
    optsHistory.push(opts);
    queue.push({ fn, opts, id });
    return id;
  };
  return {
    /** Total callbacks ever queued (scheduled, not merely still pending). */
    get scheduled() { return optsHistory.length; },
    /** Options ({ timeout }) captured for the i-th scheduled callback. */
    optsAt(i) { return optsHistory[i]; },
    /** Run the oldest queued callback with the given idle budget. */
    pump(budget, times = 1) {
      for (let n = 0; n < times && queue.length > 0; n++) {
        const { fn } = queue.shift();
        // A real IdleDeadline depletes as the slice runs; each check burns
        // one unit, so pump(3) processes exactly three items.
        let left = budget;
        fn({ timeRemaining: () => (left > 0 ? left-- : 0) });
      }
    },
    /** Number of callbacks still queued. */
    get pending() { return queue.length; },
    restore() { globalThis.requestIdleCallback = original; },
  };
}

/** Collect handle calls as [item, index] pairs and flag completion. */
function recorder() {
  const calls = [];
  let completed = false;
  return {
    handle: (item, index) => calls.push([item, index]),
    onComplete: () => { completed = true; },
    get calls() { return calls; },
    get completed() { return completed; },
  };
}

beforeEach(() => {
  // processChunked reads requestIdleCallback lazily; keep the real one off the
  // path unless a test installs the queue or explicitly wants the fallback.
  delete globalThis.requestIdleCallback;
});

afterEach(() => {
  delete globalThis.requestIdleCallback;
});

// ── Synchronous fast path (≤ SYNC_THRESHOLD items) ───────────────────────────

test('processChunked handles small arrays synchronously with no idle scheduling', () => {
  const idle = installIdleQueue();
  const rec = recorder();
  const items = ['a', 'b', 'c'];

  processChunked(items, 500, rec.handle, rec.onComplete);

  assert.deepEqual(rec.calls, [['a', 0], ['b', 1], ['c', 2]]);
  assert.ok(rec.completed, 'onComplete fires synchronously for small arrays');
  assert.equal(idle.scheduled, 0, 'no idle callback may be scheduled for small arrays');
  idle.restore();
});

test('processChunked with an empty array completes synchronously', () => {
  const idle = installIdleQueue();
  const rec = recorder();

  processChunked([], 500, rec.handle, rec.onComplete);

  assert.equal(rec.calls.length, 0);
  assert.ok(rec.completed);
  idle.restore();
});

// ── Asynchronous idle path (> SYNC_THRESHOLD items) ──────────────────────────

test('processChunked drains large arrays across idle slices in order', () => {
  const idle = installIdleQueue();
  const items = Array.from({ length: 1005 }, (_, i) => i);
  const rec = recorder();

  processChunked(items, 500, rec.handle, rec.onComplete);
  assert.ok(!rec.completed, 'not complete before any slice runs');
  assert.equal(rec.calls.length, 0);

  idle.pump(0); // an exhausted budget must yield without processing
  assert.equal(rec.calls.length, 0, 'zero timeRemaining processes nothing');
  assert.ok(idle.pending > 0, 'work must be rescheduled');

  idle.pump(3); // partial slice
  assert.equal(rec.calls.length, 3);
  assert.ok(!rec.completed);

  idle.pump(Infinity); // drain the rest in one go
  assert.equal(rec.calls.length, items.length);
  assert.ok(rec.completed, 'onComplete fires once the last item is handled');
  assert.equal(idle.pending, 0, 'no further slices scheduled after completion');
  idle.restore();
});

test('processChunked preserves item order and indices across slices', () => {
  const idle = installIdleQueue();
  const items = Array.from({ length: 1200 }, (_, i) => `item-${i}`);
  const rec = recorder();

  processChunked(items, 500, rec.handle, rec.onComplete);
  idle.pump(7);
  idle.pump(7);
  idle.pump(Infinity);

  assert.deepEqual(rec.calls, items.map((item, index) => [item, index]));
  idle.restore();
});

test('processChunked passes { timeout: 16 } to requestIdleCallback', () => {
  const idle = installIdleQueue();
  const items = Array.from({ length: 1001 }, (_, i) => i);

  processChunked(items, 500, recorder().handle);
  idle.pump(Infinity);

  assert.ok(idle.scheduled >= 1);
  assert.deepEqual(idle.optsAt(0), { timeout: 16 });
  idle.restore();
});

test('processChunked works when onComplete is omitted', () => {
  const idle = installIdleQueue();
  const rec = recorder();
  const items = Array.from({ length: 1002 }, (_, i) => i);

  processChunked(items, 500, rec.handle);
  idle.pump(Infinity);

  assert.equal(rec.calls.length, items.length);
  idle.restore();
});

// The async drain loop is deadline-driven: it ignores chunkSize and processes
// whatever the idle budget allows. This pins the behavior decision recorded in
// docs/PLAN.md Phase 5 — if chunkSize ever starts bounding slices, this test
// changes WITH the decision, not silently.
test('async path is deadline-driven; chunkSize does not bound slice size', () => {
  const idle = installIdleQueue();
  const items = Array.from({ length: 1010 }, (_, i) => i);

  const tiny = recorder();
  processChunked(items, 1, tiny.handle);
  idle.pump(Infinity);
  const tinyFirstSlice = tiny.calls.length;

  const huge = recorder();
  processChunked(items, 100000, huge.handle);
  idle.pump(Infinity);
  const hugeFirstSlice = huge.calls.length;

  assert.equal(tinyFirstSlice, items.length, 'unbounded budget drains everything regardless of chunkSize=1');
  assert.equal(hugeFirstSlice, items.length);
  assert.deepEqual(tiny.calls, huge.calls);
  idle.restore();
});

// ── Fallback scheduler (no requestIdleCallback) ──────────────────────────────

test('processChunked drains via setTimeout when requestIdleCallback is missing', () => {
  // beforeEach deleted requestIdleCallback; capture the fallback timers.
  const timers = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  try {
    const items = Array.from({ length: 1001 }, (_, i) => i);
    const rec = recorder();

    processChunked(items, 500, rec.handle, rec.onComplete);
    assert.ok(timers.length >= 1, 'fallback must schedule a timer');
    assert.ok(!rec.completed);

    // Each timer tick is one chunkSize-bounded slice: 500, 500, then 1.
    timers.shift()();
    assert.equal(rec.calls.length, 500, 'fallback slices are bounded by chunkSize');
    assert.ok(!rec.completed);

    timers.shift()();
    assert.equal(rec.calls.length, 1000, 'second slice continues in order');
    assert.ok(!rec.completed);

    timers.shift()();
    assert.equal(rec.calls.length, items.length, 'fallback drains to completion');
    assert.ok(rec.completed);
    assert.equal(timers.length, 0, 'no further timers scheduled after completion');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

// ── processChunkedSync ───────────────────────────────────────────────────────

test('processChunkedSync processes every item in order, synchronously', () => {
  const items = Array.from({ length: 37 }, (_, i) => i * 3);
  const rec = recorder();

  processChunkedSync(items, 10, rec.handle);

  assert.deepEqual(rec.calls, items.map((item, index) => [item, index]));
});

test('processChunkedSync normalizes degenerate chunk sizes without losing items', () => {
  for (const chunkSize of [undefined, 0, Number.NaN, -5, 0.4]) {
    const items = ['x', 'y', 'z'];
    const rec = recorder();
    processChunkedSync(items, chunkSize, rec.handle);
    assert.deepEqual(rec.calls, [['x', 0], ['y', 1], ['z', 2]], `chunkSize=${chunkSize}`);
  }
});

test('processChunkedSync handles an empty array', () => {
  const rec = recorder();
  processChunkedSync([], 500, rec.handle);
  assert.equal(rec.calls.length, 0);
});
