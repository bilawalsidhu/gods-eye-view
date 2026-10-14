import {
  CABA_CSV_URL,
  parseCabaTrafficCsv,
} from '../../src/layers/trafficEnforcement/records.js';
import {
  readResponseTextCapped,
  coalesceProxyRequest,
} from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

const CACHE_MS = 24 * 60 * 60 * 1000;
const REDIRECT_HOSTS = new Set([
  'data.buenosaires.gob.ar',
  'cdn.buenosaires.gob.ar',
]);

/** Fixed-source, bounded inventory download for development and preview. */
export function cabaTrafficProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cached = null;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  async function acquire() {
    if (cached && now() - cached.fetchedAt < CACHE_MS) return cached;
    const { promise } = coalesceProxyRequest(
      inFlight,
      'inventory',
      async () => {
        const signal = AbortSignal.timeout(20_000);
        let url = new URL(CABA_CSV_URL);
        for (let redirects = 0; redirects <= 3; redirects++) {
          const response = await fetchImpl(url.href, {
            signal,
            redirect: 'manual',
            headers: { Accept: 'text/csv' },
          });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            const location = response.headers.get('location');
            if (!location) throw new Error('Invalid inventory redirect');
            const next = new URL(location, url);
            if (
              next.protocol !== 'https:' ||
              !REDIRECT_HOSTS.has(next.hostname) ||
              next.port ||
              next.username ||
              next.password
            ) {
              throw new Error('Invalid inventory redirect');
            }
            url = next;
            continue;
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error('Inventory upstream unavailable');
          }
          const csv = await readResponseTextCapped(
            response,
            2 * 1024 * 1024,
            signal,
          );
          const rows = parseCabaTrafficCsv(csv);
          cached = { rows, fetchedAt: now() };
          return cached;
        }
        throw new Error('Too many inventory redirects');
      },
    );
    return promise;
  }

  async function handler(req, res) {
    const json = (status, payload) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
      });
      res.end(JSON.stringify(payload));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    // No caller-selected upstream URLs, paths or query parameters.
    if (req.url !== '/' && req.url !== '') {
      return json(404, { error: 'unknown_inventory_route' });
    }
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      json(200, await acquire());
    } catch {
      // Do not disguise failed refreshes as an empty or current inventory.
      json(502, { error: 'caba_inventory_unavailable' });
    }
  }

  return {
    name: 'caba-traffic-enforcement',
    configureServer({ middlewares }) {
      middlewares.use('/api/caba-traffic-enforcement', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/caba-traffic-enforcement', handler);
    },
  };
}
