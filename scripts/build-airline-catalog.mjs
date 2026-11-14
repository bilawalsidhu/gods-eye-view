#!/usr/bin/env node
/**
 * @file Build the airline library: every OpenFlights airline that has an
 * ICAO designator, with its IATA code, callsign word, country and active flag.
 *
 *   node scripts/build-airline-catalog.mjs [--force] [--offline]
 *     Writes src/data/airlines/catalog.json (sorted by icao). Run
 *     build-country-catalog.mjs first: the airline's country is its OpenFlights
 *     country name matched to an ISO code through the country catalog and the
 *     alias map in country-sources.mjs.
 *     Exits non-zero when the catalog fails validation, a curated tail colour
 *     names an airline not in the catalog, or coverage falls under the floor.
 *
 * Rows come from OpenFlights `airlines.dat` (ODbL 1.0, SOURCE_URLS in
 * country-sources.mjs). A row needs a three-letter upper-case ICAO designator
 * and a name. Rows that share a designator collapse to one: an active row beats
 * an inactive one, and among equals the lowest OpenFlights id wins. Tail colours
 * are the curated table in airline-tail-colors.mjs. No logo or livery image is
 * bundled.
 *
 * Every response is cached under .gev-cache/airline-catalog/ (gitignored) and
 * the outputs are derived from the cache, the country catalog and the inputs
 * alone, so a rerun with a warm cache is offline and byte-identical. --offline
 * fails on any cache miss instead of fetching, which proves it.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dedupeByIcao,
  parseOpenFlightsAirlines,
} from '../src/data/airlines/source.js';
import {
  airlineCoverage,
  validateAirlineCatalog,
} from '../src/data/airlines/validate.js';
import { buildNameIndex } from '../src/data/countries/source.js';
import { TAIL_COLORS } from './airline-tail-colors.mjs';
import { createTextFetcher } from './cached-fetch.mjs';
import { NAME_ALIASES, SOURCE_URLS } from './country-sources.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const COUNTRY_FILE = path.join(ROOT, 'src/data/countries/catalog.json');
const CATALOG_FILE = path.join(ROOT, 'src/data/airlines/catalog.json');
const CACHE_DIR = path.join(ROOT, '.gev-cache/airline-catalog');

const MIN_TOTAL = 5500;
const MIN_COUNTRY_RATE = 0.95;

/** Write a file only when its bytes change, through a rename so a crash leaves no partial. */
function writeIfChanged(file, text) {
  const bytes = Buffer.from(text);
  if (existsSync(file) && readFileSync(file).equals(bytes)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, file);
}

async function build(options) {
  if (!existsSync(COUNTRY_FILE))
    throw new Error(
      'country catalog missing: run build-country-catalog.mjs first',
    );
  const countries = JSON.parse(readFileSync(COUNTRY_FILE, 'utf8'));
  const resolveCountry = buildNameIndex(countries, NAME_ALIASES);
  const fetchText = createTextFetcher({
    cacheDir: CACHE_DIR,
    userAgent: 'airline-catalog-builder/1.0',
    ...options,
  });
  const parsed = parseOpenFlightsAirlines(
    await fetchText(SOURCE_URLS.openflightsAirlines),
  );
  const named = parsed.filter((row) => row.name);
  const { kept, collapsed } = dedupeByIcao(named);

  const unmatchedCountries = new Map();
  const entries = kept.map((row) => {
    const country = row.country ? resolveCountry(row.country) : null;
    if (row.country && !country)
      unmatchedCountries.set(
        row.country,
        (unmatchedCountries.get(row.country) ?? 0) + 1,
      );
    return {
      icao: row.icao,
      iata: row.iata,
      name: row.name,
      callsign: row.callsign,
      country,
      active: row.active,
      tailColor: TAIL_COLORS[row.icao] ?? null,
    };
  });

  const known = new Set(entries.map((e) => e.icao));
  const unknownTails = Object.keys(TAIL_COLORS).filter((k) => !known.has(k));

  writeIfChanged(CATALOG_FILE, `${JSON.stringify(entries, null, 2)}\n`);

  const failures = validateAirlineCatalog(entries, {
    knownIso2: countries.map((c) => c.iso2),
  });
  const coverage = airlineCoverage(entries);
  const countryRate = coverage.withCountry / coverage.total;
  const shortfall =
    coverage.total < MIN_TOTAL || countryRate < MIN_COUNTRY_RATE;
  const unmatchedRows = [...unmatchedCountries.values()].reduce(
    (a, b) => a + b,
    0,
  );
  console.log('=== build summary ===');
  console.log(
    `total ${coverage.total}; withCountry ${coverage.withCountry} (${(countryRate * 100).toFixed(1)}%); withIata ${coverage.withIata}; withTailColor ${coverage.withTailColor}`,
  );
  console.log(
    `rows with an ICAO designator ${parsed.length}; dropped for no name ${parsed.length - named.length}; ICAO collisions collapsed ${collapsed}`,
  );
  console.log(
    `country names unmatched ${unmatchedCountries.size} (${unmatchedRows} airlines): ${[...unmatchedCountries.keys()].sort().join('; ') || 'none'}`,
  );
  console.log(
    `tail colours for unknown airlines: ${unknownTails.join(', ') || 'none'}`,
  );
  for (const f of failures)
    console.log(`  INVALID ${f.key}: ${f.problems.join('; ')}`);
  console.log(
    failures.length ? 'validation: FAILED' : 'validation: all entries pass',
  );
  if (failures.length || unknownTails.length || shortfall) process.exitCode = 1;
}


const argv = process.argv.slice(2);
build({
  force: argv.includes('--force'),
  offline: argv.includes('--offline'),
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
