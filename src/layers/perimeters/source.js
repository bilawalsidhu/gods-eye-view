import { msg } from '../../i18n/marker.js';
import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { firePerimeterSnapshot } from './records.js';

// Failures stay English data. The Layers panel shows them translated.

/** Request a snapshot through the bounded, same-origin WFIGS proxy. */
export function createWfigsPerimeterSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * Current perimeters as fires and their pieces (firePerimeterSnapshot).
     * The proxy answers from its last snapshot, marked stale, while WFIGS is
     * unreachable.
     */
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
        throw new Error(msg('Malformed perimeter snapshot'));
      return firePerimeterSnapshot(payload.rows, {
        fetchedAt: payload.fetchedAt,
        stale: payload.stale === true,
      });
    },
  };
}
