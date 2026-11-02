/** A missing geocoder returns an unavailable outcome without making requests. */
export const unavailablePlaceSearch = Object.freeze({
  async geocode(_query, { signal } = {}) {
    signal?.throwIfAborted();
    return { place: null, answered: false };
  },
});

/**
 * Compose ordered geocoders into one bounded service. Each returns
 * { place: { lat, lng, name, label, types, viewport } | null, answered: boolean }.
 * Only definitive results are cached. Caller cancellation stops the whole chain.
 */
export function createPlaceSearch({
  providers,
  signal: lifetime,
  timeoutMs = 12_000,
  now = Date.now,
}) {
  const cache = new Map();
  return {
    async geocode(query, { bias = null, signal } = {}) {
      const combined = AbortSignal.any(
        [lifetime, signal, AbortSignal.timeout(timeoutMs)].filter(Boolean),
      );
      combined.throwIfAborted();
      const text = String(query ?? '').trim();
      if (!text) return { place: null, answered: true };
      const key = `${bias || ''}\n${text.toLowerCase()}`;
      const cached = cache.get(key);
      if (cached && cached.expires > now()) return cached.result;
      cache.delete(key);
      let result = { place: null, answered: providers.length > 0 };
      try {
        for (const [index, provider] of providers.entries()) {
          combined.throwIfAborted();
          const next = await provider.geocode(text, { bias, signal: combined });
          combined.throwIfAborted();
          result = {
            place: next.place,
            answered: Boolean(next.place) || (result.answered && next.answered),
          };
          if (result.place) {
            result.fallbackUsed = index > 0;
            break;
          }
        }
      } catch (error) {
        lifetime?.throwIfAborted();
        signal?.throwIfAborted();
        if (!combined.aborted) throw error;
        return { place: null, answered: false };
      }
      combined.throwIfAborted();
      if (result.answered) {
        cache.set(key, {
          result,
          expires: now() + (result.place ? 300_000 : 30_000),
        });
        while (cache.size > 64) cache.delete(cache.keys().next().value);
      }
      return result;
    },
  };
}
