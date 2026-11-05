import {
  SPC_PRODUCTS,
  SPC_SERVICE_URL,
  SPC_REFRESH_MS,
  SPC_BODY_LIMIT,
  normalizeSpcOutlook,
  spcSnapshotState,
} from '../../src/layers/spc/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

/** Four fixed NOAA queries; bounded memory, transport, retries and last-good age. */
export function spcOutlooksProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  timeoutMs = 15_000,
} = {}) {
  const cache = new Map(),
    failures = new Map(),
    inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });
  async function acquire(product) {
    const previous = cache.get(product);
    if (previous && now() - previous.savedAt < SPC_REFRESH_MS)
      return previous.payload;
    const fallback = () => {
      if (
        previous &&
        !['expired', 'unavailable'].includes(
          spcSnapshotState(previous.snapshot, now()),
        )
      )
        return { ...previous.payload, stale: true };
      throw new Error('spc_unavailable');
    };
    if (now() < (failures.get(product) ?? 0)) return fallback();
    try {
      const { promise } = coalesceProxyRequest(inFlight, product, async () => {
        const query = new URLSearchParams({
          where: '1=1',
          outFields: 'objectid,dn,issue,valid,expire,label',
          outSR: '4326',
          f: 'geojson',
        });
        const signal = AbortSignal.timeout(timeoutMs);
        const response = await fetchImpl(
          `${SPC_SERVICE_URL}/${SPC_PRODUCTS[product].layer}/query?${query}`,
          { signal, redirect: 'error' },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('spc_upstream_unavailable');
        }
        const body = await readResponseJsonCapped(
          response,
          SPC_BODY_LIMIT,
          signal,
        );
        const savedAt = now();
        const snapshot = normalizeSpcOutlook(body, {
          product,
          fetchedAt: savedAt,
        });
        const payload = { ...body, fetchedAt: savedAt };
        cache.set(product, { payload, snapshot, savedAt });
        failures.delete(product);
        return payload;
      });
      return await promise;
    } catch {
      failures.set(product, now() + 30_000);
      return fallback();
    }
  }
  async function handler(req, res) {
    const send = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429
          ? { 'Retry-After': '60' }
          : status === 502
            ? { 'Retry-After': '30' }
            : {}),
        ...(body.stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' });
    const path = (req.url || '').split('?')[0];
    const product = path.slice(1);
    if (!Object.hasOwn(SPC_PRODUCTS, product))
      return send(404, { error: 'unknown_product' });
    // Query parameters are not a proxy API: no client-controlled URLs, fields or filters.
    if ((req.url || '').includes('?'))
      return send(400, { error: 'unexpected_query' });
    if (!allow(clientKey(req))) return send(429, { error: 'rate_limited' });
    try {
      send(200, await acquire(product));
    } catch {
      send(502, { error: 'spc_outlooks_unavailable' });
    }
  }
  return {
    name: 'spc-outlooks',
    configureServer({ middlewares }) {
      middlewares.use('/api/spc-outlooks', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/spc-outlooks', handler);
    },
  };
}
