import { cachedSnapshot } from './common/snapshotCache.js';
import { admitSameSiteKeyless } from './common/same-site.js';
import { readResponseJsonCapped } from './common/http.js';
import {
  normalizeSaStations,
  normalizeSaMeasurements,
} from '../../src/layers/airQuality/southAfrica.js';

const ROOT = 'https://saaqis.environment.gov.za/';
const TTL = 20 * 60 * 1000;
const MAX_BYTES = 8 * 1024 * 1024;

/** Anonymous public portal session. Tokens/cookies never leave the server. */
export function createSaAcquisition({
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const shared = cachedSnapshot({
    ttlMs: TTL,
    retryMs: 60_000,
    staleMs: 6 * 3600_000,
    acquire,
    now,
  });
  async function acquire() {
    const signal = AbortSignal.timeout(45_000);
    const read = async (url, options) => {
      const response = await fetchImpl(url, {
        ...options,
        signal,
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`SAAQIS HTTP ${response.status}`);
      return {
        response,
        data: await readResponseJsonCapped(response, MAX_BYTES, signal),
      };
    };
    const session = await read(`${ROOT}Account/GetApiFromBackToken`, {
      method: 'POST',
      body: '',
      headers: { Accept: 'application/json' },
    });
    if (typeof session.data?.key !== 'string' || !session.data.key)
      throw new Error('SAAQIS session unavailable');
    const cookie = (session.response.headers.getSetCookie?.() || [])
      .map((value) => value.split(';')[0])
      .join('; ');
    const get = async (path) =>
      (
        await read(`${ROOT}api`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: session.data.key,
            Cookie: cookie,
            Referer: ROOT,
          },
          body: JSON.stringify({
            url: path,
            includeEnvistaPrefix: true,
            header: { Accept: 'application/json' },
            Method: 'GET',
            body: null,
            isMaintainView: false,
          }),
        })
      ).data;
    const regions = await get('regions');
    const stations = normalizeSaStations(regions);
    const ids = [];
    for (const region of regions) {
      if (!region.stations.length) continue;
      const id =
        typeof region.regionId === 'string' && /^\d+$/.test(region.regionId)
          ? Number(region.regionId)
          : region.regionId;
      if (!Number.isSafeInteger(id)) throw new Error('Malformed SAAQIS region');
      ids.push(id);
    }
    if (!ids.length) throw new Error('SAAQIS regions unavailable');
    const entries = await get(
      `regions/data/latest?unitConversion=true&regionsIds=${ids.join(',')}&timebase=60`,
    );
    // Concentrations only: SAAQIS's own index is not asked for.
    const readings = normalizeSaMeasurements(entries, stations);
    const known = new Set(stations.map((s) => s.stationId));
    if (entries.length && !entries.some((e) => known.has(String(e?.stationId))))
      throw new Error('Malformed SAAQIS observations');
    return {
      schemaVersion: 1,
      fetchedAt: now(),
      source: 'SAAQIS',
      attribution:
        'South African Air Quality Information System; originating monitoring networks',
      sourceUrl: ROOT,
      stations,
      readings,
    };
  }
  return {
    async getSnapshot() {
      try {
        const { snapshot, stale } = await shared.get();
        // Last-good data stays labelled stale until a refresh succeeds.
        return { ...snapshot, stale };
      } catch {
        throw new Error('SAAQIS observations unavailable');
      }
    },
  };
}

/**
 * Whether the operator switched South Africa on. Only "1" does.
 *
 * Off by default: SAAQIS is read through the portal's own session API and
 * publishes no reuse terms for it, so nothing here contacts the portal unless
 * the operator sets `SAAQIS_ENABLED=1`. Without it the route answers "not
 * configured" and the layer leaves South Africa out, with no failure.
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function saaqisEnabled(env = process.env) {
  return String(env.SAAQIS_ENABLED || '').trim() === '1';
}

const NOT_CONFIGURED = Object.freeze({
  unavailable: true,
  code: 'not_configured',
  reason: 'South Africa air quality not enabled (SAAQIS_ENABLED=1)',
});

export function southAfricaAirQualityProxy({
  env = process.env,
  ...options
} = {}) {
  const source = createSaAcquisition(options);
  const handler = async (req, res) => {
    if (admitSameSiteKeyless(req, res)) return;
    const send = (status, data) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(data));
    };
    if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' });
    // This is a fixed national snapshot, never an arbitrary upstream proxy.
    if (req.url !== '/' && req.url !== '')
      return send(400, { error: 'invalid_air_quality_query' });
    if (!saaqisEnabled(env)) return send(200, NOT_CONFIGURED);
    try {
      send(200, { ...(await source.getSnapshot()), stations: undefined });
    } catch {
      send(503, { error: 'SAAQIS observations unavailable' });
    }
  };
  return {
    name: 'south-africa-air-quality',
    configureServer({ middlewares }) {
      middlewares.use('/api/air-quality/south-africa', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/air-quality/south-africa', handler);
    },
  };
}
