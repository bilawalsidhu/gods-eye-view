/** Fetch the current AU fire incident snapshot from the local proxy. */
export function createAuFireSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/au-fire', {
        signal,
        cache: 'no-store',
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        /* status below remains authoritative */
      }
      signal?.throwIfAborted();
      if (!response.ok) throw new Error(`AU Fire HTTP ${response.status}`);
      if (!Array.isArray(payload?.incidents))
        throw new Error('Malformed AU fire snapshot');
      return payload;
    },
  };
}
