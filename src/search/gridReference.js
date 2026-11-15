/**
 * UTM and MGRS grid references to latitude and longitude, for the search box.
 *
 * Strict, like the decimal parser: a reference either reads exactly or is
 * declined. UTM is `18T 585628 4511322` (zone, latitude band, easting,
 * northing); MGRS is `18T WL 85650 11369`, spaced or not, with 3 to 5 digits
 * each for easting and northing (100 m to 1 m). Coarser MGRS (`18T WL 8511`)
 * declines: written that way, `1 JAN 2023`, `3 USA 12` or `20 KPH 1000` would
 * read as grid squares. MGRS letters are capitals, as references are printed,
 * unless written unspaced (`18twl856113`), and the square must lie in its
 * zone. Letters that spell a month (`1 JAN 2023 1200`) decline: a date is far
 * likelier than one of those few squares. The polar UPS bands (A, B, Y, Z) and the zones Svalbard does not use
 * (32X, 34X, 36X) decline. A UTM `N` or `S` is the latitude band when its
 * northing falls in that band, and otherwise the hemisphere, as UTM is also
 * written (`33N 500000 4500000`); a southern reference between about 50°S and
 * 58°S written with `S` reads as band S.
 */

/** WGS84. */
const A = 6378137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const FALSE_EASTING = 500000;
const FALSE_NORTHING_SOUTH = 10000000;

/** Latitude bands C to X (no I or O), 8° each from 80°S; X is 12°. */
const BANDS = 'CDEFGHJKLMNPQRSTUVWX';

/** MGRS 100 km column letters by zone set, and the row letters. */
const COLUMN_SETS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const ROW_LETTERS = 'ABCDEFGHJKLMNPQRSTUV';

/** The latitude range of a band letter, or null. */
function bandRange(letter) {
  const index = BANDS.indexOf(letter);
  if (index < 0) return null;
  const south = -80 + index * 8;
  return { south, north: letter === 'X' ? 84 : south + 8 };
}

/**
 * Inverse transverse Mercator (Krüger's series to the sixth order, as in
 * Karney 2011): UTM easting and northing in a zone to latitude and longitude.
 */
