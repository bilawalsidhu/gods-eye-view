/**
 * @module layers/entsoeGrid/source
 *
 * European grid load, read through the local ENTSO-E proxy.
 *
 * The proxy answers 503 {error:'no_key', keyRequired:true} when no operator
 * token is configured. That is surfaced as a KEY-REQUIRED state rather than
 * as an empty snapshot, so the layer says "needs a key" instead of
 * pretending the grid is idle.
 */
import { ENTSOE_ZONE_PINS, normalizeEntsoeSnapshot } from './model.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** The local proxy route that serves the total-load series. */
export const ENTSOE_LOAD_ROUTE = '/api/entsoe/load';
/** A day's series does not change; cache it briefly. */
export const SNAPSHOT_TTL_MS = 15 * 60_000;

/**
 * Build the ENTSO-E source.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] Injected fetch.
 * @param {number} [options.ttlMs] Snapshot cache lifetime.
 * @param {string} [options.route] The proxy route to read.
 * @returns {{getSnapshot: Function}}
 */
export function createEntsoeSource({
  fetchImpl,
  ttlMs = SNAPSHOT_TTL_MS,
  route = ENTSOE_LOAD_ROUTE,
} = {}) {
  const impl = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  let cached = null;
  let cachedAt = 0;
  let inFlight = null;
  async function readZone(code, signal) {
    const response = await impl(`${route}?zone=${encodeURIComponent(code)}`, {
      headers: { Accept: 'application/json' },
      signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      // The FIRMS pattern: the proxy names the missing key, and the layer
      // turns that into stats.keyRequired.
      if (payload?.keyRequired === true || payload?.error === 'no_key') {
        const error = new Error(msg('ENTSO-E requires an API token'));
        error.keyRequired = true;
        throw error;
      }
      if (payload?.keyRejected === true) {
        const error = new Error(msg('ENTSO-E rejected the API token'));
        error.keyRejected = true;
        throw error;
      }
      throw new Error(`ENTSO-E proxy HTTP ${response.status}`);
    }
    return payload;
  }
  return {
    async getSnapshot({ signal } = {}) {
      const now = Date.now();
      if (cached && now - cachedAt < ttlMs) return cached;
      if (inFlight) return inFlight;
      inFlight = (async () => {
        // One read per zone, in parallel: the proxy caches each, and one
        // country failing must not blank the others.
        const settled = await Promise.allSettled(
          ENTSOE_ZONE_PINS.map(async ({ code }) => ({
            code,
            payload: await readZone(code, signal),
          })),
        );
        // A missing or rejected token is the same for every zone, and it is
        // a step the operator can take: surface it rather than a partial map.
        for (const result of settled) {
          if (
            result.status === 'rejected' &&
            (result.reason?.keyRequired || result.reason?.keyRejected)
          )
            throw result.reason;
        }
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const ok = settled
          .filter((result) => result.status === 'fulfilled')
          .map((result) => result.value);
        const normalized = normalizeEntsoeSnapshot(ok);
        if (!normalized) {
          const failure = settled.find(
            (result) => result.status === 'rejected',
          );
          if (failure) throw failure.reason;
          throw new Error(msg('Malformed ENTSO-E response'));
        }
        cached = normalized;
        cachedAt = Date.now();
        return normalized;
      })().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
