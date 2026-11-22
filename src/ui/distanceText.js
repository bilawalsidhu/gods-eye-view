import { formatNumber, t } from '../i18n/index.js';

/**
 * A distance as a list row shows it: metres under a kilometre, one decimal
 * under ten kilometres, whole kilometres beyond.
 * @param {number} km
 * @returns {string}
 */
export function distanceText(km) {
  return km < 1
    ? t('{n} m', { n: formatNumber(Math.round(km * 1000)) })
    : t('{n} km', {
        n: formatNumber(km < 10 ? Number(km.toFixed(1)) : Math.round(km)),
      });
}
