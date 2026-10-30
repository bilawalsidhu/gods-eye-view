import { createStandalonePlaceSearch } from '../standalone/placeSearch.js';
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
  let engine;
  // Destroy while the browser/timer stubs are still installed.
  t.after(() => engine?.destroy());
  installAnimationFrameStubs(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  const { renderer } = fakeRenderer();
  renderer.destroy = () => {};
  let fetchesStarted = 0;
  const releases = [];
  const resolveTarget = async ({ target, signal }) => ({
    lon: Number(target.slice('clear-'.length)),
    lat: 10,
    height: 0,
    label: target,
    source: 'fake',
    ring: null,
    resolveOutline: () =>
      new Promise((resolve) => {
        fetchesStarted += 1;
        const finish = () => resolve(undefined);
        releases.push(finish);
        if (signal.aborted) finish();
        else signal.addEventListener('abort', finish, { once: true });
      }),
  });
  engine = createAnnotationEngine({
    viewer: {},
    renderer,
    resolveTarget,
  });

  await engine.annotate(
    Array.from({ length: 8 }, (_, i) => ({
      type: 'area',
      target: `clear-${i}`,
      footprint: true,
    })),
  );
  assert.equal(fetchesStarted, 2);

  // Both workers enter their real backoff while the remaining six stay queued.
  releases[0]();
  releases[1]();
  await flushMicrotasks();

  engine.clear();
  await flushMicrotasks();
  assert.equal(engine.count(), 0);
  assert.equal(
    fetchesStarted,
    2,
    'the six queued upgrades were dropped on clear',
  );

  await engine.annotate(
    [8, 9].map((i) => ({
      type: 'area',
      target: `clear-${i}`,
      footprint: true,
    })),
  );
  await flushMicrotasks();
  assert.equal(
    fetchesStarted,
    4,
    'cleared backoff timers release both workers without advancing time',
  );
});

