import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { validateSaFireSnapshot } from './records.js';

/** Request a validated snapshot through the bounded, same-origin SA fire proxy. */
export function createSaFireSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/sa-fire', { signal });
      if (!response.ok) throw new Error(`SA fire HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        16 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      return validateSaFireSnapshot(payload);
    },
  };
}
