import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { normalizeGeopoliticalSnapshot } from './records.js';

/** Same-origin proxy client; API credentials never enter browser requests. */
export function createGeopoliticalSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 20_000,
} = {}) {
  async function searchArea(provider, input, { signal } = {}) {
    const { latitude, longitude, radiusKm, category } = input;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/geopolitical/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          latitude,
          longitude,
          radiusKm,
          ...(category ? { category } : {}),
        }),
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'error',
      });
      const payload = await readResponseJsonCapped(
        response,
        512 * 1024,
        controller.signal,
      ).catch(() => ({}));
      if (!response.ok) {
        const messages = {
          invalid_area: 'The current map view cannot be searched.',
          invalid_category: 'Choose a GDELT event category before searching.',
          missing_credentials:
            'Configure the UCDP API token in Provider Settings before searching.',
          provider_unavailable: `${provider === 'ucdp' ? 'UCDP' : 'GDELT'} is temporarily unavailable. Try again later.`,
        };
        throw new Error(
          messages[payload?.error] ||
            `GDELT area search unavailable (${response.status}).`,
        );
      }
      signal?.throwIfAborted();
      return {
        ...normalizeGeopoliticalSnapshot(payload),
        search: payload.search,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  const searchGdeltArea = (input, options) =>
    searchArea('gdelt', input, options);
  const searchUcdpArea = (input, options) => searchArea('ucdp', input, options);

  return Object.freeze({
    async getSnapshot({ signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl('/api/geopolitical/events', {
          signal: controller.signal,
          cache: 'no-store',
          redirect: 'error',
        });
        const payload = await readResponseJsonCapped(
          response,
          2 * 1024 * 1024,
          controller.signal,
        );
        if (!response.ok)
          throw new Error(
            payload?.error === 'provider_unavailable'
              ? 'Geo-Political sources are temporarily unavailable.'
              : `Geo-Political data unavailable (${response.status}).`,
          );
        signal?.throwIfAborted();
        return normalizeGeopoliticalSnapshot(payload);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
    searchGdeltArea,
    searchUcdpArea,
  });
}
