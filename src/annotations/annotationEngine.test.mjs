// Voice-annotation resilience contract tests — pure logic, no network, no browser.
//
// Locks the 2026-07-21 field-test fixes:
//   1. A TRANSIENT (undefined) deferred-outline resolution is retried with backoff
//      (the /api/overpass proxy caches the late completion, so a retry is nearly
//      free) instead of silently leaving the mark a point forever. A DEFINITIVE
//      miss (null) is never retried — honest point beats hammering Overpass.
//   2. targetKey normalization strips trailing locality qualifiers so "California"
//      and "California, United States" dedupe while their outlines are pending
//      (identity is GEOMETRY once resolved; targetKey is only the pending stand-in).
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAnnotationEngine,
  resolveOutlineWithRetry,
  normalizeTargetKey,
} from './annotationEngine.js';
import { resolveAnnotationTarget } from './annotationResolver.js';
import {
  getRenderGovernorDiagnostics,
  _resetRenderGovernorForTest,
} from '../renderGovernor.js';

// A resolver that replays a scripted sequence of outcomes (undefined = transient,
// null = definitive miss, object = footprint) and counts its invocations.
function scriptedResolver(outcomes) {
  const calls = { count: 0 };
  const resolve = async () => {
    const i = Math.min(calls.count, outcomes.length - 1);
    calls.count += 1;
    const out = outcomes[i];
    if (out instanceof Error) throw out;
    return out;
  };
  return { resolve, calls };
}

// Instant fake wait that records the requested backoff delays.
function fakeWait() {
  const delays = [];
  const waitFn = async (ms) => { delays.push(ms); };
  return { waitFn, delays };
}

const FP = { ring: [[0, 0], [0, 1], [1, 1], [0, 0]], footprintKind: 'area' };

function installAnimationFrameStubs(t) {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => {
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    if (originalCancelAnimationFrame === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });
}

function fakeRenderer() {
  const calls = { add: 0, update: 0, remove: 0 };
  return {
    calls,
    renderer: {
      add() { calls.add += 1; },
      update() { calls.update += 1; },
      remove() { calls.remove += 1; },
      sync() {},
    },
  };
}

async function flushMicrotasks(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

function httpFailure(status, retryAfter = null) {
  return {
    ok: false,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) },
  };
}

test('retry: first-try footprint returns immediately, no retry, no waiting', async () => {
  const { resolve, calls } = scriptedResolver([FP]);
  const { waitFn, delays } = fakeWait();
  const fp = await resolveOutlineWithRetry(resolve, { delaysMs: [8000, 25000], waitFn });
  assert.equal(fp, FP);
  assert.equal(calls.count, 1);
  assert.deepEqual(delays, []);
});

test('retry: a DEFINITIVE miss (null) is never retried — the honest point stands', async () => {
  const { resolve, calls } = scriptedResolver([null, FP]);
  const { waitFn, delays } = fakeWait();
  const fp = await resolveOutlineWithRetry(resolve, { delaysMs: [8000, 25000], waitFn });
  assert.equal(fp, null);
  assert.equal(calls.count, 1);
  assert.deepEqual(delays, []);
});

test('retry: a TRANSIENT miss (undefined) re-runs after the first backoff and can succeed', async () => {
  const { resolve, calls } = scriptedResolver([undefined, FP]);
  const { waitFn, delays } = fakeWait();
  const fp = await resolveOutlineWithRetry(resolve, { delaysMs: [8000, 25000], waitFn });
  assert.equal(fp, FP);
  assert.equal(calls.count, 2);
  assert.deepEqual(delays, [8000]); // waited once, succeeded on attempt 2
});

test('retry: a transient retry can still conclude with a definitive miss (no third run)', async () => {
  const { resolve, calls } = scriptedResolver([undefined, null]);
  const { waitFn, delays } = fakeWait();
  const fp = await resolveOutlineWithRetry(resolve, { delaysMs: [8000, 25000], waitFn });
  assert.equal(fp, null);
  assert.equal(calls.count, 2);
  assert.deepEqual(delays, [8000]);
});

test('retry: persistent transients exhaust the backoff schedule and give up as transient', async () => {
  const { resolve, calls } = scriptedResolver([undefined, undefined, undefined, FP]);
  const { waitFn, delays } = fakeWait();
  const fp = await resolveOutlineWithRetry(resolve, { delaysMs: [8000, 25000], waitFn });
  assert.equal(fp, undefined); // never found within budget — mark honestly stays a point
  assert.equal(calls.count, 3); // initial + one per backoff entry
  assert.deepEqual(delays, [8000, 25000]);
});

test('retry: a stale board (clear/supersede during backoff) stops retrying immediately', async () => {
  const { resolve, calls } = scriptedResolver([undefined, FP]);
  const { waitFn, delays } = fakeWait();
  let stale = false;
  const fp = await resolveOutlineWithRetry(resolve, {
    delaysMs: [8000, 25000],
    waitFn: async (ms) => { await waitFn(ms); stale = true; }, // goes stale mid-wait
    isStale: () => stale,
  });
  assert.equal(fp, undefined);
  assert.equal(calls.count, 1); // never re-ran against a superseded board
  assert.deepEqual(delays, [8000]);
});

test('retry: a thrown resolver is a definitive miss (no retry), matching the old catch→point path', async () => {
  const { resolve, calls } = scriptedResolver([new Error('boom'), FP]);
  const { waitFn, delays } = fakeWait();
  const fp = await resolveOutlineWithRetry(resolve, { delaysMs: [8000, 25000], waitFn });
  assert.equal(fp, null);
  assert.equal(calls.count, 1);
  assert.deepEqual(delays, []);
});

test('outline queue: an 8-spec batch keeps at most two FIFO upgrades in flight', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer, calls } = fakeRenderer();
  const started = [];
  const releases = new Map();
  let inFlight = 0;
  let maxInFlight = 0;
  const resolveTarget = async ({ target }) => {
    const index = Number(target.slice('queue-'.length));
    return {
      lon: index,
      lat: index,
      height: 0,
      label: target,
      source: 'fake',
      ring: null,
      resolveOutline: () => new Promise((resolve) => {
        started.push(target);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        releases.set(target, () => {
          inFlight -= 1;
          resolve({
            ring: [[index, index], [index + 0.1, index], [index, index + 0.1], [index, index]],
            footprintKind: 'area',
            lat: index,
            lon: index,
            height: 0,
          });
        });
      }),
    };
  };
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget });
  let completed = 0;
  const allCompleted = new Promise((resolve) => engine.onOutlineEvent(() => {
    completed += 1;
    if (completed === 8) resolve();
  }));

  const result = await engine.annotate(Array.from({ length: 8 }, (_, i) => ({
    type: 'area',
    target: `queue-${i}`,
    footprint: true,
  })));

  assert.equal(result.drawn, 8);
  assert.equal(calls.add, 8, 'all point renders land before queued outlines finish');
  assert.deepEqual(started, ['queue-0', 'queue-1']);
  for (let next = 2; next < 8; next += 1) {
    releases.get(`queue-${next - 2}`)();
    await flushMicrotasks();
    assert.equal(started[next], `queue-${next}`, 'queued upgrades start in ask order');
  }
  releases.get('queue-6')();
  releases.get('queue-7')();
  await allCompleted;

  assert.equal(maxInFlight, 2);
  assert.equal(calls.update, 8);
});

test('outline queue: clear drops queued-but-unstarted upgrades without a later fetch', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  let fetchesStarted = 0;
  const resolveTarget = async ({ target, signal }) => ({
    lon: Number(target.slice('clear-'.length)),
    lat: 10,
    height: 0,
    label: target,
    source: 'fake',
    ring: null,
    resolveOutline: () => new Promise((resolve) => {
      fetchesStarted += 1;
      const finish = () => resolve(undefined);
      if (signal.aborted) finish();
      else signal.addEventListener('abort', finish, { once: true });
    }),
  });
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget });

  await engine.annotate(Array.from({ length: 8 }, (_, i) => ({
    type: 'area',
    target: `clear-${i}`,
    footprint: true,
  })));
  assert.equal(fetchesStarted, 2);

  engine.clear();
  await flushMicrotasks();
  assert.equal(engine.count(), 0);
  assert.equal(fetchesStarted, 2, 'the six queued upgrades were dropped on clear');
});

