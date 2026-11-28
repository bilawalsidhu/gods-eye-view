import { msg } from '../../i18n/marker.js';
import { fetchProxyRows } from '../../sources/proxyRows.js';
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
      const { rows, stale, fetchedAt } = await fetchProxyRows(
        fetchImpl,
        '/api/fire-perimeters',
        {
          upstream: 'WFIGS',
          malformed: msg('Malformed perimeter snapshot'),
          signal,
        },
      );
      return firePerimeterSnapshot(rows, { fetchedAt, stale });
    },
  };
}
