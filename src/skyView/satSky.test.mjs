import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ENTRIES, entryOf, tle } from '../testSupport/skyTleFixture.mjs';
import { RECORD_FIELDS, packFlags } from './satCore.js';
import {
  MAX_EXTRAPOLATE_MS,
  createSatSky,
  extrapolateAzEl,
  unpackRecords,
} from './satSky.js';
import { createSatWorkerHandler } from './satWorker.js';
import { passCoverage, RESCAN_AFTER_MS } from './passes.js';
import { passesView } from './satPanel.js';

const FIXTURE = readFileSync(
  new URL('./reference/satFixture200.tle', import.meta.url),
  'utf8',
);
const ISS_ROW = entryOf(25544);
const STARLINK_ROWS = ENTRIES.filter((e) => e.name.startsWith('STARLINK'));
const T0 = Date.parse('2026-10-11T03:00:00Z');

/** In-process stand-in for the module worker, running the real handler. */
class FakeWorker extends EventTarget {
  constructor({ auto = true } = {}) {
    super();
    this.auto = auto;
    this.posted = [];
    this.outbox = [];
    this.terminated = false;
    this.handle = createSatWorkerHandler((message) =>
      this.outbox.push(message),
    );
  }
  postMessage(message) {
    this.posted.push(message);
    this.handle(message);
    if (this.auto) queueMicrotask(() => this.deliver());
  }
  deliver() {
    for (const data of this.outbox.splice(0))
      this.dispatchEvent(Object.assign(new Event('message'), { data }));
  }
  terminate() {
    this.terminated = true;
  }
  ticks() {
    return this.posted.filter((m) => m.type === 'tick');
  }
}

