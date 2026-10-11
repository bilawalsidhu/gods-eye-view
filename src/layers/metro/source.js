import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { requestWithDeadline } from '../../sources/requestDeadline.js';
import {
  buildCitiesQuery,
  buildStationsQuery,
  cityBoxKey,
  parseCities,
  parseStations,
  qidFromEntity,
  snapCityBox,
} from './model.js';

export const WIKIDATA_SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
export const WIKIDATA_CLIENT_ID =
  'GodsEyeView/metro (https://github.com/robarbms/gods-eye-view)';
const CITY_TIMEOUT_MS = 25_000;
const STATION_TIMEOUT_MS = 55_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const CITY_CACHE_LIMIT = 64;
const STATION_CACHE_LIMIT = 24;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** Uncached cities fetched in one station query; keeps it under WDQS's 60 s cap. */
const STATION_BATCH = 3;

function lruGet(cache, key, now) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (now - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function lruSet(cache, key, value, limit, now) {
  cache.delete(key);
  cache.set(key, { value, at: now });
  while (cache.size > limit) cache.delete(cache.keys().next().value);
}

/**
 * Keyless Wikidata Query Service source for metro stations.
 * Requests go straight from the browser (WDQS allows CORS) with a hard
 * deadline, body cap and caller cancellation; answers are cached per
 * snapped view box (cities) and per city (stations).
 */
export function createMetroSource({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  endpoint = WIKIDATA_SPARQL_ENDPOINT,
  now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function')
    throw new TypeError('Metro source requires fetch');
  const cityCache = new Map();
  const stationCache = new Map();

  async function sparql(query, { signal, timeoutMs }) {
    signal?.throwIfAborted();
    const url = `${endpoint}?${new URLSearchParams({ query, format: 'json' })}`;
    return requestWithDeadline(
      async (requestSignal) => {
        const response = await fetchImpl(url, {
          signal: requestSignal,
          headers: {
            Accept: 'application/sparql-results+json',
            // Wikimedia's User-Agent policy: browsers identify the tool here.
            'Api-User-Agent': WIKIDATA_CLIENT_ID,
          },
        });
        if (!response.ok) {
          void response.body?.cancel?.().catch(() => {});
          throw new Error(
            response.status === 429
              ? 'Wikidata rate limit — try again shortly'
              : `Wikidata HTTP ${response.status}`,
          );
        }
        return readResponseJsonCapped(response, MAX_BODY_BYTES, requestSignal);
      },
      { signal, timeoutMs },
    );
  }

  return {
    label: 'Wikidata',
    attribution: {
      name: 'Wikidata',
      text: 'Metro stations: Wikidata (CC0)',
      href: 'https://www.wikidata.org/',
    },

    /** Most populous Wikidata cities inside the (snapped) view box. */
    async getCitiesInView(box, { signal } = {}) {
      const snapped = snapCityBox(box);
      if (!snapped) throw new TypeError('A finite view box is required');
      const key = cityBoxKey(snapped);
      const cached = lruGet(cityCache, key, now());
      if (cached) return cached;
      const json = await sparql(buildCitiesQuery(snapped), {
        signal,
        timeoutMs: CITY_TIMEOUT_MS,
      });
      const cities = Object.freeze(parseCities(json));
      lruSet(cityCache, key, cities, CITY_CACHE_LIMIT, now());
      return cities;
    },

    /** Cached station list for a city id, or undefined when not yet fetched. */
    peekStations(cityId) {
      const id = qidFromEntity(cityId);
      return id ? lruGet(stationCache, id, now()) : undefined;
    },

    /**
     * Fetch stations for uncached city ids (at most a small batch per call).
     * Resolves a Map of city id → stations for the cities just fetched.
     */
    async fetchStations(cityIds, { signal } = {}) {
      const ids = [...new Set((cityIds || []).map(qidFromEntity))]
        .filter(Boolean)
        .filter((id) => lruGet(stationCache, id, now()) === undefined)
        .slice(0, STATION_BATCH);
      if (!ids.length) return new Map();
      const json = await sparql(buildStationsQuery(ids), {
        signal,
        timeoutMs: STATION_TIMEOUT_MS,
      });
      const byCity = parseStations(json, ids);
      for (const [id, stations] of byCity) {
        if (ids.includes(id))
          lruSet(
            stationCache,
            id,
            Object.freeze(stations),
            STATION_CACHE_LIMIT,
            now(),
          );
      }
      return byCity;
    },

    clearCache() {
      cityCache.clear();
      stationCache.clear();
    },
  };
}
