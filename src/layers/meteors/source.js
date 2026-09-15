import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { validateMeteorSnapshot } from './records.js';

/** Read the fixed local GMN provider; acquisition remains independent of the renderer. */
export function createMeteorSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoint = '/api/meteors',
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(endpoint, { signal });
      if (!response.ok) throw new Error('Meteor data temporarily unavailable');
      const payload = await readResponseJsonCapped(
        response,
        8 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      return validateMeteorSnapshot(payload);
    },
  };
}
