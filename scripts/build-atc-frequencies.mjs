#!/usr/bin/env node
/**
 * Build src/data/local_data/ourairports_atc/frequencies.json from the
 * public-domain OurAirports database.
 *
 * Source:    https://ourairports.com/data/  (airports.csv, airport-frequencies.csv)
 * License:   Public domain — https://ourairports.com/data/ ("released into the
 *            public domain ... no need to credit us, though we appreciate it")
 * Key:       none; the CSVs are plain HTTP downloads.
 *
 * Unlike the other bundled packs, OurAirports has NO upstream commit to pin —
 * it is a live, continuously community-edited database. Provenance is therefore
 * the fetch timestamp plus the row counts recorded in `meta`, and a rebuild on
 * a later date is EXPECTED to differ. Re-run this script, commit the result,
 * and let the byte-budget test in
 * `src/data/ourAirportsAtc.test.mjs` hold the size line.
 *
 * Transform (deterministic given the same input bytes):
 *   1. Keep only the frequency classes a listener can actually hear a human on
 *      for a given flight phase, plus the classes that say there is NO tower:
 *        TWR GND APP ATIS CNTR   (controlled)
 *        CTAF UNIC AFIS          (uncontrolled / advisory)
 *      Every other OurAirports class is dropped: AWOS/ASOS are synthesised
 *      voice, MISC/INFO/RDO/A/D/CLD/DEL are either non-phase or not a
 *      controlling position. The class is carried through VERBATIM — it is not
 *      remapped onto a flight phase, because the data does not support that
 *      (see the counts in `meta.coverage`).
 *   2. Drop frequencies outside the 108.000–137.000 MHz VHF air band. Rows
 *      outside it are HF, UHF military, text ranges, or blanks, and would
 *      render as plausible-looking garbage. (108–118 is the navaid band and is
 *      KEPT: an ATIS is routinely broadcast on a co-located VOR.)
 *   3. Drop airports with no surviving frequency, and any airport whose
 *      latitude/longitude does not parse.
 *   4. De-duplicate exact (airport, class, MHz) triples; sort classes by the
 *      order in `types`, then by frequency, for a stable diff.
 *   5. Round coordinates to 4 decimals (~11 m — an airport is not a point) and
 *      frequencies to 3 (the 25 kHz / 8.33 kHz channel grid).
 *   6. Carry field elevation in METRES (converted from elevation_ft, rounded to
 *      0.1 m) or null when the source has none. A flight-phase classifier needs
 *      height above the FIELD, not above sea level.
 *   7. Sort airports by ident.
 *
 * Row shape: [ident, name, lat, lon, elevationM, [[typeIndex, mhz], ...]].
 * Output shape is columnar on purpose: an array-of-objects form of the same
 * data is ~2.4x larger because every record repeats its keys.
 *
 * Usage:
 *   node scripts/build-atc-frequencies.mjs [airports.csv airport-frequencies.csv]
 * With no arguments it downloads both live CSVs; with two it reads the given
 * files (the exact bytes retrieved on the date recorded in `meta.fetched`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AIRPORTS_URL =
  'https://davidmegginson.github.io/ourairports-data/airports.csv';
const FREQUENCIES_URL =
  'https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv';
const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'data',
  'local_data',
  'ourairports_atc',
  'frequencies.json',
);

/**
 * Frequency classes kept, in the order they are indexed in the pack. Controlled
 * positions first, then the advisory classes that mean "no controller".
 */
const TYPES = ['TWR', 'GND', 'APP', 'ATIS', 'CNTR', 'CTAF', 'UNIC', 'AFIS'];
const TYPE_INDEX = new Map(TYPES.map((t, i) => [t, i]));
const BAND_MIN_MHZ = 108;
const BAND_MAX_MHZ = 137;
const COORD_DECIMALS = 4;
const MHZ_DECIMALS = 3;
const FEET_TO_M = 0.3048;

