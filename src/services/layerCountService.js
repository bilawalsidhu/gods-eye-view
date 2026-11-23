import { requireOk } from './jsonRequest.js';

export const LAYER_COUNTS_ENDPOINT = '/api/layer-counts';
export const LAYER_COUNTS_TIMEOUT_MS = 10_000;

/** What each layer would show, from the server's caches. */
export function createLayerCountService(request, endpoint) {
  return {
    async getCounts(options) {
      return requireOk(
        await request(endpoint, {
          ...options,
          headers: { Accept: 'application/json' },
        }),
        'Layer counts',
      );
    },
  };
}
