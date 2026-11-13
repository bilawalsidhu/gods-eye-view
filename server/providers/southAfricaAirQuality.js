import { readResponseJsonCapped } from './common/http.js';
import {
  attachSaIndexes,
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
  let cache = null;
  let pending = null;
  let retryAfter = 0;
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
    const ids = regions
      .filter(
        (region) =>
          region.stations.length && Number.isSafeInteger(region.regionId),
      )
      .map((region) => region.regionId);
    if (!ids.length) throw new Error('SAAQIS regions unavailable');
    const entries = await get(
      `regions/data/latest?unitConversion=true&regionsIds=${ids.join(',')}&timebase=60`,
    );
    // Index availability must not suppress valid concentrations.
    let indexes = null;
    try {
      indexes = await get('stations/index/latest?hoursBack=6');
    } catch {
      /* optional provider rating */
    }
    return {
      schemaVersion: 1,
      fetchedAt: now(),
      source: 'SAAQIS',
      attribution:
        'South African Air Quality Information System; originating monitoring networks',
      sourceUrl: ROOT,
      stations,
      readings: attachSaIndexes(
        normalizeSaMeasurements(entries, stations),
        indexes,
      ),
    };
  }
  return {
    async getSnapshot() {
      if (cache && now() - cache.fetchedAt < TTL)
        return { ...cache, stale: false };
      if (!pending && now() >= retryAfter) {
        pending = acquire()
          .then((value) => {
            cache = value;
            return value;
          })
          .catch((error) => {
            retryAfter = now() + 60_000;
            throw error;
          })
          .finally(() => {
            pending = null;
          });
      }
      try {
        if (!pending) throw new Error('SAAQIS retry cooldown');
        return { ...(await pending), stale: false };
      } catch {
        // Last-good data stays labelled stale, never silently current.
        if (cache && now() - cache.fetchedAt <= 6 * 60 * 60 * 1000)
          return { ...cache, stale: true };
        throw new Error('SAAQIS observations unavailable');
      }
    },
  };
}

export function southAfricaAirQualityProxy(options = {}) {
  const source = createSaAcquisition(options);
  const handler = async (req, res) => {
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
    try {
      send(200, await source.getSnapshot());
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
