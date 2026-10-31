/**
 * Whether the app's server has a Nominatim endpoint configured, asked once per
 * page from `/api/geocode/status` (like `/api/overpass/status`). When it says
 * no, callers skip lookups the server could only refuse, so a default install
 * never asks and never logs a failed request. An older server without the
 * probe, a failed or timed-out probe and a malformed answer leave the
 * capability unknown (`null`): lookups then go to the server as before, and
 * the probe is retried after a short backoff.
 *
 * @returns {() => Promise<boolean|null>}
 */
export function createNominatimStatus({
  fetchImpl = (...args) => globalThis.fetch(...args),
  url = '/api/geocode/status',
  timeoutMs = 3000,
  retryMs = 30_000,
  now = Date.now,
} = {}) {
  let decision = null;
  let retryAt = 0;
  return function configured() {
    if (decision) return decision;
    if (now() < retryAt) return Promise.resolve(null);
    decision = (async () => {
      try {
        const response = await fetchImpl(url, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = response.ok ? await response.json() : null;
        if (typeof body?.configured === 'boolean') return body.configured;
      } catch {
        // Unknown capability: ask the server as before.
      }
      decision = null;
      retryAt = now() + retryMs;
      return null;
    })();
    return decision;
  };
}
