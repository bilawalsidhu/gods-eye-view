/**
 * @module hudLocalityFormat
 * @description The HUD summary's locality line in the active language — the
 * formatter `hud.js` hands to `composeLocalityTag`. Kept apart from `hud.js`
 * (which imports `mgrs`, not loadable under plain Node) so it is unit-testable.
 */
import { formatNumber, getLocale, t } from './i18n/index.js';
import { convertQuantity, getUnitSystem, unitLabel } from './ui/unitLabels.js';
import { METRES_PER_MILE } from './data/distanceFormat.js';
import { localizePlaceName } from './ui/placeNames.js';

/**
 * Scripts without letter case keep a space before the unit: `13 km` in
 * Chinese and Japanese, `13 كم` in Arabic, which would otherwise run the
 * digits into the word.
 */
const UNCASED_UNITS = /^(?:zh|ja|ar)(?:-|$)/;

/** An upper-case HUD quantity such as `13KM` / `13КМ`, in the active language. */
export function hudQuantity(value, unit, digits = 0) {
  const number = formatNumber(value, {
    useGrouping: false,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const label = unitLabel(unit);
  if (UNCASED_UNITS.test(getLocale()))
    return label ? `${number} ${label}` : number;
  return `${number}${label.toUpperCase()}`;
}

/**
 * A whole HUD distance of at least 1 in the active unit system: `12KM`, or
 * `7MI` under imperial units. A falsy `unit` leaves the number bare.
 * @param {number} km
 * @param {string} [unit]
 */
export function hudMeasure(km, unit) {
  const shown = convertQuantity(km, 'km');
  return hudQuantity(
    Math.max(1, Math.round(shown.value)),
    unit ? shown.unit : '',
  );
}

/**
 * The camera altitude in the summary line: `850M` / `4.2KM`, or `2790FT` /
 * `2.6MI` under imperial units.
 * @param {number} meters
 */
export function hudAltitude(meters) {
  if (getUnitSystem() === 'imperial')
    return meters >= METRES_PER_MILE
      ? hudQuantity(meters / METRES_PER_MILE, 'mi', 1)
      : hudQuantity(Math.round(convertQuantity(meters, 'm').value), 'ft');
  return meters >= 1000
    ? hudQuantity(meters / 1000, 'km', 1)
    : hudQuantity(Math.round(meters), 'm');
}

/**
 * A sensor-code length such as `0.30m` (`0.98ft` under imperial units), as
 * the HUD corner readouts print it.
 * @param {number} meters
 * @param {number} digits
 */
export function hudReadout(meters, digits) {
  const shown = convertQuantity(meters, 'm');
  // Round first, so a reading just below zero prints 0, never -0.
  const value = Number(shown.value.toFixed(digits)) || 0;
  return `${value.toFixed(digits)}${shown.unit}`;
}

/** One hemisphere-tagged coordinate, e.g. `21.33N` / `21,33С`. */
function hudCoordinate(value, positive, negative) {
  return `${hudQuantity(Math.abs(value), '', 2)}${value >= 0 ? positive : negative}`;
}

/** The summary's locality line in the active language (see hudLocality.js). */
export const LOCALIZED_LOCALITY = Object.freeze({
  // Translate the catalogued name (`Tokyo`), then upper-case it in the page's
  // language: the place-name table knows `Tokyo`, not `TOKYO`.
  near: ({ poi, city, distKm }) =>
    t('NEAR {poi} ({city}) {distance}', {
      poi: poi.toLocaleUpperCase(getLocale()),
      city: localizePlaceName(city).toLocaleUpperCase(getLocale()),
      distance: hudQuantity(
        Math.round(convertQuantity(distKm, 'km').value),
        convertQuantity(distKm, 'km').unit,
      ),
    }),
  sector: ({ latDeg, lonDeg }) =>
    t('SECTOR {lat} {lon}', {
      // Hemisphere letters, not compass words: 21.33N, never 21.33北.
      lat: hudCoordinate(
        latDeg,
        t('N', { context: 'hemisphere' }),
        t('S', { context: 'hemisphere' }),
      ),
      lon: hudCoordinate(
        lonDeg,
        t('E', { context: 'hemisphere' }),
        t('W', { context: 'hemisphere' }),
      ),
    }),
});