test('retry: HTTP 429 Retry-After 5s gets one ladder-spaced retry; a second 429 stops', async (t) => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  globalThis.window = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const requestTimes = [];
  globalThis.fetch = async () => {
    requestTimes.push(Date.now());
    return httpFailure(429, '5');
  };
  t.after(() => {
    t.mock.timers.reset();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  });

  const resolved = await resolveAnnotationTarget({
    viewer: {},
    target: 'PT2 rate-limit fixture',
    latitude: 12.345,
    longitude: 67.89,
    footprint: true,
    deferFootprint: true,
    entityKind: 'district',
  });
  let settled = false;
  const waits = [];
  const pending = resolveOutlineWithRetry(resolved.resolveOutline, {
    waitFn: (ms) => {
      waits.push(ms);
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  })
    .finally(() => { settled = true; });
  while (waits.length === 0) await flushMicrotasks();
  assert.equal(requestTimes.length, 1);
  assert.deepEqual(waits, [8000], 'the 8s ladder floor is longer than Retry-After: 5');

  t.mock.timers.tick(7999);
  await flushMicrotasks();
  assert.equal(requestTimes.length, 1);
  t.mock.timers.tick(1);
  await flushMicrotasks();
  // Mutation hygiene: if 429 is accidentally collapsed into ordinary transient,
  // drain its forbidden second ladder timer before making the named assertions.
  if (waits.length > 1) {
    t.mock.timers.tick(waits[1]);
    await flushMicrotasks();
  }

  assert.equal(requestTimes.length, 2);
  assert.ok(requestTimes[1] - requestTimes[0] >= 5000, 'Retry-After is a hard minimum');
  assert.equal(settled, true, 'a second 429 must not schedule the 25s ladder replay');
  assert.equal(await pending, undefined);
});

test('retry: a plain HTTP 500 still exhausts the existing 8s/25s transient ladder', async (t) => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  globalThis.window = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const requestTimes = [];
  globalThis.fetch = async () => {
    requestTimes.push(Date.now());
    return httpFailure(500);
  };
  t.after(() => {
    t.mock.timers.reset();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  });

  const resolved = await resolveAnnotationTarget({
    viewer: {},
    target: 'PT2 transient fixture',
    latitude: -12.345,
    longitude: -67.89,
    footprint: true,
    deferFootprint: true,
    entityKind: 'district',
  });
  let settled = false;
  const waits = [];
  const pending = resolveOutlineWithRetry(resolved.resolveOutline, {
    waitFn: (ms) => {
      waits.push(ms);
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  })
    .finally(() => { settled = true; });
  while (waits.length === 0) await flushMicrotasks();
  assert.equal(requestTimes.length, 1);
  assert.deepEqual(waits, [8000]);

  t.mock.timers.tick(8000);
  await flushMicrotasks();
  assert.equal(requestTimes.length, 2);
  assert.equal(settled, false);
  assert.deepEqual(waits, [8000, 25_000]);
  t.mock.timers.tick(24_999);
  await flushMicrotasks();
  assert.equal(requestTimes.length, 2);
  t.mock.timers.tick(1);
  await flushMicrotasks();

  assert.equal(requestTimes.length, 3);
  assert.deepEqual(requestTimes.map((at) => at - requestTimes[0]), [0, 8000, 33_000]);
  assert.equal(settled, true);
  assert.equal(await pending, undefined);
});

test('targetKey: trailing locality qualifiers are stripped so state names dedupe', () => {
  assert.equal(normalizeTargetKey('California'), 'california');
  assert.equal(normalizeTargetKey('California, United States'), 'california');
  assert.equal(
    normalizeTargetKey('California'),
    normalizeTargetKey('California, United States'),
  );
});

test('targetKey: lowercases, trims, and keeps comma-free names intact', () => {
  assert.equal(normalizeTargetKey('  Texas State Capitol  '), 'texas state capitol');
  assert.equal(normalizeTargetKey('Lady Bird Lake'), 'lady bird lake');
});

test('targetKey: multi-qualifier names keep only the leading place name', () => {
  assert.equal(normalizeTargetKey('Sixth Street, Austin, TX'), 'sixth street');
});

test('targetKey: empty / absent targets stay null (coord and pixel specs never pending-collapse)', () => {
  assert.equal(normalizeTargetKey(''), null);
  assert.equal(normalizeTargetKey('   '), null);
  assert.equal(normalizeTargetKey(null), null);
  assert.equal(normalizeTargetKey(undefined), null);
});

test('outline upgrade updates the rendered element in place without remove/add', async (t) => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.window = {
    __GOOGLE_MAPS_API_KEY__: 'unit-test-key',
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  let overpassCall = 0;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://maps.googleapis.com/')) {
      return { json: async () => ({
        status: 'OK',
        results: [{
          formatted_address: 'FB-3 Engine Texas Fixture',
          types: ['administrative_area_level_1', 'political'],
          address_components: [{
            long_name: 'FB-3 Engine Texas Fixture',
            types: ['administrative_area_level_1', 'political'],
          }],
          geometry: { location: { lat: 31, lng: -99 } },
        }],
      }) };
    }
    assert.equal(String(url), '/api/overpass');
    overpassCall += 1;
    if (overpassCall === 1) {
      return {
        ok: true,
        json: async () => ({ elements: [{
          type: 'area',
          id: 54321,
          tags: { name: 'FB-3 Engine Texas Fixture', admin_level: '4' },
        }] }),
      };
    }
    return {
      ok: true,
      json: async () => ({ elements: [{
        type: 'relation',
        geometry: [
          { lon: -106, lat: 25 },
          { lon: -93, lat: 25 },
          { lon: -93, lat: 36 },
          { lon: -106, lat: 36 },
          { lon: -106, lat: 25 },
        ],
      }] }),
    };
  };
  t.after(() => {
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    if (originalCancelAnimationFrame === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  });

  const calls = { add: 0, update: 0, remove: 0 };
  const elements = new Map();
  let originalElement = null;
  const renderer = {
    add(anno) {
      calls.add += 1;
      originalElement = { id: anno.id };
      elements.set(anno.id, originalElement);
    },
    update(anno) {
      calls.update += 1;
      assert.equal(elements.get(anno.id), originalElement);
    },
    remove() { calls.remove += 1; },
    sync() {},
  };
  const viewer = {};
  const engine = createAnnotationEngine({ viewer, renderer });
  const upgraded = new Promise((resolve) => engine.onOutlineEvent(resolve));

  const result = await engine.annotate([{
    type: 'area',
    target: 'FB-3 Engine Texas Fixture',
    label: 'Texas',
    footprint: true,
  }]);
  await upgraded;

  assert.equal(result.drawn, 1);
  assert.deepEqual(calls, { add: 1, update: 1, remove: 0 });
  assert.equal(elements.get(result.ids[0]), originalElement, 'rendered element identity survives');
  assert.deepEqual(engine.list()[0].anchor, { lon: -100.8, lat: 29.4, height: 0 });
  assert.equal(engine.list()[0].ring.length, 5, 'the existing data-level centroid/ring snap remains');
});

// ── Renderer-throw rollback: no phantom mark, no permanent governor hold ──────
//
// The engine holds continuous render for exactly as long as a mark is live
// (annotations.size > 0). A renderer/WebGL throw that leaves an entry in the
// map therefore leaks a hold that NOTHING releases short of an explicit clear —
// the idle governor is defeated for the rest of the session. The fresh path has
// always guarded this; the duplicate-REPLACEMENT path did the renderer swap
// outside the guard. (perf rebase 2026-08-17)

