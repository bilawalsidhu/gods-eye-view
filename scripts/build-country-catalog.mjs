#!/usr/bin/env node
/**
 * @file Build the country library: every ISO 3166-1 country with its
 * flag, civil registration prefixes and ICAO 24-bit address blocks.
 *
 *   node scripts/build-country-catalog.mjs [--force] [--offline]
 *     Writes src/data/countries/catalog.json (sorted by iso2). Exits non-zero
 *     when an allocation block names a country that cannot be matched (unless
 *     it is a non-country block), a registration-prefix row names an unknown
 *     country, the catalog fails validation, or coverage falls under the floor.
 *
 * Inputs are three fact sources (SOURCE_URLS in country-sources.mjs): the ISO
 * 3166-1 list for codes and names, dump1090's `ICAO_Ranges` table (generated
 * from chapter 9 of ICAO Annex 10 Vol III) for address blocks, and the curated
 * registration-prefix table. The flag is computed from the code. No image is
 * bundled.
 *
 * Every response is cached under .gev-cache/country-catalog/ (gitignored) and
 * the outputs are derived from the cache and the inputs alone, so a rerun with a
 * warm cache is offline and byte-identical. --offline fails on any cache miss
 * instead of fetching, which proves it.
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
import { flagOf } from '../src/data/countries/naming.js';
import {
  buildNameIndex,
  parseIcaoRanges,
  parseIsoCountries,
} from '../src/data/countries/source.js';
import {
  countryCoverage,
  validateCountryCatalog,
} from '../src/data/countries/validate.js';
import { createTextFetcher } from './cached-fetch.mjs';
import { REG_PREFIXES } from './country-reg-prefixes.mjs';
import {
  DISPLAY_NAMES,
  NAME_ALIASES,
  NON_COUNTRY_BLOCK,
  SOURCE_URLS,
} from './country-sources.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CATALOG_FILE = path.join(ROOT, 'src/data/countries/catalog.json');
const CACHE_DIR = path.join(ROOT, '.gev-cache/country-catalog');

const MIN_ISO_TOTAL = 240;
const MIN_WITH_ICAO24 = 185;

/** Write a file only when its bytes change, through a rename so a crash leaves no partial. */
function writeIfChanged(file, text) {
  const bytes = Buffer.from(text);
  if (existsSync(file) && readFileSync(file).equals(bytes)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, file);
}

const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

async function build(options) {
  const fetchText = createTextFetcher({
    cacheDir: CACHE_DIR,
    userAgent: 'country-catalog-builder/1.0',
    ...options,
  });
  const iso = parseIsoCountries(await fetchText(SOURCE_URLS.iso3166));
  const blocks = parseIcaoRanges(await fetchText(SOURCE_URLS.icaoRanges));

  const entries = iso
    .map(({ iso2, iso3, name }) => ({
      iso2,
      iso3,
      name: DISPLAY_NAMES[iso2] ?? name,
      flag: flagOf(iso2),
      regPrefixes: REG_PREFIXES[iso2] ?? [],
      icao24Ranges: [],
    }))
    .sort((a, b) => byCode(a.iso2, b.iso2));

  const isoNames = Object.fromEntries(iso.map((c) => [c.name, c.iso2]));
  const resolve = buildNameIndex(entries, { ...isoNames, ...NAME_ALIASES });
  const byIso2 = new Map(entries.map((e) => [e.iso2, e]));

  const dropped = [];
  const unmatched = [];
  for (const block of blocks) {
    const iso2 = resolve(block.country);
    if (iso2) byIso2.get(iso2).icao24Ranges.push([block.start, block.end]);
    else if (NON_COUNTRY_BLOCK.test(block.country)) dropped.push(block);
    else unmatched.push(block.country);
  }
  for (const entry of entries)
    entry.icao24Ranges.sort((a, b) => byCode(a[0], b[0]));

  const unknownPrefixRows = Object.keys(REG_PREFIXES).filter(
    (code) => !byIso2.has(code),
  );

  writeIfChanged(CATALOG_FILE, `${JSON.stringify(entries, null, 2)}\n`);

  const failures = validateCountryCatalog(entries);
  const coverage = countryCoverage(entries);
  const shortfall =
    coverage.isoTotal < MIN_ISO_TOTAL || coverage.withIcao24 < MIN_WITH_ICAO24;
  const droppedNames = [...new Set(dropped.map((b) => b.country))];
  console.log('=== build summary ===');
  console.log(
    `isoTotal ${coverage.isoTotal}; withIcao24 ${coverage.withIcao24}; withRegPrefix ${coverage.withRegPrefix}`,
  );
  console.log(
    `allocation blocks ${blocks.length}: ${blocks.length - dropped.length - unmatched.length} kept, ${dropped.length} dropped (${droppedNames.join('; ') || 'none'})`,
  );
  console.log(`unmatched allocation names: ${unmatched.join('; ') || 'none'}`);
  console.log(
    `registration rows for unknown countries: ${unknownPrefixRows.join(', ') || 'none'}`,
  );
  console.log(`missingIcao24 ${coverage.missingIcao24.length}`);
  for (const f of failures)
    console.log(`  INVALID ${f.key}: ${f.problems.join('; ')}`);
  console.log(
    failures.length ? 'validation: FAILED' : 'validation: all entries pass',
  );
  if (
    failures.length ||
    unmatched.length ||
    unknownPrefixRows.length ||
    shortfall
  )
    process.exitCode = 1;
}


const argv = process.argv.slice(2);
build({
  force: argv.includes('--force'),
  offline: argv.includes('--offline'),
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
