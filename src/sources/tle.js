/**
 * Parse three-line TLE catalog text into `{ name, line1, line2 }` entries.
 * Malformed sets are skipped without dropping the valid sets that follow.
 */
export function parseTleText(text) {
  const lines = String(text)
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const result = [];
  for (let i = 0; i < lines.length - 2; i++) {
    const name = lines[i];
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    const cat1 = tleCatalogNumber(line1);
    const cat2 = tleCatalogNumber(line2);
    if (
      line1.startsWith('1 ') &&
      line2.startsWith('2 ') &&
      cat1 !== null &&
      cat1 === cat2
    ) {
      result.push({ name, line1, line2 });
      i += 2;
    }
  }
  return result;
}

// Alpha-5: a letter A–Z, skipping I and O, then exactly four digits.
const ALPHA5 = /^[A-HJ-NP-Z]\d{4}$/;
const DIGITS = /^\d+$/;

/**
 * The catalog number a catalog field stands for, or null for any other field.
 *
 * A field is either plain digits or Alpha-5, the TLE spelling of numbers above
 * 99999: the letter stands for 10–33 in the ten-thousands place, skipping I
 * and O, so 100000 is "A0000" and 339999 is "Z9999". Anything else (a sign, a
 * decimal point, hex, an embedded space, a lowercase or trailing letter) is
 * not a catalog number.
 * @param {string} field the field with any leading spaces already removed
 * @returns {number | null}
 */
function decodeCatalogField(field) {
  if (DIGITS.test(field)) return Number(field);
  if (!ALPHA5.test(field)) return null;
  const letter = field[0];
  let tens = letter.charCodeAt(0) - 65 + 10;
  if (letter > 'I') tens -= 1;
  if (letter > 'O') tens -= 1;
  return tens * 10000 + Number(field.slice(1));
}

/**
 * NORAD catalog number of a satrec as a number, or NaN.
 *
 * satellite.js keeps the TLE's five-character field verbatim in
 * `satrec.satnum`, and `Number("A0000")` is NaN, so every Alpha-5 satellite
 * would share one NaN key. Digits of any length (an OMM satrec carries the
 * number unpadded) and Alpha-5 decode; anything else, blank included, is NaN.
 * @param {string} satnum
 * @returns {number}
 */
export function noradIdFromSatnum(satnum) {
  return decodeCatalogField(String(satnum ?? '').trim()) ?? Number.NaN;
}

/** The NORAD catalog number from TLE line 1 or 2 (columns 3–7), or null. */
export function tleCatalogNumber(line) {
  const field = String(line).slice(2, 7);
  return decodeCatalogField(field.replace(/^ +/, ''));
}