function throwingRendererHarness() {
  const calls = { add: 0, remove: 0 };
  let failNextAdd = false;
  return {
    calls,
    failAddOnce() { failNextAdd = true; },
    renderer: {
      add() {
        calls.add += 1;
        if (failNextAdd) { failNextAdd = false; throw new Error('WebGL context lost'); }
      },
      update() {},
      remove() { calls.remove += 1; },
      sync() {},
    },
  };
}

const FIXED_POINT = { lon: -97.7431, lat: 30.2672, height: 0 };

test('duplicate-replacement: a renderer throw leaves no phantom mark and no leaked hold', async (t) => {
  installAnimationFrameStubs(t);
  _resetRenderGovernorForTest();
  t.after(() => _resetRenderGovernorForTest());

  const { renderer, failAddOnce } = throwingRendererHarness();
  const engine = createAnnotationEngine({
    viewer: {},
    renderer,
    resolveTarget: async () => ({ ...FIXED_POINT }),
  });

  const first = await engine.annotate([{ type: 'point', target: 'Texas Capitol', label: 'Capitol' }]);
  assert.equal(first.drawn, 1);
  assert.equal(engine.list().length, 1);
  assert.ok(
    getRenderGovernorDiagnostics().holds.includes('annotations'),
    'a live mark must hold continuous render',
  );

  // Same place, same caption, NEW colour → the duplicate-REPLACEMENT branch,
  // which deletes the dup and inserts the replacement before touching the
  // renderer. (A bare point dedupes on LABEL — two different captions at one
  // spot are deliberately two marks — so a recolour is the way into this
  // branch for a point; see findDuplicate.)
  failAddOnce();
  const second = await engine.annotate([
    { type: 'point', target: 'Texas Capitol', label: 'Capitol', color: 'amber' },
  ]);

  assert.equal(second.drawn, 0, 'the failed swap is reported as a failure, not a draw');
  assert.equal(second.failed, 1);
  assert.equal(engine.list().length, 0, 'no phantom annotation survives the failed swap');
  assert.ok(
    !getRenderGovernorDiagnostics().holds.includes('annotations'),
    'the annotations hold must be released — a leak defeats the idle governor permanently',
  );
});

test('fresh path: a renderer throw is rolled back the same way', async (t) => {
  installAnimationFrameStubs(t);
  _resetRenderGovernorForTest();
  t.after(() => _resetRenderGovernorForTest());

  const { renderer, failAddOnce } = throwingRendererHarness();
  const engine = createAnnotationEngine({
    viewer: {},
    renderer,
    resolveTarget: async () => ({ ...FIXED_POINT }),
  });

  failAddOnce();
  const result = await engine.annotate([{ type: 'point', target: 'Texas Capitol', label: 'Capitol' }]);

  assert.equal(result.drawn, 0);
  assert.equal(engine.list().length, 0, 'no phantom annotation from a failed first add');
  assert.ok(
    !getRenderGovernorDiagnostics().holds.includes('annotations'),
    'a never-rendered mark must not hold continuous render',
  );
});

// ── Rollback must also unwind PARTIAL renderer state (second review) ──────────
//
// The harness above throws on the FIRST statement of add(), so a rollback that
// only deletes the engine's map entry looked complete. The real renderers build
// a mark in stages — the hybrid adds world geometry before it records the route;
// the screen renderer inserts its SVG group before its last projection pass — so
// a throw part-way leaves live content the map rollback cannot reach. The next
// annotate of the same geometry then stacks a fresh mark over that orphan.

/** A renderer that puts the mark on the board BEFORE the step that fails. */
function partialStateRendererHarness() {
  const live = new Map(); // stands in for world entities / SVG groups
  let failNextAdd = false;
  return {
    live,
    failAddOnce() { failNextAdd = true; },
    renderer: {
      add(anno) {
        live.set(anno.id, anno); // partial renderer state exists NOW
        if (failNextAdd) { failNextAdd = false; throw new Error('WebGL context lost'); }
      },
      update() {},
      remove(anno) { live.delete(anno.id); },
      sync() {},
    },
  };
}

test('fresh path: a throw AFTER partial renderer state leaves nothing on the board', async (t) => {
  installAnimationFrameStubs(t);
  _resetRenderGovernorForTest();
  t.after(() => _resetRenderGovernorForTest());

  const { renderer, failAddOnce, live } = partialStateRendererHarness();
  const engine = createAnnotationEngine({
    viewer: {},
    renderer,
    resolveTarget: async () => ({ ...FIXED_POINT }),
  });

  failAddOnce();
  const failed = await engine.annotate([{ type: 'point', target: 'Texas Capitol', label: 'Capitol' }]);
  assert.equal(failed.drawn, 0);
  assert.equal(engine.list().length, 0, 'no phantom annotation');
  assert.equal(live.size, 0, 'the rollback must release what the renderer had already created');
  assert.ok(
    !getRenderGovernorDiagnostics().holds.includes('annotations'),
    'a never-rendered mark must not hold continuous render',
  );

  // The real cost of an orphan: re-annotating the same place stacks a second
  // mark on top of the one nothing owns.
  const retry = await engine.annotate([{ type: 'point', target: 'Texas Capitol', label: 'Capitol' }]);
  assert.equal(retry.drawn, 1);
  assert.equal(live.size, 1, 'a re-annotate must draw ONE mark, not stack over an orphan');
});

test('duplicate-replacement: a throw AFTER partial renderer state leaves nothing on the board', async (t) => {
  installAnimationFrameStubs(t);
  _resetRenderGovernorForTest();
  t.after(() => _resetRenderGovernorForTest());

  const { renderer, failAddOnce, live } = partialStateRendererHarness();
  const engine = createAnnotationEngine({
    viewer: {},
    renderer,
    resolveTarget: async () => ({ ...FIXED_POINT }),
  });

  const first = await engine.annotate([{ type: 'point', target: 'Texas Capitol', label: 'Capitol' }]);
  assert.equal(first.drawn, 1);
  assert.equal(live.size, 1);

  // Recolour → the duplicate-REPLACEMENT swap: remove(dup) lands, add(anno)
  // creates its state and then throws.
  failAddOnce();
  const swap = await engine.annotate([
    { type: 'point', target: 'Texas Capitol', label: 'Capitol', color: 'amber' },
  ]);
  assert.equal(swap.drawn, 0);
  assert.equal(engine.list().length, 0, 'no phantom annotation survives the failed swap');
  assert.equal(live.size, 0, 'and no half-swapped mark survives on the board');
  assert.ok(
    !getRenderGovernorDiagnostics().holds.includes('annotations'),
    'the annotations hold must be released',
  );

  const retry = await engine.annotate([
    { type: 'point', target: 'Texas Capitol', label: 'Capitol', color: 'amber' },
  ]);
  assert.equal(retry.drawn, 1);
  assert.equal(live.size, 1, 'the recoloured mark redraws once, with no orphan underneath');
});

// ── Lifecycle, dedup identity, route/arrow resolution, cap, camera assist ────
//
// These lock the rest of the engine's contracts with a controllable frame
// clock (performance.now + requestAnimationFrame are stubbed together so the
// alpha tick loop runs deterministically) and a scripted resolver — no
// network, no browser.

import * as Cesium from 'cesium';

/**
 * Deterministic clock + frame queue. performance.now advances only via
 * advance(); requestAnimationFrame callbacks are queued and flushed by
 * advance() with the (advanced) timestamp, exactly one drain per frame — so
 * the engine's tick loop is stepped, never free-running.
 */
