import { FEET_PER_METRE, METRES_PER_MILE, getUnitSystem } from '../units.js';

/**
 * Kilometre decimals for a distance: one below 10 km, none from there on.
 * The cut is taken on the tenth that prints, so 9.96 km reads 10 km, not 10.0.
 * @param {number} meters
 * @returns {0|1}
 */
export function kilometreDigits(meters) {
  return Math.round(meters / 100) < 100 ? 1 : 0;
}

/**
 * The unit and precision a distance prints with: metres below 1 km, then
 * kilometres with `kilometreDigits`. Metres round to `metreStep` (10 for tens),
 * except below `exactBelowM`, where they stay whole. Each cut is taken after
 * rounding, so 999.6 m reads 1.0 km rather than 1000 m.
 *
 * In the imperial system (src/units.js) the same rules give feet below
 * 1000 ft, then miles: one decimal below 10 mi, none from there on.
 * `metreStep` then rounds feet (10 for tens of feet). `largeOnly` keeps
 * kilometres (or miles) all the way down, as `0.4 km`.
 * @param {number} meters
 * @param {{metreStep?: number, exactBelowM?: number, largeOnly?: boolean, system?: 'metric'|'imperial'}} [options]
 *   `system` defaults to the page's choice.
 * @returns {{value: number, unit: 'm'|'km'|'ft'|'mi', digits: 0|1}|null}
 *   null for a distance that is negative or not finite. The value is already
 *   rounded to `digits`, so toFixed and Intl render it the same way.
 */
export function distanceParts(
  meters,
  {
    metreStep = 1,
    exactBelowM = 0,
    largeOnly = false,
    system = getUnitSystem(),
  } = {},
) {
  if (!Number.isFinite(meters) || meters < 0) return null;
  if (system === 'imperial')
    return imperialParts(meters, metreStep, exactBelowM, largeOnly);
  const step = meters < exactBelowM ? 1 : metreStep;
  const shownMeters = Math.round(meters / step) * step;
  if (shownMeters < 1000 && !largeOnly)
    return { value: shownMeters, unit: 'm', digits: 0 };
  const digits = kilometreDigits(meters);
  const value =
    digits === 1 ? Math.round(meters / 100) / 10 : Math.round(meters / 1000);
  return { value, unit: 'km', digits };
}

function imperialParts(meters, footStep, exactBelowM, largeOnly) {
  const feet = meters * FEET_PER_METRE;
  const step = meters < exactBelowM ? 1 : footStep;
  const shownFeet = Math.round(feet / step) * step;
  if (shownFeet < 1000 && !largeOnly)
    return { value: shownFeet, unit: 'ft', digits: 0 };
  const miles = meters / METRES_PER_MILE;
  const digits = Math.round(miles * 10) < 100 ? 1 : 0;
  const value = digits === 1 ? Math.round(miles * 10) / 10 : Math.round(miles);
  return { value, unit: 'mi', digits };
}

/**
 * Plain `850 m` / `4.6 km` / `12 km` text for labels that are not localized;
 * `920 ft` / `2.9 mi` in the imperial system.
 * @param {number} meters
 * @param {{metreStep?: number, exactBelowM?: number, system?: 'metric'|'imperial'}} [options]
 * @returns {string|null}
 */
export function formatDistanceText(meters, options) {
  const parts = distanceParts(meters, options);
  if (!parts) return null;
  return `${parts.value.toFixed(parts.digits)} ${parts.unit}`;
}
