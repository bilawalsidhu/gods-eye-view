/**
 * Maidenhead locator (grid square) conversions — browser-safe, dependency-free.
 *
 * Cells: field 20°×10°, square 2°×1°, subsquare (2/24)°×(1/24)°, extended
 * square (2/240)°×(1/240)°. `gridToLatLon` returns the CENTRE of the cell
 * named by the locator; `latLonToGrid` renders field/square upper-case and
 * subsquare lower-case ("JO32me"), the convention operators read.
 */

const GRID_RE = /^[A-R]{2}(\d{2}([A-X]{2}(\d{2})?)?)?$/i;

/** True when `value` is a syntactically valid 2/4/6/8-character locator. */
export function isValidGrid(value) {
  const text = String(value ?? '').trim();
  if (!GRID_RE.test(text)) return false;
  // "JJ00AA" is the null island placeholder some feeds emit for "unknown".
  return text.toUpperCase() !== 'JJ00AA';
}

/** Centre of the locator's cell, or null when the locator is malformed. */
export function gridToLatLon(locator) {
  const text = String(locator ?? '').trim().toUpperCase();
  if (!isValidGrid(text)) return null;
  const code = (ch, base) => ch.charCodeAt(0) - base;
  let lon = code(text[0], 65) * 20 - 180;
  let lat = code(text[1], 65) * 10 - 90;
  let lonSize = 20;
  let latSize = 10;
  if (text.length >= 4) {
    lon += Number(text[2]) * 2;
    lat += Number(text[3]) * 1;
    lonSize = 2;
    latSize = 1;
  }
  if (text.length >= 6) {
    lon += code(text[4], 65) * (2 / 24);
    lat += code(text[5], 65) * (1 / 24);
    lonSize = 2 / 24;
    latSize = 1 / 24;
  }
  if (text.length >= 8) {
    lon += Number(text[6]) * (2 / 240);
    lat += Number(text[7]) * (1 / 240);
    lonSize = 2 / 240;
    latSize = 1 / 240;
  }
  return { lat: lat + latSize / 2, lon: lon + lonSize / 2 };
}

/** Bounding box of a locator cell: { south, west, north, east } or null. */
export function gridBounds(locator) {
  const centre = gridToLatLon(locator);
  if (!centre) return null;
  const length = String(locator).trim().length;
  const lonSize = length >= 8 ? 2 / 240 : length >= 6 ? 2 / 24 : length >= 4 ? 2 : 20;
  const latSize = lonSize / 2;
  return {
    south: centre.lat - latSize / 2,
    west: centre.lon - lonSize / 2,
    north: centre.lat + latSize / 2,
    east: centre.lon + lonSize / 2,
  };
}

/** Locator for a position; `chars` ∈ {2,4,6,8}. Wraps longitude and clamps latitude. */
export function latLonToGrid(lat, lon, chars = 6) {
  const length = [2, 4, 6, 8].includes(chars) ? chars : 6;
  let la = Math.max(-90, Math.min(89.999999, Number(lat)));
  let lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  lo = ((((lo + 180) % 360) + 360) % 360) - 180; // wrap to [-180, 180)
  la += 90;
  lo += 180;
  const upper = (n) => String.fromCharCode(65 + n);
  const lower = (n) => String.fromCharCode(97 + n);
  let out = upper(Math.floor(lo / 20)) + upper(Math.floor(la / 10));
  if (length >= 4) {
    out += String(Math.floor((lo % 20) / 2)) + String(Math.floor(la % 10));
  }
  if (length >= 6) {
    const lonRem = (lo % 2) / (2 / 24);
    const latRem = (la % 1) / (1 / 24);
    out += lower(Math.min(23, Math.floor(lonRem))) + lower(Math.min(23, Math.floor(latRem)));
  }
  if (length >= 8) {
    const lonRem = ((lo % 2) % (2 / 24)) / (2 / 240);
    const latRem = ((la % 1) % (1 / 24)) / (1 / 240);
    out += String(Math.min(9, Math.floor(lonRem))) + String(Math.min(9, Math.floor(latRem)));
  }
  return out;
}