function installFrameClock(t) {
  const queue = [];
  let now = 1000;
  const origRAF = globalThis.requestAnimationFrame;
  const origCAF = globalThis.cancelAnimationFrame;
  const origPerf = globalThis.performance;
  globalThis.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
  globalThis.cancelAnimationFrame = (id) => { if (id >= 1 && id <= queue.length) queue[id - 1] = null; };
  globalThis.performance = { now: () => now };
  t.after(() => {
    if (origRAF === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = origRAF;
    if (origCAF === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = origCAF;
    if (origPerf === undefined) delete globalThis.performance;
    else globalThis.performance = origPerf;
  });
  return {
    advance(ms) {
      now += ms;
      const pending = queue.splice(0).filter(Boolean);
      for (const cb of pending) cb(now);
    },
    get pendingFrames() { return queue.filter(Boolean).length; },
    get now() { return now; },
  };
}

function resetGovernor(t) {
  _resetRenderGovernorForTest();
  t.after(() => _resetRenderGovernorForTest());
}

/** A resolver that hands every ask a distinct anchor 0.01° apart, STABLE across
 *  repeat asks (dedup identity depends on deterministic resolution), unless
 *  scripted. strict: unscripted asks fail to resolve (return null). */
function countingResolver(script = null, { strict = false } = {}) {
  let n = 0;
  const perTarget = new Map();
  const resolve = async ({ target }) => {
    if (script && Object.hasOwn(script, target)) return script[target]();
    if (strict) return null;
    if (!perTarget.has(target)) {
      const i = n++;
      perTarget.set(target, { lon: -97.7431 - i * 0.01, lat: 30.2672, height: 0 });
    }
    return { ...perTarget.get(target), label: target, source: 'fake', ring: null };
  };
  return { resolve, perTarget };
}

/** Areas at ONE shared anchor whose outline upgrade never lands — the pending
 *  phase is the point under test. */
function pendingAreaResolver() {
  return async () => ({
    lon: -97.74, lat: 30.27, height: 0, label: null, source: 'fake', ring: null,
    resolveOutline: () => new Promise(() => { /* stays pending for the test */ }),
  });
}

test('lifecycle: a TTL mark fades in, fades out at its deadline, and is removed', async (t) => {
  installAnimationFrameStubs(t);
  const clock = installFrameClock(t);
  resetGovernor(t);
  const { renderer, calls } = fakeRenderer();
  const { resolve } = countingResolver();
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget: resolve });

  const result = await engine.annotate(
    [{ type: 'pin', target: 'TTL mark', ttlMs: 1000 }],
    { persist: false },
  );
  assert.equal(result.drawn, 1);
  const anno = engine.list()[0];
  assert.equal(anno.ttlMs, 1000, 'a non-persistent mark carries its TTL');
  assert.equal(anno.alpha, 0, 'marks start transparent and animate in');

  clock.advance(300); // fade-in (~260ms) completes
  assert.equal(anno.alpha, 1);
  assert.equal(engine.count(), 1);
  assert.ok(clock.pendingFrames >= 1, 'a TTL fade still ahead keeps the tick loop alive');
  assert.ok(
    getRenderGovernorDiagnostics().holds.includes('annotations'),
    'a live mark holds continuous render',
  );

  clock.advance(1000); // now past createdAt + ttlMs → mid fade-out
  assert.ok(anno.alpha > 0 && anno.alpha < 1, 'the fade-out is in progress');

  clock.advance(2000); // well past fadeStart + FADE_MS
  assert.equal(engine.count(), 0, 'an alpha-0 expiring mark is removed by the tick');
  assert.equal(calls.remove, 1, 'the renderer was told to drop it');
  assert.ok(
    !getRenderGovernorDiagnostics().holds.includes('annotations'),
    'removing the last mark releases the continuous-render hold',
  );
  assert.equal(clock.pendingFrames, 0, 'the tick loop stops once the board is empty');
});

test('lifecycle: the tick loop parks itself once a persistent mark is stable', async (t) => {
  installAnimationFrameStubs(t);
  const clock = installFrameClock(t);
  const { renderer } = fakeRenderer();
  const { resolve } = countingResolver();
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget: resolve });

  await engine.annotate([{ type: 'pin', target: 'Steady mark' }]);
  assert.ok(clock.pendingFrames >= 1);
  clock.advance(300);
  assert.equal(clock.pendingFrames, 0, 'a persistent faded-in mark has no animation ahead');

  const next = await engine.annotate([{ type: 'pin', target: 'Second mark' }]);
  assert.equal(next.drawn, 1);
  assert.ok(clock.pendingFrames >= 1, 'the next add restarts the tick loop');
});

test('fadeOutAll gracefully fades and removes persistent marks', async (t) => {
  installAnimationFrameStubs(t);
  const clock = installFrameClock(t);
  resetGovernor(t);
  const { renderer, calls } = fakeRenderer();
  const { resolve } = countingResolver();
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget: resolve });

  await engine.annotate([{ type: 'pin', target: 'Doomed' }]);
  clock.advance(300);
  assert.equal(clock.pendingFrames, 0);

  engine.fadeOutAll();
  const anno = engine.list()[0];
  assert.equal(anno.expiring, true);
  assert.ok(clock.pendingFrames >= 1, 'fade-out restarts ticking');
  clock.advance(1200 + 1);
  assert.equal(engine.count(), 0);
  assert.equal(calls.remove, 1);
  assert.ok(!getRenderGovernorDiagnostics().holds.includes('annotations'));
});

test('re-narration refreshes a fading mark in place and revives it', async (t) => {
  installAnimationFrameStubs(t);
  const clock = installFrameClock(t);
  const { renderer, calls } = fakeRenderer();
  const { resolve } = countingResolver();
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget: resolve });

  const first = await engine.annotate(
    [{ type: 'pin', target: 'Same', label: 'Same', ttlMs: 1000 }],
    { persist: false },
  );
  clock.advance(1400); // past fadeStart (createdAt + 1000) → fading out
  assert.ok(engine.list()[0].alpha < 1);

  const second = await engine.annotate(
    [{ type: 'pin', target: 'Same', label: 'Same', ttlMs: 1000 }],
    { persist: false },
  );
  assert.equal(second.results[0].duplicate, true, 'identical re-narration reports as a duplicate');
  assert.equal(second.ids[0], first.ids[0], 'the SAME mark id is refreshed, not restacked');
  assert.equal(engine.count(), 1);
  assert.equal(calls.add, 1, 'no second renderer add');
  const dup = engine.list()[0];
  assert.equal(dup.expiring, false, 'the refresh revives a fading-out mark');
  assert.equal(dup.fadeStart, null);

  // It now lives until createdAt(refresh) + ttlMs + FADE_MS, long past the
  // original deadline — the refresh visibly extended its life.
  clock.advance(1900);
  assert.equal(engine.count(), 1, 'the refreshed mark outlived its original fade window');
  clock.advance(2000);
  assert.equal(engine.count(), 0);
});

test('re-narration with a new label replaces in place and inherits the resolved ring', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer, calls } = fakeRenderer();
  const FP_LOCAL = {
    ring: [[-97.7, 30.2], [-97.7, 30.3], [-97.8, 30.3], [-97.7, 30.2]],
    footprintKind: 'area',
    buildingHeight: 12,
    synthesized: false,
    lat: 30.25,
    lon: -97.75,
    height: 5,
  };
  let resolveOutlineCalls = 0;
  const resolveTarget = async () => ({
    lon: FP_LOCAL.lon, lat: FP_LOCAL.lat, height: 5,
    label: null, source: 'fake', ring: null,
    resolveOutline: async () => { resolveOutlineCalls += 1; return { ...FP_LOCAL }; },
  });
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget });

  const first = await engine.annotate([{ type: 'area', target: 'Marina', label: 'Marina', footprint: true }]);
  await flushMicrotasks();
  assert.equal(resolveOutlineCalls, 1, 'the first upgrade resolved');
  assert.equal(engine.list()[0].ring.length, 4);

  const second = await engine.annotate([{ type: 'area', target: 'Marina', label: 'Marina District', footprint: true }]);
  await flushMicrotasks();
  assert.equal(second.results[0].duplicate, true);
  assert.equal(engine.count(), 1, 'replace-in-place keeps the count at one');
  assert.notEqual(second.ids[0], first.ids[0], 'a replacement is a NEW mark');
  const replaced = engine.list()[0];
  assert.equal(replaced.label, 'Marina District', 'the latest caption wins');
  assert.deepEqual(replaced.ring, FP_LOCAL.ring, 'the pending replacement inherited the dup ring');
  assert.equal(replaced.buildingHeight, 12);
  assert.equal(replaced.anchor.height, 5);
  assert.equal(calls.add, 2);
  assert.equal(calls.remove, 1);
  assert.equal(resolveOutlineCalls, 2, "the replacement re-ran its own upgrade");
});

