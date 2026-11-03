import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { normalizeAqhiStations, normalizeAqhiObservations } from './model.js';
import { normalizeCpcbRecords } from './cpcb.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel and the Weather card show them translated.
const msg = (text) => text;

const COLLECTIONS_ROOT = 'https://api.weather.gc.ca/collections';
const STATIONS_URL = `${COLLECTIONS_ROOT}/aqhi-stations/items`;
const OBSERVATIONS_URL = `${COLLECTIONS_ROOT}/aqhi-observations-realtime/items`;

/** Comfortably above Canada's ~134 stations without inviting a huge page. */
const STATION_LIMIT = 500;
const OBSERVATION_LIMIT = 500;
/** Station geometry is near-static — a few changes a year. Refetch twice a day. */
const STATION_TTL_MS = 12 * 60 * 60 * 1000;
/** A full 500-row GeoJSON page is a few hundred KB; anything past this is not a page. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Select one network per request; never rank different index scales together. */
export function createAirQualitySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  timeoutMs = 35_000,
} = {}) {
  const eccc = createEcccAirQualitySource({ fetchImpl, now });
  let stale = false;
  return {
    providers: ['eccc', 'cpcb'],
    getStatus: () => ({ stale }),
    async getSnapshot({ provider = 'eccc', pollutant = 'PM2.5', signal } = {}) {
      stale = false;
      if (provider === 'eccc') return eccc.getSnapshot({ signal });
      if (provider !== 'cpcb') throw new Error('Unknown air-quality provider');
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl('/api/air-quality/india', {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        const payload = await readResponseJsonCapped(
          response,
          16 * 1024 * 1024,
          controller.signal,
        );
        if (!response.ok) {
          if (payload?.error === 'key_required')
            throw new Error(
              msg('India air quality requires a data.gov.in API key'),
            );
          throw new Error(msg('India air quality is unavailable'));
        }
        const readings = normalizeCpcbRecords(payload, {
          pollutant,
          now: now(),
        });
        if (!readings)
          throw new Error(msg('Malformed India air-quality response'));
        signal?.throwIfAborted();
        stale = payload.stale === true;
        return readings;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}

/**
 * Request and validate a complete ECCC AQHI snapshot before it can replace
 * displayed readings. The first registered air-quality provider.
 *
 * Two collections are involved. `aqhi-stations` is the catalog — it supplies
 * every reading its coordinates and is cached for twelve hours because it
 * barely changes. `aqhi-observations-realtime` is the hourly reading feed,
 * requested with `latest=true` so the response is current values rather than
 * the full observation history, which is roughly 2,000 rows nationally.
 *
 * The station catalog is only replaced when a refresh actually returns
 * stations, so a transient empty response cannot blank the layer.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - Injected fetch, for tests.
 * @param {() => number} [options.now] - Clock seam, for tests.
 * @param {number} [options.timeoutMs=15000] - Deadline for each request.
 * @returns {{getSnapshot: Function}}
 */
export function createEcccAirQualitySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  timeoutMs = 15_000,
} = {}) {
  /** @type {Map<string, object>} */
  let stations = new Map();
  let stationsFetchedAt = 0;

  /** One bounded GeoJSON page: deadline, caller abort, byte cap, row cap. */
  const getJson = async (url, limit, signal) => {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(msg('ECCC request timed out'))),
      timeoutMs,
    );
    try {
      signal?.throwIfAborted();
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`ECCC HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        MAX_RESPONSE_BYTES,
        controller.signal,
      );
      // The server's `limit` is a request, not a guarantee.
      if (Array.isArray(payload?.features) && payload.features.length > limit)
        return { ...payload, features: payload.features.slice(0, limit) };
      return payload;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };

  return {
    async getSnapshot({ signal } = {}) {
      const clock = now();
      if (stations.size === 0 || clock - stationsFetchedAt > STATION_TTL_MS) {
        const payload = await getJson(
          `${STATIONS_URL}?f=json&limit=${STATION_LIMIT}`,
          STATION_LIMIT,
          signal,
        );
        const next = normalizeAqhiStations(payload);
        if (!next) throw new Error(msg('Malformed AQHI station response'));
        // An empty refresh must not wipe a good catalog.
        if (next.size > 0) {
          stations = next;
          stationsFetchedAt = clock;
        }
      }
      if (stations.size === 0)
        throw new Error(msg('No AQHI stations available'));

      const payload = await getJson(
        `${OBSERVATIONS_URL}?f=json&latest=true&limit=${OBSERVATION_LIMIT}`,
        OBSERVATION_LIMIT,
        signal,
      );
      const readings = normalizeAqhiObservations(payload, stations, clock);
      if (!readings)
        throw new Error(msg('Malformed AQHI observation response'));
      return readings;
    },
  };
}
