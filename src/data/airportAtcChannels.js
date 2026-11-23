import catalog from './airportAtcCatalog.json' with { type: 'json' };
import { approxDistanceKm } from './approxDistance.js';

const NEARBY_LIMIT_KM = 100;

// The catalog's Budapest channel entries predate the published reassignment.
const BUDAPEST_SOURCE =
  'https://ais.hungarocontrol.hu/aip/2026-09-03/2026-09-03-AIRAC/html/eAIP/LH-AD-2.LHBP-en-HU.html#LHBP-AD-2.18';
const airports = catalog.map((airport) => ({
  ...airport,
  channels: airport.code === 'LHBP' ? [] : airport.channels,
  source:
    airport.code === 'LHBP'
      ? BUDAPEST_SOURCE
      : `https://ourairports.com/airports/${encodeURIComponent(airport.ident)}/frequencies.html`,
}));
const byCode = new Map();
for (const airport of airports) {
  for (const code of [airport.code, airport.iata]) {
    if (code) byCode.set(code, byCode.has(code) ? null : airport);
  }
}

function routeAirports(route) {
  if (!route?.verified) return [];
  const codes = [route.from, route.to];
  return [
    ...new Set(
      codes
        .map((code) => byCode.get(code?.trim().toUpperCase()))
        .filter(Boolean),
    ),
  ];
}

/**
 * Return known route endpoints, or the closest catalogued airport within 100 km.
 * @param {{route?: object|null, lat?: number|null, lon?: number|null}} aircraft
 * @returns {object[]} Suggested airports with published channel entries.
 */
export function atcAirportsForAircraft({ route, lat, lon }) {
  const endpoints = routeAirports(route);
  if (endpoints.length) return endpoints;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];

  let nearest = null;
  let closestKm = NEARBY_LIMIT_KM;
  for (const airport of airports) {
    const km = approxDistanceKm(lat, lon, airport.lat, airport.lon);
    if (km >= closestKm) continue;
    nearest = airport;
    closestKm = km;
  }
  return nearest ? [{ ...nearest, nearby: true }] : [];
}
