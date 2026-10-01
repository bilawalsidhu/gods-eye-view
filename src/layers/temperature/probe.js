import { PROBE_TIMEOUT_MS } from './policy.js';

/**
 * Probe a tile by loading it as an image rather than fetching it.
 *
 * GIBS sends `Access-Control-Allow-Origin: *` on a tile it has and **omits it
 * on the 404** for a period it does not. A `fetch` probe therefore cannot see
 * that 404 at all: the browser rejects it as a CORS failure, which is
 * indistinguishable from the network being down. An image load is not
 * CORS-gated, so `onload` means published and `onerror` means it is not.
 *
 * Lives outside `source.js` because that module is a portable package export
 * and may not reach browser globals; the source takes this as an injected
 * dependency instead.
 * @param {string} url Tile URL.
 * @param {{signal?:AbortSignal, timeoutMs?:number}} options Cancellation and deadline.
 * @returns {Promise<boolean>} Whether the tile loaded.
 */
export function probeTileWithImage(
  url,
  { signal, timeoutMs = PROBE_TIMEOUT_MS } = {},
) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      image.onload = null;
      image.onerror = null;
      // Drop the in-flight request; a probe whose answer nobody wants should
      // not keep occupying a connection.
      image.src = '';
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const onAbort = () =>
      finish(
        Object.assign(new Error('Temperature probe aborted'), {
          name: 'AbortError',
        }),
      );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => finish(false), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = url;
  });
}
