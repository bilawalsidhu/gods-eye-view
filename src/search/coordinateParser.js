/**
 * Strict decimal-degree coordinate parsing for the search box.
 *
 * A search that guesses is worse than one that declines: reading `12junk, 34oops`
 * as 12, 34 flies the operator somewhere they did not ask for and looks like a
 * successful search. So every rule here is exact — a component is a decimal
 * number, optionally signed, optionally marked with one hemisphere letter, and
 * nothing else. Degrees/minutes/seconds and grid references are not handled;
 * they fall through to the geocoders, which is what happens today.
 */

/** One decimal-degree component: an optional hemisphere letter on either side. */
const COMPONENT =
  /^([NSEW])?\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*°?\s*([NSEW])?$/i;

/** Hemisphere letters, by the axis each one can name. */
const LATITUDE_LETTERS = new Set(['N', 'S']);

/**
 * Read one component into a signed value plus the axis its letter names.
 *
 * @param {string} text
 * @returns {{ value: number, axis: 'lat'|'lon'|null } | null}
 */
function readComponent(text) {
  const match = COMPONENT.exec(String(text).trim());
  if (!match) return null;
  const [, before, digits, after] = match;
  // Two letters on one component is a contradiction, not a coordinate.
  if (before && after) return null;
  const letter = (before || after || '').toUpperCase();
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  // A sign and a hemisphere letter both claim the direction; "-40N" means
  // neither one thing nor the other, so it is refused rather than guessed.
  if (letter && /^[+-]/.test(digits)) return null;
  if (!letter) return { value, axis: null };
  const magnitude = Math.abs(value);
  return {
    value: letter === 'S' || letter === 'W' ? -magnitude : magnitude,
    axis: LATITUDE_LETTERS.has(letter) ? 'lat' : 'lon',
  };
}

/** Split on a comma, a semicolon, or whitespace — never on anything else. */
function splitComponents(query) {
  const text = String(query).trim();
  if (!text) return null;
  const parts = /[,;]/.test(text)
    ? text.split(/[,;]/)
    : text.split(/\s+(?=[+-]?[.\d]|[NSEW]\s*[+-]?[.\d])/i);
  const trimmed = parts.map((part) => part.trim()).filter(Boolean);
  return trimmed.length === 2 ? trimmed : null;
}

/** Present a parsed pair the way a coordinate is normally written. */
export function formatCoordinateLabel(lat, lon) {
  const latLetter = lat >= 0 ? 'N' : 'S';
  const lonLetter = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}° ${latLetter}, ${Math.abs(lon).toFixed(4)}° ${lonLetter}`;
}

/**
 * Parse a decimal-degree query, or return null.
 *
 * Both orders are accepted when the hemisphere letters say which is which
 * (`W 40, N 74` is longitude then latitude); with no letters the conventional
 * latitude-then-longitude order applies. Two letters naming the same axis, a
 * letter that fixes nothing, an out-of-range latitude or longitude, and any
 * trailing text all decline.
 *
 * @param {string} query
 * @returns {{ lat: number, lon: number, label: string } | null}
 */
export function parseCoordinateQuery(query) {
  if (typeof query !== 'string') return null;
  const parts = splitComponents(query);
  if (!parts) return null;

  const first = readComponent(parts[0]);
  const second = readComponent(parts[1]);
  if (!first || !second) return null;
  // Both components naming the same axis leaves the other one unstated.
  if (first.axis && first.axis === second.axis) return null;

  let lat;
  let lon;
  if (first.axis === 'lon' || second.axis === 'lat') {
    lat = second.value;
    lon = first.value;
  } else {
    lat = first.value;
    lon = second.value;
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90) return null;
  if (lon < -180 || lon > 180) return null;
  return { lat, lon, label: formatCoordinateLabel(lat, lon) };
}
