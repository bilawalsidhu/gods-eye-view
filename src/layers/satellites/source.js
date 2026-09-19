import { providerStatusFromResponse } from '../../sources/live/contract.js';

const GROUPS = new Set([
  'stations',
  'visual',
  'gps-ops',
  'glo-ops',
  'galileo',
  'geo',
  'starlink',
]);

/**
 * Parse the JSON body of a failed proxy answer (`503 { error, provider }`) so
 * the structured status survives transports that drop custom headers. Never
 * throws; null when the body is absent or not JSON.
 */
async function readFailurePayload(response) {
  if (typeof response?.text !== 'function') return null;
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * Read catalog text from the existing group endpoint using a supplied transport.
 *
 * Each read also carries the proxy's structured provider status
 * (`X-Provider-*` headers from server/providers/common/upstream.js) as
 * `provider` — `{ status: 'live'|'stale'|'degraded'|'unavailable', source,
 * fetchedAtMs, ageSec, error, count }` — or null for a legacy proxy that sends
 * none. A `stale` answer (the proxy's own cache or the bundled snapshot) is
 * still data: `ok` stays true and `text` is the TLE body.
 */
export function createSatelliteSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async readGroup(group, { signal } = {}) {
      if (!GROUPS.has(group)) throw new TypeError('Unknown satellite group');
      signal?.throwIfAborted();
      const response = await fetchImpl(`/api/celestrak/${group}`, { signal });
      const text = response.ok ? await response.text() : '';
      const payload = response.ok ? null : await readFailurePayload(response);
      signal?.throwIfAborted();
      const provider = providerStatusFromResponse(response, payload);
      return {
        ok: response.ok,
        status: response.status,
        text,
        provider,
        error:
          provider?.error ||
          (typeof payload?.error === 'string' ? payload.error : null),
      };
    },
  };
}
