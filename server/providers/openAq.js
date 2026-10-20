import { readResponseJsonCapped } from './common/http.js';
import {
  normalizeOpenAqLocations,
  normalizeOpenAqLatest,
} from '../../src/layers/airQuality/openAq.js';

// Geographic scope is configuration, not a station/city allowlist. UN M49 Africa
// countries/areas, including Indian/Atlantic Ocean islands and territories.
// https://unstats.un.org/unsd/methodology/m49/
export const AFRICA_SCOPE = Object.freeze({
  id: 'africa',
  countries: Object.freeze(
    'DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU YT MA MZ NA NE NG RE RW SH ST SN SC SL SO ZA SS SD TZ TG TN UG EH ZM ZW IO TF'.split(
      ' ',
    ),
  ),
});
const ROOT = 'https://api.openaq.org/v3/';
const HOUR = 3600_000;
const error = (status, message) =>
  Object.assign(new Error(message), { status });

/** A bounded, demand-driven regional acquisition with injected scope and IO. */
export function createOpenAqAcquisition({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  getKey = () => process.env.OPENAQ_API_KEY || '',
  scope = AFRICA_SCOPE,
  batchSize = 24,
} = {}) {
  if (
    !scope.countries?.length ||
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 24
  )
    throw new TypeError('Invalid OpenAQ scope or batch size');
  let keyAtCache = null,
    catalog = null,
    catalogAt = 0,
    pending = null,
    cached = null,
    cachedAt = 0,
    blockedUntil = 0;
  const readings = new Map(),
    checked = new Map();
  let calls = [];
  async function acquire(key) {
    const signal = AbortSignal.timeout(40_000);
    async function get(path) {
      const time = now();
      calls = calls.filter((t) => time - t < HOUR);
      if (
        time < blockedUntil ||
        calls.length >= 1800 ||
        calls.filter((t) => time - t < 60_000).length >= 45
      )
        throw error(429, 'OpenAQ request budget reached');
      calls.push(time);
      const res = await fetchImpl(ROOT + path, {
        headers: { 'X-API-Key': key, Accept: 'application/json' },
        signal,
        redirect: 'error',
      });
      if (!res.ok) {
        if (res.status === 429) {
          const seconds = Number(res.headers.get('Retry-After'));
          blockedUntil =
            time +
            (Number.isFinite(seconds) && seconds > 0
              ? Math.min(seconds, 86400) * 1000
              : 60_000);
        }
        throw error(
          [401, 403, 429].includes(res.status) ? res.status : 503,
          'OpenAQ request unavailable',
        );
      }
      const data = await readResponseJsonCapped(res, 8 * 1024 * 1024, signal);
      if (!Array.isArray(data?.results) || data.results.length > 1000)
        throw error(503, 'Malformed OpenAQ response');
      return data;
    }
    if (!catalog || now() - catalogAt > HOUR) {
      const countries = await get('countries?limit=1000&page=1');
      const ids = countries.results
        .filter(
          (c) => scope.countries.includes(c.code) && Number.isSafeInteger(c.id),
        )
        .map((c) => c.id);
      const locations = [];
      if (ids.length) {
        let complete = false;
        for (let page = 1; page <= 10; page++) {
          const data = await get(
            `locations?countries_id=${ids.join(',')}&limit=1000&page=${page}&order_by=id&sort_order=asc`,
          );
          locations.push(...data.results);
          if (
            data.results.length < 1000 ||
            (typeof data.meta?.found === 'number' &&
              Number.isFinite(data.meta.found) &&
              locations.length >= Number(data.meta.found))
          ) {
            complete = true;
            break;
          }
        }
        if (!complete)
          throw error(503, 'OpenAQ catalog exceeds acquisition limit');
      }
      catalog = normalizeOpenAqLocations(locations).filter((s) =>
        scope.countries.includes(s.country),
      );
      catalogAt = now();
      const retained = new Set(catalog.map((station) => station.stationId));
      for (const id of readings.keys())
        if (!retained.has(id)) readings.delete(id);
      for (const id of checked.keys())
        if (!retained.has(id)) checked.delete(id);
    }
    const eligible = catalog.filter(
      (s) => !s.lastObservedMs || now() - s.lastObservedMs <= 6 * HOUR,
    );
    const due = eligible
      .filter((s) => now() - (checked.get(s.stationId) || 0) >= 20 * 60_000)
      .sort(
        (a, b) =>
          (checked.get(a.stationId) || 0) - (checked.get(b.stationId) || 0) ||
          a.stationId.localeCompare(b.stationId),
      )
      .slice(0, batchSize);
    let failed = false;
    for (const station of due) {
      try {
        const result = await get(
          `locations/${station.stationId}/latest?limit=1000&page=1`,
        );
        if (result.results.length === 1000)
          throw error(503, 'OpenAQ station exceeds acquisition limit');
        readings.set(
          station.stationId,
          normalizeOpenAqLatest(station, result.results, now()),
        );
        checked.set(station.stationId, now());
      } catch (e) {
        if ([401, 403, 429].includes(e.status)) throw e;
        failed = true;
        checked.set(station.stationId, now());
        if (signal.aborted) break;
      }
    }
    const fresh = [...readings.values()]
      .flat()
      .filter((r) => now() - r.observedMs <= 6 * HOUR);
    return {
      schemaVersion: 1,
      fetchedAt: now(),
      source: 'OpenAQ',
      scope: scope.id,
      sourceUrl: 'https://openaq.org/',
      stations: catalog,
      readings: fresh,
      checked: eligible.filter((s) => readings.has(s.stationId)).length,
      eligible: eligible.length,
      countriesReporting: new Set(fresh.map((r) => r.country)).size,
      partial: failed || eligible.some((s) => !readings.has(s.stationId)),
      stale: failed,
    };
  }
  return {
    async getSnapshot() {
      const key = getKey().trim();
      if (!key) throw error(428, 'OpenAQ key required');
      if (key !== keyAtCache) {
        if (pending) await pending.catch(() => {});
        keyAtCache = key;
        catalog = null;
        cached = null;
        readings.clear();
        checked.clear();
      }
      if (cached && now() - cachedAt < 60_000) return cached;
      if (!pending)
        pending = acquire(key)
          .then((value) => {
            cached = value;
            cachedAt = now();
            return value;
          })
          .catch((e) => {
            if (
              cached &&
              ![401, 403].includes(e.status) &&
              now() - cachedAt <= 6 * HOUR
            )
              return { ...cached, stale: true, partial: true };
            throw e;
          })
          .finally(() => {
            pending = null;
          });
      return pending;
    },
  };
}

/** Fixed local route. Browser never supplies an upstream URL or credential. */
export function openAqProxy(options = {}) {
  const source = createOpenAqAcquisition(options);
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
    if (req.url !== '/' && req.url !== '')
      return send(400, { error: 'invalid_air_quality_query' });
    try {
      send(200, await source.getSnapshot());
    } catch (e) {
      send(e.status || 503, {
        error: e.status === 428 ? 'no_key' : 'OpenAQ unavailable',
      });
    }
  };
  const register = ({ middlewares }) => {
    middlewares.use('/api/air-quality/openaq', handler);
  };
  return {
    name: 'openaq-air-quality',
    configureServer: register,
    configurePreviewServer: register,
  };
}
