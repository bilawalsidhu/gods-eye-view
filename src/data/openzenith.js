// src/data/openzenith.js
/**
 * Browser client for the OpenZenith free geospatial API, via the same-origin
 * proxy (`functions/api/openzenith/[[path]].js`; dev serves the same contract
 * from `vite.config.js`). See docs/DATA_SERVICES_CATALOG.md for the
 * live-verified upstream contract.
 *
 * The proxy already caches per-isolate and their edge caches an hour; this
 * module adds the tier that actually matters for production load — the
 * browser's localStorage via `localCache.js`. A reverse-geocoded place is a
 * property of the ground, not of the session: one lookup per ~100 m cell,
 * persisted 30 days, never re-fetched while cached.
 *
 * Pure module: worker-safe, fails silent (a missing place label is never
 * worth an error surface), injects fetch through the same-origin path so
 * tests stub `globalThis.fetch` and `setLocalCacheStorage`.
 *
 * @module data/openzenith
 */

import { readLocalCache, writeLocalCache } from './localCache.js';

/** Address data is effectively immutable — persist across sessions. */
const PLACE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** ~100 m grid: the same street corner is one cache entry, not one per float. */
const COORD_PRECISION = 3;
/** @type {Map<string, Promise<object|null>>} single-flight per cache key. */
const _inflight = new Map();

const cacheKey = (lat, lon) =>
  `oz:rg:${lat.toFixed(COORD_PRECISION)}:${lon.toFixed(COORD_PRECISION)}`;

/** The address fields the readout renders — everything else is noise. */
function toPlace(place) {
  if (!place || typeof place !== 'object') return null;
  const a = place.address || {};
  const city = a.city || a.town || a.village || a.municipality || a.county || '';
  const state = a.state || '';
  const country = a.country || '';
  const label = [city, state].filter(Boolean).join(', ') || country;
  if (!label) return null;
  return {
    label,
    displayName: String(place.display_name || ''),
    lat: Number.isFinite(place.location?.lat) ? place.location.lat : null,
    lon: Number.isFinite(place.location?.lon) ? place.location.lon : null,
  };
}

/**
 * Reverse-geocode a ground coordinate to a human place label.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<{label: string, displayName: string, lat: number|null,
 *   lon: number|null}|null>} Null on any failure or when the cell has no
 *   address (open water, wilderness) — the negative is cached too.
 */
export async function reverseGeocodePlace(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const key = cacheKey(lat, lon);
  const cached = readLocalCache(key);
  if (cached.hit) return cached.value.found ? cached.value.place : null;
  if (_inflight.has(key)) return _inflight.get(key);
  const job = (async () => {
    try {
      const res = await fetch(
        `/api/openzenith/reverse-geocode?lat=${lat.toFixed(COORD_PRECISION)}&lon=${lon.toFixed(COORD_PRECISION)}`,
        { headers: { Accept: 'application/json' } },
      );
      if (!res.ok) return null;
      const body = await res.json();
      const place = toPlace(body?.place);
      // Persist the miss as well as the hit — an addressless cell (open
      // water, wilderness) stays addressless for the TTL, exactly like the
      // server tiers treat it. The found-sentinel exists because localCache
      // refuses null payloads by design.
      writeLocalCache(key, place ? { found: true, place } : { found: false }, {
        ttlMs: PLACE_TTL_MS,
      });
      return place;
    } catch {
      return null;
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, job);
  return job;
}
