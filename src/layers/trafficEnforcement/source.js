import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { cabaTrafficFeatures } from './records.js';

/** Create an inert, replaceable client for the local CABA inventory provider. */
export function createCabaTrafficSource({
  apiUrl = '/api/caba-traffic-enforcement',
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getFeatures({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(apiUrl, { signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('CABA inventory unavailable');
      }
      const snapshot = await readResponseJsonCapped(
        response,
        4 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      return cabaTrafficFeatures(snapshot);
    },
  };
}
