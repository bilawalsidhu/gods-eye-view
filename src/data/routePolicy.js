// Shared policy for the FOSSGIS OSRM walking/driving route proxy
// (`/api/route`). Worker-safe and middleware-free so the dev middleware
// (`vite/proxies/overpass.js`) and the Pages Function (`functions/api/route.js`)
// cannot drift — same validation, same error strings, same upstream URL.
import { haversineKm } from './cctvSources.js';

/** OSRM route cache TTL (ms) — dev and Pages share it. */
export const ROUTE_CACHE_MS = 600000;

/** Memory-cache ceiling (oldest evicted, Map insertion order). */
export const ROUTE_CACHE_MAX_ENTRIES = 200;

/** Hard cap on the OSRM route response we will buffer. */
export const ROUTE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Reject routes whose straight-line spans are obviously abusive (km). */
export const ROUTE_MAX_LEG_KM = 600;

export const ROUTE_MAX_TOTAL_KM = 2500;

/** Upstream call bound (ms) — the dev middleware's AbortController budget. */
export const ROUTE_UPSTREAM_TIMEOUT_MS = 12000;

/**
 * Normalize the client's `profile` value to an OSRM profile name.
 * Accepts the aliases the annotation UI has used over time.
 * @param {string|null} raw
 * @returns {'car'|'bike'|'foot'|null} null = rejected profile.
 */
export function normalizeRouteProfile(raw) {
  const value = (raw || 'foot').toLowerCase();
  if (value === 'car' || value === 'driving') return 'car';
  if (value === 'bike' || value === 'cycling' || value === 'bicycle') return 'bike';
  if (value === 'foot' || value === 'walking' || value === 'walk') return 'foot';
  return null;
}

/**
 * Parse and validate the `coords=lon,lat;lon,lat;…` parameter.
 * @param {string} raw
 * @returns {{ok: true, pairs: string[], pts: Array<[number, number]>, coords: string}|{ok: false, error: string}}
 */
export function parseRouteCoords(raw) {
  const pairs = (raw || '').split(';').map((s) => s.trim()).filter(Boolean);
  if (pairs.length < 2 || pairs.length > 12) return { ok: false, error: 'need 2-12 coordinates' };
  const clean = [];
  const pts = [];
  for (const pr of pairs) {
    const parts = pr.split(',');
    if (parts.length !== 2) return { ok: false, error: 'invalid coordinate' };
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return { ok: false, error: 'invalid coordinate' };
    }
    clean.push(`${lon},${lat}`);
    pts.push([lon, lat]);
  }
  return { ok: true, pairs: clean, pts, coords: clean.join(';') };
}

/**
 * Reject obviously-abusive spans — a real walking/driving route is local, so a
 * cross-continent request is either a bug or an attempt to drive heavy
 * upstream OSRM work. Returns an error message, or null when acceptable.
 * @param {Array<[number, number]>} pts [lon, lat] pairs
 */
export function routeSpanError(pts) {
  let totalKm = 0;
  for (let i = 1; i < pts.length; i += 1) {
    // pts are [lon, lat]; haversineKm takes (lat1, lon1, lat2, lon2).
    const legKm = haversineKm(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]);
    if (legKm > ROUTE_MAX_LEG_KM) return 'route leg too long';
    totalKm += legKm;
  }
  if (totalKm > ROUTE_MAX_TOTAL_KM) return 'route too long';
  return null;
}

/** The exact public FOSSGIS OSRM URL both runtimes fetch. */
export function buildOsrmUrl(profile, coords) {
  const osrmProfile = profile === 'car' ? 'driving' : profile;
  return `https://routing.openstreetmap.de/routed-${profile}/route/v1/${osrmProfile}/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;
}

/**
 * Shape the OSRM response into the client payload contract.
 * @returns {{ok: true, profile: string, distanceM: number, durationS: number, geometry: Array}|{ok: false, error: string}}
 */
export function osrmRoutePayload(osrm, profile) {
  const route = osrm?.routes?.[0];
  if (osrm?.code !== 'Ok' || !route?.geometry?.coordinates?.length) return { ok: false, error: 'no route found' };
  return {
    ok: true,
    profile,
    distanceM: Math.round(route.distance),
    durationS: Math.round(route.duration),
    geometry: route.geometry.coordinates,
  };
}
