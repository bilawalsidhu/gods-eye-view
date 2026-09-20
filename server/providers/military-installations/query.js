import { MILITARY_INSTALLATION_BBOX_STEP_DEG } from './constants.js';
import { requiredFiniteQueryNumber } from '../common/query.js';

/**
 * Snap a request bbox outward onto the shared installation cache grid.
 * @param {{south:number, west:number, north:number, east:number}} box
 * @param {number} [stepDeg]
 * @returns {{south:number, west:number, north:number, east:number}}
 */
function quantizeMilitaryInstallationBox(
  box,
  stepDeg = MILITARY_INSTALLATION_BBOX_STEP_DEG,
) {
  // Round the ratio first: 29.9999/0.05 lands a hair under an exact grid line
  // in binary floating point, which would otherwise snap a whole cell too far.
  const snap = (value, grow) => {
    const cells = Number((value / stepDeg).toFixed(9));
    return Number(
      ((grow > 0 ? Math.ceil(cells) : Math.floor(cells)) * stepDeg).toFixed(6),
    );
  };
  return {
    south: Math.max(-90, snap(box.south, -1)),
    west: Math.max(-180, snap(box.west, -1)),
    north: Math.min(90, snap(box.north, 1)),
    east: Math.min(180, snap(box.east, 1)),
  };
}

/**
 * Stable disk/memory cache key for an installation bbox.
 *
 * The key's precision must match the precision of the bounds the QUERY uses, or
 * two different queries collide on one entry. Snapped boxes live on a 0.05 deg
 * grid, so 3 decimals is exact for them; an `exact=1` request carries the raw
 * viewport at 5 decimals and must be keyed at 5, otherwise two nearby exact
 * viewports would share an answer and the second would be missing the edge
 * strip it just exposed.
 * @param {{south:number, west:number, north:number, east:number}} box
 * @param {number} [decimals]
 */
function militaryInstallationCacheKey(box, decimals = 3) {
  return [box.south, box.west, box.north, box.east]
    .map((value) => value.toFixed(decimals))
    .join(',');
}

function validMilitaryInstallationBox(params) {
  const south = requiredFiniteQueryNumber(params, 'south');
  const west = requiredFiniteQueryNumber(params, 'west');
  const north = requiredFiniteQueryNumber(params, 'north');
  const east = requiredFiniteQueryNumber(params, 'east');
  if (![south, west, north, east].every(Number.isFinite)) return null;
  if (
    south < -90 ||
    north > 90 ||
    west < -180 ||
    east > 180 ||
    south >= north ||
    west >= east
  )
    return null;
  if (north - south > 10 || east - west > 10) return null;
  return { south, west, north, east };
}

/** Safe, evidence-based reason for an installation upstream failure. */
function militaryInstallationFailureReason(error) {
  if (
    ['rate_limited', 'timeout', 'query_failed'].includes(
      error?.installationReason,
    )
  )
    return error.installationReason;
  return ['AbortError', 'TimeoutError'].includes(error?.name)
    ? 'timeout'
    : 'unavailable';
}

export {
  validMilitaryInstallationBox,
  quantizeMilitaryInstallationBox,
  militaryInstallationCacheKey,
  militaryInstallationFailureReason,
};
