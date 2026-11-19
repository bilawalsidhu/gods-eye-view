/**
 * Strict coordinate parsing for the search box.
 *
 * A search that guesses is worse than one that declines: reading `12junk, 34oops`
 * as 12, 34 flies the operator somewhere they did not ask for and looks like a
 * successful search. So every rule here is exact — a component is a decimal
 * number, or degrees with minutes and seconds marked by their symbols
 * (`40°26'46"`), optionally signed, optionally marked with one hemisphere
 * letter, and nothing else. Two-dimensional WGS84 geo URIs use their own
 * strict grammar, as do UTM and MGRS grid references (`gridReference.js`) and
 * full plus codes (`plusCode.js`). Unmarked runs such as `40 26 46 N` and
 * short plus codes are not handled; they fall through to the geocoders.
 */
import { parseGridReference } from './gridReference.js';
import { parsePlusCode } from './plusCode.js';

/** One decimal-degree component: an optional hemisphere letter on either side. */
const COMPONENT =
  /^([NSEW])?\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*°?\s*([NSEW])?$/i;

/** RFC 5870's 2D WGS84 subset; never discard altitude or uncertainty. */
const GEO_URI =
  /^geo:(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)(?:;crs=wgs84)?$/i;

/**
 * Degrees, minutes and optional seconds, each marked by its symbol, with an
 * optional sign and one optional hemisphere letter on either side. Only the
 * last number may have a decimal part.
 */
const DMS_COMPONENT =
  /^([NSEW])?\s*([+-])?(\d{1,3})\s*[°º]\s*(\d{1,2}(?:\.\d+)?)\s*['′’]\s*(?:(\d{1,2}(?:\.\d+)?)\s*(?:"|″|”|''|′′))?\s*([NSEW])?$/i;

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
  if (!match) return readDmsComponent(text);
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

/**
 * Read one degrees-minutes-seconds component, by the same rules as a decimal
 * one: a sign and a letter never both, minutes and seconds below 60, and a
 * decimal part only on the last number given.
 *
 * @param {string} text
 * @returns {{ value: number, axis: 'lat'|'lon'|null } | null}
 */
function readDmsComponent(text) {
  const match = DMS_COMPONENT.exec(String(text).trim());
  if (!match) return null;
  const [, before, sign, degrees, minutes, seconds, after] = match;
  if (before && after) return null;
  const letter = (before || after || '').toUpperCase();
  if (letter && sign) return null;
  if (seconds !== undefined && minutes.includes('.')) return null;
  if (Number(minutes) >= 60 || (seconds !== undefined && Number(seconds) >= 60))
    return null;
  const magnitude =
    Number(degrees) + Number(minutes) / 60 + Number(seconds ?? 0) / 3600;
  if (!letter)
    return { value: sign === '-' ? -magnitude : magnitude, axis: null };
  return {
    value: letter === 'S' || letter === 'W' ? -magnitude : magnitude,
    axis: LATITUDE_LETTERS.has(letter) ? 'lat' : 'lon',
  };
}

/**
 * Split on a comma, a semicolon, or whitespace — never on anything else.
 * A hemisphere letter stays with the number it names, so `40.7 N 74.0 W`
 * is two components. Splitting on the space before that letter used to
 * leave three pieces and the search declined the coordinate.
 */
function splitComponents(query) {
  const text = String(query).trim();
  if (!text) return null;
  if (/[,;]/.test(text)) {
    const trimmed = text.split(/[,;]/).map((part) => part.trim());
    return trimmed.length === 2 && trimmed.every(Boolean) ? trimmed : null;
  }
  const words = text.split(/\s+/);
  // Each component has at most degrees, minutes and seconds with their
  // symbols and one hemisphere letter.
  if (words.length > 14) return null;
  // Keep every character: extracting tokens would turn `1e3` or `1.2.3`
  // into invented coordinates. A lone letter between numbers can name either
  // component; require an unambiguous split rather than guessing its owner.
  let result = null;
  for (let boundary = words.length - 1; boundary > 0; boundary -= 1) {
    const parts = [
      words.slice(0, boundary).join(' '),
      words.slice(boundary).join(' '),
    ];
    if (parts.every((part) => readComponent(part))) {
      if (result) return null;
      result = parts;
    }
  }
  return result;
}

/** Present a parsed pair the way a coordinate is normally written. */
export function formatCoordinateLabel(lat, lon) {
  const latLetter = lat >= 0 ? 'N' : 'S';
  const lonLetter = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}° ${latLetter}, ${Math.abs(lon).toFixed(4)}° ${lonLetter}`;
}

/**
 * Parse a decimal-degree or degrees-minutes-seconds pair, a two-dimensional
 * WGS84 geo URI, a UTM or MGRS grid reference or a full plus code, or return
 * null.
 *
 * Both orders are accepted when the hemisphere letters say which is which
 * (`W 40, N 74` is longitude then latitude); with no letters the conventional
 * latitude-then-longitude order applies. Two letters naming the same axis, a
 * letter that fixes nothing, an out-of-range latitude or longitude, and any
 * trailing text all decline.
 * Geo URIs accept only latitude/longitude and an optional `;crs=wgs84`;
 * altitude, uncertainty, other parameters and query/fragment suffixes decline.
 *
 * @param {string} query
 * @returns {{ lat: number, lon: number, label: string } | null}
 */
export function parseCoordinateQuery(query) {
  if (typeof query !== 'string') return null;
  const text = query.trim();
  const parts = /^geo:/i.test(text)
    ? GEO_URI.exec(text)?.slice(1, 3)
    : splitComponents(text);
  if (!parts) {
    const point = parseGridReference(text) ?? parsePlusCode(text);
    return (
      point && { ...point, label: formatCoordinateLabel(point.lat, point.lon) }
    );
  }

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
