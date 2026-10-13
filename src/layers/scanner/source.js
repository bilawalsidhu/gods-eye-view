import { normalizeScannerCalls, normalizeScannerFeedList } from './model.js';

/** Supply registered scanner feeds, recent clips and same-origin stream URLs. */
export function createScannerSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getFeeds({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/scanner/feeds', { signal });
      if (!response.ok)
        throw new Error(`Scanner feeds returned ${response.status}`);
      const feeds = normalizeScannerFeedList(await response.json());
      signal?.throwIfAborted();
      if (!feeds) throw new Error('Malformed scanner feed list');
      return feeds;
    },
    async getCalls(id, { signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(
        `/api/scanner/calls/${encodeURIComponent(id)}`,
        { signal },
      );
      if (!response.ok)
        throw new Error(`Scanner calls returned ${response.status}`);
      const calls = normalizeScannerCalls(await response.json());
      signal?.throwIfAborted();
      return calls;
    },
    getStreamUrl(id) {
      return `/api/scanner/stream/${encodeURIComponent(id)}`;
    },
  };
}
