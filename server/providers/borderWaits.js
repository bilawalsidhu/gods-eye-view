import { normalizeBorderWaitSnapshot } from '../../src/layers/borderWaits/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// U.S. Customs and Border Protection land-border wait times (public, keyless).
// One document carries every crossing CBP reports, about 135 KB.
const API_URL = 'https://bwt.cbp.gov/api/bwtnew';
// CBP refreshes lanes roughly hourly; five minutes keeps the globe current
// without asking a federal endpoint for the same bytes on every viewer poll.
const TTL_MS = 300_000;
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/** Fixed-origin, bounded CBP wait-time route for dev and preview. */
export function borderWaitsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  warn = (...args) => console.warn(...args),
} = {}) {
  let snapshot = null;
  let savedAt = 0;
  let reportedUnlocated = '';
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });

  async function fetchSnapshot() {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetchImpl(API_URL, { signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    const normalized = normalizeBorderWaitSnapshot(
      await readResponseJsonCapped(response, MAX_BYTES, signal),
    );
    if (!normalized) throw new Error('invalid_snapshot');
    // A crossing CBP adds needs a bundled location before it can be drawn.
    const unlocated = normalized.unlocated.join(',');
    if (unlocated && unlocated !== reportedUnlocated)
      warn(`[BorderWaits] No location for CBP crossings: ${unlocated}`);
    reportedUnlocated = unlocated;
    return { fetchedAt: now(), ...normalized };
  }

  async function acquire() {
    if (snapshot && now() - savedAt < TTL_MS)
      return { value: snapshot, stale: false };
    try {
      const { promise } = coalesceProxyRequest(
        inFlight,
        'snapshot',
        async () => {
          const value = await fetchSnapshot();
          snapshot = value;
          savedAt = now();
          return value;
        },
      );
      return { value: await promise, stale: false };
    } catch (error) {
      if (snapshot) return { value: snapshot, stale: true };
      throw error;
    }
  }

  async function handler(req, res) {
    const json = (status, value, stale = false) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const { value, stale } = await acquire();
      json(200, stale ? { ...value, stale: true } : value, stale);
    } catch {
      json(502, { error: 'border_waits_unavailable' });
    }
  }

  return {
    name: 'border-waits',
    configureServer({ middlewares }) {
      middlewares.use('/api/border-waits', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/border-waits', handler);
    },
  };
}
