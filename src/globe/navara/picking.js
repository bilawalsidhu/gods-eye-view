// Picks on Navara. A click is answered by Navara's own GPU pick of the same
// gesture (`featureClick`, a frame or two after the click, null over empty
// space): its batch id resolves to the mover set and instance (pickIds.js).
// Lines are not in the GPU pick, so an empty GPU answer still checks them
// on the CPU; no answer within the timeout falls back to the CPU pick.
// Hover (move with pick), drill and the synchronous picker.pick are CPU
// picks (src/globe/cpuPicks.js). No three.

import { createCpuPicker } from '../cpuPicks.js';

export { distanceToSegment } from '../cpuPicks.js';

const CLICK_TIMEOUT_MS = 250;
// A GPU answer this recent belongs to the click being delivered.
const EARLY_ANSWER_MS = 100;

/**
 * @param {{
 *   view: { on: Function, off: Function },
 *   projector: { worldToWindow: Function, horizonVisible: Function },
 *   camera: { livePosition: object },
 *   movers: () => { options: object, store: object }[],
 *   lines: () => { options: object, flat: Float64Array, modelMatrix: number[] | null }[],
 *   resolveBatch: (batchId: number) => ({ set: string, instance: number, pickId: any } | null),
 *   setTimeout?: Function, clearTimeout?: Function, timeoutMs?: number,
 * }} ports
 */
export function createNavaraPicking({
  view,
  projector,
  camera,
  movers,
  lines,
  resolveBatch,
  setTimeout: later = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout,
  timeoutMs = CLICK_TIMEOUT_MS,
  now = () => performance.now(),
}) {
  const drillPick = createCpuPicker({ projector, camera, movers, lines });

  // Clicks waiting for Navara's GPU answer, oldest first.
  const waiting = [];
  // Diagnostics: how clicks were answered and how long it took (ms).
  const stats = { gpu: 0, timeout: 0, stale: 0, latencies: [] };
  const answered = (entry, how) => {
    stats[how]++;
    stats.latencies.push(now() - entry.startedAt);
    if (stats.latencies.length > 200) stats.latencies.shift();
  };
  // Navara 0.2.1 answers clicks in quick succession (within a frame or so)
  // with the first click's pick: a GPU answer whose instance is not drawn
  // near the click is stale, and the CPU pick answers instead.
  const answerFrom = (info, at) => {
    const hit = info ? resolveBatch(info.batchId) : null;
    if (hit && !drillPick.near(hit.set, hit.instance, at)) {
      stats.stale++;
      return drillPick(at, 1)[0];
    }
    return hit
      ? { id: hit.pickId, owner: hit.set, instance: hit.instance }
      : drillPick(at, 1, { includeMovers: false })[0];
  };
  // Navara's pick helper listens to the same pointerup and, registered
  // first, usually answers before the engine's click: that answer waits
  // here, for the click of the same gesture.
  let early = null;
  const onFeatureClick = (info) => {
    const next = waiting.shift();
    if (!next) {
      early = { info, at: now() };
      return;
    }
    cancel(next.timer);
    answered(next, 'gpu');
    next.resolve(answerFrom(info, next.at));
  };
  view.on('featureClick', onFeatureClick);

  return {
    pick: (at) => drillPick(at, 1)[0],
    drillPick: (at, limit) => drillPick(at, limit ?? Infinity),
    /** The answer for a click at `at`: the GPU pick of its gesture. */
    clickPick(at) {
      const gesture = early;
      early = null;
      if (gesture && now() - gesture.at <= EARLY_ANSWER_MS) {
        const entry = { startedAt: gesture.at };
        answered(entry, 'gpu');
        return Promise.resolve(answerFrom(gesture.info, at));
      }
      return new Promise((resolve) => {
        const entry = {
          at: { x: at.x, y: at.y },
          resolve,
          timer: null,
          startedAt: now(),
        };
        entry.timer = later(() => {
          const index = waiting.indexOf(entry);
          if (index >= 0) waiting.splice(index, 1);
          answered(entry, 'timeout');
          resolve(drillPick(entry.at, 1)[0]);
        }, timeoutMs);
        waiting.push(entry);
      });
    },
    /** How clicks were answered: GPU picks, timeouts, recent latencies (ms). */
    clickStats: () => ({ ...stats, latencies: [...stats.latencies] }),
    destroy() {
      view.off('featureClick', onFeatureClick);
      for (const entry of waiting.splice(0)) {
        cancel(entry.timer);
        entry.resolve(undefined);
      }
    },
  };
}
