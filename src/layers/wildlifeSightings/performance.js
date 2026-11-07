/** Camera work runs on moveEnd/data arrival only. Measures remain observable
 * through PerformanceObserver while clearing entries prevents a long session
 * accumulating one timing record for every pan and streamed tile. */
export const WILDLIFE_MOVE_END_BUDGET_MS = 4;
const measureSpans = new Map();

function measureSpan(stage) {
  let span = measureSpans.get(stage);
  if (!span) {
    span = { name: `wildlife-sightings:${stage}`, depth: 0, frames: [] };
    measureSpans.set(stage, span);
  }
  const depth = span.depth++;
  if (!span.frames[depth]) {
    const start = `${span.name}:start:${depth}`;
    span.frames[depth] = { start, options: { start } };
  }
  return span;
}

/** Measure a render phase without accumulating performance entries. */
export function wildlifeMeasure(stage, work) {
  const clock = globalThis.performance;
  if (typeof clock?.mark !== 'function' || typeof clock?.measure !== 'function')
    return work();
  // Reuse names/options; nesting depth distinguishes simultaneous spans.
  const span = measureSpan(stage);
  const frame = span.frames[span.depth - 1];
  clock.mark(frame.start);
  try {
    return work();
  } finally {
    clock.measure(span.name, frame.options);
    clock.clearMarks?.(frame.start);
    clock.clearMeasures?.(span.name);
    span.depth--;
  }
}

// A unit is at most 128 cells/billboards. The one-millisecond target leaves
// room for the last unit, Cesium setters and the overlay host within 4ms.
export const WILDLIFE_WORK_UNIT = 128;
const WILDLIFE_WORK_SLICE_MS = 1;
export const WILDLIFE_SYNC_CELL_LIMIT = 256;

function wildlifeWorkStep(work, stage = 'bucket') {
  return wildlifeMeasure(stage, () => work.next());
}

/** Run bounded work synchronously for a small population. */
export function drainWildlifeWork(work) {
  let stage = 'bucket';
  for (;;) {
    const step = wildlifeWorkStep(work, stage);
    if (step.done) return step.value;
    stage = step.value || stage;
  }
}

/** A cancellable idle queue, never a frame listener. Superseding a camera view
 * drops unrun work. No network or requestAnimationFrame enters this queue. */
export function createWildlifeWorkQueue({
  requestIdle = globalThis.requestIdleCallback?.bind(globalThis),
  cancelIdle = globalThis.cancelIdleCallback?.bind(globalThis),
  now = () => performance.now(),
  onSlice = () => {},
} = {}) {
  let active = null;
  function cancel() {
    if (!active) return;
    const old = active;
    active = null;
    if (requestIdle) cancelIdle?.(old.handle);
    else clearTimeout(old.handle);
    old.work.return?.();
  }
  function start(work, complete) {
    cancel();
    const job = { work, handle: null, stage: 'bucket' };
    active = job;
    function schedule() {
      job.handle = requestIdle
        ? requestIdle(run, { timeout: 32 })
        : setTimeout(run, 0);
    }
    function run() {
      if (active !== job) return;
      const began = now();
      let units = 0;
      let result;
      wildlifeMeasure('moveEnd:slice', () => {
        do {
          result = wildlifeWorkStep(work, job.stage);
          units++;
          if (result.done) {
            active = null;
            complete(result.value);
            break;
          }
          job.stage = result.value || job.stage;
        } while (units < 8 && now() - began < WILDLIFE_WORK_SLICE_MS);
      });
      onSlice({ startTimeMs: began, durationMs: now() - began, units });
      if (!result.done && active === job) schedule();
    }
    schedule();
  }
  return {
    start,
    cancel,
    get pending() {
      return active !== null;
    },
  };
}
