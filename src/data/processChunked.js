/**
 * processChunked.js
 *
 * Processes a large array in slices via requestIdleCallback, yielding to the
 * browser between chunks so the main thread stays responsive during bulk
 * operations (e.g. AIS 12k vessel reconciliation, flights 5k enrichment).
 *
 * Small arrays (≤ SYNC_THRESHOLD items) are processed synchronously in one go
 * to avoid the overhead of scheduling idle callbacks and to keep tests deterministic.
 *
 * Usage:
 *   processChunked(items, 500, item => handle(item), () => onDone());
 */

/** Default items per idle-chunk slice */
const DEFAULT_CHUNK = 500;
/** Below this size, process synchronously to avoid idle-callback overhead. */
const SYNC_THRESHOLD = 1000;

/**
 * Process `items` in slices, yielding to the browser between each slice.
 * Small arrays (≤ SYNC_THRESHOLD) are processed synchronously.
 *
 * @param {Array} items - Items to process (iterated in order, items[n] before items[n+1]).
 * @param {number} [chunkSize] - Items per slice (default 500). Must be >= 1.
 * @param {(item: any, index: number) => void} handle - Called once per item.
 * @param {() => void} [onComplete] - Called after the last item is handled.
 */
export function processChunked(items, chunkSize, handle, onComplete) {
  const chunk = Math.max(1, Math.floor(chunkSize) || DEFAULT_CHUNK);
  // Fast path: small arrays are processed synchronously in one go.
  if (items.length <= SYNC_THRESHOLD) {
    for (let i = 0; i < items.length; i++) {
      handle(items[i], i);
    }
    if (typeof onComplete === 'function') onComplete();
    return;
  }

  let index = 0;

  /**
   * Drain items for one scheduled slice, then re-schedule if any remain.
   * @param {IdleDeadline=} deadline Real deadline when driven by
   *   requestIdleCallback; absent on the setTimeout fallback path.
   * @returns {void}
   */
  function runSlice(deadline) {
    // With a real IdleDeadline, process as many items as the remaining idle
    // time allows. The setTimeout fallback invokes runSlice WITHOUT a
    // deadline; bound those slices by chunkSize instead, so the fallback
    // still yields between slices rather than draining in one tick.
    const idleBudget = deadline && typeof deadline.timeRemaining === 'function'
      ? () => deadline.timeRemaining()
      : () => (processed < chunk ? 1 : 0);
    let processed = 0;
    while (index < items.length && idleBudget() > 0) {
      handle(items[index], index);
      index++;
      processed++;
    }

    if (index < items.length) {
      // More items remain — schedule the next slice (via the same scheduler
      // the first slice used, so the fallback keeps working past one slice).
      schedule(runSlice, { timeout: 16 });
    } else if (typeof onComplete === 'function') {
      onComplete();
    }
  }

  // Fallback to setTimeout if requestIdleCallback is unavailable (e.g. some test
  // environments). This still yields between chunks, just not as precisely.
  const schedule = globalThis.requestIdleCallback ?? ((fn) => setTimeout(fn, 0));
  schedule(runSlice, { timeout: 16 });
}

/**
 * Synchronous fallback for cases where yielding is undesirable (e.g. tests,
 * or when caller has already yielded and needs to drain remaining items).
 *
 * @param {Array} items - Items to process; iterated in index order.
 * @param {number} [chunkSize] - Items per inner loop (default 500); bounds
 *   the `Math.min` slice, not the outer walk, so it cannot skip items.
 * @param {(item: any, index: number) => void} handle - Called once per item.
 */
export function processChunkedSync(items, chunkSize, handle) {
  const chunk = Math.max(1, Math.floor(chunkSize) || DEFAULT_CHUNK);
  for (let i = 0; i < items.length; i += chunk) {
    const limit = Math.min(i + chunk, items.length);
    for (let j = i; j < limit; j++) {
      handle(items[j], j);
    }
  }
}

