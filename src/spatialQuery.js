/**
 * Small, Cesium-free helpers for geographic spatial queries.
 *
 * Coordinates are expressed as { lat, lon } (or { lat, lng }) in decimal degrees.
 * Consumers can adapt other entity shapes with the getPosition accessor.
 *
 * This module deliberately uses a linear scan. It is intended as the
 * correctness-first primitive; an indexed backend can replace the
 * scan later without changing the public query semantics.
 */

const EARTH_RADIUS_M = 6_371_000;
const DEGREES_TO_RADIANS = Math.PI / 180;

function getLon(point) {
  return point.lon !== undefined ? point.lon : point.lng;
}

function isValidPoint(point) {
  if (point == null || typeof point !== "object") {
    return false;
  }
  const lat = point.lat;
  const lon = getLon(point);
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

function assertPoint(point, name) {
  if (!isValidPoint(point)) {
    throw new TypeError(
      `${name} must be an object with finite lat/lon in valid geographic ranges`
    );
  }
}

/**
 * Internal great-circle distance calculation between two points.
 */
function computeGreatCircleMeters(lat1, lon1, lat2, lon2) {
  const lat1Rad = lat1 * DEGREES_TO_RADIANS;
  const lat2Rad = lat2 * DEGREES_TO_RADIANS;
  const deltaLat = (lat2 - lat1) * DEGREES_TO_RADIANS;
  const deltaLon = (lon2 - lon1) * DEGREES_TO_RADIANS;

  // Haversine form. Because longitude enters through sin(deltaLon / 2),
  // crossing +/-180 degrees is handled naturally without explicit wrap logic.
  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1Rad) *
      Math.cos(lat2Rad) *
      Math.sin(deltaLon / 2) ** 2;

  // Clamp floating-point round-off so 1 - h cannot become negative.
  const h = Math.min(1, Math.max(0, haversine));

  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Great-circle distance between two latitude/longitude points.
 *
 * @param {{lat: number, lon?: number, lng?: number}} a
 * @param {{lat: number, lon?: number, lng?: number}} b
 * @returns {number} distance in metres
 */
export function greatCircleMeters(a, b) {
  assertPoint(a, "point a");
  assertPoint(b, "point b");

  return computeGreatCircleMeters(a.lat, getLon(a), b.lat, getLon(b));
}

/**
 * Return all entities within a great-circle radius, nearest first.
 *
 * Invalid entity coordinates are ignored. Invalid center/radius/accessor
 * arguments are programmer errors and throw.
 *
 * @template T
 * @param {T[]} entities
 * @param {{lat: number, lon?: number, lng?: number}} center
 * @param {number} radiusM
 * @param {(entity: T, index: number) => ({lat: number, lon?: number, lng?: number} | null | undefined)} [getPosition]
 * @returns {{entity: T, distanceM: number}[]}
 */
export function queryRadius(
  entities,
  center,
  radiusM,
  getPosition = (entity) => entity
) {
  if (!Array.isArray(entities)) {
    throw new TypeError("entities must be an array");
  }
  assertPoint(center, "center");

  if (!Number.isFinite(radiusM) || radiusM < 0) {
    throw new RangeError("radiusM must be a finite non-negative number");
  }

  if (typeof getPosition !== "function") {
    throw new TypeError("getPosition must be a function");
  }

  const centerLon = getLon(center);
  const matches = [];

  for (let index = 0; index < entities.length; index += 1) {
    const entity = entities[index];
    const position = getPosition(entity, index);

    if (!isValidPoint(position)) {
      continue;
    }

    const distanceM = computeGreatCircleMeters(
      center.lat,
      centerLon,
      position.lat,
      getLon(position)
    );

    if (distanceM <= radiusM) {
      matches.push({ entity, distanceM });
    }
  }

  // Stable sort preserves source order for equal distances without extra allocations.
  matches.sort((a, b) => a.distanceM - b.distanceM);

  return matches;
}

/**
 * Find the nearest entity to a geographic point.
 *
 * Invalid entity coordinates are ignored. Returns null when no entity has
 * a valid position. Equal-distance ties retain the original entity order.
 *
 * @template T
 * @param {T[]} entities
 * @param {{lat: number, lon?: number, lng?: number}} point
 * @param {(entity: T, index: number) => ({lat: number, lon?: number, lng?: number} | null | undefined)} [getPosition]
 * @returns {{entity: T, distanceM: number} | null}
 */
export function nearest(
  entities,
  point,
  getPosition = (entity) => entity
) {
  if (!Array.isArray(entities)) {
    throw new TypeError("entities must be an array");
  }
  assertPoint(point, "point");

  if (typeof getPosition !== "function") {
    throw new TypeError("getPosition must be a function");
  }

  const pointLon = getLon(point);
  let best = null;

  for (let index = 0; index < entities.length; index += 1) {
    const entity = entities[index];
    const position = getPosition(entity, index);

    if (!isValidPoint(position)) {
      continue;
    }

    const distanceM = computeGreatCircleMeters(
      point.lat,
      pointLon,
      position.lat,
      getLon(position)
    );

    if (best === null || distanceM < best.distanceM) {
      best = { entity, distanceM };
    }
  }

  return best;
}
