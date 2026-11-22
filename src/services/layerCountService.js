import { requestWithDeadline } from '../sources/requestDeadline.js';
import { createSourceSlot } from '../sources/sourceSlot.js';
import { createJsonRequest, requireOk } from './jsonRequest.js';

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

export const layerCountSlot = createSourceSlot(
  createLayerCountService(createJsonRequest(), LAYER_COUNTS_ENDPOINT),
  ['getCounts'],
  'layerCounts service',
);

/** Bound the configured source even when its adapter ignores abort. */
export function getConfiguredLayerCounts({ signal, onTimeout } = {}) {
  return requestWithDeadline(
    (boundedSignal) => {
      if (onTimeout) {
        boundedSignal.addEventListener(
          'abort',
          () => {
            if (
              !signal?.aborted &&
              boundedSignal.reason?.name === 'TimeoutError'
            )
              onTimeout();
          },
          { once: true },
        );
      }
      return layerCountSlot.source.getCounts({ signal: boundedSignal });
    },
    { signal, timeoutMs: LAYER_COUNTS_TIMEOUT_MS },
  );
}
