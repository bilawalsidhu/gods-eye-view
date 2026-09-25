import { API_URL, MORE_URL } from './policy.js';
import { newsRegionQueryString } from '../../data/worldNewsRegion.js';
import { normalizeWorldNewsSnapshot } from './records.js';

/** Proxy error codes → the human message the row shows (contract v1). */
const ERROR_MESSAGES = Object.freeze({
  bad_key: 'World News key rejected',
  quota: 'World News quota exhausted',
  budget: 'daily news budget exhausted',
  rate_limited: 'World News rate-limited',
  pages: 'extra pages exhausted',
  bad_region: 'this view is not a valid news circle',
  region_off: 'view fetching is off on this server',
  region_rate: 'view fetches exhausted this hour',
});

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * The region a payload says it is, or null for the global feed.
 * A half-formed descriptor reads as global rather than as a circle the row
 * would then describe with NaN coordinates.
 * @param {unknown} region Proxy `region` field.
 * @returns {{band:string, key:string|null,
 *   center:{lat:number, lon:number}, radiusKm:number}|null}
 */
function normalizeRegion(region) {
  if (!region || typeof region !== 'object' || Array.isArray(region))
    return null;
  const lat = finiteOrNull(region.center?.lat);
  const lon = finiteOrNull(region.center?.lon);
  const radiusKm = finiteOrNull(region.radiusKm);
  if (lat === null || lon === null || radiusKm === null) return null;
  return {
    band: typeof region.band === 'string' ? region.band : 'local',
    key: typeof region.key === 'string' ? region.key : null,
    center: { lat, lon },
    radiusKm,
  };
}

/**
 * Construct the proxy adapter without starting a request.
 * Both methods resolve `{ keyRequired: true }` on 503 {error:'no_key'};
 * otherwise a validated snapshot. Any other non-OK status throws an Error
 * whose `code` is the proxy's `error` field (null when the body had none).
 */
export function createWorldNewsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function request(url, signal) {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, { signal, cache: 'no-store' });
    let payload;
    try {
      payload = await response.json();
    } catch {
      /* status below remains authoritative */
    }
    signal?.throwIfAborted();
    if (!response.ok) {
      if (response.status === 503 && payload?.error === 'no_key')
        return { keyRequired: true };
      const code = typeof payload?.error === 'string' ? payload.error : null;
      const error = new Error(
        ERROR_MESSAGES[code] || `World News HTTP ${response.status}`,
      );
      error.code = code;
      throw error;
    }
    const rows = normalizeWorldNewsSnapshot(payload);
    if (!rows) throw new Error('Malformed news snapshot');
    const budget =
      payload.budget && typeof payload.budget === 'object'
        ? {
            spent: finiteOrNull(payload.budget.spent),
            limit: finiteOrNull(payload.budget.limit),
            date:
              typeof payload.budget.date === 'string'
                ? payload.budget.date
                : null,
          }
        : null;
    const quota =
      payload.quota && typeof payload.quota === 'object'
        ? {
            left: finiteOrNull(payload.quota.left),
            used: finiteOrNull(payload.quota.used),
          }
        : null;
    return {
      rows,
      fetchedAt: finiteOrNull(payload.fetchedAt),
      stale: payload.stale === true,
      blocked: typeof payload.blocked === 'string' ? payload.blocked : null,
      budget,
      quota,
      requested: finiteOrNull(payload.requested) ?? rows.length,
      unplacedCount: finiteOrNull(payload.unplacedCount) ?? 0,
      morePagesLeft: finiteOrNull(payload.morePagesLeft) ?? 0,
      costPerRequest: finiteOrNull(payload.costPerRequest),
      costMeasured: payload.costMeasured === true,
      // How long the browser may keep this batch on the map. The provider's
      // terms cap caching at one hour and the proxy enforces the same window;
      // an accumulating map has to honour it too.
      retentionMs: finiteOrNull(payload.retentionMs),
      // Which feed this batch IS, as the proxy describes it — not what was
      // asked for. The global endpoint carries no region, so a plain refresh
      // landing on top of a pinned circle correctly reads as global again.
      region: normalizeRegion(payload.region),
      regionFetchesLeft: finiteOrNull(payload.regionFetchesLeft),
    };
  }
  return {
    /** GET /api/world-news — the retained batch, newest first. */
    getSnapshot({ signal } = {}) {
      return request(API_URL, signal);
    },
    /** GET /api/world-news/more — one extra page merged into that batch. */
    loadMore({ signal } = {}) {
      return request(MORE_URL, signal);
    },
    /**
     * GET /api/world-news?region=view&… — one page filtered to a circle.
     * @param {{center:{lat:number,lon:number}, radiusKm:number}} region
     *   Local-band descriptor from resolveViewerRegion; a global-band view has
     *   no circle to ask for and is rejected here rather than upstream.
     * @param {AbortSignal} [signal]
     * @returns {Promise<object>} Snapshot, as getSnapshot.
     */
    getRegionSnapshot({ region, signal } = {}) {
      const query = newsRegionQueryString(region);
      if (!query) {
        const error = new Error(ERROR_MESSAGES.bad_region);
        error.code = 'bad_region';
        return Promise.reject(error);
      }
      return request(`${API_URL}?${query}`, signal);
    },
  };
}
