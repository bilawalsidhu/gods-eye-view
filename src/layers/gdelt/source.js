import { normalizeGdeltSnapshot } from './records.js';

const GDELT_DOC_API =
  'https://api.gdeltproject.org/api/v2/doc/doc?query=(crisis%20OR%20conflict%20OR%20military%20OR%20protest%20OR%20summit)&mode=artlist&format=json&maxrecords=50&sort=datedesc';

const NASA_EONET_API =
  'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=30';

export function createGdeltEventsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const allRows = [];

      // 1. Pull GDELT DOC API
      try {
        const res = await fetchImpl(GDELT_DOC_API, { signal });
        if (res.ok) {
          const data = await res.json();
          allRows.push(...normalizeGdeltSnapshot(data));
        }
      } catch (err) {
        console.warn('[GDELT] Live news fetch notice:', err?.message);
      }

      // 2. Pull NASA Global Crisis & Events
      try {
        const res = await fetchImpl(NASA_EONET_API, { signal });
        if (res.ok) {
          const data = await res.json();
          allRows.push(...normalizeGdeltSnapshot(data));
        }
      } catch (err) {
        console.warn('[NASA EONET] Events fetch notice:', err?.message);
      }

      return allRows;
    },
  };
}
