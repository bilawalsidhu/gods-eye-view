/** Construct the live GLM lightning endpoint without making a request. */
export function createGlmSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/glm', {
        signal,
        cache: 'no-store',
      });
      const payload = await response.json();
      signal?.throwIfAborted();
      if (!response.ok) throw new Error(`GLM HTTP ${response.status}`);
      if (!Array.isArray(payload?.flashes))
        throw new Error('Malformed lightning snapshot');
      return payload;
    },
  };
}