test('retry: HTTP 429 Retry-After 5s gets one ladder-spaced retry; a second 429 stops', async (t) => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  globalThis.window = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const requestTimes = [];
  globalThis.fetch = async (url) => {
    // The one-time capability probe is not an outline request.
    if (String(url).endsWith('/status')) return httpFailure(404);
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
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/status'))
      return Response.json({ configured: true });
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

test('outline upgrade updates the rendered element in place without remove/add', { timeout: 5000 }, async (t) => {
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
    if (String(url).startsWith('/api/google/geocode')) {
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
  const engine = createAnnotationEngine({ viewer, renderer, placeSearch: createStandalonePlaceSearch({ resolveApiKey: () => 'unit-test-key' }) });
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

// Building installation is a renderer-owned async interval after location resolution.
function controlledBuildingRenderer() {
  const { renderer, calls } = fakeRenderer();
  const pending = [];
  const live = new Set();
  const enqueue = (anno, options = {}) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const finish = (status = 'installed', error) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', abort);
        if (status === 'installed' && (options.isCurrent?.() ?? true))
          live.add(anno.id);
        if (error) reject(error);
        else
          resolve({
            status,
            timing: { workMs: 1, maxSliceMs: 1, lastSliceMs: 1 },
          });
      };
      const abort = () => finish('cancelled');
      options.signal?.addEventListener('abort', abort, { once: true });
      pending.push({ anno, options, finish });
    });
  renderer.add = (anno, options) => {
    calls.add += 1;
    if (anno.footprintKind === 'building' && anno.ring)
      return enqueue(anno, options);
    live.add(anno.id);
  };
  renderer.update = (anno, options) => {
    calls.update += 1;
    if (anno.footprintKind === 'building' && anno.ring)
      return enqueue(anno, options);
  };
  renderer.remove = (anno) => {
    calls.remove += 1;
    live.delete(anno.id);
    pending
      .filter((item) => item.anno === anno)
      .forEach((item) => item.finish('cancelled'));
  };
  renderer.destroy = () => pending.forEach((item) => item.finish('cancelled'));
  return { renderer, calls, pending, live };
}
const BUILDING_FP = {
  ...FIXED_POINT,
  ring: [
    [-97.744, 30.267],
    [-97.743, 30.267],
    [-97.743, 30.268],
    [-97.744, 30.267],
  ],
  footprintKind: 'building',
  buildingHeight: 20,
};

test('fresh async building batch reserves slots together and releases failed/cleared installs', async (t) => {
  installAnimationFrameStubs(t);
  _resetRenderGovernorForTest();
  t.after(() => _resetRenderGovernorForTest());
  const h = controlledBuildingRenderer();
  const engine = createAnnotationEngine({
    viewer: {},
    renderer: h.renderer,
    resolveTarget: async ({ target }) => ({
      ...BUILDING_FP,
      lon: target === 'second' ? -97.7 : BUILDING_FP.lon,
    }),
  });
  const result = engine.annotate([
    { type: 'area', target: 'first', label: 'First' },
    { type: 'area', target: 'second', label: 'Second' },
  ]);
  await flushMicrotasks();
  assert.equal(
    h.pending.length,
    2,
    'both installs enqueue without serial awaits',
  );
  assert.equal(engine.count(), 2, 'pending marks reserve the cap');
  h.pending[0].finish('failed', new Error('async WebGL failure'));
  h.pending[1].finish('timeout');
  const completed = await result;
  assert.equal(completed.drawn, 1);
  assert.equal(completed.failed, 1);
  assert.equal(engine.count(), 1);
  assert.equal(engine.list()[0].outlineUnavailable, true);
  assert.equal(engine.list()[0].ring, null);
  assert.equal(engine.list()[0].pendingOutline, false);
  engine.clear();
  assert.equal(engine.count(), 0);
  assert.ok(!getRenderGovernorDiagnostics().holds.includes('annotations'));

  const cancelled = engine.annotate([{ type: 'area', target: 'third' }]);
  await flushMicrotasks();
  const task = h.pending.at(-1);
  engine.clear();
  assert.equal(task.options.signal.aborted, true);
  task.finish();
  assert.equal((await cancelled).aborted, true);
  assert.equal(engine.count(), 0);
  assert.equal(h.live.size, 0);
});

test('outline workers retain completion ownership and clear cancels resolved-but-uninstalled geometry', async (t) => {
  installAnimationFrameStubs(t);
  const h = controlledBuildingRenderer();
  const started = [];
  const engine = createAnnotationEngine({
    viewer: {},
    renderer: h.renderer,
    resolveTarget: async ({ target }) => ({
      ...FIXED_POINT,
      lon: -97 + Number(target),
      resolveOutline: async () => {
        started.push(target);
        return { ...BUILDING_FP, lon: -97 + Number(target) };
      },
    }),
  });
  const events = [];
  engine.onOutlineEvent((event) => events.push(event));
  const result = await engine.annotate(
    ['0', '1', '2'].map((target) => ({ type: 'area', target })),
  );
  assert.equal(result.drawn, 3);
  await flushMicrotasks();
  assert.equal(h.pending.length, 2);
  assert.deepEqual(started, ['0', '1']);
  assert.equal(events.length, 0, 'resolver finish is not installation finish');
  assert.ok(engine.list().every((anno) => anno.pendingOutline));
  h.pending[0].finish();
  await flushMicrotasks();
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'resolved');
  assert.deepEqual(started, ['0', '1', '2']);
  engine.clear();
  await flushMicrotasks();
  h.pending.forEach((task) => {
    assert.equal(task.options.signal.aborted, true);
    task.finish();
  });
  await flushMicrotasks();
  assert.equal(events.length, 1, 'no late outcome on cleared marks');
  assert.equal(engine.count(), 0);
  assert.equal(h.live.size, 0);
});

test('building recaption timeout retains old route and a newer replacement owns the swap', async (t) => {
  installAnimationFrameStubs(t);
  const h = controlledBuildingRenderer();
  const engine = createAnnotationEngine({
    viewer: {},
    renderer: h.renderer,
    resolveTarget: async () => ({ ...BUILDING_FP }),
  });
  const initial = engine.annotate([
    { type: 'area', target: 'Capitol', label: 'Old' },
  ]);
  await flushMicrotasks();
  h.pending[0].finish();
  await initial;
  const old = engine.list()[0];
  const refresh = (label) =>
    engine.annotate([{ type: 'area', target: 'Capitol', label }]);
  const timed = refresh('Timed');
  await flushMicrotasks();
  assert.equal(engine.list()[0], old);
  assert.ok(h.live.has(old.id));
  h.pending.at(-1).finish('timeout');
  assert.equal((await timed).failed, 1);
  assert.equal(engine.list()[0], old);
  assert.equal(old.label, 'Old');
  assert.ok(h.live.has(old.id));

  const losing = refresh('Losing');
  await flushMicrotasks();
  const loser = h.pending.at(-1);
  const winning = refresh('Winning');
  await flushMicrotasks();
  const winner = h.pending.at(-1);
  assert.notEqual(loser.anno, winner.anno);
  assert.equal(loser.options.isCurrent(), false);
  winner.finish();
  loser.finish();
  assert.equal((await losing).failed, 1);
  assert.equal((await winning).drawn, 1);
  assert.equal(engine.list()[0].label, 'Winning');
  assert.equal(h.live.size, 1);
  assert.ok(!h.live.has(old.id));

  const late = refresh('After clear');
  await flushMicrotasks();
  const lateTask = h.pending.at(-1);
  engine.clear();
  lateTask.finish();
  assert.equal((await late).aborted, true);
  assert.equal(engine.count(), 0);
  assert.equal(h.live.size, 0);
});



test('replacement cleanup failure still removes the old route and retains failed cleanup ownership', async (t) => {
  installAnimationFrameStubs(t);
  const h = controlledBuildingRenderer();
  const engine = createAnnotationEngine({
    viewer: {}, renderer: h.renderer, resolveTarget: async () => ({ ...BUILDING_FP }),
  });
  const initial = engine.annotate([{ type: 'area', target: 'Capitol', label: 'Old' }]);
  await flushMicrotasks();
  h.pending[0].finish();
  await initial;
  const old = engine.list()[0];
  const refresh = engine.annotate([{ type: 'area', target: 'Capitol', label: 'New' }]);
  await flushMicrotasks();
  const replacementTask = h.pending.at(-1);
  const replacement = replacementTask.anno;
  const originalRemove = h.renderer.remove;
  const removals = [];
  let fail = true;
  h.renderer.remove = (anno) => {
    removals.push(anno);
    if (anno === replacement && fail) throw new Error('replacement cleanup failed');
    originalRemove(anno);
  };
  assert.throws(() => engine.clear(), /replacement cleanup failed/);
  assert.ok(removals.includes(old), 'old removal is attempted even when replacement removal throws');
  assert.equal(replacementTask.options.isCurrent(), false, 'cleanup failure cannot retain install authority');
  assert.equal(engine.list()[0], old, 'failed cleanup remains reachable');
  await flushMicrotasks();
  fail = false;
  const attempts = removals.filter((anno) => anno === replacement).length;
  engine.clear();
  assert.ok(
    removals.filter((anno) => anno === replacement).length > attempts,
    'the failed replacement route is retried on the next clear',
  );
  await refresh;
  assert.equal(engine.count(), 0);
  assert.equal(h.live.size, 0);
  replacementTask.finish();
  await flushMicrotasks();
  assert.equal(h.live.size, 0, 'a revoked install cannot commit after cleanup');
});



test('identical refresh revokes an older building replacement even if cancellation cleanup fails', async (t) => {
  installAnimationFrameStubs(t);
  const h = controlledBuildingRenderer();
  const engine = createAnnotationEngine({
    viewer: {}, renderer: h.renderer, resolveTarget: async () => ({ ...BUILDING_FP }),
  });
  const initial = engine.annotate([{ type: 'area', target: 'Capitol', label: 'Old' }]);
  await flushMicrotasks(); h.pending[0].finish(); await initial;
  const old = engine.list()[0];
  const pending = engine.annotate([{ type: 'area', target: 'Capitol', label: 'New' }]);
  await flushMicrotasks();
  const task = h.pending.at(-1);
  const remove = h.renderer.remove;
  let fail = true;
  h.renderer.remove = (anno) => {
    if (anno === task.anno && fail) throw new Error('cancel cleanup failed');
    remove(anno);
  };
  const identical = await engine.annotate([{ type: 'area', target: 'Capitol', label: 'Old' }]);
  assert.equal(identical.results[0].id, old.id);
  assert.equal(identical.results[0].cleanupPending, true);
  assert.equal(task.options.isCurrent(), false, 'newest identical ask revokes install authority immediately');
  task.finish();
  assert.equal((await pending).failed, 1);
  assert.equal(engine.list()[0], old);
  assert.equal(old.label, 'Old');
  fail = false;
  engine.clear();
  assert.equal(engine.count(), 0);
});

test('successful replacement survives failed old-route retirement and keeps cleanup addressable', async (t) => {
  installAnimationFrameStubs(t);
  const h = controlledBuildingRenderer();
  const engine = createAnnotationEngine({
    viewer: {}, renderer: h.renderer, resolveTarget: async () => ({ ...BUILDING_FP }),
  });
  const initial = engine.annotate([{ type: 'area', target: 'Capitol', label: 'Old' }]);
  await flushMicrotasks(); h.pending[0].finish(); await initial;
  const old = engine.list()[0];
  const remove = h.renderer.remove;
  const removals = [];
  let fail = true;
  h.renderer.remove = (anno) => {
    removals.push(anno);
    if (anno === old && fail) throw new Error('retirement failed');
    remove(anno);
  };
  const refresh = engine.annotate([{ type: 'area', target: 'Capitol', label: 'New' }]);
  await flushMicrotasks(); h.pending.at(-1).finish();
  const completed = await refresh;
  const current = engine.list()[0];
  assert.equal(completed.drawn, 1);
  assert.equal(completed.results[0].cleanupPending, true);
  assert.equal(current.label, 'New');
  assert.ok(h.live.has(current.id), 'valid installed replacement is not rolled back by old teardown failure');
  assert.equal(h.pending.filter((task) => task.options.isCurrent()).length, 0, 'no install is left pending');
  fail = false;
  const attempts = removals.filter((anno) => anno === old).length;
  engine.clear();
  assert.ok(
    removals.filter((anno) => anno === old).length > attempts,
    'the old route that failed to retire is retried on clear',
  );
  assert.equal(engine.count(), 0);
  assert.equal(h.live.size, 0);
});

test('pending fresh predecessor failure cannot erase a newer building intent', async (t) => {
  installAnimationFrameStubs(t);
  const frames = [];
  globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  const h = controlledBuildingRenderer();
  const engine = createAnnotationEngine({
    viewer: {}, renderer: h.renderer, resolveTarget: async () => ({ ...BUILDING_FP }),
  });
  const first = engine.annotate([{ type: 'area', target: 'Capitol', label: 'First' }]);
  await flushMicrotasks();
  const predecessor = h.pending[0];
  assert.ok(frames.length > 0, 'fresh pending point starts its existing fade tick before batch settlement');
  const remove = h.renderer.remove;
  h.renderer.remove = (anno) => {
    if (anno !== predecessor.anno) remove(anno);
  };
  const second = engine.annotate([{ type: 'area', target: 'Capitol', label: 'Second' }]);
  await flushMicrotasks();
  const successor = h.pending.at(-1);
  assert.notEqual(successor.anno, predecessor.anno);
  predecessor.finish('failed', new Error('late old install failure'));
  await flushMicrotasks();
  assert.equal(engine.list()[0], successor.anno);
  assert.equal(successor.options.isCurrent(), true);
  successor.finish();
  assert.equal((await first).failed, 1);
  assert.equal((await second).drawn, 1);
  assert.equal(engine.list()[0].label, 'Second');
  engine.clear();
});

test('duplicate pending building results reflect final failure rather than a dead id', async (t) => {
  installAnimationFrameStubs(t);
  const h = controlledBuildingRenderer();
  const engine = createAnnotationEngine({
    viewer: {}, renderer: h.renderer, resolveTarget: async () => ({ ...BUILDING_FP }),
  });
  const spec = { type: 'area', target: 'Capitol', label: 'Same' };
  const batch = engine.annotate([spec, spec]);
  await flushMicrotasks();
  assert.equal(h.pending.length, 1);
  h.pending[0].finish('failed', new Error('failed shared install'));
  const result = await batch;
  assert.equal(result.drawn, 0);
  assert.equal(result.failed, 2);
  assert.deepEqual(result.ids, []);
  assert.equal(engine.count(), 0);
});

test('separate duplicate callers observe the original building install outcome', async (t) => {
  installAnimationFrameStubs(t);
  for (const outcome of ['installed', 'failed', 'timeout', 'clear']) {
    const h = controlledBuildingRenderer();
    const engine = createAnnotationEngine({
      viewer: {},
      renderer: h.renderer,
      resolveTarget: async () => ({ ...BUILDING_FP }),
    });
    const spec = { type: 'area', target: 'Capitol', label: 'Same' };
    const first = engine.annotate([spec]);
    await flushMicrotasks();
    let reported = false;
    const second = engine.annotate([spec]).then((result) => {
      reported = true;
      return result;
    });
    await flushMicrotasks();
    assert.equal(h.pending.length, 1);
    assert.equal(
      reported,
      false,
      'the observer cannot report before owner settlement',
    );
    assert.equal(h.pending[0].options.signal.aborted, false);
    assert.equal(h.pending[0].options.isCurrent(), true);
    if (outcome === 'clear') engine.clear();
    else
      h.pending[0].finish(
        outcome,
        outcome === 'failed' ? new Error('owner install failed') : undefined,
      );
    const results = await Promise.all([first, second]);
    if (outcome === 'failed' || outcome === 'clear') {
      for (const result of results) {
        assert.equal(result.drawn, 0);
        assert.deepEqual(result.ids, []);
      }
      assert.equal(engine.count(), 0);
    } else {
      assert.equal(results[0].drawn, 1);
      assert.equal(results[1].drawn, 1);
      assert.deepEqual(results[1].ids, results[0].ids);
      assert.equal(results[1].results[0].duplicate, true);
      if (outcome === 'timeout') {
        for (const result of results)
          assert.equal(result.results[0].outlineUnavailable, true);
        assert.equal(engine.list()[0].ring, null);
      }
    }
    engine.clear();
  }
});

test('a duplicate joins the physical deferred install but not another outline lookup', async (t) => {
  installAnimationFrameStubs(t);
  const h = controlledBuildingRenderer();
  let lookups = 0;
  const engine = createAnnotationEngine({
    viewer: {},
    renderer: h.renderer,
    resolveTarget: async () => ({
      ...FIXED_POINT,
      resolveOutline: async () => {
        lookups++;
        return { ...BUILDING_FP };
      },
    }),
  });
  const spec = { type: 'area', target: 'Capitol', label: 'Same' };
  const initial = await engine.annotate([spec]);
  await flushMicrotasks();
  assert.equal(initial.drawn, 1, 'the progressive point already exists');
  assert.equal(h.pending.length, 1);
  let reported = false;
  const duplicate = engine.annotate([spec]).then((result) => {
    reported = true;
    return result;
  });
  await flushMicrotasks();
  assert.equal(reported, false);
  assert.equal(h.pending.length, 1);
  assert.equal(lookups, 1);
  h.pending[0].finish('failed', new Error('deferred owner install failed'));
  const result = await duplicate;
  assert.equal(result.drawn, 1, 'the owner restored an honest point');
  assert.deepEqual(result.ids, initial.ids);
  assert.equal(result.results[0].outlineUnavailable, true);
  assert.equal(engine.list()[0].ring, null);
  assert.equal(lookups, 1);
  assert.equal(h.pending.length, 1);
  engine.clear();
});

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

// ── Rollback must also unwind PARTIAL renderer state (review round 2) ──────────
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

test('destroy releases the renderer and prevents subsequent annotation work', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer, calls } = fakeRenderer();
  let destroyed = 0;
  renderer.destroy = () => { destroyed++; };
  const engine = createAnnotationEngine({ viewer: {}, renderer });
  const drawn = await engine.annotate([{ type: 'pin', longitude: -97.74, latitude: 30.27 }]);
  assert.equal(drawn.drawn, 1);
  engine.destroy();
  const additions = calls.add;
  const result = await engine.annotate([{ type: 'pin', target: 'Must not resolve' }]);
  assert.equal(result.error, 'destroyed');
  assert.equal(calls.add, additions);
  assert.equal(engine.count(), 0);
  engine.destroy();
  assert.equal(destroyed, 1);
  assert.ok(!getRenderGovernorDiagnostics().holds.includes('annotations'));
});

