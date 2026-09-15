import { normalizeOverpassRoads } from '../../sources/overpassRoads.js';
export { normalizeOverpassRoads } from '../../sources/overpassRoads.js';
import { createFlowTileSource } from './flowSource.js';
function buildOverpassQuery(
  south,
  west,
  north,
  east,
  { majorOnly = false, timeoutSec = 25 } = {},
) {
  // Regex matches the OSM `highway` tag value against allowed road types
  const regex = majorOnly
    ? '^(motorway|trunk|primary|secondary)$'
    : '^(motorway|trunk|primary|secondary|tertiary|residential|unclassified)$';
  return `[out:json][timeout:${timeoutSec}];(way["highway"~"${regex}"](${south},${west},${north},${east}););out geom qt;`;
}

/** Supply road responses, flow availability and one decoded flow cache. */
export function createTrafficSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const flow = createFlowTileSource({ fetchImpl });
  return {
    ...flow,
    async requestRoads(
      { south, west, north, east },
      { majorOnly = false, timeoutSec = 25, signal } = {},
    ) {
      if (
        ![south, west, north, east].every(Number.isFinite) ||
        south < -90 ||
        north > 90 ||
        west < -180 ||
        east > 180 ||
        north <= south ||
        east <= west ||
        north - south > 10 ||
        east - west > 10 ||
        !Number.isInteger(timeoutSec) ||
        timeoutSec < 1 ||
        timeoutSec > 30
      )
        throw new TypeError('A bounded road viewport and timeout are required');
      signal?.throwIfAborted();
      const query = buildOverpassQuery(south, west, north, east, {
        majorOnly,
        timeoutSec,
      });
      const response = await fetchImpl('/api/overpass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal,
      });
      signal?.throwIfAborted();
      return {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        async json() {
          const body = await response.json();
          signal?.throwIfAborted();
          if (!Array.isArray(body?.elements))
            throw new Error('Malformed road snapshot');
          return { roads: normalizeOverpassRoads(body) };
        },
      };
    },
    async getStatus({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/tomtom/status', { signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const status = await response.json();
      signal?.throwIfAborted();
      if (typeof status?.hasKey !== 'boolean')
        throw new Error('Malformed traffic status');
      return status;
    },
  };
}
