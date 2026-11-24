import {
  readResponseBytesCapped,
  readResponseJsonCapped,
} from '../../sources/httpBody.js';
import { GHOSTMAPS_MAX_FILE_BYTES } from './catalog.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/**
 * Same-origin GhostMaps source: the catalog, one product's KMZ bytes, and a
 * push subscription that fires whenever the watcher sees a new commit.
 */
export function createGhostMapsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  EventSourceImpl = globalThis.EventSource,
} = {}) {
  return {
    async getCatalog({ signal } = {}) {
      const response = await fetchImpl('/api/ghostmaps/catalog', { signal });
      if (!response.ok)
        throw new Error(
          `GhostMaps catalog unavailable (HTTP ${response.status})`,
        );
      const catalog = await readResponseJsonCapped(
        response,
        1024 * 1024,
        signal,
      );
      if (!Array.isArray(catalog?.products))
        throw new Error(msg('Malformed GhostMaps catalog'));
      return catalog;
    },

    async getFile(id, version, { signal } = {}) {
      const response = await fetchImpl(
        `/api/ghostmaps/file/${encodeURIComponent(id)}?v=${encodeURIComponent(version)}`,
        { signal },
      );
      if (!response.ok)
        throw new Error(`GhostMaps file unavailable (HTTP ${response.status})`);
      return readResponseBytesCapped(
        response,
        GHOSTMAPS_MAX_FILE_BYTES,
        signal,
      );
    },

    /**
     * Call `onCatalog(catalog)` for every catalog the server pushes, and
     * `onState('open' | 'connecting' | 'closed')` as the stream changes. The
     * browser's EventSource reconnects by itself. Returns an unsubscribe.
     */
    subscribe(onCatalog, onState = () => {}) {
      if (typeof EventSourceImpl !== 'function') {
        onState('closed');
        return () => {};
      }
      const events = new EventSourceImpl('/api/ghostmaps/events');
      const states = ['connecting', 'open', 'closed'];
      const report = () => onState(states[events.readyState] ?? 'connecting');
      events.onopen = report;
      events.onerror = report;
      const listener = (event) => {
        try {
          const catalog = JSON.parse(event.data);
          if (Array.isArray(catalog?.products)) onCatalog(catalog);
        } catch {
          /* ignore a malformed frame; the next one replaces it */
        }
      };
      events.addEventListener('catalog', listener);
      report();
      return () => {
        events.removeEventListener('catalog', listener);
        events.close();
      };
    },
  };
}
