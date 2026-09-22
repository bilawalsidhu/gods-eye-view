export function createMeshtasticSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiUrl = '/api/meshtastic/nodes',
  maxAgeSec = 7200,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const response = await fetchImpl(
        `${apiUrl}?maxAgeSec=${encodeURIComponent(maxAgeSec)}`,
        {
          headers: { Accept: 'application/json' },
          signal,
        },
      );

      if (!response.ok) {
        throw new Error(`Meshtastic HTTP ${response.status}`);
      }

      const payload = await response.json();
      return Array.isArray(payload?.nodes) ? payload.nodes : [];
    },
  };
}
