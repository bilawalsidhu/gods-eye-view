import { createNominatimClient } from '../../sources/nominatim.js';
import {
  normalizeRouteProfile,
  projectRouteResult,
} from '../../data/placeProviderPayloads.js';
import { normalizeOsrmSteps } from '../../data/routeSteps.js';
import {
  NOMINATIM_MIN_INTERVAL_MS,
  OSRM_MIN_INTERVAL_MS,
  UPSTREAM_NOT_ALLOWED,
  getSharedPacer,
  isUpstreamRefusal,
} from '../sourcePolicy.js';

/**
 * Keyless on-device geocode + route: Nominatim search/reverse through the
 * shared portable client and FOSSGIS OSRM routes projected with the shared
 * route payload builder. Courtesy pacers are enforced client-side
 * (Nominatim 1.1 s, OSRM 1/s) because there is no proxy left to gate them.
 *
 * @module mobile/adapters/geocodeDirect
 */

/** Nominatim search endpoint (registry family `geocode`). */
export const NOMINATIM_SEARCH_ENDPOINT =
  'https://nominatim.openstreetmap.org/search';

/** Nominatim reverse endpoint (registry family `geocode`). */
export const NOMINATIM_REVERSE_ENDPOINT =
  'https://nominatim.openstreetmap.org/reverse';

/** OSRM base per profile (registry family `route`). */
export const OSRM_BASES = Object.freeze({
  foot: 'https://routing.openstreetmap.de/routed-foot',
  car: 'https://routing.openstreetmap.de/routed-car',
  bike: 'https://routing.openstreetmap.de/routed-bike',
});

/** Mirror of the server route span guards (an abusive span is refused). */
export const ROUTE_MAX_LEG_KM = 600;
export const ROUTE_MAX_TOTAL_KM = 2500;

/**
 * Great-circle distance in km (local copy mirroring the server route
 * guards; the shared copies live in heavier modules this adapter avoids).
 * @param {number} lat1 Start latitude.
 * @param {number} lon1 Start longitude.
 * @param {number} lat2 End latitude.
 * @param {number} lon2 End longitude.
 * @returns {number} Distance in kilometres.
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const d2r = Math.PI / 180;
  const dLat = (lat2 - lat1) * d2r;
  const dLon = (lon2 - lon1) * d2r;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Validate one route endpoint.
 * @param {*} point `{ lat, lon }` candidate.
 * @returns {{ lat: number, lon: number }|null} Clean point or null.
 */
function cleanRoutePoint(point) {
  const lat = Number(point?.lat);
  const lon = Number(point?.lon);
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) return null;
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/**
 * Create the keyless on-device geocoder (Nominatim, paced at 1.1 s via
 * the shared pacer gate). The shared pacer enforces a single courtesy
 * budget across all direct geocode/route sources.
 * @param {{ fetchImpl?: Function }} options Transport only; pacer is shared.
 * @returns {{ search: Function, reverse: Function }} Forward + reverse lookup.
 */
export function createGeocodeDirectSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const pacer = getSharedPacer();
  const pacedFetch = async (url, init = {}) => {
    await pacer.wait(init);
    return fetchImpl(url, init);
  };
  const client = createNominatimClient({
    searchEndpoint: NOMINATIM_SEARCH_ENDPOINT,
    reverseEndpoint: NOMINATIM_REVERSE_ENDPOINT,
    fetchImpl: pacedFetch,
  });
  return {
    /**
     * Search place names (refusals propagate with their code intact: the
     * contract returns row arrays, which must never be faked empty).
     */
    search: (query, options) => client.search(query, options),
    /** Reverse-geocode one point (same refusal contract as search). */
    reverse: (latitude, longitude, options) =>
      client.reverse(latitude, longitude, options),
  };
}

/**
 * Create the keyless on-device router (OSRM, paced at 1/s via the
 * shared pacer gate). The shared pacer enforces a single courtesy
 * budget across all direct geocode/route sources.
 * @param {{ fetchImpl?: Function }} options Transport only; pacer is shared.
 * @returns {{ getRoute: Function }} Directions-shaped route lookup.
 */
export function createRouteDirectSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const pacer = getSharedPacer();
  return {
    /**
     * Route between two points, returning the proxy's payload shape
     * (`{ ok: true, profile, distanceM, durationS, geometry, steps }` or
     * `{ ok: false, error }`, plus `unavailable` on registry refusal).
     * @param {{ mode: string, a: object, b: object }} endpoints Profile + points.
     * @param {{ signal?: AbortSignal }} options Caller signal.
     * @returns {Promise<object>} Route payload or honest failure.
     */
    async getRoute({ mode, a, b } = {}, { signal } = {}) {
      const profile = normalizeRouteProfile(String(mode || '').toLowerCase());
      if (!profile) return { ok: false, error: 'invalid profile' };
      const start = cleanRoutePoint(a);
      const end = cleanRoutePoint(b);
      if (!start || !end) return { ok: false, error: 'invalid coordinate' };
      const legKm = haversineKm(start.lat, start.lon, end.lat, end.lon);
      if (legKm > ROUTE_MAX_LEG_KM) {
        return { ok: false, error: 'route leg too long' };
      }
      if (legKm > ROUTE_MAX_TOTAL_KM) {
        return { ok: false, error: 'route too long' };
      }
      await pacer.wait({ signal });
      signal?.throwIfAborted();
      const osrmProfile = profile === 'car' ? 'driving' : profile;
      const coords =
        `${start.lon.toFixed(6)},${start.lat.toFixed(6)};` +
        `${end.lon.toFixed(6)},${end.lat.toFixed(6)}`;
      const url =
        `${OSRM_BASES[profile]}/route/v1/${osrmProfile}/${coords}` +
        '?overview=full&geometries=geojson&alternatives=false&steps=true';
      let response;
      try {
        response = await fetchImpl(url, {
          signal,
          redirect: 'error',
          headers: { 'User-Agent': 'gods-eye-view/dev (local)' },
        });
      } catch (error) {
        if (isUpstreamRefusal(error)) {
          return {
            ok: false,
            error: 'routing upstream not allowed',
            unavailable: UPSTREAM_NOT_ALLOWED,
          };
        }
        throw error;
      }
      signal?.throwIfAborted();
      if (response.status === 429) {
        throw new Error('Routing is rate limited — try again in a moment');
      }
      if (!response.ok) return { ok: false, error: 'no route found' };
      const upstream = await response.json();
      signal?.throwIfAborted();
      const route = upstream?.routes?.[0];
      if (upstream?.code !== 'Ok' || !route?.geometry?.coordinates?.length) {
        return { ok: false, error: 'no route found' };
      }
      const payload = projectRouteResult(route, profile);
      const { steps, truncated } = normalizeOsrmSteps(route);
      payload.steps = steps;
      if (truncated) payload.stepsTruncated = true;
      return payload;
    },
  };
}