function utmToLatLon(zone, easting, northing, southern) {
  const n = F / (2 - F);
  const n2 = n * n;
  const n3 = n2 * n;
  const n4 = n3 * n;
  const n5 = n4 * n;
  const n6 = n5 * n;
  const rectifying = (A / (1 + n)) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
  const beta = [
    n / 2 -
      (2 / 3) * n2 +
      (37 / 96) * n3 -
      n4 / 360 -
      (81 / 512) * n5 +
      (96199 / 604800) * n6,
    n2 / 48 +
      n3 / 15 -
      (437 / 1440) * n4 +
      (46 / 105) * n5 -
      (1118711 / 3870720) * n6,
    (17 / 480) * n3 - (37 / 840) * n4 - (209 / 4480) * n5 + (5569 / 90720) * n6,
    (4397 / 161280) * n4 - (11 / 504) * n5 - (830251 / 7257600) * n6,
    (4583 / 161280) * n5 - (108847 / 3991680) * n6,
    (20648693 / 638668800) * n6,
  ];
  const xi =
    (southern ? northing - FALSE_NORTHING_SOUTH : northing) / (K0 * rectifying);
  const eta = (easting - FALSE_EASTING) / (K0 * rectifying);
  let xiPrime = xi;
  let etaPrime = eta;
  for (let j = 1; j <= 6; j += 1) {
    xiPrime -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaPrime -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const conformal = Math.asin(Math.sin(xiPrime) / Math.cosh(etaPrime));
  const longitudeOffset = Math.atan2(Math.sinh(etaPrime), Math.cos(xiPrime));
  // Conformal to geodetic latitude, by Newton's method on tan φ.
  const e = Math.sqrt(F * (2 - F));
  const tauPrime = Math.tan(conformal);
  let tau = tauPrime;
  for (let i = 0; i < 6; i += 1) {
    const sigma = Math.sinh(
      e * Math.atanh((e * tau) / Math.sqrt(1 + tau * tau)),
    );
    const tauIPrime =
      tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
    const delta =
      ((tauPrime - tauIPrime) / Math.sqrt(1 + tauIPrime * tauIPrime)) *
      ((1 + (1 - e * e) * tau * tau) /
        ((1 - e * e) * Math.sqrt(1 + tau * tau)));
    tau += delta;
    if (Math.abs(delta) < 1e-12) break;
  }
  const lat = (Math.atan(tau) * 180) / Math.PI;
  let lon = (zone - 1) * 6 - 180 + 3 + (longitudeOffset * 180) / Math.PI;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return { lat, lon };
}

/**
 * Whether a latitude sits in a band, allowing `slack` degrees past its edges
 * (an MGRS square's centre can lie across the band edge the square touches).
 */
function inBand(lat, range, slack = 0) {
  return lat >= range.south - slack && lat <= range.north + slack;
}

/** Zones 32, 34 and 36 do not exist in band X (Svalbard's widened zones). */
function zoneExists(zone, band) {
  return !(band === 'X' && (zone === 32 || zone === 34 || zone === 36));
}

/** Svalbard's widened zones in band X, as [west, east] longitudes. */
const SVALBARD_ZONES = { 31: [0, 9], 33: [9, 21], 35: [21, 33], 37: [33, 42] };

/**
 * The longitudes a zone covers in a band: 6° each, except southwest Norway
 * (31V is 0°–3°E, 32V is 3°E–12°E) and Svalbard (band X).
 */
function zoneLongitudes(zone, band) {
  if (band === 'V' && zone === 31) return [0, 3];
  if (band === 'V' && zone === 32) return [3, 12];
  if (band === 'X' && SVALBARD_ZONES[zone]) return SVALBARD_ZONES[zone];
  const west = (zone - 1) * 6 - 180;
  return [west, west + 6];
}

/** UTM `18T 585628 4511322` (or `18 T 585628 4511322`), or null. */
function parseUtm(text) {
  const match =
    /^(\d{1,2})\s*([C-HJ-NP-X])\s+(\d{6}(?:\.\d+)?)\s*m?\s+(\d{1,7}(?:\.\d+)?)\s*m?$/i.exec(
      text,
    );
  if (!match) return null;
  const zone = Number(match[1]);
  const letter = match[2].toUpperCase();
  const easting = Number(match[3]);
  const northing = Number(match[4]);
  if (
    zone < 1 ||
    zone > 60 ||
    easting < 100000 ||
    easting > 900000 ||
    northing > 10000000 ||
    !zoneExists(zone, letter)
  )
    return null;
  const range = bandRange(letter);
  const asBand = utmToLatLon(zone, easting, northing, range.south < 0);
  const bandFits = inBand(asBand.lat, range);
  if (bandFits) return asBand;
  // `N` and `S` are also how UTM is written for the hemispheres. Where both
  // fit, the 32°N–40°N band (Tokyo, Los Angeles, the Mediterranean) is far
  // likelier than 50°S–58°S, so the band wins above.
  if (letter === 'N') {
    const north = utmToLatLon(zone, easting, northing, false);
    if (north.lat >= 0 && north.lat <= 84) return north;
  }
  if (letter === 'S') {
    const south = utmToLatLon(zone, easting, northing, true);
    if (south.lat < 0 && south.lat >= -80) return south;
  }
  return null;
}

/**
 * The lowest northing of each band, in metres, that MGRS's 2,000 km row
 * cycle is lifted past (the NGA table, as used by proj4's mgrs module).
 */
const BAND_MIN_NORTHING = {
  C: 1100000,
  D: 2000000,
  E: 2800000,
  F: 3700000,
  G: 4600000,
  H: 5500000,
  J: 6400000,
  K: 7300000,
  L: 8200000,
  M: 9100000,
  N: 0,
  P: 800000,
  Q: 1700000,
  R: 2600000,
  S: 3500000,
  T: 4400000,
  U: 5300000,
  V: 6200000,
  W: 7000000,
  X: 7900000,
};

/** Month abbreviations a band and square could spell (`JAN`, `SEP`, …). */
const MONTHS = new Set([
  'JAN',
  'FEB',
  'MAR',
  'MAY',
  'JUN',
  'JUL',
  'SEP',
  'NOV',
  'DEC',
]);

/**
 * MGRS as `18TWL8565011369`, `18T WL 8565011369` or `18T WL 85650 11369`
 * (easting and northing the same length), or null.
 */
function parseMgrs(text) {
  const match =
    /^(\d{1,2})\s*([C-HJ-NP-X])\s*([A-HJ-NP-Z])([A-HJ-NP-V])(?:\s*(\d{6,10})|\s*(\d{3,5})\s+(\d{3,5}))$/i.exec(
      text,
    );
  if (!match) return null;
  const zone = Number(match[1]);
  const band = match[2].toUpperCase();
  const column = match[3].toUpperCase();
  const row = match[4].toUpperCase();
  let east;
  let north;
  if (match[5]) {
    if (match[5].length % 2) return null;
    east = match[5].slice(0, match[5].length / 2);
    north = match[5].slice(match[5].length / 2);
  } else if (match[6]) {
    if (match[6].length !== match[7].length) return null;
    [east, north] = [match[6], match[7]];
  }
  if (zone < 1 || zone > 60 || !zoneExists(zone, band)) return null;
  const precision = east.length;
  const letters = text.replace(/[\d\s]/g, '');
  if (MONTHS.has(letters.toUpperCase())) return null;
  if (letters !== letters.toUpperCase() && /\s/.test(text)) return null;
  const columnIndex = COLUMN_SETS[(zone - 1) % 3].indexOf(column);
  if (columnIndex < 0) return null;
  // Rows start at A in odd zones and at F in even ones.
  const rowIndex =
    (ROW_LETTERS.indexOf(row) - (zone % 2 === 0 ? 5 : 0) + 20) % 20;
  const scale = 10 ** (5 - precision);
  // The centre of the square the digits name; a 1 m reference is its corner.
  const half = precision < 5 ? scale / 2 : 0;
  const easting = (columnIndex + 1) * 100000 + Number(east) * scale + half;
  let northing = rowIndex * 100000 + Number(north) * scale + half;
  while (northing < BAND_MIN_NORTHING[band]) northing += 2000000;
  const range = bandRange(band);
  const point = utmToLatLon(zone, easting, northing, range.south < 0);
  // Slack of the square's size in degrees of latitude, and in longitude at
  // that latitude.
  const slack = scale / 111000;
  if (!inBand(point.lat, range, slack)) return null;
  const [zoneWest, zoneEast] = zoneLongitudes(zone, band);
  const lonSlack =
    slack / Math.max(Math.cos((point.lat * Math.PI) / 180), 0.01);
  // Compare across the antimeridian unwrapped: zone 1 starts at 180°W.
  let lon = point.lon;
  if (lon - zoneWest > 180) lon -= 360;
  if (zoneEast - lon > 180) lon += 360;
  return lon >= zoneWest - lonSlack && lon <= zoneEast + lonSlack
    ? point
    : null;
}

/**
 * A UTM or MGRS reference as `{ lat, lon }`, or null when the text is not
 * exactly one.
 * @param {string} text
 */
export function parseGridReference(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 40) return null;
  return parseUtm(trimmed) ?? parseMgrs(trimmed);
}
