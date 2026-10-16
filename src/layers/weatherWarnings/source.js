import { readResponseJsonCapped } from '../../sources/httpBody.js';

/** Request normalized warnings through the bounded, same-origin MetAlerts proxy. */
export function createMetAlertsWarningSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/weather-warnings', { signal });
      if (!response.ok) throw new Error(`MetAlerts HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        16 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.rows))
        throw new Error('Malformed weather warning snapshot');
      return payload.rows;
    },
  };
}
