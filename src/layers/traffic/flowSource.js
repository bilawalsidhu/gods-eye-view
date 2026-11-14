import { isDrivableFlowSegment } from './roadModes.js';
import { createVectorTileSource } from '../../sources/vectorTiles.js';
import { clipTileLine } from '../../sources/openFreeMap.js';
import { tileToBBox } from '../../data/tomtomTiles.js';
import { decodeFlowTile } from './flowDecode.js';

const FLOW_TILE_PATH = (z, x, y) => `/api/tomtom/flow/${z}/${x}/${y}.pbf`;

/**
 * Whether the proxy answered a tile from its cache past the refresh window
 * (STALE-BUDGET once the daily budget is spent, STALE-ERROR when TomTom
 * fails), and when the proxy fetched it.
 */
/**
 * The machine-readable reason a failed tile carries: `code` (hosted usage,
 * e.g. USAGE_LIMIT_REACHED or RATE_LIMITED) or the local proxy's `error`
 * (`no_key`, `budget`). Only short identifiers are kept; prose is ignored.
 */
async function failureCode(response) {
  if (!/json/i.test(response.headers?.get?.('content-type') || '')) return null;
  try {
    const text = await response.text();
    if (text.length > 4096) return null;
    const body = JSON.parse(text);
    const code = body?.code ?? body?.error;
    return typeof code === 'string' && /^[A-Za-z_]{1,40}$/.test(code)
      ? code
      : null;
  } catch {
    return null;
  }
}

function tileFreshness(response) {
  const status = response.headers?.get?.('x-tomtom-cache') || '';
  const fetchedAt = Number(response.headers?.get?.('x-tomtom-fetched-at'));
  return {
    stale: status.startsWith('STALE'),
    fetchedAt: fetchedAt > 0 ? fetchedAt : null,
  };
}

/**
 * Clip a flow line to a box. Every piece keeps its uncut line as `line`, so
 * pieces of one line that doubles back are never paired with each other.
 */
function clipFlowSegment(segment, bbox) {
  const line = segment.line || segment;
  return clipTileLine(segment.coords, bbox).map((coords) => ({
    ...segment,
    coords,
    line,
  }));
}

/** Own one bounded decoded flow cache; every request still passes the server tile budget. */
export function createFlowTileSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  // Freshness travels in response headers, but the tile cache keeps only
  // decoded segments: hold each response's freshness until its tile decodes,
  // then key it by the decoded tile, which the cache hands back on a hit.
  const pending = new Map();
  const freshness = new WeakMap();
  const tiles = createVectorTileSource({
    template: FLOW_TILE_PATH('{z}', '{x}', '{y}'),
    allowedOrigin: 'http://localhost',
    decode: (bytes, z, x, y) => {
      // Take the mark before decoding, so a tile that fails to decode
      // leaves nothing behind.
      const path = FLOW_TILE_PATH(z, x, y);
      const entry = pending.get(path);
      const mark = entry?.mark;
      entry?.release();
      const segments = decodeFlowTile(bytes, z, x, y, { strict: true })
        .filter(isDrivableFlowSegment)
        .flatMap((segment) => clipFlowSegment(segment, tileToBBox(z, x, y)));
      if (mark) freshness.set(segments, mark);
      return segments;
    },
    fetchImpl: async (url, init) => {
      const response = await fetchImpl(url, init);
      if (!response.ok) {
        const code = await failureCode(response);
        await response.body?.cancel().catch(() => {});
        throw Object.assign(
          // Classified for display by deriveTrafficFlowError.
          new Error(`TomTom flow unavailable (HTTP ${response.status})`),
          { status: response.status, code },
        );
      }
      if (!init.signal.aborted) {
        const path = String(url);
        const entry = {
          mark: tileFreshness(response),
          release() {
            if (pending.get(path) === entry) pending.delete(path);
            init.signal.removeEventListener('abort', entry.release);
          },
        };
        pending.get(path)?.release();
        pending.set(path, entry);
        // The vector source aborts this signal for failed/cancelled body reads,
        // including size-limit failures that never reach decode.
        init.signal.addEventListener('abort', entry.release, { once: true });
      }
      return response;
    },
    ttlMs: 120_000,
    maxTiles: 16,
  });
  let partial = false;
  /**
   * Flow segments for bounds, with whether any covering tile failed to load
   * for this request, whether any came from the proxy's stale cache, and when
   * the oldest tile was fetched.
   */
  async function fetchFlowDetail(bounds, { signal, zoom = 12 } = {}) {
    const result = await tiles.fetchBounds(bounds, {
      zoom,
      signal,
      tiles: bounds.coverage?.coarse,
    });
    partial = result.partial;
    const segments = bounds.coverage
      ? result.tiles.flat()
      : result.tiles
          .flat()
          .flatMap((segment) => clipFlowSegment(segment, bounds));
    const marks = result.tiles.map((tile) => freshness.get(tile) || {});
    const times = marks
      .map((mark) => mark.fetchedAt)
      .filter((at) => Number.isFinite(at));
    return {
      segments,
      partial: result.partial === true,
      stale: marks.some((mark) => mark.stale === true),
      oldestTileAt: times.length ? Math.min(...times) : null,
    };
  }
  return {
    fetchFlowDetail,
    async fetchFlowForBounds(bounds, options) {
      return (await fetchFlowDetail(bounds, options)).segments;
    },
    getFlowSessionStats: () => ({ ...tiles.getStats(), partial }),
    resetFlowTileCache: () => {
      for (const entry of pending.values()) entry.release();
      tiles.clear();
    },
  };
}
