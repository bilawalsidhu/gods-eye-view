/**
 * @file The satellites layer's class choice as share-link and saved-state
 * letters. Shared by the layer-state codec and the layer, which takes a saved
 * choice back in this form.
 */

/**
 * Satellite classes shown, as one letter each in legend order: stations,
 * imaging, telecom, probes, debris (`sitpd`, every one; `0`, none).
 * Starlink is the `catalog` option's, so it has no letter here.
 */
const SATELLITE_CLASS_LETTERS = Object.freeze([
  ['stations', 's'],
  ['imaging', 'i'],
  ['telecom', 't'],
  ['probes', 'p'],
  ['debris', 'd'],
]);
const SATELLITE_CLASS_MASK = /^(0|s?i?t?p?d?)$/;

/**
 * The canonical class letters for a class choice (an object of booleans, as
 * the layer's `classes` param, or a partial one) or for letters already,
 * else null.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeSatelliteClassMask(value) {
  if (typeof value === 'string')
    return value && SATELLITE_CLASS_MASK.test(value) ? value : null;
  if (!value || typeof value !== 'object') return null;
  // A class the choice leaves out keeps its default, which is shown: a
  // partial request (`{debris: false}`) hides only what it names.
  const letters = SATELLITE_CLASS_LETTERS.filter(([id]) => value[id] !== false)
    .map(([, letter]) => letter)
    .join('');
  return letters || '0';
}

/**
 * The class choice the letters stand for, without Starlink, or null.
 * @param {string} mask
 * @returns {Record<string, boolean>|null}
 */
export function decodeSatelliteClassMask(mask) {
  const normalized = normalizeSatelliteClassMask(mask);
  if (normalized === null || typeof mask !== 'string') return null;
  return Object.fromEntries(
    SATELLITE_CLASS_LETTERS.map(([id, letter]) => [
      id,
      normalized.includes(letter),
    ]),
  );
}
