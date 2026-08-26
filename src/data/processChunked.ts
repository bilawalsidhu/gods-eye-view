/**
 * processChunked.ts
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

interface IdleDeadline {
  readonly didTimeout: boolean;
  timeRemaining(): number;
}

type ScheduleFn = (fn: (deadline: IdleDeadline) => void, opts?: { timeout?: number }) => number;

/**
 * Process `items` in slices, yielding to the browser between each slice.
 * Small arrays (≤ SYNC_THRESHOLD) are processed synchronously.
 *
 * @param items - Items to process (iterated in order, items[n] before items[n+1]).
 * @param chunkSize - Items per slice (default 500). Must be >= 1.
 * @param handle - Called once per item.
 * @param onComplete - Called after the last item is handled.
 */
export function processChunked<T>(
  items: T[],
  chunkSize: number,
  handle: (item: T, index: number) => void,
  onComplete?: () => void,
): void {
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

  function runSlice(deadline: IdleDeadline): void {
    // Process as many items as we can in the remaining idle time
    while (index < items.length && deadline.timeRemaining() > 0) {
      handle(items[index], index);
      index++;
    }

    if (index < items.length) {
      // More items remain — schedule the next slice
      requestIdleCallback(runSlice, { timeout: 16 });
    } else if (typeof onComplete === 'function') {
      onComplete();
    }
  }

  // Fallback to setTimeout if requestIdleCallback is unavailable (e.g. some test
  // environments). This still yields between chunks, just not as precisely.
  const schedule: ScheduleFn =
    globalThis.requestIdleCallback ?? ((fn) => {
      const id = setTimeout(() => fn({ timeRemaining: () => Infinity, didTimeout: false } as IdleDeadline), 0);
      return id;
    });
  schedule(runSlice, { timeout: 16 });
}

/**
 * Synchronous fallback for cases where yielding is undesirable (e.g. tests,
 * or when caller has already yielded and needs to drain remaining items).
 *
 * @param items - Items to process.
 * @param chunkSize - Items per slice (default 500).
 * @param handle - Called once per item.
 */
export function processChunkedSync<T>(items: T[], chunkSize: number, handle: (item: T, index: number) => void): void {
  const chunk = Math.max(1, Math.floor(chunkSize) || DEFAULT_CHUNK);
  for (let i = 0; i < items.length; i += chunk) {
    const limit = Math.min(i + chunk, items.length);
    for (let j = i; j < limit; j++) {
      handle(items[j], j);
    }
  }
}
