import { readResponseJsonCapped } from './common/http.js';

const RESOURCE =
  'https://api.data.gov.in/resource/3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69';
const TTL = 20 * 60_000;
const PAGE_SIZE = 1000;
const MAX_ROWS = 20_000;
const FIELDS = [
  'country',
  'state',
  'city',
  'station',
  'latitude',
  'longitude',
  'last_update',
  'pollutant_id',
  'pollutant_min',
  'pollutant_max',
  'pollutant_avg',
  'min_value',
  'max_value',
  'avg_value',
];

/** Fixed-origin, bounded OGD proxy. Private API keys never leave the server. */
export function cpcbProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiKey = () => process.env.DATA_GOV_IN_API_KEY,
  now = () => Date.now(),
  timeoutMs = 30_000,
} = {}) {
  let cache = null;
  let cachedAt = 0;
  let inflight = null;
  let retryAt = 0;
  async function refresh(key) {
    const signal = AbortSignal.timeout(timeoutMs);
    const records = [];
    let total = null;
    for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
      const url = new URL(RESOURCE);
      url.search = new URLSearchParams({
        'api-key': key,
        format: 'json',
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      const response = await fetchImpl(url, {
        signal,
        redirect: 'error',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('OGD request failed');
      }
      const page = await readResponseJsonCapped(
        response,
        2 * 1024 * 1024,
        signal,
      );
      const count = Number(page.total);
      if (
        !Array.isArray(page.records) ||
        page.records.length > PAGE_SIZE ||
        page.total === null ||
        page.total === undefined ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > MAX_ROWS ||
        (total !== null && total !== count)
      )
        throw new Error('Invalid OGD page');
      total = count;
      for (const row of page.records) {
        if (!row || typeof row !== 'object' || Array.isArray(row))
          throw new Error('Invalid OGD row');
        records.push(
          Object.fromEntries(
            FIELDS.map((field) => [
              field,
              typeof row[field] === 'string'
                ? row[field].slice(0, 500)
                : typeof row[field] === 'number'
                  ? row[field]
                  : null,
            ]),
          ),
        );
      }
      if (records.length === total) return { records };
      if (page.records.length !== PAGE_SIZE || records.length > total)
        throw new Error('Incomplete OGD snapshot');
    }
    throw new Error('OGD row cap exceeded');
  }
  const install = (server) => {
    server.middlewares.use('/api/air-quality/india', async (req, res, next) => {
      if ((req.url || '/').split('?')[0] !== '/') return next();
      const send = (status, body) => {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return send(405, { error: 'method_not_allowed' });
      }
      const key = apiKey()?.trim();
      if (!key) return send(503, { error: 'key_required' });
      if (cache && now() - cachedAt < TTL)
        return send(200, { ...cache, stale: false });
      if (!inflight && now() >= retryAt) {
        inflight = refresh(key)
          .then((snapshot) => {
            cache = snapshot;
            cachedAt = now();
            retryAt = 0;
          })
          .catch(() => {
            // Never log upstream error text or a URL: either could contain the key.
            retryAt = now() + 60_000;
          })
          .finally(() => {
            inflight = null;
          });
      }
      await inflight;
      if (cache && now() - cachedAt <= 6 * 60 * 60_000)
        return send(200, { ...cache, stale: now() - cachedAt >= TTL });
      return send(502, { error: 'upstream_unavailable' });
    });
  };
  return {
    name: 'cpcb-air-quality',
    configureServer: install,
    configurePreviewServer: install,
  };
}
