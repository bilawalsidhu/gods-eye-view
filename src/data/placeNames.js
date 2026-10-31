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
 * Comparable form of a place name, shared by the bundled packs, the
 * OpenFreeMap street and grounds matchers and the Nominatim server: case
 * folded, accents removed from Latin letters only, punctuation and symbols
 * collapsed to single spaces, and a leading "the" dropped. Other scripts keep
 * their marks, so "कुल मार्ग" and "काली मार्ग" stay distinct while "São Paulo",
 * "sao paulo" and "SÃO PAULO!" meet.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function foldPlaceName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[ßøæłđıœþ]/g, (c) => FOLD[c])
    .normalize('NFKD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^the /, '');
}
