import { readResponseJsonCapped } from './common/http.js';
import { normalizeCpcbRecords } from '../../src/layers/airQuality/cpcb.js';

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

/**
 * Fixed-origin, bounded OGD acquisition answering the shared air-quality
 * snapshot (schemaVersion 1). Private API keys never leave the server.
 */
export function cpcbProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiKey = () => process.env.DATA_GOV_IN_API_KEY,
  now = () => Date.now(),
  timeoutMs = 30_000,
  // Rating settings for the normalizer; default to the module's.
  unitsVerified,
  averagingMinutes,
} = {}) {
  let cache = null;
  let cachedAt = 0;
  let inflight = null;
  let retryAt = 0;
  /** 401 or 403 while OGD rejects the key; cleared by a good refresh. */
  let keyRejected = null;
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
        throw Object.assign(new Error('OGD request failed'), {
          status: response.status,
        });
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
      if (records.length === total) {
        const snapshot = normalizeCpcbRecords(
          { records },
          { now: now(), unitsVerified, averagingMinutes },
        );
        if (!snapshot) throw new Error('Invalid OGD snapshot');
        return {
          schemaVersion: 1,
          fetchedAt: now(),
          source: 'CPCB',
          attribution:
            'Central Pollution Control Board via Open Government Data Platform India',
          sourceUrl:
            'https://www.data.gov.in/catalog/real-time-air-quality-index',
          ...snapshot,
        };
      }
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
      // The layer reads 428 as "needs a key" (Provider Settings).
      if (!key) return send(428, { error: 'no_key' });
      if (cache && now() - cachedAt < TTL)
        return send(200, { ...cache, stale: false });
      if (!inflight && now() >= retryAt) {
        inflight = refresh(key)
          .then((snapshot) => {
            cache = snapshot;
            cachedAt = now();
            retryAt = 0;
            keyRejected = null;
          })
          .catch((error) => {
            // Never log upstream error text or a URL: either could contain the key.
            retryAt = now() + 60_000;
            keyRejected = [401, 403].includes(error?.status)
              ? error.status
              : null;
          })
          .finally(() => {
            inflight = null;
          });
      }
      await inflight;
      // The layer shows "Provider key rejected. Check Provider Settings."
      if (keyRejected) return send(keyRejected, { error: 'key_rejected' });
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
