import { buildRepeatersUrl } from '../../sources/hamRepeaters.js';

/**
 * Supply repeater rows around a point from the same-origin broker. Any
 * adapter with `getRepeaters(query, { signal })` resolving to
 * `{ repeaters, generatedAt, sources, errors, partial }` can replace it.
 */
export function createHamRepeatersSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getRepeaters(query, { signal } = {}) {
      const url = buildRepeatersUrl(query);
      if (!url) throw new Error('A latitude and longitude are required');
      signal?.throwIfAborted();
      const response = await fetchImpl(url, {
        signal,
        headers: { Accept: 'application/json' },
      });
      const body = await response.json().catch(() => null);
      signal?.throwIfAborted();
      if (!response.ok)
        throw new Error(
          body?.error || `Repeater directory returned ${response.status}`,
        );
      return body;
    },
  };
}
