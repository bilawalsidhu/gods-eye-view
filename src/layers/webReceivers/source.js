import { CATALOG_ENDPOINT } from './policy.js';

/**
 * Supply the merged receiver directory from the same-origin broker. Tuning
 * is a URL the browser opens itself: this source never talks to a receiver.
 */
export function createWebReceiversSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getCatalog({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(CATALOG_ENDPOINT, {
        signal,
        headers: { Accept: 'application/json' },
      });
      const body = await response.json().catch(() => null);
      signal?.throwIfAborted();
      if (!response.ok) {
        const error = new Error(
          body?.error || `Web receiver directory returned ${response.status}`,
        );
        error.degraded = Boolean(body?.degraded);
        throw error;
      }
      return body;
    },
  };
}
