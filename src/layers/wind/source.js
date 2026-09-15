/** Create a source that loads the current GFS wind field. */
export function createWindSource({ fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/wind/manifest', {
        signal,
        cache: 'no-store',
      });
      signal?.throwIfAborted();
      if (!response.ok) throw new Error(`Wind HTTP ${response.status}`);
      const manifest = await response.json();
      signal?.throwIfAborted();
      if (!manifest?.grid || !manifest.gridUrl)
        throw new Error('Malformed wind manifest');
      if (manifest.unavailable) return manifest;
      const gridResponse = await fetchImpl(manifest.gridUrl, { signal });
      signal?.throwIfAborted();
      if (!gridResponse.ok) throw new Error(`Wind HTTP ${gridResponse.status}`);
      const buffer = await gridResponse.arrayBuffer();
      signal?.throwIfAborted();
      const count = manifest.grid.nx * manifest.grid.ny;
      if (buffer.byteLength !== count * 8)
        throw new Error('Malformed wind grid');
      const values = new Float32Array(buffer);
      return {
        ...manifest,
        u: values.slice(0, count),
        v: values.slice(count),
      };
    },
  };
}
