/**
 * @file Parsers for the fact sources of the country and airline catalogs.
 *
 * Used by the offline builders, never at view time. Each takes the text of a
 * source file and returns plain rows, so the builders stay thin and the parsing
 * is tested against fixtures. Pure.
 */

import { formatIcao24, normalizeName } from './naming.js';

/**
 * Parse RFC 4180 CSV: quoted fields, doubled quotes inside them, CRLF or LF.
 * Blank lines are skipped.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') endField();
    else if (c === '\n') endRow();
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

/**
 * Countries of the ISO 3166-1 list (lukes/ISO-3166-Countries-with-Regional-Codes
 * `all.csv`): name, alpha-2 and alpha-3 only.
 * @param {string} csv
 * @returns {{iso2: string, iso3: string, name: string}[]}
 */
export function parseIsoCountries(csv) {
  const [header, ...rows] = parseCsv(csv);
  const col = (name) => header.indexOf(name);
  const [name, iso2, iso3] = [col('name'), col('alpha-2'), col('alpha-3')];
  if (name < 0 || iso2 < 0 || iso3 < 0)
    throw new Error('ISO 3166 CSV: name, alpha-2 or alpha-3 column missing');
  return rows.map((row) => ({
    iso2: row[iso2],
    iso3: row[iso3],
    name: row[name],
  }));
}

/**
 * Address blocks of dump1090's `ICAO_Ranges` array, which is generated from the
 * allocation table in chapter 9 of ICAO Annex 10 Vol III. Reads each
 * `{ start: 0x..., end: 0x..., country: "..." }` literal without evaluating the
 * script. Line comments are skipped.
 * @param {string} js
 * @returns {{start: string, end: string, country: string}[]} six-digit hex bounds.
 */
export function parseIcaoRanges(js) {
  const body = js.slice(js.indexOf('ICAO_Ranges'));
  const array = body.slice(0, body.indexOf('];')).replace(/\/\/.*$/gm, '');
  const pattern =
    /\{\s*start:\s*0x([0-9A-Fa-f]+)\s*,\s*end:\s*0x([0-9A-Fa-f]+)\s*,\s*country:\s*"([^"]*)"/g;
  const blocks = [];
  for (const m of array.matchAll(pattern))
    blocks.push({
      start: formatIcao24(Number.parseInt(m[1], 16)),
      end: formatIcao24(Number.parseInt(m[2], 16)),
      country: m[3],
    });
  return blocks;
}

/**
 * Name resolver over country entries and a name-to-iso2 alias map. A name
 * matches an entry's own name or any alias after {@link normalizeName} folding.
 * Throws when an alias points at a code the catalog lacks, or two names fold to
 * different countries.
 * @param {{iso2: string, name: string}[]} entries
 * @param {Record<string, string>} aliases name -> iso2
 * @returns {(name: string) => string|null} the iso2, or null for an unknown name.
 */
export function buildNameIndex(entries, aliases) {
  const known = new Set(entries.map((e) => e.iso2));
  const index = new Map();
  const add = (name, iso2) => {
    const key = normalizeName(name);
    if (index.has(key) && index.get(key) !== iso2)
      throw new Error(`name "${name}" is both ${index.get(key)} and ${iso2}`);
    index.set(key, iso2);
  };
  for (const entry of entries) add(entry.name, entry.iso2);
  for (const [name, iso2] of Object.entries(aliases)) {
    if (!known.has(iso2)) throw new Error(`alias "${name}" -> unknown ${iso2}`);
    add(name, iso2);
  }
  return (name) => index.get(normalizeName(name)) ?? null;
}