/**
 * Column positions in a packed airport row. Named because the row is a bare
 * array for byte reasons, and a bare array is exactly the shape where an
 * inserted column silently shifts every reader that spelled its index by hand.
 */
const COL = Object.freeze({
  IDENT: 0,
  NAME: 1,
  LAT: 2,
  LON: 3,
  ELEVATION_M: 4,
  FREQUENCIES: 5,
});

/**
 * Parse RFC-4180 CSV into an array of row objects keyed by the header line.
 * OurAirports quotes any field containing a comma or a doubled quote, and
 * airport names legitimately contain both.
 * @param {string} text - Whole CSV file.
 * @returns {Array<Record<string, string>>} One object per data row.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') {
      quoted = true;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift() ?? [];
  return rows.map((r) =>
    Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])),
  );
}

/** Round to `places` decimals without trailing float noise. */
function round(value, places) {
  return Number.parseFloat(value.toFixed(places));
}

/** Fetch a URL as text, failing loudly rather than writing a truncated pack. */
async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

const [airportsArg, frequenciesArg] = process.argv.slice(2);
const iso = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
// When reading local CSVs, the honest provenance is when those bytes were
// DOWNLOADED, not when this script happened to run over them.
const fetched =
  airportsArg && frequenciesArg
    ? iso(fs.statSync(airportsArg).mtime)
    : iso(new Date());
const [airportsCsv, frequenciesCsv] =
  airportsArg && frequenciesArg
    ? [
        fs.readFileSync(airportsArg, 'utf8'),
        fs.readFileSync(frequenciesArg, 'utf8'),
      ]
    : await Promise.all([get(AIRPORTS_URL), get(FREQUENCIES_URL)]);

const airportRows = parseCsv(airportsCsv);
const frequencyRows = parseCsv(frequenciesCsv);

const airports = new Map();
for (const row of airportRows) {
  const lat = Number.parseFloat(row.latitude_deg);
  const lon = Number.parseFloat(row.longitude_deg);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  // Field elevation, in metres. A flight-phase classifier needs height above
  // the FIELD, not above sea level: 900 m MSL is short final at an airport on
  // the coast and below the runway at one on a plateau. 14,951 of the source
  // rows have no elevation; those airports keep a null and a caller must fall
  // back rather than assume zero.
  const elevationFt = Number.parseFloat(row.elevation_ft);
  airports.set(row.ident, {
    name: String(row.name || '').trim(),
    lat,
    lon,
    elevationM: Number.isFinite(elevationFt)
      ? round(elevationFt * FEET_TO_M, 1)
      : null,
  });
}

/** @type {Map<string, Set<string>>} ident → "typeIndex:mhz" (de-duplication). */
const kept = new Map();
let droppedOutOfBand = 0;
let droppedClass = 0;
for (const row of frequencyRows) {
  const type = String(row.type || '')
    .trim()
    .toUpperCase();
  const typeIndex = TYPE_INDEX.get(type);
  if (typeIndex === undefined) {
    droppedClass += 1;
    continue;
  }
  const mhz = Number.parseFloat(row.frequency_mhz);
  if (!Number.isFinite(mhz) || mhz < BAND_MIN_MHZ || mhz > BAND_MAX_MHZ) {
    droppedOutOfBand += 1;
    continue;
  }
  const ident = row.airport_ident;
  if (!airports.has(ident)) continue;
  if (!kept.has(ident)) kept.set(ident, new Set());
  kept.get(ident).add(`${typeIndex}:${round(mhz, MHZ_DECIMALS)}`);
}

const packed = [...kept.entries()]
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([ident, entries]) => {
    const { name, lat, lon, elevationM } = airports.get(ident);
    const frequencies = [...entries]
      .map((entry) => {
        const [typeIndex, mhz] = entry.split(':');
        return [Number(typeIndex), Number(mhz)];
      })
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const row = [];
    row[COL.IDENT] = ident;
    row[COL.NAME] = name;
    row[COL.LAT] = round(lat, COORD_DECIMALS);
    row[COL.LON] = round(lon, COORD_DECIMALS);
    row[COL.ELEVATION_M] = elevationM;
    row[COL.FREQUENCIES] = frequencies;
    return row;
  });

