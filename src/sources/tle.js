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

/**
 * The catalog number an Alpha-5 field stands for, or null for any other field.
 *
 * Since the catalog passed 99999 (July 2026) a TLE writes the numbers above it
 * in Alpha-5: a letter A–Z, skipping I and O, stands for 10–33 in the
 * ten-thousands place, so 100000 is "A0000" and 339999 is "Z9999".
 */
function alpha5CatalogNumber(field) {
  const letter = field[0];
  if (
    letter >= 'A' &&
    letter <= 'Z' &&
    letter !== 'I' &&
    letter !== 'O' &&
    /^\d{4}$/.test(field.slice(1))
  ) {
    let tens = letter.charCodeAt(0) - 65 + 10;
    if (letter > 'I') tens -= 1;
    if (letter > 'O') tens -= 1;
    return tens * 10000 + Number(field.slice(1));
  }
  return null;
}

/** The NORAD catalog number from a TLE line, or null. */
export function tleCatalogNumber(line) {
  const field = String(line).slice(2, 7);
  const alpha5 = alpha5CatalogNumber(field);
  if (alpha5 !== null) return alpha5;
  const number = Number.parseInt(field, 10);
  return Number.isInteger(number) ? number : null;
}
