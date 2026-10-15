import { normalizeBorderWaitSnapshot } from '../../src/layers/borderWaits/records.js';
import {
  attachCanadaBound,
  parseCbsaCsv,
} from '../../src/layers/borderWaits/canada.js';
import {
  readResponseJsonCapped,
  readResponseTextCapped,
  coalesceProxyRequest,
} from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// U.S. Customs and Border Protection land-border wait times (public, keyless).
// One document carries every crossing CBP reports, about 135 KB.
const API_URL = 'https://bwt.cbp.gov/api/bwtnew';
// Canada Border Services Agency waits into Canada (Open Government Licence –
// Canada, keyless), about 3 KB for its busiest offices. Optional: CBP's
// snapshot is served whether or not CBSA answers.
const CBSA_URL = 'https://www.cbsa-asfc.gc.ca/bwt-taf/bwt-eng.csv';
// CBP refreshes lanes roughly hourly; five minutes keeps the globe current
// without asking a federal endpoint for the same bytes on every viewer poll.
const TTL_MS = 300_000;
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/** Fixed-origin, bounded CBP and CBSA wait-time route for dev and preview. */
export function borderWaitsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  warn = (...args) => console.warn(...args),
} = {}) {
  const cache = new Map();
  let reportedUnlocated = '';
  let reportedUnmatched = '';
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });

  async function upstream(url) {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetchImpl(url, { signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    return { response, signal };
  }

  async function fetchCbp() {
    const { response, signal } = await upstream(API_URL);
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

  async function fetchCbsa() {
    const { response, signal } = await upstream(CBSA_URL);
    const parsed = parseCbsaCsv(
      await readResponseTextCapped(response, 256 * 1024, signal),
    );
    if (!parsed) throw new Error('invalid_snapshot');
    const unmatched = parsed.unmatched.join(',');
    if (unmatched && unmatched !== reportedUnmatched)
      warn(`[BorderWaits] No CBP crossing for CBSA offices: ${unmatched}`);
    reportedUnmatched = unmatched;
    return { fetchedAt: now(), byCrossing: parsed.byCrossing };
  }

  /** Serve a fresh value, or the last good one marked stale when the source fails. */
  async function acquire(key, load) {
    const previous = cache.get(key);
    if (previous && now() - previous.savedAt < TTL_MS)
      return { value: previous.value, stale: false };
    try {
      const { promise } = coalesceProxyRequest(inFlight, key, async () => {
        const value = await load();
        cache.set(key, { value, savedAt: now() });
        return value;
      });
      return { value: await promise, stale: false };
    } catch (error) {
      if (previous) return { value: previous.value, stale: true };
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
    const [cbp, cbsa] = await Promise.allSettled([
      acquire('cbp', fetchCbp),
      acquire('cbsa', fetchCbsa),
    ]);
    if (cbp.status === 'rejected')
      return json(502, { error: 'border_waits_unavailable' });
    const { value, stale } = cbp.value;
    const canada =
      cbsa.status === 'fulfilled'
        ? {
            available: true,
            fetchedAt: cbsa.value.value.fetchedAt,
            ...(cbsa.value.stale ? { stale: true } : {}),
          }
        : { available: false };
    json(
      200,
      {
        ...value,
        rows: attachCanadaBound(
          value.rows,
          cbsa.status === 'fulfilled' ? cbsa.value.value.byCrossing : {},
        ),
        canada,
        ...(stale ? { stale: true } : {}),
      },
      stale,
    );
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