/** The frequency list of a packed row. */
const freqs = (row) => row[COL.FREQUENCIES];

/** Airports that carry at least one of the given classes. */
const countWith = (classes) => {
  const wanted = new Set(classes.map((t) => TYPE_INDEX.get(t)));
  return packed.filter((a) => freqs(a).some(([t]) => wanted.has(t))).length;
};
const CONTROLLED = ['TWR', 'GND', 'APP', 'ATIS'];
const ADVISORY = ['CTAF', 'UNIC', 'AFIS'];
const controlledSet = new Set(CONTROLLED.map((t) => TYPE_INDEX.get(t)));

const pack = {
  meta: {
    source: 'OurAirports — airports.csv + airport-frequencies.csv',
    url: 'https://ourairports.com/data/',
    // A live community database: there is no upstream commit to pin, so the
    // fetch timestamp and these counts ARE the provenance.
    commit: null,
    license: 'Public domain (OurAirports — ourairports.com/data/)',
    fetched,
    curation: {
      types: TYPES,
      bandMhz: [BAND_MIN_MHZ, BAND_MAX_MHZ],
      coordDecimals: COORD_DECIMALS,
      mhzDecimals: MHZ_DECIMALS,
    },
    coverage: {
      sourceAirportRows: airportRows.length,
      sourceFrequencyRows: frequencyRows.length,
      droppedOtherClass: droppedClass,
      droppedOutOfBand,
      airports: packed.length,
      withoutElevation: packed.filter((a) => a[COL.ELEVATION_M] === null)
        .length,
      frequencies: packed.reduce((n, a) => n + freqs(a).length, 0),
      // The numbers that decide what the UI may promise: a phase→frequency map
      // has all four controlled rails at only a small fraction of airports, and
      // most airports in the pack have no controller at all.
      withAnyOfTwrGndAppAtis: countWith(CONTROLLED),
      withAllOfTwrGndAppAtis: packed.filter(
        (a) =>
          new Set(
            freqs(a)
              .filter(([t]) => controlledSet.has(t))
              .map(([t]) => t),
          ).size === 4,
      ).length,
      // "Advisory only" and "center only" are both measured against the four
      // TOWER classes, not against CONTROLLED_CLASSES in the loader (which
      // counts CNTR too) — the question these answer is "is there a local
      // controller at this field", and an area centre is not one.
      advisoryOnly: packed.filter(
        (a) =>
          freqs(a).some(([t]) => ADVISORY.includes(TYPES[t])) &&
          !freqs(a).some(([t]) => controlledSet.has(t)),
      ).length,
      centerOnlyNoTower: packed.filter(
        (a) =>
          !freqs(a).some(([t]) => controlledSet.has(t)) &&
          !freqs(a).some(([t]) => ADVISORY.includes(TYPES[t])),
      ).length,
    },
  },
  types: TYPES,
  // Published so the loader decodes by name. A future column can then be
  // appended without every reader having to be found and corrected.
  columns: COL,
  airports: packed,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(pack)}\n`);
const bytes = fs.statSync(OUT).size;
console.log(
  `${OUT}\n  ${pack.meta.coverage.airports} airports · ` +
    `${pack.meta.coverage.frequencies} frequencies · ` +
    `${(bytes / 1024 / 1024).toFixed(2)} MB`,
);
console.log(
  `  all four of ${CONTROLLED.join('/')}: ${pack.meta.coverage.withAllOfTwrGndAppAtis}`,
);
console.log(
  `  advisory only (no controller): ${pack.meta.coverage.advisoryOnly}`,
);
console.log(
  `  dropped: ${droppedClass} rows of other classes, ${droppedOutOfBand} out of band`,
);
