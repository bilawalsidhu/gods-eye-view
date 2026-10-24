import {
  readResponseBytesCapped,
  readResponseJsonCapped,
} from '../../sources/httpBody.js';

/** 2 × 1440 × 721 float32, the largest grid an IFS field route can advertise. */
const MAX_GRID_BYTES = 2 * 1440 * 721 * 4;

/**
 * Read one global IFS field through its same-origin route: the manifest, then
 * the grid it names. Failures are English data in the shapes ui/statusText.js
 * translates: `<errorPrefix> HTTP <status>`, plus the network and malformed
 * texts the caller passes as literals so the catalogs see them.
 * @param {{route: string, errorPrefix: string, networkError: string,
 *   malformed: string, parse: (payload: unknown) => object|null,
 *   decode: (buffer: ArrayBuffer, grid: object) => object|null,
 *   fetchImpl?: Function}} options
 */
export function createIfsFieldSource({
  route,
  errorPrefix,
  networkError,
  malformed,
  parse,
  decode,
  fetchImpl = (...args) => globalThis.fetch(...args),
}) {
  function httpError(status) {
    return Object.assign(new Error(`${errorPrefix} HTTP ${status}`), {
      status,
      retryable: status >= 500 || status === 429,
    });
  }
  async function get(url, signal) {
    try {
      return await fetchImpl(url, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(networkError);
    }
  }
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await get(route, signal);
      if (!response.ok) {
        await response.body?.cancel?.();
        throw httpError(response.status);
      }
      let manifest;
      try {
        manifest = parse(
          await readResponseJsonCapped(response, 64 * 1024, signal),
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        manifest = null;
      }
      if (!manifest) throw new Error(malformed);
      const gridResponse = await get(manifest.gridUrl, signal);
      if (!gridResponse.ok) {
        await gridResponse.body?.cancel?.();
        throw httpError(gridResponse.status);
      }
      let values = null;
      try {
        const bytes = await readResponseBytesCapped(
          gridResponse,
          MAX_GRID_BYTES,
          signal,
        );
        values = decode(
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
          manifest.grid,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
      }
      signal?.throwIfAborted();
      if (!values) throw new Error(malformed);
      return { ...manifest, values };
    },
  };
}
