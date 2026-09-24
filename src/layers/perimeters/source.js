import { readResponseJsonCapped } from '../../sources/httpBody.js';

/** Request a normalized snapshot through the bounded, same-origin WFIGS proxy. */
export function createWfigsPerimeterSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/fire-perimeters', { signal });
      if (!response.ok) throw new Error(`WFIGS HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        80 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.rows))
        throw new Error('Malformed perimeter snapshot');
      return payload.rows;
    },
  };
}
