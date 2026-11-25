import { formatNumber, t } from '../i18n/index.js';
import { distanceParts } from '../data/distanceFormat.js';

// iNaturalist privacy cells and Acartia observations rounded to 0.01°.
export const approximatePosition = (record) =>
  record?.obscured === true || record?.source === 'Acartia';

/**
 * A distance as a list row shows it: metres under a kilometre, one decimal
 * under ten kilometres, whole kilometres beyond.
 * @param {number} km
 * @param {boolean} [approximate] The position is a privacy cell or a rounded observation.
 * @returns {string}
 */
export function distanceText(km, approximate = false) {
  const parts = distanceParts(km * 1000);
  if (!parts) return '';
  const n = formatNumber(parts.value);
  const value = parts.unit === 'm' ? t('{n} m', { n }) : t('{n} km', { n });
  return approximate ? `${value} (${t('approximate')})` : value;
}
