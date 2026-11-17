/**
 * Full Open Location Codes ("plus codes", `849VCWC8+R9`) to the centre of
 * their area, for the search box. Implements the decoding half of the Open
 * Location Code specification (github.com/google/open-location-code). Short
 * codes (`CWC8+R9 Mountain View`) need a reference place and decline, as does
 * anything that is not exactly one valid full code.
 */

const ALPHABET = '23456789CFGHJMPQRVWX';
const SEPARATOR = '+';
const SEPARATOR_POSITION = 8;
const PADDING = '0';
const PAIR_LENGTH = 10;
const GRID_COLUMNS = 4;
const GRID_ROWS = 5;
const MAX_LENGTH = 15;

/** Whether `code` is a valid full code (the specification's isFull). */
function isFullCode(code) {
  const separator = code.indexOf(SEPARATOR);
  if (separator < 0 || separator !== code.lastIndexOf(SEPARATOR)) return false;
  if (
    separator !== SEPARATOR_POSITION ||
    code.length === SEPARATOR_POSITION + 2
  )
    return false;
  const padding = code.indexOf(PADDING);
  if (padding >= 0) {
    // Padding only before the separator, in an even count from an even place,
    // and nothing after the separator.
    if (padding === 0 || padding % 2) return false;
    const run = /0+/.exec(code)[0];
    if (
      run.length % 2 ||
      run.length !== code.split('').filter((c) => c === PADDING).length
    )
      return false;
    if (padding + run.length !== separator) return false;
    if (code.length > separator + 1) return false;
  }
  for (const character of code)
    if (
      character !== SEPARATOR &&
      character !== PADDING &&
      !ALPHABET.includes(character)
    )
      return false;
  // The first two characters keep latitude below 90 and longitude below 180.
  if (ALPHABET.indexOf(code[0]) * 20 >= 180) return false;
  if (ALPHABET.indexOf(code[1]) * 20 >= 360) return false;
  return true;
}

/**
 * The centre of a full plus code as `{ lat, lon }`, or null.
 * @param {string} text
 */
export function parsePlusCode(text) {
  if (typeof text !== 'string') return null;
  const code = text.trim().toUpperCase();
  if (!code || code.length > 32 || !isFullCode(code)) return null;
  const digits = code
    .replace(SEPARATOR, '')
    .replace(/0+$/, '')
    .slice(0, MAX_LENGTH);
  let south = -90;
  let west = -180;
  let latStep = 400;
  let lonStep = 400;
  // Pairs: alternating latitude and longitude digits in base 20.
  for (let i = 0; i < Math.min(digits.length, PAIR_LENGTH); i += 2) {
    latStep /= 20;
    lonStep /= 20;
    south += ALPHABET.indexOf(digits[i]) * latStep;
    if (i + 1 < digits.length)
      west += ALPHABET.indexOf(digits[i + 1]) * lonStep;
  }
  // Beyond ten digits, each one picks a cell of a 4 × 5 grid.
  for (let i = PAIR_LENGTH; i < digits.length; i += 1) {
    latStep /= GRID_ROWS;
    lonStep /= GRID_COLUMNS;
    const index = ALPHABET.indexOf(digits[i]);
    south += Math.floor(index / GRID_COLUMNS) * latStep;
    west += (index % GRID_COLUMNS) * lonStep;
  }
  const lat = Math.min(90, south + latStep / 2);
  let lon = west + lonStep / 2;
  if (lon >= 180) lon -= 360;
  return { lat, lon };
}
