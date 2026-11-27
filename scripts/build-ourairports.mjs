#!/usr/bin/env node
/**
 * Build the bundled airports pack read by `src/data/airports.js`:
 *
 *   src/data/local_data/ourairports/airports.json
 *
 * Source: OurAirports (https://ourairports.com/data/), released to the public
 * domain. This script reads two files that were downloaded beforehand; it
 * makes no request of its own:
 *
 *   airports.csv  https://davidmegginson.github.io/ourairports-data/airports.csv
 *   runways.csv   https://davidmegginson.github.io/ourairports-data/runways.csv
 *
 * What goes in: large and medium airports, and small airports that have an
 * IATA code and scheduled service. Closed airports, heliports, seaplane bases
 * and balloon ports are left out, and so are placeholder rows (duplicates,
 * misplaced or closed entries; see isPlaceholderAirport). Each row is
 * `[ident, iata, name, lat, lon, size, city, country, elevationFt, runways, icao?]`,
 * with a distinct ICAO code appended when present. Positions are rounded to
 * four decimals. The runway count excludes closed runways and helipads.
 *
 * Usage:
 *   node scripts/build-ourairports.mjs <airports.csv> <runways.csv>
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsvRows } from '../src/library/formats.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src/data/local_data/ourairports/airports.json');
const SIZES = {
  large_airport: 'large',
  medium_airport: 'medium',
  small_airport: 'small',
};

const PACK_FIELDS = [
  'ident',
  'type',
  'name',
  'iata_code',
  'icao_code',
  'scheduled_service',
  'latitude_deg',
  'longitude_deg',
  'elevation_ft',
  'municipality',
  'iso_country',
  'airport_ident',
  'closed',
  'le_ident',
  'he_ident',
];

/** Read the airport and runway fields used by airportRows. */
export function parseCsv(text) {
  const [header = [], ...body] = parseCsvRows(text);
  const columns = PACK_FIELDS.map((name) => [
    name,
    header.lastIndexOf(name),
  ]).filter(([, index]) => index >= 0);
  return body.map((values, index) => {
    if (values.length !== header.length)
      throw new Error(
        `CSV record ${index + 2}: expected ${header.length} fields, got ${values.length}`,
      );
    const record = {};
    for (const [name, column] of columns) record[name] = values[column];
    return record;
  });
}

/**
 * Whether an OurAirports row is a placeholder, not an airport to open: a
 * duplicate or misplaced entry ("(Duplicate)YEG", "[Duplicate] …",
 * "(Misplaced duplicate?) …"), one marked closed in its name, or a large
 * airport with no IATA code and no open runway (a second "YEG" in
 * Saskatchewan). Such rows would win a name or nearest-airport lookup over
 * the real airport.
 * @param {{name: string, iata: string, size: string, runways: number}} row
 * @returns {boolean}
 */
export function isPlaceholderAirport({ name, iata, size, runways }) {
  if (/duplicate|misplaced|\[closed\]|\(closed\)/i.test(name)) return true;
  return size === 'large' && !iata && !runways;
}

/**
 * The pack's rows from OurAirports' airports and runways.
 * @param {Array<Record<string, string>>} airports
 * @param {Array<Record<string, string>>} runways
 */
export function airportRows(airports, runways) {
  const open = new Map();
  const runwayEnds = new Set();
  for (const runway of runways) {
    if (runway.closed === '1') continue;
    const low = (runway.le_ident || '').trim().toUpperCase();
    const high = (runway.he_ident || '').trim().toUpperCase();
    if (low.startsWith('H') && !high) continue;
    if (low && high) {
      const ends = [low, high]
        .map((end) => end.replace(/^0+(?=\d)/, ''))
        .sort();
      const key = [runway.airport_ident, ...ends].join('/');
      if (runwayEnds.has(key)) continue;
      runwayEnds.add(key);
    }
    open.set(runway.airport_ident, (open.get(runway.airport_ident) || 0) + 1);
  }
  const rows = [];
  for (const airport of airports) {
    const size = SIZES[airport.type];
    if (!size) continue;
    const iata = airport.iata_code.trim();
    if (size === 'small' && !(iata && airport.scheduled_service === 'yes'))
      continue;
    const lat = Number(airport.latitude_deg);
    const lon = Number(airport.longitude_deg);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !airport.ident ||
      !airport.name
    )
      continue;
    const runwayCount = open.get(airport.ident) || 0;
    if (
      isPlaceholderAirport({
        name: airport.name,
        iata,
        size,
        runways: runwayCount,
      })
    )
      continue;
    const elevation =
      airport.elevation_ft === '' ? null : Number(airport.elevation_ft);
    const row = [
      airport.ident,
      iata,
      airport.name,
      Number(lat.toFixed(4)),
      Number(lon.toFixed(4)),
      size,
      airport.municipality || '',
      airport.iso_country || '',
      Number.isFinite(elevation) ? elevation : null,
      runwayCount,
    ];
    const icao = airport.icao_code?.trim().toUpperCase();
    if (icao && icao !== airport.ident && icao !== iata) row.push(icao);
    rows.push(row);
  }
  const rank = { large: 0, medium: 1, small: 2 };
  return rows.sort(
    (a, b) => rank[a[5]] - rank[b[5]] || a[0].localeCompare(b[0]),
  );
}

async function main([airportsCsv, runwaysCsv] = []) {
  if (!airportsCsv || !runwaysCsv) {
    console.error(
      'Usage: node scripts/build-ourairports.mjs <airports.csv> <runways.csv>',
    );
    process.exit(2);
  }
  const [airports, runways] = await Promise.all([
    readFile(airportsCsv, 'utf8'),
    readFile(runwaysCsv, 'utf8'),
  ]);
  const rows = airportRows(parseCsv(airports), parseCsv(runways));
  // Well-known airports must be there, or the files were not what was meant.
  for (const ident of ['KAUS', 'EGLL', 'RJTT', 'YSSY', 'FAOR']) {
    if (!rows.some((row) => row[0] === ident))
      throw new Error(`missing ${ident}: is airports.csv complete?`);
  }
  const pack = {
    meta: {
      source: 'OurAirports (https://ourairports.com/data/)',
      license: 'Public domain',
      built: new Date().toISOString(),
      count: rows.length,
      columns: [
        'ident',
        'iata',
        'name',
        'lat',
        'lon',
        'size',
        'city',
        'country',
        'elevationFt',
        'runways',
        'icao',
      ],
    },
    rows,
  };
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(pack)}\n`);
  console.log(`Wrote ${rows.length} airports to ${path.relative(ROOT, OUT)}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main(process.argv.slice(2));
