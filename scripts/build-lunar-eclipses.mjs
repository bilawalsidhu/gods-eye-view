#!/usr/bin/env node
/**
 * Rebuild src/layers/eclipses/lunar.json from NASA's Five Millennium Canon of
 * Lunar Eclipses (Fred Espenak and Jean Meeus, NASA's GSFC).
 *
 *   mkdir lunar && cd lunar
 *   for c in 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29; do
 *     curl -LO "https://eclipse.gsfc.nasa.gov/LEcat5/LE${c}01-$((c+1))00.html"
 *   done
 *   cd .. && node scripts/build-lunar-eclipses.mjs lunar
 *
 * Each century page is a fixed-column table: one lunar eclipse a line. The
 * layer bundles the same years as the solar catalogue (see
 * build-eclipse-elements.mjs).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { FIRST_YEAR, LAST_YEAR } from './build-eclipse-elements.mjs';

const OUTPUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/layers/eclipses/lunar.json',
);
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const ROW =
  /^\d{5}\s+(-?\d{4}) ([A-Z][a-z]{2}) (\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+(-?\d+)\s+-?\d+\s+(-?\d+)\s+(\S+)\s+\S+\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+([\d.]+)\s+([\d.]+|-)\s+([\d.]+|-)\s+(\d+)([NS])\s+(\d+)([EW])\s*$/;

export const COLUMNS = [
  'year',
  'month',
  'day',
  'greatestTdSeconds',
  'deltaT',
  'type',
  'saros',
  'gamma',
  'penumbralMagnitude',
  'umbralMagnitude',
  'penumbralMinutes',
  'partialMinutes',
  'totalMinutes',
  'zenithLat',
  'zenithLon',
];

/** One catalogue line as the compact array the layer reads, or null. */
export function parseRow(line) {
  const match = ROW.exec(line);
  if (!match) return null;
  const minutes = (text) => (text === '-' ? 0 : Number(text));
  return [
    Number(match[1]),
    MONTHS.indexOf(match[2]) + 1,
    Number(match[3]),
    Number(match[4]) * 3600 + Number(match[5]) * 60 + Number(match[6]),
    Number(match[7]),
    match[9],
    Number(match[8]),
    Number(match[10]),
    Number(match[11]),
    Number(match[12]),
    Number(match[13]),
    minutes(match[14]),
    minutes(match[15]),
    Number(match[16]) * (match[17] === 'S' ? -1 : 1),
    Number(match[18]) * (match[19] === 'W' ? -1 : 1),
  ];
}

function main() {
  const directory = process.argv[2];
  if (!directory) {
    console.error('usage: node scripts/build-lunar-eclipses.mjs <directory>');
    process.exit(2);
  }
  const rows = [];
  for (const name of readdirSync(directory).sort()) {
    if (!/^LE\d{4}-\d{4}\.html$/.test(name)) continue;
    const text = readFileSync(join(directory, name), 'utf8').replace(
      /<[^>]*>/g,
      '',
    );
    let found = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!/^\d{5}\s/.test(line)) continue;
      const row = parseRow(line);
      if (!row) throw new Error(`${name}: cannot read "${line}"`);
      found += 1;
      if (row[0] >= FIRST_YEAR && row[0] <= LAST_YEAR) rows.push(row);
    }
    if (!found) throw new Error(`${name}: no eclipses found`);
  }
  rows.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
  const body = rows.map((row) => `    ${JSON.stringify(row)}`).join(',\n');
  writeFileSync(
    OUTPUT,
    `{\n  "source": "Five Millennium Canon of Lunar Eclipses: -1999 to +3000 (Fred Espenak and Jean Meeus, NASA's GSFC)",\n  "url": "https://eclipse.gsfc.nasa.gov/SEpubs/5MCLE.html",\n  "columns": ${JSON.stringify(COLUMNS)},\n  "rows": [\n${body}\n  ]\n}\n`,
  );
  console.log(`${rows.length} lunar eclipses written to ${OUTPUT}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
