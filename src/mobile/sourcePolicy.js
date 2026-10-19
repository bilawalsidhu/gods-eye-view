import { storedApiBase } from './runtimeConfig.js';

/**
 * On-device source policy: when the app talks to upstream APIs directly
 * instead of through the same-origin proxy, plus the shared courtesy and
 * refusal helpers every direct adapter uses.
 *
 * Selection rule: direct only inside the Capacitor native shell with no
 * operator backend configured (`Capacitor && !storedApiBase()`); the web
 * build and any backend-pointed shell keep the legacy proxy sources.
 *
 * Two cross-adapter contracts live here:
 *
 * - Registry refusal (`{ code: 'UPSTREAM_NOT_ALLOWED' }` from Task 2's
 *   `createNativeFetch`) is never swallowed and never faked into empty
 *   data. Object-returning methods resolve `{ unavailable:
 *   'UPSTREAM_NOT_ALLOWED' }`; array-shaped methods (perimeter rows,
 *   terrain heights) reject with that code and `unavailable` attached, so
 *   callers can tell "refused" from "empty".
 * - CapacitorHttp cannot cancel in flight, so every adapter checks its
 *   caller signal after each await and discards late responses by throwing
 *   the abort — never by delivering stale data.
 *
 * @module mobile/sourcePolicy
 */

/** Refusal code shared with `createNativeFetch` and every direct adapter. */
export const UPSTREAM_NOT_ALLOWED = 'UPSTREAM_NOT_ALLOWED';

/** Minimum gap between Nominatim requests (usage policy: max 1 req/s). */
export const NOMINATIM_MIN_INTERVAL_MS = 1_100;

/** Minimum gap between OSRM requests (FOSSGIS: max 1 request per second). */
export const OSRM_MIN_INTERVAL_MS = 1_000;

/**
 * Whether this page runs inside the Capacitor native shell.
 * @returns {boolean} True only when `Capacitor.isNativePlatform()` says so.
 */
export function isCapacitorNative() {
  try {
    const host = globalThis.Capacitor;
    if (!host || typeof host.isNativePlatform !== 'function') return false;
    return host.isNativePlatform() === true;
  } catch {
    return false;
  }
}

/**
 * Whether upstream sources should be fetched directly on-device.
 * @param {{ capacitor?: boolean, apiBase?: string }} overrides Test seam;
 *   both default to the live environment.
 * @returns {boolean} True for Capacitor with no stored backend.
 */
export function shouldUseDirect({ capacitor, apiBase } = {}) {
  const native = capacitor === undefined ? isCapacitorNative() : capacitor;
  const base = apiBase === undefined ? storedApiBase() : apiBase;
  return native === true && !base;
}

/**
 * Build one source or the other without constructing both.
 * @param {Function} directFactory Built when `shouldUseDirect()` is true.
 * @param {Function} legacyFactory Built otherwise.
 * @param {{ capacitor?: boolean, apiBase?: string }} options Policy override.
 * @returns {*} The chosen factory's product.
 */
export function selectSource(directFactory, legacyFactory, options) {
  if (
    typeof directFactory !== 'function' ||
    typeof legacyFactory !== 'function'
  ) {
    throw new TypeError('selectSource needs direct and legacy factories');
  }
  return shouldUseDirect(options) ? directFactory() : legacyFactory();
}

/**
 * Whether an error is a registry refusal (never retry, never fake data).
 * @param {*} error Thrown value.
 * @returns {boolean} True only for `{ code: 'UPSTREAM_NOT_ALLOWED' }`.
 */
export function isUpstreamRefusal(error) {
  return !!error && error.code === UPSTREAM_NOT_ALLOWED;
}

/**
 * Tag a refusal (or any error from a refused request) as honestly
 * unavailable for array-shaped methods that cannot resolve a marker.
 * @param {*} error Original error.
 * @returns {*} The same error with `unavailable` attached.
 */
export function asUnavailable(error) {
  if (error && typeof error === 'object') {
    if (!error.code) error.code = UPSTREAM_NOT_ALLOWED;
    error.unavailable = UPSTREAM_NOT_ALLOWED;
    return error;
  }
  return Object.assign(new Error('Upstream not allowed'), {
    code: UPSTREAM_NOT_ALLOWED,
    unavailable: UPSTREAM_NOT_ALLOWED,
  });
}

/**
 * Settle with `promise`, or reject with the abort reason as soon as `signal`
 * aborts; a later settlement of `promise` is ignored (never unhandled).
 * @param {Promise} promise In-flight work (e.g. a courtesy sleep).
 * @param {AbortSignal} signal Caller signal.
 * @returns {Promise} Settled value, or the abort rejection.
 */
function untilAborted(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error);
        return;
      }
      reject(new Error('aborted'));
    };
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Singleton shared pacer gate for geocode/route (Nominatim 1.1 s + OSRM 1/s). */
let sharedPacer = null;

/**
 * Get or create the single shared pacer used by all direct geocode/route sources.
 * @param {{ now?: Function, sleep?: Function }} clock Injectable clock.
 * @returns {{ wait: Function }} Shared pacer `wait({ signal })`.
 */
export function getSharedPacer({
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!sharedPacer) {
    sharedPacer = createPacer(1100, { now, sleep }); // max(NOMINATIM, OSRM)
  }
  return sharedPacer;
}

/**
 * Enforce a minimum gap between upstream requests (Nominatim 1.1 s, OSRM
 * 1/s), abort-aware so a cancelled caller never sleeps out its deadline.
 * @param {number} minIntervalMs Minimum milliseconds between starts.
 * @param {{ now?: Function, sleep?: Function }} clock Injectable clock.
 * @returns {{ wait: Function }} `wait({ signal })` before each request.
 */
export function createPacer(
  minIntervalMs,
  {
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  let lastStartMs = null;
  /**
   * Wait out the remainder of the courtesy gap, if any.
   * @param {{ signal?: AbortSignal }} options Caller signal.
   * @returns {Promise<void>}
   */
  async function wait({ signal } = {}) {
    signal?.throwIfAborted();
    if (lastStartMs !== null) {
      const delayMs = minIntervalMs - (now() - lastStartMs);
      if (delayMs > 0) {
        if (signal) await untilAborted(sleep(delayMs), signal);
        else await sleep(delayMs);
      }
    }
    signal?.throwIfAborted();
    lastStartMs = now();
  }
  return { wait };
}

/**
 * Wrap a fetchImpl with a courtesy pacer, preserving `(url, init)`.
 * @param {Function} fetchImpl Underlying fetch.
 * @param {number} minIntervalMs Minimum milliseconds between starts.
 * @returns {Function} Paced fetch with the same signature.
 */
export function withUpstreamPacer(fetchImpl, minIntervalMs) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('withUpstreamPacer needs a fetchImpl function');
  }
  const pacer = createPacer(minIntervalMs);
  return async function pacedFetch(url, init = {}) {
    await pacer.wait(init);
    return fetchImpl(url, init);
  };
}

/** Reset the shared pacer (test seam only). */
export function resetSharedPacer() {
  sharedPacer = null;
}

/** Install a test clock for the shared pacer (test seam only). */
export function setSharedPacerClock({ now, sleep }) {
  resetSharedPacer();
  getSharedPacer({ now, sleep });
}
