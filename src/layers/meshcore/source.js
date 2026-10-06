/** Construct the existing MeshCore node-map endpoint without making a request. */
export function createMeshcoreSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/meshcore/nodes', {
        signal,
        cache: 'no-store',
      });
      signal?.throwIfAborted();
      let payload;
      try {
        payload = await response.json();
      } catch {
        /* status below remains authoritative */
      }
      signal?.throwIfAborted();
      if (!response.ok) throw new Error(`MeshCore HTTP ${response.status}`);
      if (!payload || !Array.isArray(payload.nodes))
        throw new Error('Malformed MeshCore snapshot');
      return payload;
    },
  };
}
