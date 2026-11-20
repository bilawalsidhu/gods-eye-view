import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { firePerimeterSnapshot } from './records.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Request a snapshot through the bounded, same-origin WFIGS proxy. */
export function createWfigsPerimeterSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
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
        now: now(),
      });
    },
  };
}
