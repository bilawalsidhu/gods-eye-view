/**
 * Retry policy for keyless terrain tiles.
 *
 * Re:Earth serves its quantized-mesh tiles straight to the browser — nothing
 * in this repository proxies them — and its edge answers a zoom-out burst
 * with HTTP 429 for a few dozen tiles at once. Cesium marks each throttled
 * tile FAILED and upsamples the parent mesh, so the terrain stays coarse until
 * the quadtree happens to ask for that tile again.
 *
 * Cesium's `Resource` carries a retry contract (`retryCallback` +
 * `retryAttempts`) that `getDerivedResource` copies onto every tile fetch, and
 * the callback may return a promise: the request is re-issued only once it
 * resolves `true`. That is the hook this policy uses to insert the wait.
 *
 * Policy: throttled (429) and transient gateway (502/503/504) replies retry up
 * to three times with exponential backoff. Every retry waits behind ONE shared
 * cooldown per policy, so a burst of throttled tiles reissues as a jittered
 * trickle after the window instead of as a second burst that gets throttled
 * again. `Retry-After` extends the cooldown when the upstream exposes it.
 * Anything else (404 outside coverage, network errors, aborts) is left to
 * Cesium's own handling so the flat-terrain fallback stays prompt.
 */

export const TERRAIN_RETRY_ATTEMPTS = 3;
export const TERRAIN_RETRY_STATUSES = Object.freeze([429, 502, 503, 504]);
export const TERRAIN_RETRY_BASE_MS = 750;
export const TERRAIN_RETRY_MAX_MS = 15_000;
export const TERRAIN_RETRY_SPREAD_MS = 1_500;

const defaultWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parses a `Retry-After` header (delay-seconds or HTTP-date) into a wait in
 * milliseconds relative to `nowMs`. Returns null for absent or unparseable
 * values; a date already in the past yields 0.
 * @param {string|number|null|undefined} value
 * @param {number} nowMs
 * @returns {number|null}
 */
export function parseRetryAfter(value, nowMs) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - nowMs);
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

/**
 * Builds the retry policy handed to a Cesium `Resource`.
 *
 * @param {object} [options]
 * @param {() => number} [options.now] clock (ms); injectable for tests
 * @param {(ms: number) => Promise<void>} [options.wait] sleeper; injectable
 * @param {() => number} [options.random] jitter source in [0, 1)
 * @param {number} [options.attempts] retries per tile before giving up
 * @param {(info: {statusCode: number, attempt: number, delayMs: number,
 *   inWindow: number}) => void} [options.onThrottle] observer, called once per
 *   throttled reply; `inWindow` is 1 for the reply that opened a cooldown
 * @returns {{
 *   retryCallback: (resource: object, error: object) => Promise<boolean>,
 *   retryAttempts: number,
 *   shouldRetry: (error: object) => boolean,
 *   cooldownUntil: () => number,
 * }}
 */
export function createTerrainRetryPolicy({
  now = () => Date.now(),
  wait = defaultWait,
  random = Math.random,
  attempts = TERRAIN_RETRY_ATTEMPTS,
  onThrottle = null,
} = {}) {
  /** @type {WeakMap<object, number>} attempts already spent per tile resource. */
  const attemptsByResource = new WeakMap();
  let cooldownUntil = 0;
  let inWindow = 0;

  const shouldRetry = (error) =>
    TERRAIN_RETRY_STATUSES.includes(error?.statusCode);

  /**
   * Cesium `Resource.RetryCallback`: resolves `true` once the tile may be
   * re-requested, `false` to let the failure stand.
   */
  async function retryCallback(resource, error) {
    if (!shouldRetry(error)) return false;
    const attempt = attemptsByResource.get(resource) ?? 0;
    attemptsByResource.set(resource, attempt + 1);
    const started = now();
    const backoff = Math.min(
      TERRAIN_RETRY_MAX_MS,
      TERRAIN_RETRY_BASE_MS * 2 ** attempt,
    );
    const retryAfter = parseRetryAfter(
      headerValue(error?.responseHeaders, 'retry-after'),
      started,
    );
    const delay = Math.min(
      TERRAIN_RETRY_MAX_MS,
      Math.max(backoff, retryAfter ?? 0),
    );
    if (cooldownUntil <= started) inWindow = 0;
    inWindow += 1;
    if (started + delay > cooldownUntil) cooldownUntil = started + delay;
    onThrottle?.({
      statusCode: error.statusCode,
      attempt: attempt + 1,
      delayMs: cooldownUntil - started,
      inWindow,
    });
    const jitter = random() * TERRAIN_RETRY_SPREAD_MS;
    // Re-check after each sleep: replies that arrive while this tile waits can
    // push the shared window out, and the retry must stay behind it. The
    // iteration cap only guards against a sleeper that cannot advance time.
    for (let i = 0; i < 32; i += 1) {
      const remaining = cooldownUntil + jitter - now();
      if (remaining <= 0) break;
      await wait(remaining);
    }
    return true;
  }

  return {
    retryCallback,
    retryAttempts: attempts,
    shouldRetry,
    cooldownUntil: () => cooldownUntil,
  };
}
