/**
 * Cesium-free spatial queries over geographic point collections.
 *
 * Great-circle distances are delegated to geoDistance.js so that all
 * consumers share one Earth-radius convention and invalid-input contract.
 *
 * Coordinates use decimal degrees as { lat, lon } or { lat, lng }.
 * Consumers can adapt other entity shapes with a position accessor.
 *
 * This implementation uses a linear scan. An indexed backend can replace
 * the scan later without changing the public query semantics.
 */

import { greatCircleMeters } from './geoDistance.js';

function getLon(point) {
  return point.lon !== undefined ? point.lon : point.lng;
}

function isValidPoint(point) {
  if (point === null || typeof point !== 'object') return false;

  const lon = getLon(point);

  return (
    Number.isFinite(point.lat) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    Number.isFinite(lon) &&
    lon >= -180 &&
    lon <= 180
  );
}

function assertPoint(point, name) {
  if (!isValidPoint(point)) {
    throw new TypeError(
      `${name} must be an object with finite lat/lon in valid geographic ranges`,
    );
  }
}

function toGeoPoint(point) {
  return { lat: point.lat, lon: getLon(point) };
}

/**
 * Return entities within a great-circle radius, nearest first.
 *
 * Invalid entity positions are skipped. Invalid query arguments throw.
 * Equal-distance results retain source order, and the input array is not
 * modified.
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
  getPosition = (entity) => entity,
) {
  if (!Array.isArray(entities)) {
    throw new TypeError('entities must be an array');
  }

  assertPoint(center, 'center');

  if (!Number.isFinite(radiusM) || radiusM < 0) {
    throw new RangeError('radiusM must be a finite non-negative number');
  }

  if (typeof getPosition !== 'function') {
    throw new TypeError('getPosition must be a function');
  }

  const canonicalCenter = toGeoPoint(center);
  const matches = [];

  for (let index = 0; index < entities.length; index += 1) {
    const entity = entities[index];
    const position = getPosition(entity, index);

    if (!isValidPoint(position)) continue;

    const distanceM = greatCircleMeters(
      canonicalCenter,
      toGeoPoint(position),
    );

    if (distanceM <= radiusM) {
      matches.push({ entity, distanceM });
    }
  }

  // Stable sort preserves source order for equal-distance results.
  matches.sort((a, b) => a.distanceM - b.distanceM);

  return matches;
}

/**
 * Find the nearest entity to a geographic point.
 *
 * Invalid entity positions are skipped. Returns null when no entity has
 * a valid position. Equal-distance ties retain source order.
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
  getPosition = (entity) => entity,
) {
  if (!Array.isArray(entities)) {
    throw new TypeError('entities must be an array');
  }

  assertPoint(point, 'point');

  if (typeof getPosition !== 'function') {
    throw new TypeError('getPosition must be a function');
  }

  const canonicalPoint = toGeoPoint(point);
  let best = null;

  for (let index = 0; index < entities.length; index += 1) {
    const entity = entities[index];
    const position = getPosition(entity, index);

    if (!isValidPoint(position)) continue;

    const distanceM = greatCircleMeters(
      canonicalPoint,
      toGeoPoint(position),
    );

    if (best === null || distanceM < best.distanceM) {
      best = { entity, distanceM };
    }
  }

  return best;
}