test('pending-phase dedup collapses re-asks of the SAME target under different labels', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer, calls } = fakeRenderer();
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget: pendingAreaResolver() });

  await engine.annotate([{ type: 'area', target: 'Presidio', label: 'The Presidio', footprint: true }]);
  const second = await engine.annotate([{
    type: 'area', target: 'Presidio, San Francisco', label: 'Presidio', footprint: true,
  }]);
  await flushMicrotasks();
  assert.equal(second.results[0].duplicate, true, 'the locality qualifier is stripped for identity');
  assert.equal(engine.count(), 1);
  assert.equal(engine.list()[0].label, 'Presidio', 'the latest caption wins');
  assert.equal(calls.add, 2, 'replace-in-place swapped the rendered mark');
});

test('pending-phase dedup keeps DIFFERENT targets at one anchor apart', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget: pendingAreaResolver() });

  await engine.annotate([{ type: 'area', target: 'Capitol', label: 'Capitol', footprint: true }]);
  await engine.annotate([{ type: 'area', target: 'Capitol grounds', label: 'Grounds', footprint: true }]);
  await flushMicrotasks();
  assert.equal(engine.count(), 2, 'different asks stay distinct while geometry is unknown');

  const around = await engine.annotate([{
    type: 'area', target: 'Capitol', label: 'Around the Capitol',
    footprint: true, intent: 'around_the_thing',
  }]);
  assert.equal(around.drawn, 1);
  assert.equal(engine.count(), 3, 'a different SHAPE INTENT of the same target is not a duplicate');
});

test('resolved geometry dedup collapses two names that resolve to one polygon', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer, calls } = fakeRenderer();
  const SHARED_FP = {
    ring: [[-122.4, 37.8], [-122.4, 37.9], [-122.5, 37.9], [-122.4, 37.8]],
    footprintKind: 'area',
    synthesized: false,
    lat: 37.85, lon: -122.45, height: 0,
  };
  const sameGeometry = async () => ({
    lon: SHARED_FP.lon, lat: SHARED_FP.lat, height: 0, label: null, source: 'fake', ring: null,
    resolveOutline: async () => ({ ...SHARED_FP }),
  });
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget: sameGeometry });
  const events = [];
  engine.onOutlineEvent((e) => events.push(e));

  await engine.annotate([{ type: 'area', target: 'Marina', label: 'Marina', footprint: true }]);
  await engine.annotate([{ type: 'area', target: 'Marina District', label: 'Marina District', footprint: true }]);
  await flushMicrotasks();

  assert.equal(engine.count(), 1, 'identity is GEOMETRY: one polygon, one mark');
  assert.equal(engine.list()[0].label, 'Marina District', 'the latest caption survives');
  assert.equal(calls.remove, 1, 'the collapsed twin was removed from the renderer');
  assert.deepEqual(events.map((e) => e.status), ['resolved', 'resolved']);
});

test('geometry dedup keeps a different-footprintKind neighbour alive', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  const RING = [[0, 0], [0, 1], [1, 1], [0, 0]];
  const resolveTarget = async ({ target }) => ({
    lon: -97.75, lat: 30.25, height: 0, label: null, source: 'fake', ring: null,
    resolveOutline: async () => ({
      ring: RING.map(([a, b]) => [a, b]),
      footprintKind: target === 'building mark' ? 'building' : 'area',
      synthesized: false, lat: 30.25, lon: -97.75, height: 0,
    }),
  });
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget });

  await engine.annotate([{ type: 'area', target: 'area mark', label: 'area', footprint: true }]);
  await engine.annotate([{ type: 'area', target: 'building mark', label: 'building', footprint: true }]);
  await flushMicrotasks();
  assert.equal(engine.count(), 2, 'a building footprint is NOT the same mark as an area one');
});

test('routes: OSRM geometry is used with real metrics when routing succeeds', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  const { resolve } = countingResolver();
  let routeUrl = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    routeUrl = String(url);
    return {
      json: async () => ({
        ok: true,
        geometry: [[-97.74, 30.27], [-97.73, 30.28], [-97.72, 30.29]],
        distanceM: 12400,
        durationS: 900,
      }),
    };
  };
  t.after(() => {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  });
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget: resolve });

  const result = await engine.annotate([{
    type: 'route', label: 'errand', mode: 'drive',
    points: [{ target: 'A' }, { target: 'B' }],
  }]);
  assert.equal(result.drawn, 1);
  assert.match(routeUrl, /^\/api\/route\?profile=car&coords=/, 'the normalized mode is sent to the proxy');
  const anno = engine.list()[0];
  assert.equal(anno.path.length, 3, 'the street-following geometry is drawn, not the raw points');
  assert.equal(anno.fallback, false);
  assert.equal(anno.mode, 'car');
  assert.equal(anno.distanceM, 12400);
  assert.equal(anno.durationS, 900);
  assert.equal(result.results[0].label, 'errand — 12 km · 15 min drive');
  assert.equal(result.results[0].fallback, false);
});

test('routes: a routing outage draws an honest direct line, never a fake route', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  const script = {
    A: async () => ({ lon: -97.74, lat: 30.27, height: 0, label: 'A', source: 'fake', ring: null }),
    B: async () => ({ lon: -97.74, lat: 31.27, height: 0, label: 'B', source: 'fake', ring: null }),
  };
  const { resolve } = countingResolver(script);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('proxy down'); };
  t.after(() => {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  });
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget: resolve });

  const result = await engine.annotate([{
    type: 'route', label: 'hop', points: [{ target: 'A' }, { target: 'B' }],
  }]);
  assert.equal(result.drawn, 1);
  const r = result.results[0];
  assert.equal(r.fallback, true, 'the result says fallback loudly');
  assert.equal(r.mode, 'foot');
  // 1° of latitude ≈ 111.195 km → formatDistance → '111.2 km'
  assert.equal(r.label, 'hop — 111 km · direct line (no route)');
  assert.ok(Math.abs(r.distanceM - 111195) < 60, 'the great-circle distance is computed');
  assert.equal(r.durationS, null, 'no travel time is invented');
});

test('routes: a missing waypoint fails loudly with the specific name', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  const script = {
    A: async () => ({ lon: -97.74, lat: 30.27, height: 0, label: 'A', source: 'fake', ring: null }),
    C: async () => ({ lon: -97.72, lat: 30.29, height: 0, label: 'C', source: 'fake', ring: null }),
  };
  const { resolve } = countingResolver(script, { strict: true });
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget: resolve });

  const result = await engine.annotate([{
    type: 'route', points: [{ target: 'A' }, { target: 'B' }, { target: 'C' }],
  }]);
  assert.equal(result.drawn, 0);
  assert.deepEqual(result.results[0].failedTargets, ['B'], 'A→B→C must not become A→C');
  assert.equal(result.results[0].error, 'could not locate one or more route waypoints');
});

test('routes: fewer than two waypoints is rejected before any resolution', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  let resolveCalls = 0;
  const engine = createAnnotationEngine({
    viewer: {},
    renderer,
    resolveTarget: async () => { resolveCalls += 1; return { lon: 0, lat: 0, height: 0, source: 'fake' }; },
  });
  const result = await engine.annotate([{ type: 'route', points: [{ target: 'Only one' }] }]);
  assert.equal(result.drawn, 0);
  assert.equal(result.results[0].error, 'a route needs at least 2 waypoints');
  assert.equal(resolveCalls, 0);
});

