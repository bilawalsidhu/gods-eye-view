/**
 * GTFS `route_type` → the transit modes this app colours.
 *
 * A GTFS-Realtime VehiclePosition names a `route_id` and nothing else about
 * what kind of vehicle it is, so a feed that mixes modes — every national feed
 * does — renders entirely as its default until the static `routes.txt` is
 * joined in. For OVapi that default is bus, which draws all five Rotterdam
 * metro lines as buses.
 *
 * Pure data + pure parsing: no network, no Node built-ins, no Cesium.
 */

/** Classic route types (0-7) plus the extended ranges operators actually use. */
export const GTFS_ROUTE_TYPE_TO_MODE = Object.freeze({
  0: 'tram', 1: 'subway', 2: 'rail', 3: 'bus', 4: 'ferry',
  5: 'tram', // cable tram
  6: 'unknown', // aerial lift
  7: 'rail', // funicular
  11: 'bus', // trolleybus
  12: 'rail', // monorail
});

/**
 * Extended route types are ranges, not values: 100-117 rail, 200-299 coach,
 * 400-405 urban rail, 700-716 bus, 900-906 tram, 1000 water, 1200 ferry.
 * @param {string|number} value - Raw `route_type`.
 * @returns {string} One of the transit modes, or 'unknown'.
 */
export function gtfsRouteTypeToMode(value) {
  // Number('') and Number(null) are both 0, which is a valid route type (tram).
  // Coercing first would classify every blank route_type as a tram, so the
  // emptiness check has to come before the conversion.
  const raw = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) return 'unknown';
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return 'unknown';
  if (n in GTFS_ROUTE_TYPE_TO_MODE) return GTFS_ROUTE_TYPE_TO_MODE[n];
  if (n >= 100 && n <= 199) return 'rail';
  if (n >= 200 && n <= 299) return 'bus'; // coach
  if (n >= 400 && n <= 405) return 'subway';
  if (n >= 700 && n <= 799) return 'bus';
  if (n >= 900 && n <= 999) return 'tram';
  if (n === 1000 || n === 1200) return 'ferry';
  return 'unknown';
}

/**
 * Split one CSV line, honouring double-quoted fields containing commas.
 * @param {string} line
 * @returns {string[]}
 */
export function splitCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

/**
 * Parse a GTFS `routes.txt` into `route_id` → mode.
 *
 * Column order is not fixed by the spec, so the header is read rather than
 * assumed. A row missing either column is skipped instead of guessed at.
 * @param {string} text - Full routes.txt contents.
 * @returns {Map<string,string>}
 */
export function parseRoutesTxt(text) {
  const table = new Map();
  const lines = String(text ?? '').split(/\r?\n/);
  if (!lines.length) return table;
  const header = splitCsvLine(lines[0]).map((h) => h.trim().replace(/^﻿/, ''));
  const idAt = header.indexOf('route_id');
  const typeAt = header.indexOf('route_type');
  if (idAt === -1 || typeAt === -1) return table;
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i]) continue;
    const cells = splitCsvLine(lines[i]);
    const id = (cells[idAt] ?? '').trim();
    if (!id) continue;
    const mode = gtfsRouteTypeToMode((cells[typeAt] ?? '').trim());
    if (mode !== 'unknown') table.set(id, mode);
  }
  return table;
}
