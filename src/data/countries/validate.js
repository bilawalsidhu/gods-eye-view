/**
 * @file Country catalog validation and coverage.
 *
 * {@link validateCountryCatalog} is the gate the tests and the builder run over
 * the catalog: codes are well formed and unique, the flag matches the code, and
 * the ICAO 24-bit blocks are well formed and overlap nowhere in the whole
 * catalog. {@link countryCoverage} reports how much of the ISO list carries an
 * address allocation and a registration prefix. Pure.
 */

import { flagOf, formatIcao24 } from './naming.js';

const HEX6 = /^[0-9A-F]{6}$/;

/**
 * Report every entry that fails the shape policy, and every pair of overlapping
 * address blocks.
 * @param {object[]} catalog
 * @returns {{key: string, problems: string[]}[]} empty when the catalog is clean.
 */
export function validateCountryCatalog(catalog) {
  const seen = new Set();
  const failures = [];
  const blocks = [];
  for (const entry of catalog) {
    const problems = [];
    if (!/^[A-Z]{2}$/.test(entry.iso2 ?? '')) problems.push('bad iso2');
    if (seen.has(entry.iso2)) problems.push('duplicate iso2');
    seen.add(entry.iso2);
    if (!/^[A-Z]{3}$/.test(entry.iso3 ?? '')) problems.push('bad iso3');
    if (!String(entry.name ?? '').trim()) problems.push('missing name');
    if (!entry.flag || entry.flag !== flagOf(entry.iso2))
      problems.push(`flag does not match iso2: ${entry.flag}`);
    if (
      !Array.isArray(entry.regPrefixes) ||
      entry.regPrefixes.some((p) => !/^[A-Z0-9]{1,4}$/.test(p))
    )
      problems.push('bad regPrefixes');
    if (!Array.isArray(entry.icao24Ranges)) problems.push('bad icao24Ranges');
    else
      for (const range of entry.icao24Ranges) {
        const [start, end] = Array.isArray(range) ? range : [];
        if (
          !Array.isArray(range) ||
          range.length !== 2 ||
          !HEX6.test(start) ||
          !HEX6.test(end)
        )
          problems.push(`bad icao24 range: ${JSON.stringify(range)}`);
        else if (start > end)
          problems.push(`icao24 range start after end: ${start}-${end}`);
        else
          blocks.push({
            key: entry.iso2,
            start: Number.parseInt(start, 16),
            end: Number.parseInt(end, 16),
          });
      }
    if (problems.length) failures.push({ key: entry.iso2, problems });
  }
  blocks.sort((a, b) => a.start - b.start);
  for (let i = 1; i < blocks.length; i++) {
    const prev = blocks[i - 1];
    const block = blocks[i];
    if (block.start <= prev.end) {
      const message = `icao24 overlap: ${formatIcao24(prev.start)}-${formatIcao24(prev.end)} (${prev.key}) with ${formatIcao24(block.start)}-${formatIcao24(block.end)} (${block.key})`;
      for (const key of new Set([prev.key, block.key])) {
        const failure = failures.find((f) => f.key === key);
        if (failure) failure.problems.push(message);
        else failures.push({ key, problems: [message] });
      }
    }
  }
  return failures;
}

/**
 * How much of the catalog carries an address allocation and a registration prefix.
 * @param {{iso2: string, icao24Ranges: unknown[], regPrefixes: unknown[]}[]} catalog
 * @returns {{isoTotal: number, withIcao24: number, withRegPrefix: number, missingIcao24: string[]}}
 */
export function countryCoverage(catalog) {
  const missingIcao24 = catalog
    .filter((e) => e.icao24Ranges.length === 0)
    .map((e) => e.iso2);
  return {
    isoTotal: catalog.length,
    withIcao24: catalog.length - missingIcao24.length,
    withRegPrefix: catalog.filter((e) => e.regPrefixes.length > 0).length,
    missingIcao24,
  };
}
