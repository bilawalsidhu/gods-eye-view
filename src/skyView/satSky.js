/**
 * Sky view satellites, main-thread side: owns the
 * module worker, feeds it the TLE groups from the existing same-origin
 * /api/celestrak/<group> endpoints (no new third-party calls; the server
 * proxy's cache applies as for the satellites layer), runs the
 * tick policy, and turns packed tick results into drawable objects with
 * az/el extrapolated between ticks.
 *
 * also takes the SATCAT radar cross-sections from an injected
 * `fetchRcs` (brightness estimates; the host serves none yet, so brightness
 * is omitted and the naked-eye filter falls back to classes), and drives the
 * worker's "Next passes" scan (progressive
 * results, cached in the worker; re-requested on a new catalogue, a time
 * jump or when Sky time leaves the scanned window).
 *
 * Backlog rule: at most ONE tick is in flight; a timer tick that finds the
 * worker busy is skipped and counted (stats.skipped), a forced tick (time
 * jump, observer move, switch) is remembered and sent as soon as the worker
 * answers.
 */
import {
  ACTIVE_PATH,
  RECORD_FIELDS,
  SKY_CORE_GROUPS,
  STARLINK_PATH,
  decodeFlags,
  planTick,
} from './satCore.js';
import { nextPassOf, passCoverage, RESCAN_AFTER_MS } from './passes.js';
import { normalizeAz } from './skyMath.js';

export const TICK_MS = 1000;
/** Do not extrapolate from two frames further apart than this (sky time). */
export const MAX_RATE_BASE_MS = 15_000;
/** Never extrapolate further than this past the newest frame (sky time). */
export const MAX_EXTRAPOLATE_MS = 15_000;
/** Cap on the azimuth an extrapolation may add (near the zenith az races). */
const MAX_AZ_STEP_DEG = 10;

function defaultCreateWorker() {
  if (typeof Worker !== 'function') return null;
  // Keep this the literal `new Worker(new URL(...), { type: 'module' })`
  // pattern: Vite only bundles a worker (and its imports) when it sees it.
  return new Worker(new URL('./satWorker.js', import.meta.url), {
    type: 'module',
    name: 'gev-sky-satellites',
  });
}

