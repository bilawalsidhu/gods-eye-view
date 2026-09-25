/**
 * NORAD catalog number of a satrec as a number.
 *
 * satellite.js keeps the TLE's five-character field verbatim in `satrec.satnum`. Since the
 * catalog passed 99999 (July 2026) that field is written in Alpha-5: a letter A–Z, skipping
 * I and O, stands for 10–33 in the ten-thousands place, so 100000 is "A0000". `Number("A0000")`
 * is NaN, and every Alpha-5 satellite would then share one NaN key. This decodes the letter;
 * a five-digit field is unchanged; anything else stays NaN.
 * @param {string} satnum
 * @returns {number}
 */
export function noradIdFromSatnum(satnum) {
  const field = String(satnum ?? '').trim();
  const c = field[0];
  if (
    c >= 'A' &&
    c <= 'Z' &&
    c !== 'I' &&
    c !== 'O' &&
    /^\d{4}$/.test(field.slice(1))
  ) {
    let tens = c.charCodeAt(0) - 65 + 10;
    if (c > 'I') tens -= 1;
    if (c > 'O') tens -= 1;
    return tens * 10000 + Number(field.slice(1));
  }
  return Number(field);
}
