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

/**
 * A road request upstream declined, carrying a line fit to show an operator.
 *
 * The status travels beside the message instead of only inside it, so a caller
 * can branch on the code without parsing English — the same shape
 * `LiveSourceError` uses in `src/sources/live/contract.js`.
 */
export class RoadRequestError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'RoadRequestError';
    this.status = status;
  }
}

/**
 * Name an Overpass refusal in the words the traffic row will print.
 *
 * This layer has two upstreams — OpenStreetMap for road geometry and TomTom
 * for flow — and only one of them can be down at a time. A row that says
 * nothing more than "road data unavailable" sends the reader to check their
 * TomTom key, which is the wrong half of the layer and costs them the
 * afternoon. So the status upstream actually returned is reported: 406 from a
 * public mirror is not a configuration problem the reader can fix, and saying
 * so is the difference between a dead end and a next step.
 *
 * The first two lines match `alpr`'s Overpass source word for word; this is
 * the same vocabulary, not a new one. What the status adds is *which* upstream
 * and *how* it declined — the part a single-source layer never needs to say.
 *
 * Only what the browser can see is claimed. The proxy rotates mirrors behind
 * `/api/overpass`, so a refusal arriving here means the proxy had nothing
 * better to offer; how many mirrors it tried is not something this side knows,
 * and the message does not pretend otherwise.
 * @param {number} status - HTTP status the proxy returned; a code that is
 *   not a finite number is treated as absent rather than printed.
 * @returns {RoadRequestError}
 */
export function roadRequestError(status) {
  const code = Number.isFinite(status) ? status : null;
  const message =
    code === 429
      ? 'Overpass rate-limited'
      : code === 504
        ? 'Overpass timed out'
        : // Our own proxy answers these, not a mirror: 502 when every mirror
          // failed at the network level, 503 from its local concurrency
          // limiter before any mirror was asked. Neither is a refusal.
          code === 502
          ? 'Overpass mirrors unreachable'
          : code === 503
            ? 'Overpass temporarily unavailable'
            : // A source is injected, so a caller's adapter may hand back a
              // refusal with no status on it. "HTTP undefined" on a panel row is
              // worse than not naming a number, so an unreadable code falls back
              // to what `alpr` says when it cannot be more specific either.
              code === null
              ? 'Overpass temporarily unavailable'
              : `Overpass refused the road query (HTTP ${code})`;
  return new RoadRequestError(message, { status: code });
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
