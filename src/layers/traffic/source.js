import { normalizeOverpassRoads } from '../../sources/overpassRoads.js';
export { normalizeOverpassRoads } from '../../sources/overpassRoads.js';
import { providerStatusFromResponse } from '../../sources/live/contract.js';
import { createFlowTileSource } from './flowSource.js';

/** `?point=lat,lon` for a valid scene point (3 dp — the proxy keys its cache at 0.01°), else ''. */
function pointQuery(point) {
  const lat = Number(point?.lat);
  const lon = Number(point?.lon);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return '';
  return `?point=${lat.toFixed(3)},${lon.toFixed(3)}`;
}
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
    /**
     * Probe `/api/tomtom/status`. With a scene `point` ({lat, lon} degrees)
     * the proxy also samples live speed there when it holds a key
     * (`flowSegment`). The structured provider status — X-Provider-* headers
     * first, the body's `provider` object as the fallback — is returned as
     * `providerStatus` ({status, source, fetchedAtMs, ageSec, error, count}),
     * or null for a legacy proxy that reports neither.
     */
    async getStatus({ signal, point = null } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(
        '/api/tomtom/status' + pointQuery(point),
        { signal },
      );
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const status = await response.json();
      signal?.throwIfAborted();
      if (typeof status?.hasKey !== 'boolean')
        throw new Error('Malformed traffic status');
      const providerStatus = providerStatusFromResponse(response, status);
      // Header values are ASCII-only (the em dash in the proxy's reason
      // arrives as '?'); the JSON body carries the reason verbatim.
      if (providerStatus && typeof status.provider?.error === 'string')
        providerStatus.error = status.provider.error.trim() || null;
      return { ...status, providerStatus };
    },
  };
}