test('arrows: both endpoints resolve and the distance is appended to the label', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  const script = {
    origin: async () => ({ lon: -97.74, lat: 30.27, height: 10, label: null, source: 'fake', ring: null }),
    dest: async () => ({ lon: -97.74, lat: 31.27, height: 0, label: null, source: 'fake', ring: null }),
  };
  const { resolve } = countingResolver(script);
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget: resolve });

  const labelled = await engine.annotate([{ type: 'arrow', target: 'origin', toTarget: 'dest', label: 'hop' }]);
  assert.equal(labelled.results[0].label, 'hop — 111 km');
  assert.equal(labelled.results[0].outline, false);

  const bare = await engine.annotate([{ type: 'vector', target: 'origin', toTarget: 'dest' }]);
  assert.equal(bare.results[0].label, '111 km', 'a caption-less arrow still says how far');
});

test('arrows: only the actually-missing endpoint is blamed', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  const script = {
    origin: async () => ({ lon: -97.74, lat: 30.27, height: 0, label: 'Origin', source: 'fake', ring: null }),
  };
  const { resolve } = countingResolver(script, { strict: true });
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget: resolve });

  const result = await engine.annotate([{
    type: 'arrow', target: 'origin', toTarget: 'Atlantis', label: 'hop',
  }]);
  assert.equal(result.drawn, 0);
  assert.deepEqual(result.results[0].failedTargets, ['Atlantis']);
  assert.equal(result.results[0].error, 'could not locate one or both arrow endpoints');
});

test('the hard live cap rejects new marks but still allows re-narration refreshes', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  const { resolve } = countingResolver();
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget: resolve });

  for (let i = 0; i < 120; i += 1) {
    const r = await engine.annotate([{ type: 'pin', target: `fill-${i}`, label: `fill-${i}` }]);
    assert.equal(r.drawn, 1);
  }
  const over = await engine.annotate([{ type: 'pin', target: 'one too many' }]);
  assert.equal(over.drawn, 0);
  assert.equal(over.capped, true, 'the result reports the cap');
  assert.equal(over.results[0].error, 'annotation limit reached');
  assert.equal(engine.count(), 120);

  const refresh = await engine.annotate([{ type: 'pin', target: 'fill-7', label: 'fill-7' }]);
  assert.equal(refresh.drawn, 1, 'de-dup runs BEFORE the cap: a re-narration still refreshes');
  assert.equal(refresh.results[0].duplicate, true);
  assert.equal(engine.count(), 120);
});

test('a clear mid-resolution aborts the whole call and draws nothing', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  let release;
  const gate = new Promise((r) => { release = r; });
  const engine = createAnnotationEngine({
    viewer: {},
    renderer,
    resolveTarget: () => gate,
  });

  const pending = engine.annotate({ type: 'pin', target: 'slow' }); // object form, not array
  await flushMicrotasks();
  engine.clear(); // bumps the generation and aborts the in-flight resolve
  release({ lon: 1, lat: 1, height: 0, label: 'late', source: 'fake', ring: null });
  const result = await pending;

  assert.equal(result.aborted, true, 'the superseded call reports itself as aborted');
  assert.equal(result.drawn, 0);
  assert.equal(engine.count(), 0, 'a late resolve never draws onto the cleared board');
});

test('an unresolvable target produces the shared failure shape', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  const engine = createAnnotationEngine({
    viewer: {},
    renderer,
    resolveTarget: async () => null,
  });
  const result = await engine.annotate({ type: 'pin', target: 'Nowhere', label: 'Nothing' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.results[0], {
    ok: false,
    label: 'Nothing',
    target: 'Nowhere',
    failedTargets: ['Nowhere'],
    error: 'could not resolve location',
  });
});

test('type aliases normalize to the five canonical kinds', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  const { resolve } = countingResolver();
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget: resolve });
  const result = await engine.annotate([
    { type: 'polygon', target: 'p1' },
    { type: 'path', target: 'r1', points: [{ target: 'p1' }, { target: 'r1' }] },
    { type: 'vector', target: 'p1', toTarget: 'r1' },
    { type: 'callout', target: 'c1' },
    { type: 'marker', target: 'm1' },
    { type: 'completely-unknown', target: 'u1' },
  ]);
  assert.deepEqual(result.results.map((r) => r.type), ['area', 'route', 'arrow', 'label', 'pin', 'highlight']);
});

// ── Camera assist: off-screen marks are framed, on-screen marks are left alone ─

function cameraAssistViewer({ visibility, cameraHeight = 5000 } = {}) {
  const flights = [];
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, cameraHeight);
  const camera = {
    heading: 0.4,
    position,
    direction: Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.negate(Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    ),
    up: Cesium.Cartesian3.clone(Cesium.Cartesian3.UNIT_Y),
    frustum: {
      computeCullingVolume: () => ({
        computeVisibility: () => (visibility === 'outside'
          ? Cesium.Intersect.OUTSIDE
          : Cesium.Intersect.INSIDE),
      }),
    },
    flyToBoundingSphere(sphere, opts) { flights.push({ sphere, opts }); },
  };
  return { viewer: { camera }, flights };
}

test('camera assist frames a single off-screen mark using the Places viewport', async (t) => {
  installAnimationFrameStubs(t);
  const clock = installFrameClock(t);
  const { renderer } = fakeRenderer();
  const { viewer, flights } = cameraAssistViewer({ visibility: 'outside' });
  const resolveTarget = async () => ({
    lon: -97.74, lat: 30.27, height: 0, label: null, source: 'fake', ring: null,
    viewport: { low: { longitude: -98, latitude: 30 }, high: { longitude: -96, latitude: 31 } },
  });
  const engine = createAnnotationEngine({ viewer, renderer, resolveTarget });

  const result = await engine.annotate([{ type: 'pin', target: 'off screen' }]);
  assert.equal(result.drawn, 1);
  assert.equal(flights.length, 1, 'nothing visible → one assist flight');
  // The viewport box spans ~222 km; 0.7× exceeds the 120 km regional assist cap.
  assert.equal(flights[0].sphere.radius, 120000, 'the assist range is capped at regional scale');
  assert.equal(flights[0].opts.duration, 1.8);

  // Debounce: a second call within the assist window must not re-fly.
  const second = await engine.annotate([{ type: 'pin', target: 'second', }]);
  assert.equal(second.drawn, 1);
  assert.equal(flights.length, 1, 'the assist debounce stands down mid-flight');
  clock.advance(2700);
  await engine.annotate([{ type: 'pin', target: 'third' }]);
  assert.equal(flights.length, 2, 'after the window the assist works again');
});

test('camera assist frames multiple off-screen marks with one bounding flight', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  const { viewer, flights } = cameraAssistViewer({ visibility: 'outside' });
  const { resolve } = countingResolver();
  const engine = createAnnotationEngine({ viewer, renderer, resolveTarget: resolve });

  const result = await engine.annotate([
    { type: 'pin', target: 'west' },
    { type: 'pin', target: 'east' },
  ], { persist: true });
  assert.equal(result.drawn, 2);
  assert.equal(flights.length, 1);
  assert.equal(flights[0].opts.duration, 1.6, 'the multi-mark framing is its own flight shape');
  assert.ok(flights[0].sphere.radius > 0, 'one sphere spans both marks');
  assert.equal(
    flights[0].opts.offset.range,
    Math.max(900, flights[0].sphere.radius * 2.6),
    'the range floor keeps tight clusters from flying point-blank',
  );
});

test('camera assist never fights a camera that already sees the mark', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  const { viewer, flights } = cameraAssistViewer({ visibility: 'inside' });
  const resolveTarget = async () => ({ lon: -97.74, lat: 30.27, height: 0, label: null, source: 'fake', ring: null });
  const engine = createAnnotationEngine({ viewer, renderer, resolveTarget });

  const result = await engine.annotate([{ type: 'pin', target: 'in view' }]);
  assert.equal(result.drawn, 1);
  assert.equal(flights.length, 0, 'a visible mark needs no assist');
});

