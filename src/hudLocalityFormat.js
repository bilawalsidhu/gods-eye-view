/**
 * @module hudLocalityFormat
 * @description The HUD summary's locality line in the active language — the
 * formatter `hud.js` hands to `composeLocalityTag`. Kept apart from `hud.js`
 * (which imports `mgrs`, not loadable under plain Node) so it is unit-testable.
 */
import { formatNumber, getLocale, t } from './i18n/index.js';
import { unitLabel } from './ui/unitLabels.js';
import { localizePlaceName } from './ui/placeNames.js';

/** An upper-case HUD quantity such as `13KM` / `13КМ`, in the active language. */
export function hudQuantity(value, unit, digits = 0) {
  const number = formatNumber(value, {
    useGrouping: false,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const label = unitLabel(unit);
  if (getLocale() === 'zh-CN') return label ? `${number} ${label}` : number;
  return `${number}${label.toUpperCase()}`;
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
      distance: hudQuantity(Math.round(distKm), 'km'),
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
