// Test fixture: 200 satellites (ISS, one GEO, one Molniya, one Starlink and a
// seeded draw from CelesTrak's `active` group, epochs around 2026-10-11) as
// the three-line TLE text /api/celestrak/<group> serves. satFixture200.tle is
// converted from a 200-object CelesTrak GP export.
import { readFileSync } from 'node:fs';
import { tleCatalogNumber } from '../sources/tle.js';

export const FIXTURE = readFileSync(
  new URL('../skyView/reference/satFixture200.tle', import.meta.url),
  'utf8',
);

function checksum(line) {
  let total = 0;
  for (const ch of line.slice(0, 68)) {
    if (ch >= '0' && ch <= '9') total += Number(ch);
    else if (ch === '-') total += 1;
  }
  return total % 10;
}

function entryFrom(name, line1, line2) {
  const yy = Number(line1.slice(18, 20));
  const day = Number(line1.slice(20, 32));
  return {
    name,
    line1,
    line2,
    norad: tleCatalogNumber(line1),
    /** Revolutions per day (line 2, columns 53-63). */
    meanMotion: Number(line2.slice(52, 63)),
    /** Element epoch (UTC ms). */
    epochMs:
      Date.UTC(yy < 57 ? 2000 + yy : 1900 + yy, 0, 1) + (day - 1) * 864e5,
  };
}

const lines = FIXTURE.split(/\r?\n/).filter(Boolean);
/** Every fixture object, in file order. */
export const ENTRIES = [];
for (let i = 0; i + 2 < lines.length; i += 3)
  ENTRIES.push(entryFrom(lines[i], lines[i + 1], lines[i + 2]));

/** TLE text of some entries (the body of one /api/celestrak/<group>). */
export const tle = (...entries) =>
  entries.map((e) => `${e.name}\n${e.line1}\n${e.line2}\n`).join('');

/** The fixture entry for a NORAD id, or undefined. */
export const entryOf = (norad) => ENTRIES.find((e) => e.norad === norad);

/** The same elements under another catalogue number (and optionally name). */
export function renumber(entry, norad, name = entry.name) {
  const id = String(norad).padStart(5, ' ');
  const fix = (line) => {
    const body = line.slice(0, 2) + id + line.slice(7, 68);
    return body + checksum(body);
  };
  return entryFrom(name, fix(entry.line1), fix(entry.line2));
}
