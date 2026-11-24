import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export: no i18n here. Failures stay English data; the Layers
// panel shows them translated (ui/statusText.js matches "<source> HTTP <n>").

async function readJson(fetchImpl, url, signal, maxBytes) {
  let response;
  try {
    response = await fetchImpl(url, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw Object.assign(new Error('SondeHub network error'), {
      retryable: true,
      cause: error,
    });
  }
  if (!response.ok)
    throw Object.assign(new Error(`SondeHub HTTP ${response.status}`), {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
    });
  return readResponseJsonCapped(response, maxBytes, signal);
}

/**
 * Radiosondes through the same-origin `/api/sondehub` mirror, which follows
 * SondeHub's live feed so browsers never poll SondeHub themselves.
 */
export function createSondeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  base = '/api/sondehub',
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const payload = await readJson(
        fetchImpl,
        `${base}/latest`,
        signal,
        16 * 1024 * 1024,
      );
      if (!Array.isArray(payload?.rows))
        throw new Error('Malformed SondeHub response');
      return {
        rows: payload.rows,
        live: payload.live === true,
        fetchedAt: Number.isFinite(payload.fetchedAt)
          ? payload.fetchedAt
          : null,
      };
    },

    async getPrediction(serial, { signal } = {}) {
      const payload = await readJson(
        fetchImpl,
        `${base}/prediction?serial=${encodeURIComponent(serial)}`,
        signal,
        2 * 1024 * 1024,
      );
      return payload?.prediction ?? null;
    },
  };
}
