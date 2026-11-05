import { readResponseJsonCapped } from '../../sources/httpBody.js';
import {
  SPC_BODY_LIMIT,
  SPC_PRODUCTS,
  normalizeSpcOutlook,
} from './records.js';

/** Portable, same-origin SPC source; the application supplies its lifetime signal. */
export function createSpcOutlookSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ product = 'day1-categorical', signal } = {}) {
      if (!Object.hasOwn(SPC_PRODUCTS, product))
        throw new TypeError('Invalid SPC product');
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(20_000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetchImpl(`/api/spc-outlooks/${product}`, {
        signal: combined,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('spc_outlooks_unavailable');
      }
      const payload = await readResponseJsonCapped(
        response,
        SPC_BODY_LIMIT,
        combined,
      );
      combined.throwIfAborted();
      return normalizeSpcOutlook(payload, {
        product,
        fetchedAt: payload.fetchedAt,
      });
    },
  };
}
