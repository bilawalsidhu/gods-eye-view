import { normalizePhotonFeature, photonSearchUrl } from '../keylessGeocoder.js';
import {
  requestWithDeadline,
  waitForSignal,
} from '../sources/requestDeadline.js';

const MAX_QUERY_CHARS = 200;
const CJK =
  /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** Han, Hangul or Kana text, whose place names are often two characters. */
export const isCjk = (text) => CJK.test(String(text || ''));
/** The fewest characters a place name is looked up from. */
export const minPlaceChars = (text) => (isCjk(text) ? 2 : 3);

/**
 * The most words a line sent for place suggestions may have: as many as the
 * Omnibar reads as a place's name (ten with a number, as an address has).
 */
const suggestMaxWords = (text) => (/\d/.test(text) ? 10 : 8);

const MIN_GAP_MS = 500;
const TIMEOUT_MS = 6000;
const PAUSE_AFTER_REFUSAL_MS = 60_000;
const CACHE_LIMIT = 200;

/**
 * The spacing, the pause and the cache, shared by every suggester in the tab:
 * a search box that is put up again starts from where the last one left off.
 */
const shared = {
  nextRequestAt: 0,
  pausedUntil: 0,
  cache: new Map(),
  /** Requests on their way, by cache key: the same text asked again waits. */
  pending: new Map(),
};

/** Forget the shared spacing, pause and cache (tests). */
export function resetPlaceSuggestions() {
  shared.nextRequestAt = 0;
  shared.pausedUntil = 0;
  shared.cache.clear();
  shared.pending.clear();
}

/**
 * Countries that write a house's number before its street ("10 Downing
 * Street", "12 rue de Rivoli"); elsewhere it follows ("Hauptstraße 12").
 */
const NUMBER_FIRST = new Set([
  'US',
  'CA',
  'GB',
  'IE',
  'AU',
  'NZ',
  'FR',
  'LU',
  'MC',
  'ZA',
  'IN',
  'PH',
  'SG',
  'MY',
  'HK',
  'TH',
  'LK',
  'NG',
  'GH',
  'KE',
  'JM',
  'TT',
]);

/** A house's number and street as its country writes them, or ''. */
export function houseAddress({ houseNumber, street, countryCode }) {
  if (!houseNumber || !street) return '';
  return NUMBER_FIRST.has(String(countryCode || 'US').toUpperCase())
    ? `${houseNumber} ${street}`
    : `${street} ${houseNumber}`;
}