test('a resolved ring sizes the framing flight from the footprint extent', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  const { viewer, flights } = cameraAssistViewer({ visibility: 'outside' });
  const RING = [[-98, 30], [-96, 30], [-96, 31], [-98, 31], [-98, 30]];
  const resolveTarget = async () => ({
    lon: -97, lat: 30.5, height: 0, label: null, source: 'fake', ring: RING,
  });
  const engine = createAnnotationEngine({ viewer, renderer, resolveTarget });

  await engine.annotate([{ type: 'area', target: 'big area', label: 'Big' }]);
  assert.equal(flights.length, 1);
  assert.ok(flights[0].sphere.radius > 100000, 'the ring diagonal drives the range');
});

// ── demo() and tour(): the scripted experiences ───────────────────────────────

test('demo lays the scripted San Francisco tour with clearPrevious + flyTo', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer, calls } = fakeRenderer();
  const { viewer, flights } = cameraAssistViewer({ visibility: 'inside' });
  const { resolve } = countingResolver();
  const engine = createAnnotationEngine({ viewer, renderer, resolveTarget: resolve });

  await engine.annotate([{ type: 'pin', target: 'pre-existing' }]);
  assert.equal(engine.count(), 1);

  const result = await engine.demo();
  assert.equal(result.drawn, 4, 'highlight + area + pin + arrow all draw');
  assert.equal(engine.count(), 4, 'clearPrevious wiped the earlier mark');
  assert.ok(calls.remove >= 1);
  assert.equal(flights.length, 1, 'flyTo frames the first resolved annotation');
});

test('tour sequences camera moves and annotations end-to-end', async (t) => {
  const originalRAF = globalThis.requestAnimationFrame;
  const originalCAF = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    t.mock.timers.reset();
    if (originalRAF === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRAF;
    if (originalCAF === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = originalCAF;
  });

  const { renderer } = fakeRenderer();
  const flights = [];
  const viewer = {
    camera: {
      heading: 0,
      flyTo({ orientation, duration }) { flights.push({ orientation, duration }); },
    },
  };
  const { resolve } = countingResolver();
  const engine = createAnnotationEngine({ viewer, renderer, resolveTarget: resolve });

  const done = engine.tour();
  let guard = 0;
  while (guard < 200) {
    guard += 1;
    t.mock.timers.tick(4000);
    await flushMicrotasks(5);
    const finished = await Promise.race([done.then(() => true), flushMicrotasks(5).then(() => false)]);
    if (finished) break;
  }
  const result = await done;
  assert.deepEqual(result, { ok: true, steps: 6 });
  assert.equal(engine.count(), 5, 'highlight + arrow + area + pin + route all landed');
  assert.equal(flights.length, 2, 'the tour flies the scripted camera moves');
  assert.equal(flights[0].duration, 3);
  assert.equal(flights[1].orientation.heading, 18 * Math.PI / 180);
  assert.equal(flights[1].orientation.pitch, -32 * Math.PI / 180);
});

// ── Last-mile contracts: dedup geometry branches, stale queue, hostile camera ─

test('route re-narration: same mode + same path dedupes, a different mode does not', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  const { resolve } = countingResolver();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    json: async () => ({
      ok: true,
      geometry: [[-97.74, 30.27], [-97.73, 30.28]],
      distanceM: 1500,
      durationS: 300,
    }),
  });
  t.after(() => {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  });
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget: resolve });

  const first = await engine.annotate([{
    type: 'route', label: 'walk it', mode: 'foot',
    points: [{ target: 'A' }, { target: 'B' }],
  }]);
  const again = await engine.annotate([{
    type: 'route', label: 'walk it', mode: 'foot',
    points: [{ target: 'A' }, { target: 'B' }],
  }]);
  assert.equal(again.results[0].duplicate, true, 'same mode + same vertex path is one mark');
  assert.equal(again.ids[0], first.ids[0]);
  assert.equal(engine.count(), 1);

  await engine.annotate([{
    type: 'route', label: 'ride it', mode: 'bike',
    points: [{ target: 'A' }, { target: 'B' }],
  }]);
  assert.equal(engine.count(), 2, 'a different MODE is a different route');
});

test('route re-narration: a different waypoint count is never a duplicate', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  const { resolve } = countingResolver();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    // coords= is encodeURIComponent-ed (%3B between legs)
    const coords = decodeURIComponent(String(url).split('coords=')[1]);
    const legs = coords.split(';').length;
    const geometry = Array.from({ length: legs }, (_, i) => [-97.74 - i * 0.01, 30.27 + i * 0.01]);
    return { json: async () => ({ ok: true, geometry, distanceM: 1500, durationS: null }) };
  };
  t.after(() => {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  });
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget: resolve });

  await engine.annotate([{ type: 'route', points: [{ target: 'A' }, { target: 'B' }] }]);
  const detour = await engine.annotate([{
    type: 'route', points: [{ target: 'A' }, { target: 'B' }, { target: 'C' }],
  }]);
  // Fresh marks carry no `duplicate` key at all — only refreshes/replacements do.
  assert.ok(!detour.results[0].duplicate, 'A→B→C is not a re-narration of A→B');
  assert.equal(engine.count(), 2, 'A→B and A→B→C are different marks');
});

test('resolved-ring areas at one anchor: a different synthesis or kind stays distinct', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  const RING = [[0, 0], [0, 1], [1, 1], [0, 0]];
  const engine = createAnnotationEngine({
    viewer: {},
    renderer,
    resolveTarget: async ({ target }) => ({
      lon: -97.74, lat: 30.27, height: 0, label: null, source: 'fake',
      // 'shifted one' shares kind + synthesis with 'real one' but a DIFFERENT ring
      ring: (target === 'shifted one' ? RING.map(([a, b]) => [a + 0.5, b]) : RING).map(([a, b]) => [a, b]),
      footprintKind: target === 'building one' ? 'building' : 'area',
      synthesized: target === 'buffered one',
    }),
  });

  await engine.annotate([{ type: 'area', target: 'real one', label: 'real' }]);
  await engine.annotate([{ type: 'area', target: 'buffered one', label: 'buffer' }]);
  assert.equal(engine.count(), 2, 'synthesized vs real boundary are different marks');

  await engine.annotate([{ type: 'area', target: 'building one', label: 'bldg' }]);
  assert.equal(engine.count(), 3, 'a building footprint is not an area footprint');

  await engine.annotate([{ type: 'area', target: 'shifted one', label: 'shifted' }]);
  assert.equal(engine.count(), 4, 'same kind + synthesis but a different ring stays distinct');
});

test('a failed outline is RETRIED by re-narration: the fresh resolver attaches to the dup', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer, calls } = fakeRenderer();
  const FP_RETRY = {
    ring: [[1, 1], [1, 2], [2, 2], [1, 1]],
    footprintKind: 'area',
    synthesized: false,
    lat: 1.5, lon: 1.5, height: 0,
  };
  let outlineCall = 0;
  const engine = createAnnotationEngine({
    viewer: {},
    renderer,
    resolveTarget: async () => ({
      lon: 1.5, lat: 1.5, height: 0, label: null, source: 'fake', ring: null,
      resolveOutline: async () => {
        outlineCall += 1;
        return outlineCall === 1 ? null : { ...FP_RETRY }; // 1st: definitive miss
      },
    }),
  });
  const events = [];
  engine.onOutlineEvent((e) => events.push(e));

  const first = await engine.annotate([{ type: 'area', target: 'Missed', label: 'Missed' }]);
  await flushMicrotasks();
  assert.equal(first.results[0].outlinePending, true, 'the tool result never waits on the outline');
  assert.equal(engine.list()[0].pendingOutline, false, 'the first upgrade concluded');
  assert.equal(engine.list()[0].ring, null, 'the honest point stands after a definitive miss');
  assert.deepEqual(events.map((e) => e.status), ['failed']);

  // Re-narration is a RETRY: the dup (ring-less, no live task) inherits this
  // call's resolver and upgrades to the ring.
  const retry = await engine.annotate([{ type: 'area', target: 'Missed', label: 'Missed' }]);
  await flushMicrotasks();
  assert.equal(retry.results[0].duplicate, true);
  assert.deepEqual(engine.list()[0].ring, FP_RETRY.ring, 'the retried outline landed');
  assert.deepEqual(events.map((e) => e.status), ['failed', 'resolved']);
  assert.equal(calls.update, 1, 'the upgrade re-routed the same mark');
});

