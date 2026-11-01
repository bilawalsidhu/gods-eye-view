/**
 * Sky view satellite module worker. Thin message
 * wrapper around satCore.js's engine and passes.js; all maths lives there
 * (and in the reused src/data/satellitePass.js), so node tests drive the same
 * handler directly.
 *
 * Messages in:
 *   { type: 'tle', path, text }                  load one /api/celestrak group
 *   { type: 'rcs', rcs }                        SATCAT { noradId: rcsM2 }
 *   { type: 'observer', latDeg, lonDeg }        set the observer (resets culling)
 *   { type: 'tick', seq, timeMs, sets, ageSets } compute one tick
 *   { type: 'passes', timeMs, backward, defer } 48 h "Next passes" scan
 *     backward: the window starts 24 h before timeMs (reverse play);
 *     defer: playback request, never cancels a running scan of the same
 *     data/observer (the newest one runs when that scan finishes).
 *   { type: 'passArc', requestId, noradId, riseMs, setMs } arc of one pass
 * Messages out:
 *   { type: 'catalog', version, load, meta }    after every 'tle'
 *     (load.warmUp = { calls, durationMs } of the JIT warm-up that ran)
 *   { type: 'rcs', size, matched, meta }
 *   { type: 'observer', ok }
 *   { type: 'tick', seq, timeMs, records, count, sets, sunAltDeg, dark,
 *     computed, culled, dropped, failed, durationMs, age }
 *     `records` is the packed Float32Array (transferred, not copied).
 *   { type: 'passes', scanId, fromMs, observer, done, processed, total,
 *     prefiltered, added, passes, cached }
 *     Progressive: while scanning, `added` holds the rows found since the
 *     last message; the final message (done) carries the merged `passes`.
 *   { type: 'passArc', requestId, noradId, riseMs, arc }
 *   { type: 'error', message, request }
 *
 * The pass scan runs a slice at a time (about `sliceMs` of work, then
 * `schedule()` the next slice), so tick messages are answered between
 * slices and the sky keeps moving while the list fills in.
 */
import { createSatEngine } from './satCore.js';
import {
  createPassScan,
  OBSERVER_MOVE_KM,
  observerDistanceKm,
  packArc,
  passArc,
  passCacheValid,
  passScanStart,
} from './passes.js';

export const PASS_SLICE_MS = 25;

