import { readResponseJsonCapped } from '../../src/sources/httpBody.js';
import {
  MAX_CONAE_RECORDS,
  currentConaeRecords,
  parseConaeGoes,
} from './conae-goes/parse.js';

const TTL_MS = 10 * 60_000;
const RETRY_MS = 60_000;
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 32 * 1024 * 1024;
const ENDPOINT = 'https://geoservicios.conae.gov.ar/geoserver/FocosDeCalor/wfs';

/**
 * One optional CONAE cache per proxy instance, independent of FIRMS disk/quota.
 * No request is made at construction. The caller owns the server-side opt-in.
 */
export function createConaeGoesSource({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
} = {}) {
  let entry = null;
  let inflight = null;
  let retryAt = 0;
  let failed = false;

  async function refresh() {
    const params = new URLSearchParams({
      service: 'WFS',
      version: '1.0.0',
      request: 'GetFeature',
      typeName: 'FocosDeCalor:FocosGOES_24hs',
      outputFormat: 'application/json',
      srsName: 'EPSG:4326',
      maxFeatures: String(MAX_CONAE_RECORDS + 1),
    });
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetchImpl(ENDPOINT + '?' + params, {
      signal,
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error('CONAE HTTP ' + response.status);
    }
    const payload = await readResponseJsonCapped(response, MAX_BYTES, signal);
    const at = now();
    return { at, fires: parseConaeGoes(payload, at) };
  }

  function snapshot() {
    if (!entry) throw new Error('CONAE GOES unavailable');
    const fires = currentConaeRecords(entry.fires, now());
    const stale = failed || now() - entry.at >= TTL_MS;
    return {
      fetchedAt: entry.at,
      sourceLabel: 'CONAE GOES',
      stale,
      ttlMs: TTL_MS,
      sources: [
        { source: 'CONAE GOES', count: fires.length, ok: !failed, stale },
      ],
      count: fires.length,
      fires,
    };
  }

  return {
    /** Cached acquisition with single-flight refresh and failure backoff. */
    async getSnapshot() {
      if (entry && now() - entry.at < TTL_MS && !failed) return snapshot();
      if (now() < retryAt) return snapshot();
      if (!inflight) {
        inflight = refresh()
          .then((fresh) => {
            entry = fresh;
            failed = false;
            retryAt = 0;
          })
          .catch(() => {
            failed = true;
            retryAt = now() + RETRY_MS;
          })
          .finally(() => {
            inflight = null;
          });
      }
      const pending = inflight;
      await pending;
      return snapshot();
    },
    /** Observe cache health without fetching either provider. */
    getStatus() {
      return {
        fetchedAt: entry?.at ?? null,
        count: entry ? currentConaeRecords(entry.fires, now()).length : null,
        stale: entry ? failed || now() - entry.at >= TTL_MS : false,
        unavailable: failed,
        ttlMs: TTL_MS,
      };
    },
  };
}
