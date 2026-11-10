/** Latin letters that Unicode decomposition does not fold to plain ASCII. */
const FOLD = {
  ß: 'ss',
  ø: 'o',
  æ: 'ae',
  ł: 'l',
  đ: 'd',
  ı: 'i',
  œ: 'oe',
  þ: 'th',
};

/**
 * Script-aware fold of a place name: case folded, accents removed from Latin
 * letters only, punctuation and symbols collapsed to single spaces. Other
 * scripts keep their marks, so "कुल मार्ग" and "काली मार्ग" stay distinct while
 * "São Paulo", "sao paulo" and "SÃO PAULO!" meet. Every word is kept: "The
 * Hague" is not "Hague".
 *
 * @param {unknown} value
 * @returns {string}
 */
export function foldPlaceText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[ßøæłđıœþ]/g, (c) => FOLD[c])
    .normalize('NFKD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Comparable form of a place name, shared by the bundled packs, the
 * OpenFreeMap street and grounds matchers and the Nominatim server:
 * `foldPlaceText` with a leading "the" dropped.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function foldPlaceName(value) {
  return foldPlaceText(value).replace(/^the /, '');
}

/**
 * Fold a name for matching (see `foldPlaceName`), with "saint" and "sainte"
 * shortened the way US place names abbreviate them.
 */
export function normalizePlaceName(value) {
  return foldPlaceName(value)
    .replace(/\bsaint\b/g, 'st')
    .replace(/\bsainte\b/g, 'ste');
}
