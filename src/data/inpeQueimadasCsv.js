/**
 * INPE Programa Queimadas near-real-time CSV parsing — pure functions, no
 * Cesium/DOM/network.
 *
 * Upstream directory (one file per 10 minutes, about four days kept):
 *   https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/10min/
 * Files are named `focos_10min_YYYYMMDD_HHMM.csv` and carry the header
 * `lat,lon,satelite,data` (confirmed live 2026-10-29). `data` is the satellite
 * pass time in GMT (Programa Queimadas FAQ 43). A file holds the detections
 * processed in that 10-minute slot, so a pass can land up to about 28 hours
 * after it was observed; callers filter by `data`, not by the file name.
 *
 * Records come out in the src/data/firmsCsv.js shape so the Active Fires layer
 * renders them unchanged. INPE publishes no fire radiative power, confidence,
 * brightness or day/night flag, so those fields are null or empty, never zero:
 * an unknown FRP must not read as "0 MW" and an unknown confidence must not
 * read as "low".
 */

/** The near-real-time directory listing; file names are appended to it. */
export const INPE_10MIN_URL =
  'https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/10min/';

const FILE_PATTERN = /focos_10min_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})\.csv/g;
const PASS_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/;

/**
 * INPE satellite names → FIRMS-style satellite code and instrument, so
 * satelliteShortName() and the card's sensor line read the same as FIRMS.
 * The names seen on 2026-10-29 were NOAA-20, NOAA-21, NPP-375, NPP-375D,
 * AQUA_M-T, AQUA_M-M, TERRA_M-T, TERRA_M-M, GOES-19, MSG-03, METOP-B and
 * METOP-C. An unlisted satellite keeps its own name and no instrument.
 */
const SATELLITES = [
  [/^NOAA-?20\b/, () => 'N20', 'VIIRS'],
  [/^NOAA-?21\b/, () => 'N21', 'VIIRS'],
  [/^NPP\b/, () => 'N', 'VIIRS'],
  [/^AQUA\b/, () => 'Aqua', 'MODIS'],
  [/^TERRA\b/, () => 'Terra', 'MODIS'],
  [/^GOES-?(\d+)/, (m) => `G${Number(m[1])}`, 'ABI'],
  [/^MSG-?(\d+)/, (m) => `MSG${Number(m[1])}`, 'SEVIRI'],
  [/^METOP-?([A-Z])\b/, (m) => `MetOp${m[1]}`, 'AVHRR'],
];

/**
 * Map an INPE satellite name to `{satellite, instrument}`.
 * @param {string} name - The CSV `satelite` cell, e.g. "NOAA-20" or "AQUA_M-T".
 * @returns {{satellite: string, instrument: string}}
 */
export function inpeSatellite(name) {
  const raw = String(name || '')
    .trim()
    .toUpperCase()
    .replace(/_/g, '-');
  for (const [pattern, code, instrument] of SATELLITES) {
    const match = pattern.exec(raw);
    if (match) return { satellite: code(match), instrument };
  }
  return { satellite: raw.slice(0, 12), instrument: '' };
}

/**
 * File names in a directory listing, oldest first, each with the epoch
 * milliseconds its name stands for (UTC). Duplicate links collapse.
 * @param {string} html - The Apache index page.
 * @returns {Array<{name: string, at: number}>}
 */
export function parseInpeListing(html) {
  if (typeof html !== 'string') return [];
  const files = new Map();
  for (const match of html.matchAll(FILE_PATTERN)) {
    const [name, year, month, day, hour, minute] = match;
    const at = Date.UTC(+year, +month - 1, +day, +hour, +minute);
    if (Number.isFinite(at)) files.set(name, at);
  }
  return [...files]
    .map(([name, at]) => ({ name, at }))
    .sort((a, b) => a.at - b.at);
}

/**
 * Parse one 10-minute file into firmsCsv-shaped records.
 *
 * A header-only file parses to `[]`. Anything that is not an INPE fire CSV
 * (an HTML error page, a moved file) returns `null`, so callers can tell "no
 * fires" from "upstream failure". Rows with a blank or out-of-range position
 * or an unreadable pass time are skipped.
 *
 * @param {string} text - Raw CSV payload.
 * @returns {?Array<Object>} Records, or null for a non-INPE payload.
 */
export function parseInpeCsv(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split('\n');
  let headerIndex = 0;
  while (headerIndex < lines.length && !lines[headerIndex].trim())
    headerIndex += 1;
  if (headerIndex >= lines.length) return null;
  const header = lines[headerIndex]
    .trim()
    .toLowerCase()
    .split(',')
    .map((field) => field.trim());
  const col = new Map(header.map((name, i) => [name, i]));
  const iLat = col.get('lat');
  const iLon = col.get('lon');
  const iSatellite = col.get('satelite');
  const iPass = col.get('data');
  if ([iLat, iLon, iSatellite, iPass].some((i) => i === undefined)) return null;

  const records = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const parts = lines[i].trim().split(',');
    if (parts.length < header.length) continue;
    const latText = parts[iLat].trim();
    const lonText = parts[iLon].trim();
    const lat = Number(latText);
    const lon = Number(lonText);
    if (
      !latText ||
      !lonText ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    )
      continue;
    const pass = PASS_TIME.exec(parts[iPass].trim());
    if (!pass) continue;
    const { satellite, instrument } = inpeSatellite(parts[iSatellite]);
    records.push({
      lat,
      lon,
      frp: null,
      confidence: null,
      brightness: null,
      brightnessTi5: null,
      daynight: '',
      acqDate: pass[1],
      acqTime: `${pass[2]}${pass[3]}`,
      satellite,
      instrument,
      provider: 'inpe',
    });
  }
  return records;
}
