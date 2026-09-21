import { requiredFiniteQueryNumber } from '../common/query.js';
import {
  WQ_CHARACTERISTIC_TYPES,
  WQ_DEFAULT_WINDOW_YEARS,
  WQ_MAX_WINDOW_YEARS,
} from './constants.js';

/** Matches the client bound: the upstream times out past roughly two degrees. */
const MAX_BOX_DEGREES = 2;

/** Snap size for the shared cache grid, in degrees. */
const QUANTIZE_DEGREES = 0.05;

/**
 * Read a bounded, non-dateline viewport from request parameters.
 * @param {URLSearchParams} params Request query parameters.
 * @returns {?{south:number, west:number, north:number, east:number}} Box, or null when invalid.
 */
export function validWaterQualityBox(params) {
  const south = requiredFiniteQueryNumber(params, 'south');
  const west = requiredFiniteQueryNumber(params, 'west');
  const north = requiredFiniteQueryNumber(params, 'north');
  const east = requiredFiniteQueryNumber(params, 'east');
  if (![south, west, north, east].every(Number.isFinite)) return null;
  if (south < -90 || north > 90 || west < -180 || east > 180) return null;
  if (north <= south || east <= west) return null;
  if (north - south > MAX_BOX_DEGREES || east - west > MAX_BOX_DEGREES)
    return null;
  return { south, west, north, east };
}

/**
 * Snap a viewport outward onto a shared grid so neighbouring views reuse one
 * cache entry. An outward snap always covers what was asked for.
 * @param {{south:number, west:number, north:number, east:number}} box Requested viewport.
 * @returns {{south:number, west:number, north:number, east:number}} Snapped viewport.
 */
export function quantizeWaterQualityBox(box) {
  const floor = (value) =>
    Math.floor(value / QUANTIZE_DEGREES) * QUANTIZE_DEGREES;
  const ceil = (value) =>
    Math.ceil(value / QUANTIZE_DEGREES) * QUANTIZE_DEGREES;
  return {
    south: Math.max(-90, floor(box.south)),
    west: Math.max(-180, floor(box.west)),
    north: Math.min(90, ceil(box.north)),
    east: Math.min(180, ceil(box.east)),
  };
}

/** @param {object} box Viewport. @param {number} precision Decimal places. @returns {string} Cache key. */
export function waterQualityCacheKey(box, precision = 3) {
  return [box.south, box.west, box.north, box.east]
    .map((value) => value.toFixed(precision))
    .join(',');
}

/**
 * Resolve a client family identifier to its upstream vocabulary values.
 * @param {?string} value Requested family identifier.
 * @returns {?{family:string, characteristicTypes:ReadonlyArray<string>}} Resolved family, or null when unlisted.
 */
export function resolveCharacteristicType(value) {
  const family = String(value || '')
    .trim()
    .toLowerCase();
  return Object.hasOwn(WQ_CHARACTERISTIC_TYPES, family)
    ? { family, characteristicTypes: WQ_CHARACTERISTIC_TYPES[family] }
    : null;
}

/**
 * Clamp the trailing sampling window.
 *
 * An absent parameter must fall back to the default, not to the floor: a
 * missing query value arrives as null, and `Number(null)` is 0 — finite — so a
 * plain finite check would silently narrow every unparameterised request to one
 * year and hide most of the monitoring record.
 * @param {?string} value Requested window.
 * @returns {number} Clamped trailing window in years.
 */
export function resolveWindowYears(value) {
  if (value === null || value === undefined || String(value).trim() === '')
    return WQ_DEFAULT_WINDOW_YEARS;
  const years = Number(value);
  if (!Number.isFinite(years)) return WQ_DEFAULT_WINDOW_YEARS;
  return Math.min(WQ_MAX_WINDOW_YEARS, Math.max(1, Math.round(years)));
}

/**
 * The upstream wants `MM-DD-YYYY` and a positional `west,south,east,north`
 * bbox, while this API speaks named bounds and ISO dates. Both conversions live
 * here so no other module has to remember either ordering.
 */

/** @param {number} years Trailing window. @param {number} now Epoch ms. @returns {{iso:string, upstream:string}} Window start. */
export function windowStart(years, now = Date.now()) {
  const start = new Date(now);
  start.setUTCFullYear(start.getUTCFullYear() - years);
  const month = String(start.getUTCMonth() + 1).padStart(2, '0');
  const day = String(start.getUTCDate()).padStart(2, '0');
  return {
    iso: start.toISOString().slice(0, 10),
    upstream: `${month}-${day}-${start.getUTCFullYear()}`,
  };
}

/** @param {object} box Viewport. @returns {string} Upstream positional bbox. */
export function waterQualityBBoxParam(box) {
  return [box.west, box.south, box.east, box.north]
    .map((value) => value.toFixed(5))
    .join(',');
}

/**
 * A site identifier is an agency-qualified token (`WATERKEEPER-CAPCapeFear...`),
 * not free text. Bounding it at the codec keeps an arbitrary string out of the
 * upstream query and the cache key. Reject rather than truncate: half an
 * identifier is a DIFFERENT site, not a shorter name for the same one.
 * @param {?string} value Requested site identifier.
 * @returns {?string} Accepted identifier, or null.
 */
export function validSiteIdentifier(value) {
  const site = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9 ._:[\]/-]{0,127}$/.test(site) ? site : null;
}

/** @param {?Error} error Upstream failure. @returns {string} Stable client reason code. */
export function waterQualityFailureReason(error) {
  const reason = error?.waterQualityReason;
  return ['rate_limited', 'timeout', 'query_failed'].includes(reason)
    ? reason
    : 'unavailable';
}
