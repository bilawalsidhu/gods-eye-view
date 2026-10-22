#!/usr/bin/env node
/**
 * Build src/data/local_data/sky/bright_stars.json from the Yale Bright Star
 * Catalogue, 5th Revised Edition (Hoffleit & Warren 1991).
 *
 * Source:   CDS VizieR catalogue V/50, https://cdsarc.cds.unistra.fr/viz-bin/cat/V/50
 * Fetched:  https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz
 * Format:   fixed-width ASCII, 197 bytes per record, byte layout in
 *           https://cdsarc.cds.unistra.fr/ftp/V/50/ReadMe
 * License:  public domain (Yale University Observatory / NASA ADC); CDS asks
 *           for an acknowledgement, which the Data attribution popover carries.
 *
 * Transform (deterministic):
 *   1. J2000 RA/Dec (bytes 76-90), V magnitude (103-107) and B−V (110-114).
 *   2. The 14 records without a J2000 position (novae and other objects later
 *      found not to be stars) are dropped.
 *   3. RA/Dec rounded to 3 decimals of a degree (3.6″ — a fraction of a pixel
 *      at any field of view the globe uses), magnitudes to 2.
 *   4. Missing B−V is stored as null; the renderer gives it a neutral colour.
 *   5. Records keep catalogue (HR) order for a stable diff.
 *
 * Usage:
 *   node scripts/build-bright-stars.mjs [catalog | catalog.gz]
 * With no argument it downloads the catalogue from CDS.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz';
const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'data',
  'local_data',
  'sky',
  'bright_stars.json',
);

/** Slice 1-based inclusive byte columns the way the CDS ReadMe numbers them. */
function columns(line, from, to) {
  return line.slice(from - 1, to).trim();
}

/** Parse a fixed-width float; blank fields are null. */
function parseField(text) {
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parse one BSC5 record. Returns null for records without a J2000 position
 * or V magnitude.
 */
export function parseBscRecord(line) {
  const hr = parseField(columns(line, 1, 4));
  const raH = parseField(columns(line, 76, 77));
  const raM = parseField(columns(line, 78, 79));
  const raS = parseField(columns(line, 80, 83));
  const sign = columns(line, 84, 84);
  const deD = parseField(columns(line, 85, 86));
  const deM = parseField(columns(line, 87, 88));
  const deS = parseField(columns(line, 89, 90));
  const vmag = parseField(columns(line, 103, 107));
  const bv = parseField(columns(line, 110, 114));
  if (
    hr === null ||
    raH === null ||
    raM === null ||
    raS === null ||
    deD === null ||
    deM === null ||
    deS === null ||
    vmag === null ||
    (sign !== '+' && sign !== '-')
  )
    return null;
  const raDeg = (raH + raM / 60 + raS / 3600) * 15;
  const decDeg = (sign === '-' ? -1 : 1) * (deD + deM / 60 + deS / 3600);
  return { hr, raDeg, decDeg, vmag, bv };
}

const round = (value, decimals) => {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
};

/** Build the committed pack from the raw catalogue text. */
export function buildStarPack(text, { fetched = null } = {}) {
  const stars = [];
  let dropped = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const record = parseBscRecord(line);
    if (!record) {
      dropped += 1;
      continue;
    }
    stars.push(
      round(record.raDeg, 3),
      round(record.decDeg, 3),
      round(record.vmag, 2),
      record.bv === null ? null : round(record.bv, 2),
    );
  }
  return {
    meta: {
      source:
        'Yale Bright Star Catalogue, 5th Revised Ed. (Hoffleit & Warren 1991), CDS V/50',
      url: SOURCE_URL,
      license: 'public domain',
      fetched,
      frame: 'ICRF/J2000, epoch 2000.0',
      columns: ['raDeg', 'decDeg', 'vmag', 'bv'],
      count: stars.length / 4,
      dropped,
    },
    stars,
  };
}

async function readCatalogue(file) {
  if (!file) {
    const response = await fetch(SOURCE_URL);
    if (!response.ok) throw new Error(`${SOURCE_URL}: HTTP ${response.status}`);
    return zlib
      .gunzipSync(Buffer.from(await response.arrayBuffer()))
      .toString('latin1');
  }
  const bytes = fs.readFileSync(file);
  return (file.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes).toString(
    'latin1',
  );
}

async function main() {
  const [file] = process.argv.slice(2);
  const text = await readCatalogue(file);
  const pack = buildStarPack(text, {
    fetched: new Date().toISOString().slice(0, 10),
  });
  // One star per line keeps the JSON compact and the diff readable.
  const rows = [];
  for (let i = 0; i < pack.stars.length; i += 4)
    rows.push(JSON.stringify(pack.stars.slice(i, i + 4)).slice(1, -1));
  const body = `{"meta":${JSON.stringify(pack.meta)},\n"stars":[\n${rows.join(',\n')}\n]}\n`;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body);
  console.log(
    `wrote ${pack.meta.count} stars (${pack.meta.dropped} dropped) → ${path.relative(process.cwd(), OUT)} (${body.length} bytes)`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