export function createSatWorkerHandler(
  post,
  {
    engine = createSatEngine(),
    schedule = (fn) => globalThis.setTimeout(fn, 0),
    clock = () => globalThis.performance?.now?.() ?? Date.now(),
    sliceMs = PASS_SLICE_MS,
  } = {},
) {
  let scan = null; // { id, key, fromMs, observer, job, done, passes }
  let scanSeq = 0;
  let pending = null; // newest deferred playback request (see startPasses)

  const passKey = () => `${engine.passVersion}:${engine.rcsVersion}`;

  function postPasses(state, extra) {
    post({
      type: 'passes',
      scanId: state.id,
      fromMs: state.fromMs,
      observer: {
        latDeg: state.observer.latDeg,
        lonDeg: state.observer.lonDeg,
      },
      processed: state.job.processed,
      total: state.job.total,
      prefiltered: state.job.prefiltered,
      ...extra,
    });
  }

  function runSlice(state) {
    if (scan !== state) return; // superseded by a newer scan
    const started = clock();
    const added = [];
    while (!state.job.done) {
      added.push(...state.job.step());
      if (clock() - started >= sliceMs) break;
    }
    if (state.job.done) {
      state.done = true;
      state.passes = state.job.passes();
      postPasses(state, { done: true, added, passes: state.passes });
      // A playback request deferred while this scan ran: re-evaluate it now
      // (answered from this cache when still inside, else the next scan).
      if (pending) {
        const next = pending;
        pending = null;
        startPasses({ ...next, defer: false });
      }
    } else {
      postPasses(state, { done: false, added });
      schedule(() => {
        try {
          runSlice(state);
        } catch (error) {
          post({
            type: 'error',
            request: 'passes',
            seq: null,
            message: String(error?.message || error),
          });
        }
      });
    }
  }

  function startPasses(data) {
    const observer = engine.observer;
    if (!observer) throw new Error('no observer');
    const timeMs = Number(data.timeMs);
    if (!Number.isFinite(timeMs)) throw new Error('bad time');
    const key = passKey();
    if (scan && passCacheValid(scan, { key, observer, timeMs })) {
      // Same TLE data and RCS, observer within 50 km, time inside the window:
      // a running scan keeps going (its messages follow), a finished one
      // answers from the cache. An older deferred request is now moot.
      pending = null;
      if (scan.done)
        postPasses(scan, {
          done: true,
          cached: true,
          added: [],
          passes: scan.passes,
        });
      return;
    }
    if (
      data.defer &&
      scan &&
      !scan.done &&
      scan.key === key &&
      observerDistanceKm(scan.observer, observer) <= OBSERVER_MOVE_KM
    ) {
      // Playback moved Sky time out of a scan that is still running, with
      // the same data and observer. Restarting on every tick would cancel
      // each scan before it finishes (reverse play starved the list), so
      // the running scan completes and only the NEWEST such request runs
      // after it. Data/observer changes and jumps (no `defer`) still
      // replace the scan at once.
      pending = { ...data };
      return;
    }
    pending = null;
    const fromMs = passScanStart(timeMs, { backward: Boolean(data.backward) });
    const state = {
      id: ++scanSeq,
      key,
      fromMs,
      observer,
      done: false,
      passes: null,
      job: createPassScan({
        entries: engine.entries,
        observer,
        fromMs,
      }),
    };
    scan = state;
    runSlice(state);
  }

  function arcFor(data) {
    const entry = engine.byNorad(data.noradId);
    const observer = engine.observer;
    const riseMs = Number(data.riseMs);
    const setMs = Number(data.setMs);
    const ok =
      entry &&
      observer &&
      Number.isFinite(riseMs) &&
      Number.isFinite(setMs) &&
      setMs >= riseMs &&
      setMs - riseMs <= 6 * 3600_000;
    post({
      type: 'passArc',
      requestId: data.requestId ?? null,
      noradId: Number(data.noradId),
      riseMs,
      arc: ok ? packArc(passArc(entry, observer, riseMs, setMs)) : [],
    });
  }

  return function handle(data) {
    const type = data?.type;
    try {
      if (type === 'tle') {
        const load = engine.loadGroup(String(data.path || ''), data.text);
        // Compile the tick's code on the new entries now, not inside the
        // first 1 Hz tick (satCore warmUp; reported, not hidden).
        load.warmUp = engine.warmUp();
        post({
          type: 'catalog',
          version: engine.version,
          load,
          meta: engine.meta(),
        });
      } else if (type === 'rcs') {
        const result = engine.setRcs(data.rcs);
        post({ type: 'rcs', ...result, meta: engine.meta() });
      } else if (type === 'observer') {
        post({
          type: 'observer',
          ok: engine.setObserver(data.latDeg, data.lonDeg),
        });
      } else if (type === 'tick') {
        const result = engine.tick({
          timeMs: data.timeMs,
          sets: Array.isArray(data.sets) ? data.sets : undefined,
          cull: data.cull !== false,
        });
        const age = engine.ageSummary(
          data.timeMs,
          Array.isArray(data.ageSets) ? data.ageSets : result.sets,
        );
        post({ type: 'tick', seq: data.seq ?? null, ...result, age }, [
          result.records.buffer,
        ]);
      } else if (type === 'passes') {
        startPasses(data);
      } else if (type === 'passArc') {
        arcFor(data);
      }
    } catch (error) {
      post({
        type: 'error',
        request: type ?? null,
        seq: data?.seq ?? null,
        message: String(error?.message || error),
      });
    }
  };
}

// Inside a real worker only (node tests import the handler above).
const scope = globalThis;
if (
  typeof scope.WorkerGlobalScope !== 'undefined' &&
  scope instanceof scope.WorkerGlobalScope
) {
  const handle = createSatWorkerHandler((message, transfer) =>
    scope.postMessage(message, transfer || []),
  );
  scope.addEventListener('message', (event) => handle(event.data));
}