test('a late annotation resolver cannot redraw after destruction', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer, calls } = fakeRenderer();
  renderer.destroy = () => {};
  let release;
  let signal;
  const engine = createAnnotationEngine({
    viewer: {}, renderer,
    resolveTarget: (options) => {
      signal = options.signal;
      return new Promise((resolve) => { release = resolve; });
    },
  });
  const pending = engine.annotate([{ type: 'pin', target: 'Pending place' }]);
  engine.destroy();
  assert.equal(signal.aborted, true);
  release({ lon: -97.74, lat: 30.27 });
  await pending;
  assert.equal(calls.add, 0);
  assert.equal(engine.count(), 0);
});

test('only an explicit navigation request permits resolving distant annotation targets', async (t) => {
  installAnimationFrameStubs(t);
  _resetRenderGovernorForTest();
  t.after(() => _resetRenderGovernorForTest());
  const { renderer } = throwingRendererHarness();
  renderer.destroy = () => {};
  const received = [];
  const engine = createAnnotationEngine({ viewer: {}, renderer,
    resolveTarget: async (options) => { received.push(options); return null; },
  });
  await engine.annotate([{ type: 'point', target: 'Remote landmark' }]);
  await engine.annotate([{ type: 'point', target: 'Remote landmark' }], { flyTo: true });
  assert.deepEqual(received.map(options => options.allowDistant), [false, true]);
  engine.destroy();
});


test('recaption inherits outline credit from borrowed geometry rather than its new anchor', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  let first = true;
  const ring = [[-99,31],[-98.99,31],[-98.99,31.01],[-99,31]];
  const engine = createAnnotationEngine({ viewer: {}, renderer,
    resolveTarget: async () => {
      if (first) { first = false; return { ...FIXED_POINT, ring, footprintKind: 'area', outlineCredit: 'tiles' }; }
      return { ...FIXED_POINT, source: 'osm-local', resolveOutline: async () => null };
    },
  });
  await engine.annotate([{ type: 'area', target: 'Library', label: 'Old' }]);
  await engine.annotate([{ type: 'area', target: 'Library', label: 'New' }]);
  await flushMicrotasks();
  assert.equal(engine.list()[0].outlineCredit, 'tiles');
  assert.equal(engine.list()[0].ring, ring);
  engine.clear();
});