test("outline queue: a replaced mark's queued upgrade is dropped as stale", async (t) => {
  installAnimationFrameStubs(t);
  const { renderer, calls } = fakeRenderer();
  const releases = new Map();
  const resolveTarget = async ({ target }) => {
    const i = Number(target.slice(1)); // q0 -> 0, q1 -> 1, q2 -> 2
    return {
      lon: -97.74 - i * 0.01, lat: 30.27, height: 0, label: target, source: 'fake', ring: null,
      resolveOutline: () => new Promise((res) => {
        releases.set(target, () => res({
          ring: [[i, 0], [i, 1], [i + 1, 1], [i, 0]],
          footprintKind: 'area', lat: 30.27, lon: -97.74 - i * 0.01, height: 0,
        }));
      }),
    };
  };
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget });
  const events = [];
  engine.onOutlineEvent((e) => events.push(e));

  await engine.annotate([
    { type: 'area', target: 'q0', label: 'q0' },
    { type: 'area', target: 'q1', label: 'q1' },
    { type: 'area', target: 'q2', label: 'q2' },
  ]);
  // Two upgrades in flight; q2's task is QUEUED. Re-narrate q2 with a new
  // label → replace-in-place: the old mark leaves the map, its queued task
  // must be dropped as stale rather than mutating a ghost.
  await engine.annotate([{ type: 'area', target: 'q2', label: 'q2 renamed' }]);
  releases.get('q0')();
  await flushMicrotasks();
  releases.get('q1')();
  await flushMicrotasks(40); // drain: stale q2 task discarded, renamed task starts

  assert.equal(engine.count(), 3, 'three live marks: q0, q1, renamed q2');
  const renamed = engine.list().find((a) => a.label === 'q2 renamed');
  assert.ok(renamed, 'the renamed mark survived');
  assert.equal(events.length, 2, 'only the live upgrades reported outcomes');

  releases.get('q2')(); // arms the RENAMED mark's own resolver (map entry overwritten)
  await flushMicrotasks(40);
  assert.equal(renamed.ring.length, 4, 'the renamed mark upgraded once its turn came');
  assert.equal(events.length, 3);
  assert.equal(calls.update, 3, 'each resolved upgrade re-routed its mark');
});

test('a hostile camera never breaks annotation: every framing path swallows the throw', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  const flights = [];
  const viewer = {
    camera: {
      heading: 0,
      position: Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 5000),
      direction: Cesium.Cartesian3.negate(Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3()),
      up: Cesium.Cartesian3.clone(Cesium.Cartesian3.UNIT_Y),
      frustum: {
        computeCullingVolume: () => ({ computeVisibility: () => Cesium.Intersect.OUTSIDE }),
      },
      flyToBoundingSphere() { throw new Error('camera gone'); },
      flyTo() { throw new Error('camera gone'); },
    },
  };
  const { resolve } = countingResolver();
  const engine = createAnnotationEngine({ viewer, renderer, resolveTarget: resolve });

  // flyTo framing (single mark) — swallowed inside frameAnnotation
  const framed = await engine.annotate([{ type: 'pin', target: 'one' }], { flyTo: true });
  assert.equal(framed.drawn, 1);
  assert.equal(flights.length, 0);

  // multi-mark assist — swallowed inside ensureMarksVisible
  const assisted = await engine.annotate([{ type: 'pin', target: 'two' }, { type: 'pin', target: 'three' }]);
  assert.equal(assisted.drawn, 2);
  assert.equal(engine.count(), 3);
});

test('tour survives a camera whose flyTo always throws', async (t) => {
  const originalRAF = globalThis.requestAnimationFrame;
  const originalCAF = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    t.mock.timers.reset();
    if (originalRAF === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRAF;
    if (originalCAF === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = originalCAF;
  });

  const { renderer } = fakeRenderer();
  const viewer = { camera: { heading: 0, flyTo() { throw new Error('no camera'); } } };
  const { resolve } = countingResolver();
  const engine = createAnnotationEngine({ viewer, renderer, resolveTarget: resolve });

  const done = engine.tour();
  let guard = 0;
  while (guard < 200) {
    guard += 1;
    t.mock.timers.tick(4000);
    await flushMicrotasks(5);
    const finished = await Promise.race([done.then(() => true), flushMicrotasks(5).then(() => false)]);
    if (finished) break;
  }
  const result = await done;
  assert.deepEqual(result, { ok: true, steps: 6 }, 'the tour completes with its scripted steps');
  assert.equal(engine.count(), 5);
});

test('a viewport that throws during measurement falls back to the default range', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  const flights = [];
  const viewer = {
    camera: {
      heading: 0.2,
      flyToBoundingSphere(sphere, opts) { flights.push({ sphere, opts }); },
    },
  };
  const resolveTarget = async () => ({
    lon: -97.74, lat: 30.27, height: 0, label: null, source: 'fake', ring: null,
    viewport: {
      // Passes the low/high presence guard, then explodes mid-measurement —
      // viewportRange's own catch turns that into null → the 600 m default.
      low: { longitude: -98, latitude: 30 },
      high: { get longitude() { throw new Error('corrupt viewport'); }, latitude: 31 },
    },
  });
  const engine = createAnnotationEngine({ viewer, renderer, resolveTarget });

  await engine.annotate([{ type: 'pin', target: 'measuring' }], { flyTo: true });
  assert.equal(flights.length, 1);
  assert.equal(flights[0].sphere.radius, 600, 'the 600 m default range framed the mark');
});

test('a viewport that throws in the presence guard skips framing entirely', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  const flights = [];
  const viewer = {
    camera: {
      heading: 0.2,
      flyToBoundingSphere(sphere, opts) { flights.push({ sphere, opts }); },
    },
  };
  const resolveTarget = async () => ({
    lon: -97.74, lat: 30.27, height: 0, label: null, source: 'fake', ring: null,
    viewport: {
      low: { longitude: -98, latitude: 30 },
      // The !vp?.high guard read sits OUTSIDE viewportRange's try, so this
      // throw escapes to frameAnnotation's best-effort catch: no flight.
      get high() { throw new Error('corrupt viewport'); },
    },
  });
  const engine = createAnnotationEngine({ viewer, renderer, resolveTarget });

  const result = await engine.annotate([{ type: 'pin', target: 'guarded' }], { flyTo: true });
  assert.equal(result.drawn, 1, 'the mark itself is unaffected');
  assert.equal(flights.length, 0, 'the framing was skipped, not defaulted');
});

test('an arrow whose resolver THROWS names both endpoints in the failure', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  const engine = createAnnotationEngine({
    viewer: {},
    renderer,
    resolveTarget: async () => { throw new Error('geocoder exploded'); },
  });
  const result = await engine.annotate([{
    type: 'arrow', target: 'Here', toTarget: 'There', label: 'hop',
  }]);
  assert.equal(result.drawn, 0);
  assert.equal(result.results[0].error, 'geocoder exploded');
  assert.deepEqual(result.results[0].failedTargets, ['Here', 'There']);
});

test('a route fetch aborted by clear() unwinds without a fallback draw', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  let fetchAborted = false;
  const engine = createAnnotationEngine({
    viewer: {},
    renderer,
    resolveTarget: async ({ latitude }) => ({
      lon: -97.74, lat: latitude ?? 30.27, height: 0, label: null, source: 'fake', ring: null,
    }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      fetchAborted = true;
      reject(new Error('AbortError'));
    });
  });
  t.after(() => {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  });

  const pending = engine.annotate([{
    type: 'route', points: [{ latitude: 30.27 }, { latitude: 31.27 }],
  }]);
  await flushMicrotasks();
  engine.clear(); // aborts the in-flight route fetch via the shared controller
  const result = await pending;
  assert.equal(fetchAborted, true, 'the external signal reached the route fetch');
  assert.equal(result.aborted, true);
  assert.equal(engine.count(), 0);
});