function fakeTimers() {
  const intervals = new Map();
  let id = 1;
  return {
    intervals,
    setInterval: (fn, ms) => {
      intervals.set(id, { fn, ms });
      return id++;
    },
    clearInterval: (handle) => intervals.delete(handle),
    fire() {
      for (const { fn } of [...intervals.values()]) fn();
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
async function pump(worker, rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await settle();
    worker.deliver();
  }
}

function setup({ auto = true, fail = [], ...options } = {}) {
  const worker = new FakeWorker({ auto });
  const fetched = [];
  const timers = fakeTimers();
  let time = T0;
  const sky = createSatSky({
    createWorker: () => worker,
    fetchText: async (path) => {
      fetched.push(path);
      if (fail.includes(path)) throw new Error('HTTP 503');
      if (path === 'active') return FIXTURE;
      if (path === 'stations') return tle(ISS_ROW);
      if (path === 'starlink') return tle(...STARLINK_ROWS);
      return '';
    },
    timers,
    getTime: () => time,
    ...options,
  });
  return {
    worker,
    fetched,
    timers,
    sky,
    setTime: (t) => {
      time = t;
    },
  };
}

const OBS = { latDeg: 29.7604, lonDeg: -95.3698 };

test('start: observer, core groups + active from /api/celestrak (Starlink off), objects with names', async () => {
  const { worker, fetched, sky } = setup();
  assert.equal(sky.start(OBS), true);
  assert.equal(sky.status, 'loading');
  await pump(worker);
  assert.deepEqual(fetched.sort(), [
    'active',
    'galileo',
    'geo',
    'glo-ops',
    'gps-ops',
    'stations',
    'visual',
  ]);
  assert.equal(sky.status, 'ready');
  assert.equal(worker.posted[0].type, 'observer');
  const objects = sky.objectsAt(T0);
  assert.ok(objects.length > 0);
  assert.ok(
    objects.every((o) => o.name && o.elDeg > -2 && o.set !== 'starlink'),
  );
  const iss = sky.meta.find((m) => m.noradId === 25544);
  assert.equal(iss.set, 'core');
  assert.equal(
    sky.stats.age.total,
    sky.meta.filter((m) => m.set !== 'starlink').length,
  );
  assert.ok(sky.stats.durationMs >= 0);
});

test('backlog never exceeds one tick: busy timer ticks are skipped, a forced tick waits', async () => {
  const { worker, timers, sky, setTime } = setup({ auto: false });
  sky.start(OBS);
  assert.equal(worker.ticks().length, 1);
  assert.equal(sky.pending, true);
  for (let i = 0; i < 3; i++) {
    setTime(T0 + (i + 1) * 1000);
    timers.fire();
  }
  assert.equal(worker.ticks().length, 1, 'still one in flight');
  assert.equal(sky.stats.skipped, 3);
  sky.timeChanged(); // forced while busy: remembered
  assert.equal(worker.ticks().length, 1);
  worker.deliver();
  assert.equal(worker.ticks().length, 2, 'forced tick sent on reply');
  assert.ok(sky.stats.maxBacklog <= 1);
  worker.deliver();
  assert.equal(sky.pending, false);
  // a fixed clock that did not move does not tick again
  timers.fire();
  assert.equal(worker.ticks().length, 2);
});

test('Starlink: off by default; on uses the rows already in `active`; without active it fetches the starlink group', async () => {
  const a = setup();
  a.sky.start(OBS);
  await pump(a.worker);
  a.sky.setSets({ starlink: true });
  await pump(a.worker);
  assert.ok(!a.fetched.includes('starlink'));
  const lastTick = a.worker.ticks().at(-1);
  assert.ok(lastTick.sets.includes('starlink'));

  const b = setup({ activeOn: false });
  b.sky.start(OBS);
  await pump(b.worker);
  assert.ok(!b.fetched.includes('active'));
  b.sky.setSets({ starlink: true });
  await pump(b.worker);
  assert.ok(b.fetched.includes('starlink'));

  const c = setup({ starlinkOn: true, fail: ['active'] });
  c.sky.start(OBS);
  await pump(c.worker);
  assert.equal(c.sky.loads.get('active'), 'error');
  assert.ok(c.fetched.includes('starlink'), 'falls back to the starlink group');
  assert.match(c.sky.lastError, /active: HTTP 503/);
});

test('a time jump keeps the old objects until the new tick answers (no blank sky)', async () => {
  const { worker, sky, setTime } = setup({ auto: false });
  sky.start(OBS);
  for (let i = 0; i < 4; i++) {
    await settle();
    worker.deliver();
  }
  await pump(worker);
  const before = sky.objectsAt(T0).length;
  assert.ok(before > 0);
  setTime(T0 + 6 * 3600_000);
  sky.timeChanged();
  assert.equal(sky.objectsAt(T0 + 6 * 3600_000).length, before, 'still drawn');
  worker.deliver();
  assert.equal(sky.stats.timeMs, T0 + 6 * 3600_000);
});

test('switching a set off removes its objects at once', async () => {
  const { worker, sky } = setup({ starlinkOn: true });
  sky.start(OBS);
  await pump(worker);
  const before = sky.objectsAt(T0).length;
  sky.setSets({ active: false, starlink: false });
  const after = sky.objectsAt(T0);
  assert.ok(after.every((o) => o.set === 'core'));
  assert.ok(after.length < before);
});

test('stop terminates the worker and forgets everything; late replies are ignored', async () => {
  const { worker, sky } = setup({ auto: false });
  sky.start(OBS);
  sky.stop();
  assert.equal(worker.terminated, true);
  assert.equal(sky.running, false);
  worker.deliver();
  assert.deepEqual(sky.meta, []);
  assert.deepEqual(sky.objectsAt(T0), []);
  assert.equal(sky.status, 'idle');
});

test('no Worker in this browser: status unavailable, nothing fetched', () => {
  const fetched = [];
  const sky = createSatSky({
    createWorker: () => null,
    fetchText: async (p) => fetched.push(p),
    timers: fakeTimers(),
  });
  assert.equal(sky.start(OBS), false);
  assert.equal(sky.status, 'unavailable');
  assert.deepEqual(fetched, []);
});

test('extrapolation: linear from the two newest samples, wraps azimuth, capped', () => {
  const prev = { timeMs: 0, azDeg: 359, elDeg: 10 };
  const cur = { timeMs: 2000, azDeg: 1, elDeg: 12 };
  assert.deepEqual(extrapolateAzEl(prev, cur, 3000), { azDeg: 2, elDeg: 13 });
  assert.deepEqual(extrapolateAzEl(null, cur, 3000), { azDeg: 1, elDeg: 12 });
  assert.deepEqual(
    extrapolateAzEl(prev, cur, 1000),
    { azDeg: 1, elDeg: 12 },
    'never backwards',
  );
  const far = extrapolateAzEl(prev, cur, 2000 + 10 * MAX_EXTRAPOLATE_MS);
  assert.ok(far.elDeg <= 12 + MAX_EXTRAPOLATE_MS / 1000 + 1e-9);
  const zenith = extrapolateAzEl(
    { timeMs: 0, azDeg: 0, elDeg: 89 },
    { timeMs: 1000, azDeg: 90, elDeg: 89.5 },
    2000,
  );
  assert.equal(zenith.azDeg, 100, 'azimuth step capped at 10 deg');
  assert.deepEqual(
    extrapolateAzEl(
      { timeMs: 0, azDeg: 0, elDeg: 0 },
      { timeMs: 60_000, azDeg: 50, elDeg: 5 },
      61_000,
    ),
    { azDeg: 50, elDeg: 5 },
    'samples too far apart',
  );
});

test('unpackRecords splits a packed tick by set', () => {
  const rec = new Float32Array(2 * RECORD_FIELDS);
  rec.set([3, 10, 20, 500, -1.5, packFlags({ setId: 0, state: 1 })], 0);
  rec.set(
    [9, 30, 40, 900, 2.5, packFlags({ setId: 2, state: 3 })],
    RECORD_FIELDS,
  );
  const bySet = unpackRecords(rec, 1234);
  assert.deepEqual([...bySet.keys()].sort(), ['core', 'starlink']);
  assert.equal(bySet.get('core').get(3).azDeg, 10);
  assert.equal(bySet.get('starlink').get(9).stateName, 'shadow');
  assert.equal(bySet.get('starlink').get(9).timeMs, 1234);
});

test('RCS fetched once and sent to the worker; passes requested after the catalogue and filled progressively', async () => {
  let rcsCalls = 0;
  const { worker, sky } = setup({
    fetchRcs: async () => {
      rcsCalls += 1;
      return { rcs: { 25544: 399.0524 }, withRcs: 1, fetchedAt: 1 };
    },
  });
  sky.start(OBS);
  await pump(worker);
  assert.equal(rcsCalls, 1);
  assert.equal(sky.rcs.status, 'ready');
  assert.equal(sky.rcs.matched, 1);
  assert.ok(worker.posted.some((m) => m.type === 'rcs'));
  assert.ok(worker.posted.some((m) => m.type === 'passes' && m.timeMs === T0));
  for (let i = 0; i < 400 && !sky.passes.done; i++) {
    await new Promise((r) => setTimeout(r, 2));
    worker.deliver();
  }
  assert.equal(sky.passes.done, true);
  assert.ok(sky.passes.list.some((p) => p.noradId === 25544));
  assert.equal(sky.passes.fromMs, T0);
  const next = sky.nextPass(25544, T0);
  assert.ok(next && next.setMs > T0);
  assert.equal(sky.arcFor(next), null, 'requested');
  assert.equal(sky.arcFor(next), null, 'only once');
  assert.equal(worker.posted.filter((m) => m.type === 'passArc').length, 1);
  await pump(worker);
  assert.ok(sky.arcFor(next).length > 3);
  sky.stop();
  assert.equal(sky.passes.list.length, 0);
  assert.equal(sky.rcs.status, 'idle');
});

test('RCS failure only drops the estimates (status error), satellites still load', async () => {
  const { worker, sky } = setup({
    fetchRcs: async () => {
      throw new Error('HTTP 503');
    },
  });
  sky.start(OBS);
  await pump(worker);
  assert.equal(sky.rcs.status, 'error');
  assert.equal(sky.status, 'ready');
  assert.ok(sky.objectsAt(T0).every((o) => o.estMag == null));
  assert.ok(!worker.posted.some((m) => m.type === 'rcs'));
});

/**
 * The real worker handler with its pass scan driven slice by slice (one
 * object per slice), so a test decides how fast the scan runs against how
 * fast Sky time moves. Ticks and the other messages answer at once.
 */
class SlicedWorker extends EventTarget {
  constructor() {
    super();
    this.slices = [];
    this.posted = [];
    this.passMsgs = [];
    let clock = 0;
    this.handle = createSatWorkerHandler(
      (message) => {
        if (message.type === 'passes') this.passMsgs.push(message);
        queueMicrotask(() =>
          this.dispatchEvent(
            Object.assign(new Event('message'), { data: message }),
          ),
        );
      },
      {
        schedule: (fn) => this.slices.push(fn),
        clock: () => (clock += 10), // every object "takes" 10 ms
        sliceMs: 1,
      },
    );
  }
  postMessage(message) {
    this.posted.push(message);
    this.handle(message);
  }
  /** Run up to `n` scan slices (each one object). */
  runSlices(n = 1) {
    for (let i = 0; i < n && this.slices.length; i++) this.slices.shift()();
  }
  terminate() {}
  scansStarted() {
    return [...new Set(this.passMsgs.map((m) => m.scanId))];
  }
}

test('x reverse play: a running pass scan is never restarted by playback ticks; every scan completes, reverse windows keep 24 h, pause and direction change recover coverage', async () => {
  // 40 stations-group objects: the scan takes many slices (progressive)
  const stations = tle(...ENTRIES.slice(0, 40), ISS_ROW);
  const worker = new SlicedWorker();
  const timers = fakeTimers();
  let time = T0;
  const sky = createSatSky({
    createWorker: () => worker,
    fetchText: async (path) => (path === 'stations' ? stations : ''),
    fetchRcs: async () => ({ rcs: { 25544: 399.0524 }, withRcs: 1 }),
    timers,
    getTime: () => time,
  });
  const flush = async () => {
    for (let i = 0; i < 4; i++) await settle();
  };
  const drain = async () => {
    for (let i = 0; i < 10_000 && worker.slices.length; i++) {
      worker.runSlices(1);
      await flush();
    }
    await flush();
  };
  // the panel/handle never show a partial or uncovered list as complete
  const checkHonest = () => {
    const state = sky.passes;
    if (state.done) assert.equal(state.processed, state.total);
    const view = passesView(state, time);
    if (/\(\d+\)/.test(view.title)) {
      assert.equal(state.done, true, 'count only on a finished scan');
      assert.equal(passCoverage(state.fromMs, time), 'ok');
    }
    if (passCoverage(state.fromMs, time) === 'gap') {
      assert.equal(view.rows.length, 0, 'no rows before the window');
      assert.equal(sky.nextPass(25544, time), null);
    }
  };
  const completed = () =>
    new Set(worker.passMsgs.filter((m) => m.done).map((m) => m.scanId));

  sky.start(OBS);
  await flush();
  await drain();
  assert.equal(sky.passes.done, true, 'baseline scan completes');
  assert.equal(sky.passes.fromMs, T0);
  const total = sky.passes.total;
  assert.ok(total >= 10, `progressive scan over ${total} objects`);
  assert.ok(
    worker.passMsgs.filter((m) => m.scanId === sky.passes.scanId && !m.done)
      .length >= 5,
    'scan arrives in several progressive messages',
  );
  const baselineScans = worker.scansStarted().length;

  // REVERSE at -3600 (900 s of Sky time per 250 ms tick) with a scan SLOWER
  // than playback: one object per 4 ticks, i.e. far more than the 24 h of
  // reverse coverage per scan. The old code restarted the scan on every
  // tick out of the window and never finished one.
  for (let i = 1; i <= 320; i++) {
    time -= 900_000;
    timers.fire();
    await flush();
    if (i % 4 === 0) {
      worker.runSlices(1);
      await flush();
    }
    checkHonest();
  }
  const newScans = worker.scansStarted().slice(baselineScans);
  assert.ok(newScans.length >= 2, 'reverse play rescans as it leaves windows');
  // 320 ticks with one rescan per tick would be ~300 scans; each scan of
  // `total` objects needs 4*total ticks here, so at most 320/(4*total)+1
  assert.ok(
    newScans.length <= Math.ceil(320 / (4 * total)) + 1,
    `no restart storm: ${newScans.length} scans for 320 reverse ticks`,
  );
  const done = completed();
  for (const id of newScans.slice(0, -1))
    assert.ok(done.has(id), `scan ${id} ran to completion, not cancelled`);
  for (const m of worker.passMsgs.filter((x) => newScans.includes(x.scanId)))
    assert.ok(m.fromMs < T0, 'reverse scans start before the anchor');
  // a reverse-anchored scan covers 24 h BEFORE its request time
  const reverseReqs = worker.posted.filter(
    (m) => m.type === 'passes' && m.backward,
  );
  assert.ok(reverseReqs.length >= 1 && reverseReqs.every((m) => m.defer));

  // PAUSE: the list
  // recovers full coverage at the paused time.
  sky.timeChanged();
  await flush();
  await drain();
  checkHonest();
  let state = sky.passes;
  assert.equal(state.done, true, 'complete after pause');
  assert.equal(state.processed, state.total);
  assert.equal(passCoverage(state.fromMs, time), 'ok', 'paused time covered');
  const pausedAt = time;
  const iss = sky.nextPass(25544, pausedAt, { visibleOnly: false });
  assert.ok(iss && iss.setMs > pausedAt, 'next ISS pass known after pause');
  // same answer as a fresh forward scan at the paused time (within the 5 s
  // fine step: different coarse grids)
  const fresh = new SlicedWorker();
  const sky2 = createSatSky({
    createWorker: () => fresh,
    fetchText: async (path) => (path === 'stations' ? stations : ''),
    fetchRcs: async () => ({ rcs: { 25544: 399.0524 }, withRcs: 1 }),
    timers: fakeTimers(),
    getTime: () => pausedAt,
  });
  sky2.start(OBS);
  for (let i = 0; i < 4; i++) await settle();
  for (let i = 0; i < 10_000 && fresh.slices.length; i++) {
    fresh.runSlices(1);
    for (let j = 0; j < 4; j++) await settle();
  }
  for (let j = 0; j < 4; j++) await settle();
  assert.equal(sky2.passes.done, true);
  const ref = sky2.nextPass(25544, pausedAt, { visibleOnly: false });
  assert.ok(ref);
  assert.ok(Math.abs(ref.riseMs - iss.riseMs) <= 10_000, 'same next ISS pass');
  sky2.stop();

  // DIRECTION CHANGE: forward again past the window; scans still complete
  const forwardStart = worker.scansStarted().length;
  for (let i = 1; i <= 240; i++) {
    time += 900_000;
    timers.fire();
    await flush();
    if (i % 4 === 0) {
      worker.runSlices(1);
      await flush();
    }
    checkHonest();
  }
  await drain();
  // the last playback tick before the drain may still be out of the window:
  // one more tick re-requests, then the list covers the time
  timers.fire();
  await flush();
  await drain();
  checkHonest();
  const fwdScans = worker.scansStarted().slice(forwardStart);
  assert.ok(fwdScans.length >= 1, 'forward play rescans');
  const done2 = completed();
  for (const id of fwdScans) assert.ok(done2.has(id), `scan ${id} completed`);
  state = sky.passes;
  assert.equal(state.done, true);
  assert.equal(passCoverage(state.fromMs, time), 'ok');
  assert.ok(state.fromMs <= time && time - state.fromMs <= RESCAN_AFTER_MS);
  sky.stop();
});
