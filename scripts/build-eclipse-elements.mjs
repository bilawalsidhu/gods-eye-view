#!/usr/bin/env node
/**
 * Rebuild src/layers/eclipses/elements.json from NASA's Five Millennium Canon
 * of Solar Eclipses database (Fred Espenak and Jean Meeus, NASA's GSFC).
 *
 *   curl -L -o besselian.csv \
 *     https://eclipse.gsfc.nasa.gov/eclipse_besselian_from_mysqldump2.csv
 *   node scripts/build-eclipse-elements.mjs besselian.csv
 *
 * The CSV lists every solar eclipse from -1999 to +3000 with its Besselian
 * elements. The layer bundles the years FIRST_YEAR to LAST_YEAR, from the
 * first full year of the Gregorian calendar (the catalogue dates earlier
 * eclipses in the Julian one) to the end of the catalogue: an eclipse never
 * changes, so nothing is fetched at runtime. Each row is checked before
 * it is written: at the catalogue's instant of greatest eclipse the shadow
 * axis must pass the Earth's centre at the catalogue's own gamma.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const FIRST_YEAR = 1583;
export const LAST_YEAR = 3000;

const OUTPUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/layers/eclipses/elements.json',
);

/** Split one CSV line; quoted fields never hold a comma or a quote here. */
function cells(line) {
  return line.split(',').map((cell) => cell.replace(/^"|"$/g, ''));
}

const round = (value, digits) => Number(Number(value).toFixed(digits));

/** One catalogue row as the compact array the layer reads (see COLUMNS). */
export function compactRow(row) {
  const [hours, minutes, seconds] = row.td_ge.split(':').map(Number);
  const greatestHours = hours + minutes / 60 + seconds / 3600;
  // t0 is the whole hour nearest greatest eclipse, which may fall on the
  // day before or after the calendar date of greatest eclipse.
  let t0 = Number(row.t0);
  if (t0 - greatestHours > 12) t0 -= 24;
  else if (greatestHours - t0 > 12) t0 += 24;
  const poly = (name, count, digits) =>
    Array.from({ length: count }, (_, index) =>
      round(row[`${name}${index}`], digits),
    );
  const x = poly('x', 4, 7);
  const y = poly('y', 4, 7);
  const t = greatestHours - t0;
  const at = (c) => c.reduceRight((sum, value) => sum * t + value, 0);
  const gamma = Math.hypot(at(x), at(y));
  if (Math.abs(gamma - Math.abs(Number(row.gamma))) > 2e-3)
    throw new Error(
      `${row.year}-${row.month}-${row.day}: gamma ${gamma.toFixed(5)} does not match the catalogue's ${row.gamma}`,
    );
  return [
    Number(row.year),
    Number(row.month),
    Number(row.day),
    round(greatestHours * 3600, 0),
    round(row.dt, 1),
    row.eclipse_type,
    Number(row.saros),
    round(row.gamma, 5),
    round(row.magnitude, 5),
    round(row.lat_dd_ge, 3),
    round(row.lng_dd_ge, 3),
    round(row.path_width, 1),
    round(row.duration_secs, 1),
    t0,
    Number(row.tmin),
    Number(row.tmax),
    x,
    y,
    poly('d', 3, 7),
    poly('mu', 3, 6),
    poly('l1', 3, 7),
    poly('l2', 3, 7),
    round(row.tan_f1, 7),
    round(row.tan_f2, 7),
  ];
}

export const COLUMNS = [
  'year',
  'month',
  'day',
  'greatestTdSeconds',
  'deltaT',
  'type',
  'saros',
  'gamma',
  'magnitude',
  'greatestLat',
  'greatestLon',
  'pathWidthKm',
  'centralDurationSeconds',
  't0',
  'tmin',
  'tmax',
  'x',
  'y',
  'd',
  'mu',
  'l1',
  'l2',
  'tanF1',
  'tanF2',
];

function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('usage: node scripts/build-eclipse-elements.mjs <csv>');
    process.exit(2);
  }
  const lines = readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = cells(lines[0]);
  const rows = [];
  for (const line of lines.slice(1)) {
    const values = cells(line);
    const row = Object.fromEntries(header.map((name, i) => [name, values[i]]));
    const year = Number(row.year);
    if (year < FIRST_YEAR || year > LAST_YEAR) continue;
    rows.push(compactRow(row));
  }
  const body = rows.map((row) => `    ${JSON.stringify(row)}`).join(',\n');
  writeFileSync(
    OUTPUT,
    `{\n  "source": "Five Millennium Canon of Solar Eclipses: -1999 to +3000 (Fred Espenak and Jean Meeus, NASA's GSFC)",\n  "url": "https://eclipse.gsfc.nasa.gov/SEpubs/5MCSE.html",\n  "columns": ${JSON.stringify(COLUMNS)},\n  "rows": [\n${body}\n  ]\n}\n`,
  );
  console.log(`${rows.length} eclipses written to ${OUTPUT}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
