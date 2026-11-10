import {
  readResponseBytesCapped,
  readResponseJsonCapped,
} from '../../sources/httpBody.js';
import { decodeSeaStateGrid, parseSeaStateManifest } from './model.js';

// Failures stay English data in the `<source> HTTP <status>` shapes that
// ui/statusText.js translates; the Layers panel shows them translated.
const msg = (text) => text;

/** 1440 × 721 float32, the largest grid the manifest can advertise. */
const MAX_GRID_BYTES = 1440 * 721 * 4;

function httpError(status) {
  return Object.assign(new Error(`Sea state HTTP ${status}`), {
    status,
    retryable: status >= 500 || status === 429,
  });
}

/** Read the global significant-wave-height field through the same-origin route. */
export function createSeaStateSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function get(url, signal) {
    try {
      return await fetchImpl(url, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(msg('Sea state network error'));
    }
  }
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await get('/api/sea-state', signal);
      if (!response.ok) {
        await response.body?.cancel?.();
        throw httpError(response.status);
      }
      let manifest;
      try {
        manifest = parseSeaStateManifest(
          await readResponseJsonCapped(response, 64 * 1024, signal),
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        manifest = null;
      }
      if (!manifest) throw new Error(msg('Malformed sea state response'));
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
        values = decodeSeaStateGrid(
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
      if (!values) throw new Error(msg('Malformed sea state response'));
      return { ...manifest, values };
    },
  };
}
