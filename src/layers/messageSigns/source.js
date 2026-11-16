import {
  readResponseBytesCapped,
  readResponseJsonCapped,
} from '../../sources/httpBody.js';
import { GIF_MAX_BYTES, gifSize } from './gif.js';
import { MESSAGE_NAME_RE } from './records.js';

// No i18n here: failures stay English data in the shapes translateFeedError
// knows, and the Layers panel translates them.
const LIST_MAX_BYTES = 1024 * 1024; // About 40 KB today.
const MALFORMED = 'Malformed MnDOT response';

function isSign(row) {
  return (
    typeof row?.id === 'string' &&
    Number.isFinite(row.lat) &&
    Number.isFinite(row.lon) &&
    typeof row.location === 'string' &&
    typeof row.message === 'string' &&
    MESSAGE_NAME_RE.test(row.message) &&
    typeof row.multi === 'string'
  );
}

async function request(fetchImpl, url, signal) {
  signal?.throwIfAborted();
  let response;
  try {
    response = await fetchImpl(url, { signal });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    throw new Error('MnDOT network error');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`MnDOT HTTP ${response.status}`);
  }
  return response;
}

/** Lit MnDOT message signs and their rendered faces through the bounded,
 * same-origin /api/message-signs proxy. */
export function createMessageSignsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /** @returns {Promise<{ signs: object[], ageMs: number, stale: boolean }>} */
    async getSnapshot({ signal } = {}) {
      const response = await request(fetchImpl, '/api/message-signs', signal);
      let payload;
      try {
        payload = await readResponseJsonCapped(
          response,
          LIST_MAX_BYTES,
          signal,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error(MALFORMED);
      }
      signal?.throwIfAborted();
      if (
        !Array.isArray(payload?.signs) ||
        !Number.isFinite(payload.ageMs) ||
        payload.ageMs < 0
      )
        throw new Error(MALFORMED);
      return {
        signs: payload.signs.filter(isSign),
        ageMs: payload.ageMs,
        stale: payload.stale === true,
      };
    },

    /** MnDOT's GIF of one message, checked as a GIF within the size caps. */
    async getFaceImage(message, { signal } = {}) {
      if (typeof message !== 'string' || !MESSAGE_NAME_RE.test(message))
        throw new Error(MALFORMED);
      const response = await request(
        fetchImpl,
        `/api/message-signs/img/${message}.gif`,
        signal,
      );
      let bytes;
      try {
        bytes = await readResponseBytesCapped(response, GIF_MAX_BYTES, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error(MALFORMED);
      }
      if (!gifSize(bytes)) throw new Error(MALFORMED);
      return bytes;
    },
  };
}
