#!/usr/bin/env node
/**
 * Build the vendored IGRF table from IAGA's published coefficient file.
 *
 * The published file carries every epoch back to 1900. The layer only needs
 * the most recent main-field epoch plus its secular variation, so this keeps
 * those two columns and drops the other twenty-odd — 42 KB of history becomes
 * a few KB of what we actually evaluate.
 *
 * IGRF is produced by IAGA and distributed by NOAA NCEI as U.S. government
 * work in the public domain, so vendoring the derived table is permitted and
 * means the field model needs no network at runtime.
 *
 * Usage: node scripts/build-igrf-coefficients.mjs [path-to-igrfNNcoeffs.txt]
 * Download: https://www.ngdc.noaa.gov/IAGA/vmod/coeffs/igrf14coeffs.txt
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SOURCE =
  'https://www.ngdc.noaa.gov/IAGA/vmod/coeffs/igrf14coeffs.txt';
const OUT = new URL(
  '../src/data/local_data/igrf/igrf-coefficients.json',
  import.meta.url,
);

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/build-igrf-coefficients.mjs <coeffs.txt>');
  console.error(`Download from ${SOURCE}`);
  process.exit(1);
}

const lines = readFileSync(input, 'utf8').split('\n');
const header = lines.find((line) => line.startsWith('g/h'));
if (!header) throw new Error('no g/h header row: not an IAGA coefficient file');
const columns = header.trim().split(/\s+/);
// IAGA heads the secular-variation column with the span it covers, e.g.
// "2025-30", not the literal "SV". Assert the shape so a layout change is
// caught here rather than silently read as another epoch.
const svColumn = columns.at(-1);
if (!/^\d{4}-\d{2}$/.test(svColumn))
  throw new Error(`last column "${svColumn}" is not an SV span; file layout changed`);
const epoch = Number(columns.at(-2));
if (!Number.isFinite(epoch)) throw new Error('unparsable final epoch');
const svEnd = Number(`${String(epoch).slice(0, 2)}${svColumn.slice(5)}`);
if (!Number.isFinite(svEnd) || svEnd <= epoch)
  throw new Error(`unparsable SV span: ${svColumn}`);

const rows = [];
let nMax = 0;
let nMaxSV = 0;
for (const line of lines) {
  if (!/^[gh]\s/.test(line)) continue;
  const parts = line.trim().split(/\s+/);
  if (parts.length !== columns.length)
    throw new Error(`row has ${parts.length} fields, header has ${columns.length}`);
  const [cs, nRaw, mRaw] = parts;
  const n = Number(nRaw);
  const m = Number(mRaw);
  const value = Number(parts.at(-2));
  const sv = Number(parts.at(-1));
  if (!Number.isFinite(n) || !Number.isFinite(m)) throw new Error(`bad degree/order: ${line}`);
  if (!Number.isFinite(value) || !Number.isFinite(sv))
    throw new Error(`bad coefficient: ${line}`);
  rows.push([cs, n, m, value, sv]);
  nMax = Math.max(nMax, n);
  if (sv !== 0) nMaxSV = Math.max(nMaxSV, n);
}

// Every (n,m) the model needs must be present: a silently short table would
// evaluate to a plausible but wrong field.
const present = new Set(rows.map(([cs, n, m]) => `${cs}${n},${m}`));
for (let n = 1; n <= nMax; n++) {
  for (let m = 0; m <= n; m++) {
    if (!present.has(`g${n},${m}`)) throw new Error(`missing g(${n},${m})`);
    if (m > 0 && !present.has(`h${n},${m}`)) throw new Error(`missing h(${n},${m})`);
  }
}

const table = {
  source: SOURCE,
  rights:
    'IAGA International Geomagnetic Reference Field, distributed by NOAA NCEI. U.S. government work, public domain.',
  epoch,
  // Taken from the SV column header rather than assumed.
  validUntil: svEnd,
  nMax,
  nMaxSV,
  units: { value: 'nT', sv: 'nT/year' },
  rows,
};
writeFileSync(OUT, `${JSON.stringify(table, null, 1)}\n`);
console.log(
  `wrote ${OUT.pathname}: epoch ${epoch}, degree ${nMax}, ${rows.length} coefficients`,
);
