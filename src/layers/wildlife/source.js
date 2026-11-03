import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { sanitizeWildlifeSnapshot } from './records.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Request the curated Movebank tracks through the same-origin proxy. */
export function createWildlifeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /** Every cached animal with its latest fixes, and each study's state. */
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/wildlife', { signal });
      if (!response.ok) throw new Error(`Wildlife HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        4 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      const snapshot = sanitizeWildlifeSnapshot(payload);
      if (!snapshot) throw new Error(msg('Malformed wildlife snapshot'));
      return {
        ...snapshot,
        fetchedAt: Number.isFinite(payload.fetchedAt)
          ? payload.fetchedAt
          : null,
        generatedAt: Number.isFinite(payload.generatedAt)
          ? payload.generatedAt
          : null,
      };
    },
  };
}
