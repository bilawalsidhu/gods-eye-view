import { formatNumber, t } from '../i18n/index.js';

/**
 * A distance as a list row shows it: metres under a kilometre, one decimal
 * under ten kilometres, whole kilometres beyond.
 * @param {number} km
 * @param {boolean} [approximate] The point represents a privacy cell.
 * @returns {string}
 */
export function distanceText(km, approximate = false) {
  const metres = Math.round(km * 1000);
  const value =
    metres < 1000
      ? t('{n} m', { n: formatNumber(metres) })
      : t('{n} km', {
          n: formatNumber(km < 10 ? Number(km.toFixed(1)) : Math.round(km)),
        });
  return approximate ? `${value} (${t('approximate')})` : value;
}
