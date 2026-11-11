// Picks on Navara. A click is answered by Navara's own GPU pick of the same
// gesture (`featureClick`, a frame or two after the click, null over empty
// space): its batch id resolves to the mover set and instance (pickIds.js).
// Lines are not in the GPU pick, so an empty GPU answer still checks them
// on the CPU; no answer within the timeout falls back to the CPU pick.
// Hover (move with pick), drill and the synchronous picker.pick are CPU
// picks (src/globe/cpuPicks.js). No three.

import { createCpuPicker } from '../cpuPicks.js';

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
  const meshPickers = new Set();
  const drillPick = createCpuPicker({
    projector,
    camera,
    movers,
    lines,
    meshes: (at) => [...meshPickers].flatMap((pick) => pick(at)),
  });
  const isModelSet = (id) =>
    movers().some(
      ({ options }) => options.id === id && options.kind === 'model',
    );

  // Clicks waiting for Navara's GPU answer, oldest first.
  const waiting = [];
  // Navara 0.2.1 answers clicks in quick succession (within a frame or so)
  // with the first click's pick: a GPU answer whose instance is not drawn
  // near the click is stale, and the CPU pick answers instead.
  // `hit` is the batch id resolved when Navara answered (the pick's own
  // frame): a set that changes its instances after it still names the
  // instance that was under the pointer.
  const resolveInfo = (info) => (info ? resolveBatch(info.batchId) : null);
  // A GPU answer is checked against the CPU pick at the click: an instance
  // the CPU sees must be drawn under the click (its pick radius, no slack)
  // and be the one the CPU finds on top. A stale answer from the previous
  // gesture (the followed aircraft at the centre) lay within twice its
  // radius of a neighbour's click and won. A model hit is
  // checked against its projected position within its drawn radius
  // (pickRadiusPx); the CPU's top hit (drawn order first) is not asked of
  // it, as a model is drawn depth-tested among the glyphs.
  const answerFrom = (hit, at) => {
    if (hit) {
      // The instance the CPU sees on top (lines are not in the GPU pick).
      const top = drillPick(at, 1, { includeLines: false })[0];
      const stale =
        !drillPick.near(hit.set, hit.instance, at, 1) ||
        (top !== undefined &&
          !(top.owner === hit.set && top.instance === hit.instance) &&
          (!isModelSet(hit.set) || top.instance === undefined));
      if (stale) return drillPick(at, 1)[0];
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
      early = { hit: resolveInfo(info), at: now() };
      return;
    }
    cancel(next.timer);
    next.resolve(answerFrom(resolveInfo(info), next.at));
  };
  view.on('featureClick', onFeatureClick);

  return {
    registerMeshPicker(pick) {
      meshPickers.add(pick);
      return () => meshPickers.delete(pick);
    },
    pick: (at, width, height) => drillPick(at, 1, { width, height })[0],
    drillPick: (at, limit, width, height) =>
      drillPick(at, limit ?? Infinity, { width, height }),
    /** The answer for a click at `at`: the GPU pick of its gesture. */
    clickPick(at) {
      const gesture = early;
      early = null;
      if (gesture && now() - gesture.at <= EARLY_ANSWER_MS)
        return Promise.resolve(answerFrom(gesture.hit, at));
      return new Promise((resolve) => {
        const entry = {
          at: { x: at.x, y: at.y },
          resolve,
          timer: null,
        };
        entry.timer = later(() => {
          const index = waiting.indexOf(entry);
          if (index >= 0) waiting.splice(index, 1);
          resolve(drillPick(entry.at, 1)[0]);
        }, timeoutMs);
        waiting.push(entry);
      });
    },
    destroy() {
      meshPickers.clear();
      view.off('featureClick', onFeatureClick);
      for (const entry of waiting.splice(0)) {
        cancel(entry.timer);
        entry.resolve(undefined);
      }
    },
  };
}
