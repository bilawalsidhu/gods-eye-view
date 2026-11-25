import { cachedSnapshot } from './common/snapshotCache.js';
import { admitSameSite } from './common/same-site.js';
import { readResponseJsonCapped } from './common/http.js';
import { normalizeCpcbRecords } from '../../src/layers/airQuality/cpcb.js';

const RESOURCE =
  'https://api.data.gov.in/resource/3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69';
const TTL = 20 * 60_000;
const PAGE_SIZE = 1000;
const MAX_ROWS = 20_000;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
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
} = {}) {
  const shared = cachedSnapshot({
    ttlMs: TTL,
    retryMs: 60_000,
    staleMs: 6 * 3600_000,
    acquire: refresh,
    now,
  });
  let encoded = null;
  /** The answer's JSON, encoded once for every request sharing it. */
  const body = (snapshot, stale) => {
    if (encoded?.snapshot !== snapshot || encoded.stale !== stale)
      encoded = {
        snapshot,
        stale,
        text: JSON.stringify({ ...snapshot, stale }),
      };
    return encoded.text;
  };
  async function refresh(key) {
    const signal = AbortSignal.timeout(timeoutMs);
    const seen = new Map();
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
        !(
          Number.isSafeInteger(page.total) ||
          (typeof page.total === 'string' && /^\d+$/.test(page.total))
        ) ||
        page.records.length > PAGE_SIZE ||
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
        const record = Object.fromEntries(
          FIELDS.map((field) => [
            field,
            typeof row[field] === 'string'
              ? row[field].slice(0, 500)
              : typeof row[field] === 'number'
                ? row[field]
                : null,
          ]),
        );
        const identity = JSON.stringify([
          record.state,
          record.city,
          record.station,
          record.pollutant_id,
        ]);
        if ((seen.get(identity) ?? offset) !== offset)
          throw new Error('Inconsistent OGD pages');
        seen.set(identity, offset);
        records.push(record);
      }
      if (records.length === total) {
        const normalized = normalizeCpcbRecords({ records }, { now: now() });
        if (!normalized || (records.length && !normalized.stations.length))
          throw new Error('Unrecognised OGD rows');
        const snapshot = {
          schemaVersion: 1,
          fetchedAt: now(),
          source: 'CPCB',
          attribution:
            'Central Pollution Control Board via Open Government Data Platform India',
          sourceUrl:
            'https://www.data.gov.in/catalog/real-time-air-quality-index',
          readings: normalized.readings,
        };
        if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES)
          throw new Error('OGD snapshot too large');
        return snapshot;
      }
      if (page.records.length !== PAGE_SIZE || records.length > total)
        throw new Error('Incomplete OGD snapshot');
    }
    throw new Error('OGD row cap exceeded');
  }
  const install = (server) => {
    server.middlewares.use('/api/air-quality/india', async (req, res, next) => {
      if ((req.url || '/').split('?')[0] !== '/') return next();
      if (admitSameSite(req, res)) return;
      const send = (status, body) => {
        if (res.destroyed) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return send(405, { error: 'method_not_allowed' });
      }
      const key = apiKey()?.trim();
      // The layer reads 428 as "needs a key" (Provider Settings).
      if (!key) return send(428, { error: 'no_key' });
      let answer;
      try {
        answer = await shared.get(key);
      } catch (error) {
        // Never log upstream error text or a URL: either could contain the key.
        return [401, 403].includes(error?.status)
          ? send(error.status, { error: 'key_rejected' })
          : send(502, { error: 'upstream_unavailable' });
      }
      // The layer shows "Provider key rejected. Check Provider Settings."
      if ([401, 403].includes(answer.failure?.status))
        return send(answer.failure.status, { error: 'key_rejected' });
      if (!res.destroyed) send(200, body(answer.snapshot, answer.stale));
    });
  };
  return {
    name: 'cpcb-air-quality',
    configureServer: install,
    configurePreviewServer: install,
  };
}