/** TLE text of a group from the same-origin CelesTrak proxy. */
export async function fetchCelestrakText(path) {
  const response = await globalThis.fetch(`/api/celestrak/${path}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/**
 * Linear az/el extrapolation from the two newest samples of one object.
 * Pure. `prev` may be null (then the newest sample is returned unchanged).
 */
export function extrapolateAzEl(prev, cur, timeMs) {
  const base = { azDeg: cur.azDeg, elDeg: cur.elDeg };
  if (!prev) return base;
  // dt < 0 when the Sky clock plays backwards: extrapolate in the direction
  // the clock moves, never back towards (or past) the older sample
  const dt = cur.timeMs - prev.timeMs;
  if (!dt || Math.abs(dt) > MAX_RATE_BASE_MS) return base;
  const ahead = (timeMs - cur.timeMs) * Math.sign(dt);
  const h = Math.min(Math.max(ahead, 0), MAX_EXTRAPOLATE_MS) * Math.sign(dt);
  if (!h) return base;
  let dAz = cur.azDeg - prev.azDeg;
  if (dAz > 180) dAz -= 360;
  if (dAz < -180) dAz += 360;
  const stepAz = Math.max(
    -MAX_AZ_STEP_DEG,
    Math.min(MAX_AZ_STEP_DEG, (dAz / dt) * h),
  );
  return {
    azDeg: normalizeAz(cur.azDeg + stepAz),
    elDeg: cur.elDeg + ((cur.elDeg - prev.elDeg) / dt) * h,
  };
}

/** Split a packed tick into one Map(index -> row) per set. */
export function unpackRecords(records, timeMs) {
  const bySet = new Map();
  for (let o = 0; o + RECORD_FIELDS <= records.length; o += RECORD_FIELDS) {
    const flags = decodeFlags(records[o + 5]);
    let rows = bySet.get(flags.set);
    if (!rows) bySet.set(flags.set, (rows = new Map()));
    rows.set(records[o], {
      index: records[o],
      timeMs,
      azDeg: records[o + 1],
      elDeg: records[o + 2],
      rangeKm: records[o + 3],
      rangeRateKmS: records[o + 4],
      estMag: Number.isFinite(records[o + 6]) ? records[o + 6] : null,
      ...flags,
    });
  }
  return bySet;
}

export function createSatSky({
  createWorker = defaultCreateWorker,
  fetchText = fetchCelestrakText,
  fetchRcs = null,
  timers = globalThis,
  getTime = () => Date.now(),
  onChange = () => {},
  activeOn = true,
  starlinkOn = false,
  tickMs = TICK_MS,
} = {}) {
  let worker = null;
  let removeListener = null;
  let observer = null;
  let meta = [];
  let catalogVersion = 0;
  const loads = new Map();
  /** set -> { cur: Map, prev: Map|null, timeMs } */
  const frames = new Map();
  let pendingSeq = null;
  let wantForce = false;
  let seq = 0;
  let tickNo = 0;
  let lastStarlinkMs = null;
  let timer = null;
  let status = 'idle';
  let lastError = null;
  const stats = {
    ticks: 0,
    skipped: 0,
    maxBacklog: 0,
    durationMs: null,
    computed: 0,
    culled: 0,
    count: 0,
    sunAltDeg: null,
    dark: false,
    age: null,
    timeMs: null,
  };
  const sets = { active: activeOn, starlink: starlinkOn };
  // brightness (SATCAT RCS) and passes
  let rcs = { status: 'idle', withRcs: 0, matched: 0, fetchedAt: null };
  let passes = emptyPasses();
  let lastPassRequestMs = null;
  const arcs = new Map(); // `${noradId}@${riseMs}` -> arc rows | 'loading'
  let arcSeq = 0;
  function emptyPasses() {
    return {
      scanId: null,
      fromMs: null,
      done: false,
      processed: 0,
      total: 0,
      prefiltered: 0,
      list: [],
    };
  }
  const enabledSets = () =>
    ['core', 'active', 'starlink'].filter((s) => s === 'core' || sets[s]);

  const notify = (what) => {
    try {
      onChange(what);
    } catch {
      /* a broken listener must not stop the worker loop */
    }
  };

  function load(path) {
    if (!worker || loads.has(path)) return;
    loads.set(path, 'loading');
    const target = worker;
    Promise.resolve()
      .then(() => fetchText(path))
      .then((text) => {
        if (worker !== target) return;
        target.postMessage({ type: 'tle', path, text });
        loads.set(path, 'ready');
      })
      .catch((error) => {
        if (worker !== target) return;
        loads.set(path, 'error');
        lastError = `${path}: ${error?.message || error}`;
        notify('load-error');
        // Starlink rides in `active`; without it, fetch the Starlink group.
        if (path === ACTIVE_PATH) ensureData();
      });
  }

  function loadRcs() {
    if (!worker || rcs.status === 'loading' || rcs.status === 'ready') return;
    if (typeof fetchRcs !== 'function') {
      // No RCS source: no estimates; the naked-eye filter falls back to classes.
      if (rcs.status !== 'error') {
        rcs = { ...rcs, status: 'error' };
        notify('rcs');
      }
      return;
    }
    rcs = { ...rcs, status: 'loading' };
    const target = worker;
    Promise.resolve()
      .then(() => fetchRcs())
      .then((body) => {
        if (worker !== target) return;
        target.postMessage({ type: 'rcs', rcs: body.rcs });
        rcs = {
          ...rcs,
          status: 'ready',
          withRcs: Number(body.withRcs) || Object.keys(body.rcs).length,
          fetchedAt: body.fetchedAt ?? null,
        };
      })
      .catch(() => {
        if (worker !== target) return;
        // No RCS: no estimates; the naked-eye filter falls back to classes.
        rcs = { ...rcs, status: 'error' };
        notify('rcs');
      });
  }

  /**
   * Ask the worker for the "Next passes" scan at Sky time. `defer` (playback
   * ticks) lets a running scan finish instead of being replaced; `backward`
   * (Sky time ran back out of the window) anchors the new window 24 h
   * earlier so reverse play keeps one scan for 24 h of Sky time.
   */
  function requestPasses(
    force = false,
    { defer = false, backward = false } = {},
  ) {
    if (!worker || !observer || status !== 'ready') return false;
    const timeMs = getTime();
    if (
      !force &&
      lastPassRequestMs != null &&
      Math.abs(timeMs - lastPassRequestMs) < 60_000
    )
      return false;
    lastPassRequestMs = timeMs;
    const message = { type: 'passes', timeMs };
    if (defer) message.defer = true;
    if (backward) message.backward = true;
    worker.postMessage(message);
    return true;
  }

  /** Sky time left the scanned window: ask again (the worker decides). */
  function passesStale(timeMs) {
    if (passes.fromMs == null) return false;
    return timeMs < passes.fromMs || timeMs > passes.fromMs + RESCAN_AFTER_MS;
  }

  function acceptPasses(msg) {
    if (msg.scanId !== passes.scanId) {
      passes = { ...emptyPasses(), scanId: msg.scanId, fromMs: msg.fromMs };
      arcs.clear();
    }
    passes.processed = msg.processed;
    passes.total = msg.total;
    passes.prefiltered = msg.prefiltered;
    passes.done = Boolean(msg.done);
    if (msg.done && Array.isArray(msg.passes)) passes.list = msg.passes;
    else if (Array.isArray(msg.added) && msg.added.length)
      passes.list = [...passes.list, ...msg.added];
    notify('passes');
  }

  function ensureData() {
    for (const group of SKY_CORE_GROUPS) load(group.path);
    if (sets.active) load(ACTIVE_PATH);
    if (sets.starlink && (!sets.active || loads.get(ACTIVE_PATH) === 'error'))
      load(STARLINK_PATH);
  }

  function onMessage(event) {
    const msg = event?.data ?? event;
    if (!msg || !worker) return;
    if (msg.type === 'catalog') {
      meta = msg.meta || [];
      catalogVersion = msg.version;
      status = 'ready';
      notify('catalog');
      requestTick(true);
      requestPasses(true);
    } else if (msg.type === 'rcs') {
      meta = msg.meta || meta;
      rcs = { ...rcs, matched: msg.matched ?? 0 };
      notify('rcs');
      requestTick(true);
      requestPasses(true);
    } else if (msg.type === 'passes') {
      acceptPasses(msg);
    } else if (msg.type === 'passArc') {
      const key = `${msg.noradId}@${msg.riseMs}`;
      if (arcs.get(key) === 'loading') {
        arcs.set(key, msg.arc || []);
        notify('arc');
      }
    } else if (msg.type === 'tick') {
      if (msg.seq !== pendingSeq) return;
      pendingSeq = null;
      acceptTick(msg);
      if (wantForce) requestTick(true);
    } else if (msg.type === 'error') {
      lastError = msg.message;
      if (msg.request === 'tick' && msg.seq === pendingSeq) pendingSeq = null;
      if (msg.request === 'passes') lastPassRequestMs = null;
      notify('worker-error');
    }
  }

  function acceptTick(msg) {
    const bySet = unpackRecords(msg.records, msg.timeMs);
    for (const set of msg.sets) {
      const rows = bySet.get(set) || new Map();
      const old = frames.get(set);
      const keepPrev =
        old &&
        msg.timeMs !== old.timeMs &&
        Math.abs(msg.timeMs - old.timeMs) <= MAX_RATE_BASE_MS;
      frames.set(set, {
        cur: rows,
        prev: keepPrev ? old.cur : null,
        timeMs: msg.timeMs,
      });
      if (set === 'starlink') lastStarlinkMs = msg.timeMs;
    }
    for (const set of [...frames.keys()])
      if (!enabledSets().includes(set)) frames.delete(set);
    Object.assign(stats, {
      ticks: stats.ticks + 1,
      durationMs: msg.durationMs,
      computed: msg.computed,
      culled: msg.culled,
      count: msg.count,
      sunAltDeg: msg.sunAltDeg,
      dark: msg.dark,
      age: msg.age,
      timeMs: msg.timeMs,
    });
    notify('tick');
    if (passesStale(msg.timeMs))
      requestPasses(false, {
        defer: true,
        backward: msg.timeMs < passes.fromMs,
      });
  }

  function requestTick(force = false) {
    if (!worker || !observer) return false;
    if (pendingSeq != null) {
      if (force) wantForce = true;
      else {
        stats.skipped += 1;
        stats.maxBacklog = Math.max(stats.maxBacklog, 1);
      }
      return false;
    }
    wantForce = false;
    const timeMs = getTime();
    if (!force && timeMs === stats.timeMs) return false; // fixed time: nothing moved
    const plan = planTick({
      tickNo,
      timeMs,
      activeOn: sets.active,
      starlinkOn: sets.starlink,
      lastStarlinkMs,
      force,
    });
    tickNo += 1;
    pendingSeq = ++seq;
    worker.postMessage({
      type: 'tick',
      seq: pendingSeq,
      timeMs,
      sets: plan,
      ageSets: enabledSets(),
    });
    return true;
  }

  function startTimer() {
    stopTimer();
    timer = timers.setInterval?.(() => requestTick(false), tickMs) ?? null;
  }
  function stopTimer() {
    if (timer != null) timers.clearInterval?.(timer);
    timer = null;
  }

  function resetFrames() {
    frames.clear();
    lastStarlinkMs = null;
  }

  const api = {
    get status() {
      return status;
    },
    get lastError() {
      return lastError;
    },
    get meta() {
      return meta;
    },
    get catalogVersion() {
      return catalogVersion;
    },
    get loads() {
      return new Map(loads);
    },
    get stats() {
      return { ...stats };
    },
    get sets() {
      return { core: true, ...sets };
    },
    get running() {
      return Boolean(worker);
    },
    get pending() {
      return pendingSeq != null;
    },
    /** Start (or move) at an observer. Returns false when no worker exists. */
    start(next) {
      observer = next;
      if (!worker) {
        try {
          worker = createWorker();
        } catch (error) {
          worker = null;
          lastError = String(error?.message || error);
        }
        if (!worker) {
          status = 'unavailable';
          notify('status');
          return false;
        }
        status = 'loading';
        const handler = (event) => onMessage(event);
        worker.addEventListener?.('message', handler);
        removeListener = () =>
          worker?.removeEventListener?.('message', handler);
      }
      resetFrames();
      worker.postMessage({
        type: 'observer',
        latDeg: observer.latDeg,
        lonDeg: observer.lonDeg,
      });
      passes = emptyPasses();
      arcs.clear();
      lastPassRequestMs = null;
      ensureData();
      loadRcs();
      startTimer();
      requestTick(true);
      requestPasses(true);
      notify('status');
      return true;
    },
    /** Leave the sky: terminate the worker and drop everything it held. */
    stop() {
      stopTimer();
      removeListener?.();
      removeListener = null;
      worker?.terminate?.();
      worker = null;
      observer = null;
      meta = [];
      loads.clear();
      resetFrames();
      pendingSeq = null;
      wantForce = false;
      status = 'idle';
      rcs = { status: 'idle', withRcs: 0, matched: 0, fetchedAt: null };
      passes = emptyPasses();
      arcs.clear();
      lastPassRequestMs = null;
    },
    /**
     * The Sky clock jumped (picked time, back to live): recompute now. The old
     * frames stay until the answer arrives (no blank sky for a tick); a frame
     * more than MAX_RATE_BASE_MS away is never used as an extrapolation base.
     */
    timeChanged() {
      requestTick(true);
      if (passesStale(getTime())) requestPasses(true);
    },
    setSets(next = {}) {
      if ('active' in next) sets.active = Boolean(next.active);
      if ('starlink' in next) sets.starlink = Boolean(next.starlink);
      ensureData();
      for (const set of [...frames.keys()])
        if (!enabledSets().includes(set)) frames.delete(set);
      requestTick(true);
      notify('sets');
    },
    requestTick,
    get tickMs() {
      return tickMs;
    },
    /**
     * Tick period in wall ms (faster while the Sky clock plays, so the
     * extrapolation base stays within MAX_RATE_BASE_MS of sky time).
     */
    setTickMs(ms) {
      const next = Math.max(100, Math.min(TICK_MS, Number(ms) || TICK_MS));
      if (next === tickMs) return;
      tickMs = next;
      if (timer != null) startTimer();
    },
    requestPasses,
    /** SATCAT RCS state: status idle|loading|ready|error, counts. */
    get rcs() {
      return { ...rcs };
    },
    /** "Next passes" scan: { scanId, fromMs, done, processed, total, list }. */
    get passes() {
      return { ...passes, list: passes.list };
    },
    /**
     * Next pass of an object not over at `timeMs` (null if none known). Null
     * too while `timeMs` is before the scanned window (reverse play ahead of
     * the scan): a pass between the two would be missed, so a later one is
     * not "the next".
     */
    nextPass(noradId, timeMs = getTime(), options = {}) {
      if (passCoverage(passes.fromMs, timeMs) === 'gap') return null;
      return nextPassOf(passes.list, Number(noradId), timeMs, options);
    },
    /**
     * Arc rows [[azDeg, elDeg, sunlit, timeMs], ...] for a pass: null while
     * the worker computes it (requested on the first call), [] if unknown.
     */
    arcFor(pass) {
      if (!pass || !worker) return null;
      const key = `${pass.noradId}@${pass.riseMs}`;
      const have = arcs.get(key);
      if (Array.isArray(have)) return have;
      if (have === 'loading') return null;
      arcs.set(key, 'loading');
      worker.postMessage({
        type: 'passArc',
        requestId: ++arcSeq,
        noradId: pass.noradId,
        riseMs: pass.riseMs,
        setMs: pass.setMs,
      });
      return null;
    },
    /** Drawable objects at Sky time `timeMs` (extrapolated between ticks). */
    objectsAt(timeMs) {
      const out = [];
      for (const set of enabledSets()) {
        const frame = frames.get(set);
        if (!frame) continue;
        for (const row of frame.cur.values()) {
          const m = meta[row.index];
          if (!m) continue;
          const p = extrapolateAzEl(frame.prev?.get(row.index), row, timeMs);
          out.push({
            ...row,
            azDeg: p.azDeg,
            elDeg: p.elDeg,
            name: m.name,
            noradId: m.noradId,
            group: m.group,
            klass: row.klass,
            epochMs: m.epochMs,
          });
        }
      }
      return out;
    },
    /** Newest row + meta for one object (null when not above -2 deg now). */
    lookup(index) {
      const m = meta[index];
      if (!m) return null;
      for (const frame of frames.values()) {
        const row = frame.cur.get(index);
        if (row) return { meta: m, row };
      }
      return { meta: m, row: null };
    },
  };
  return api;
}
