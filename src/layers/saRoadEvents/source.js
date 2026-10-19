import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { validateSaRoadEventsPayload } from './records.js';

// One page of ~1,300 points is well under 2 MB; the cap is a safety bound.
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Request the road-event snapshot through the bounded same-origin proxy.
 * The whole payload is validated before it is returned, so a malformed or
 * partial response can never replace what the layer is already showing.
 */
export function createSaRoadEventsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/sa-road-events', { signal });
      if (!response.ok) {
        void response.body?.cancel?.().catch(() => {});
        throw new Error(`Traffic SA HTTP ${response.status}`);
      }
      const payload = await readResponseJsonCapped(
        response,
        MAX_BODY_BYTES,
        signal,
      );
      signal?.throwIfAborted();
      const snapshot = validateSaRoadEventsPayload(payload);
      if (!snapshot) throw new Error('Malformed Traffic SA snapshot');
      return snapshot;
    },
  };
}
