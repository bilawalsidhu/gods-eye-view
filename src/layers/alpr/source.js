import {
  OVERPASS_URL,
  MAX_VIEWPORT_DEGREES,
  QUERY_SNAP_DEGREES,
  QUERY_LIMIT,
} from './policy.js';
import { buildOverpassQuery, normalizeAlprNode } from './model.js';
/** Construct the bounded OSM request adapter without starting a request. */
export function createOverpassAlprSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function fetchAlprNodes(box, signal) {
    signal?.throwIfAborted();
    if (
      !box ||
      ![box.south, box.west, box.north, box.east].every(Number.isFinite) ||
      box.south < -90 ||
      box.north > 90 ||
      box.west < -180 ||
      box.east > 180 ||
      box.north <= box.south ||
      box.east <= box.west ||
      box.north - box.south >
        MAX_VIEWPORT_DEGREES + 2 * QUERY_SNAP_DEGREES + 1e-9 ||
      box.east - box.west > MAX_VIEWPORT_DEGREES + 2 * QUERY_SNAP_DEGREES + 1e-9
    ) {
      throw new TypeError('ALPR requires a bounded city viewport');
    }
    const query = buildOverpassQuery(box.south, box.west, box.north, box.east);
    const response = await fetchImpl(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal,
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* already closed */
      }
      const message =
        response.status === 429
          ? 'Overpass rate-limited'
          : response.status === 504
            ? 'Overpass timed out'
            : 'Overpass temporarily unavailable';
      throw new Error(message);
    }
    const stale = response.headers.get('x-overpass-cache') === 'STALE';
    const payload = await response.json();
    signal?.throwIfAborted();
    // The shared proxy already rejects query errors. Validate here too so a
    // malformed or partial response never becomes an authoritative empty map.
    if (!Array.isArray(payload?.elements) || payload.remark) {
      throw new Error('Overpass returned an incomplete camera response');
    }
    return {
      records: [
        ...new Map(
          payload.elements
            .slice(0, QUERY_LIMIT)
            .map(normalizeAlprNode)
            .filter(Boolean)
            .map((record) => [record.id, record]),
        ).values(),
      ],
      stale,
      saturated: payload.elements.length >= QUERY_LIMIT,
    };
  }
  return {
    fetch: fetchAlprNodes,
    label: 'OpenStreetMap · community mapped',
    attribution: {
      name: 'OpenStreetMap',
      description: 'OpenStreetMap contributors (ODbL 1.0; community mapped)',
      text: '© OpenStreetMap',
      href: 'https://www.openstreetmap.org/copyright',
    },
  };
}
