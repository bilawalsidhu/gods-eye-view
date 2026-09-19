import { API_URL, MORE_URL } from './policy.js';
import { normalizeWorldNewsSnapshot } from './records.js';

/** Proxy error codes → the human message the row shows (contract v1). */
const ERROR_MESSAGES = Object.freeze({
  bad_key: 'World News key rejected',
  quota: 'World News quota exhausted',
  budget: 'daily news budget exhausted',
  rate_limited: 'World News rate-limited',
  pages: 'extra pages exhausted',
});

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
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
  };
}