/** List Photon candidates while typing. The submitted search owns navigation. */
export function createPlaceSuggester({
  endpoint,
  fetchImpl = (...args) => globalThis.fetch(...args),
  limit = 4,
} = {}) {
  const enabled = endpoint === undefined || Boolean(endpoint);
  const { cache } = shared;

  return {
    enabled,
    async suggest(query, { signal } = {}) {
      signal?.throwIfAborted();
      const text = String(query ?? '')
        .trim()
        .slice(0, MAX_QUERY_CHARS);
      // A line longer than a place's name is never sent: a pasted sentence
      // or phrase is no place.
      if (
        !enabled ||
        text.length < minPlaceChars(text) ||
        text.split(/\s+/).length > suggestMaxWords(text)
      )
        return [];
      const language = (globalThis.document?.documentElement?.lang || 'en')
        .slice(0, 2)
        .toLowerCase();
      const key = `${endpoint ?? ''}|${limit}|${language}|${text.toLowerCase()}`;
      if (cache.has(key)) return cache.get(key);

      // The same text already on its way is that request's answer, unless
      // its caller cancels it: then this one asks for itself.
      const inFlight = shared.pending.get(key);
      if (inFlight)
        try {
          return await waitForSignal(inFlight, signal);
        } catch {
          signal?.throwIfAborted();
        }
      const ask = async () => {
        // Concurrent callers recheck the gap after waking before sending.
        while (shared.nextRequestAt > Date.now()) {
          let timer;
          const pause = new Promise((resolve) => {
            timer = setTimeout(resolve, shared.nextRequestAt - Date.now());
          });
          try {
            await waitForSignal(pause, signal);
          } finally {
            clearTimeout(timer);
          }
        }
        signal?.throwIfAborted();
        // The same text asked again while this one waited is answered now.
        if (cache.has(key)) return cache.get(key);
        if (Date.now() < shared.pausedUntil) return [];
        const url = new URL(photonSearchUrl(text, { endpoint, limit }));
        if (['en', 'de', 'fr', 'it'].includes(language))
          url.searchParams.set('lang', language);

        shared.nextRequestAt = Date.now() + MIN_GAP_MS;
        let features;
        try {
          features = await requestWithDeadline(
            async (requestSignal) => {
              const response = await fetchImpl(url, { signal: requestSignal });
              requestSignal.throwIfAborted();
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              const data = await response.json();
              return data?.features;
            },
            { signal, timeoutMs: TIMEOUT_MS },
          );
        } catch (error) {
          signal?.throwIfAborted();
          // A refusal, a timeout or a failed request (a refusal sent without
          // CORS headers arrives as one) all hold suggestions off a while.
          void error;
          shared.pausedUntil = Date.now() + PAUSE_AFTER_REFUSAL_MS;
          return [];
        }
        signal?.throwIfAborted();
        if (!Array.isArray(features)) return [];

        const seen = new Set();
        const places = [];
        for (const feature of features) {
          const normalized = normalizePhotonFeature(feature);
          if (!normalized) continue;
          const {
            city,
            state,
            country,
            countrycode: countryCode,
            osm_value: osmType,
            type,
            street,
            housenumber: houseNumber,
            locality,
            district,
          } = feature.properties ?? {};
          // A house has no name of its own: its street (or, without one, its
          // locality) and number are its name, written in the country's own
          // order, so two houses on one street stay two places.
          const address = houseAddress({
            houseNumber,
            street: street || locality || district || city,
            countryCode,
          });
          const name = normalized.name || address || city || state || country;
          if (!name) continue;
          const detail = [...new Set([city, state, country])]
            .filter((part) => part && part !== name)
            .join(', ');
          const id = `${name}|${detail}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const { southwest, northeast } = normalized.viewport ?? {};
          places.push({
            name,
            detail,
            latitude: normalized.lat,
            longitude: normalized.lng,
            type: (osmType === 'administrative' ? type : osmType || type) || '',
            state: state || null,
            country: country || null,
            countryCode: /^[a-z]{2}$/i.test(countryCode ?? '')
              ? countryCode.toUpperCase()
              : null,
            extent: southwest
              ? [southwest.lng, northeast.lat, northeast.lng, southwest.lat]
              : null,
          });
          if (places.length >= limit) break;
        }

        cache.set(key, places);
        if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
        return places;
      };
      const asking = ask();
      shared.pending.set(key, asking);
      try {
        return await asking;
      } finally {
        if (shared.pending.get(key) === asking) shared.pending.delete(key);
      }
    },
  };
}

/**
 * The cities that lie in a region: inside its extent (`[west, north, east,
 * south]`, as Photon gives it) and, when the region names a country by its
 * ISO code, in that country. Without either there is nothing to tell a
 * region's cities from its neighbours', so none are listed.
 * @param {Array<{latitude: number, longitude: number, country?: string}>} cities
 *   Bundled cities, `country` an ISO 3166-1 code.
 * @param {{extent?: ?Array<number>, countryCode?: ?string}} region
 */
export function citiesInRegion(cities, { extent, countryCode } = {}) {
  const box = Array.isArray(extent) && extent.length === 4 ? extent : null;
  if (!box && !countryCode) return [];
  return cities.filter(
    (city) =>
      (!countryCode || city.country === countryCode) &&
      (!box || inExtent(box, city)),
  );
}

/**
 * Whether a place lies in an extent `[west, north, east, south]`. An extent
 * across the antimeridian (west east of east) runs from west round to east.
 * @param {Array<number>} extent
 * @param {{latitude: number, longitude: number}} place
 */
export function inExtent([west, north, east, south], place) {
  const lon = place.longitude;
  const inLongitude =
    west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
  return place.latitude <= north && place.latitude >= south && inLongitude;
}
