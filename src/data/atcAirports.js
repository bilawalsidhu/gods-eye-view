/**
 * @module atcAirports
 * @description Global airport registry and spatial proximity resolver for
 * real-time air traffic control (ATC) communications.
 *
 * Backed by OurAirports public-domain data (8,340 international and regional airports
 * with verified VHF frequencies: Tower, Approach, ATIS, Ground).
 */

import ourAirportsJson from './local_data/ourairports/atc_airports.json' with { type: 'json' };
import { greatCircleKm } from './routePlausible.js';
import { getLiveAtcUrl } from './atcCustomStreams.js';

/**
 * Earth radius in meters (mean radius for Haversine calculations).
 */
export const EARTH_RADIUS_M = 6371000;

/**
 * 1 International Nautical Mile in meters.
 */
export const METERS_PER_NM = 1852;

/**
 * Convert meters to nautical miles.
 * @param {number} meters
 * @returns {number}
 */
export function metersToNauticalMiles(meters) {
  if (!Number.isFinite(meters) || meters < 0) return 0;
  return meters / METERS_PER_NM;
}

/**
 * Calculate Great-Circle distance between two coordinates using shared Haversine formula.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} Distance in meters
 */
export function greatCircleDistanceM(lat1, lon1, lat2, lon2) {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lon1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lon2)
  ) {
    return Number.POSITIVE_INFINITY;
  }
  return greatCircleKm(lat1, lon1, lat2, lon2) * 1000;
}

/**
 * Global registry of airports with published VHF frequencies.
 * All coordinates use WGS84 decimal degrees.
 */
export const GLOBAL_AIRPORTS = Object.freeze(ourAirportsJson);
export const ATC_AIRPORTS = GLOBAL_AIRPORTS;

/**
 * Fast ICAO lookup map.
 */
export const AIRPORT_BY_ICAO = new Map(
  GLOBAL_AIRPORTS.map((a) => [a.icao.toUpperCase(), a]),
);

/**
 * Find the nearest airport to a given coordinate within an optional maximum distance.
 * Includes fast bounding-box prefiltering for optimal 60fps performance on 8,000+ entries.
 * @param {number} lat
 * @param {number} lon
 * @param {number} [maxDistanceM=Number.POSITIVE_INFINITY]
 * @param {Array<object>} [airports=GLOBAL_AIRPORTS]
 * @returns {{ airport: object, distanceM: number, distanceNm: number } | null}
 */
export function findNearestAirport(
  lat,
  lon,
  maxDistanceM = Number.POSITIVE_INFINITY,
  airports = GLOBAL_AIRPORTS,
) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  let bestAirport = null;
  let minDistanceM = Number.POSITIVE_INFINITY;

  // Bounding box filter: 1 deg lat is ~111,139 meters
  const hasFiniteMax = Number.isFinite(maxDistanceM);
  const maxLatDiff = hasFiniteMax
    ? (maxDistanceM / 111139) * 1.05
    : Number.POSITIVE_INFINITY;

  for (let i = 0; i < airports.length; i++) {
    const airport = airports[i];
    if (hasFiniteMax && Math.abs(airport.lat - lat) > maxLatDiff) {
      continue;
    }

    const dist = greatCircleDistanceM(lat, lon, airport.lat, airport.lon);
    if (dist < minDistanceM && dist <= maxDistanceM) {
      minDistanceM = dist;
      bestAirport = airport;
    }
  }

  if (!bestAirport) return null;

  return {
    airport: bestAirport,
    distanceM: minDistanceM,
    distanceNm: metersToNauticalMiles(minDistanceM),
  };
}

/**
 * Get an airport record by ICAO code.
 * @param {string} icao
 * @returns {object|null}
 */
export function getAirportByIcao(icao) {
  if (!icao || typeof icao !== 'string') return null;
  return AIRPORT_BY_ICAO.get(icao.trim().toUpperCase()) || null;
}

export { getLiveAtcUrl };
