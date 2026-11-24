import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export: no i18n here. Failures stay English data; the Layers
// panel shows them translated (ui/statusText.js matches "<source> HTTP <n>").

/**
 * JPL CNEOS fireball events through the same-origin `/api/fireballs` proxy
 * (the JPL API answers browsers without CORS headers).
 */
export function createFireballSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  url = '/api/fireballs/events',
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      let response;
      try {
        response = await fetchImpl(url, { signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw Object.assign(new Error('JPL CNEOS network error'), {
          retryable: true,
          cause: error,
        });
      }
      if (!response.ok)
        throw Object.assign(new Error(`JPL CNEOS HTTP ${response.status}`), {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      const payload = await readResponseJsonCapped(
        response,
        4 * 1024 * 1024,
        signal,
      );
      if (!Array.isArray(payload?.rows))
        throw new Error('Malformed JPL CNEOS response');
      return {
        rows: payload.rows,
        fetchedAt: Number.isFinite(payload.fetchedAt)
          ? payload.fetchedAt
          : null,
        stale: payload.stale === true,
      };
    },
  };
}
