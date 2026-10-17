import { json2satrec, twoline2satrec } from 'satellite.js';
import { parseTleText, tleCatalogNumber } from './tle.js';

/**
 * Parse a CelesTrak GP catalog into `{ name, omm }` or `{ name, line1, line2 }`
 * entries. OMM JSON carries the six-digit catalog numbers TLE cannot; TLE text
 * stays accepted for caches written before the switch. Records without a
 * catalog number or epoch are skipped without dropping the ones that follow.
 */
export function parseOrbitalElements(text) {
  const body = String(text).trim();
  if (!body.startsWith('[')) return parseTleText(body);
  let records;
  try {
    records = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(records)) return [];
  return records.flatMap((omm) =>
    Number.isSafeInteger(omm?.NORAD_CAT_ID) && typeof omm.EPOCH === 'string'
      ? [{ name: String(omm.OBJECT_NAME ?? '').trim(), omm }]
      : [],
  );
}

/** The SGP4 record for a parsed entry; callers check `satrec.error`. */
export function satrecFromElements(entry) {
  return entry.omm
    ? json2satrec(entry.omm)
    : twoline2satrec(entry.line1, entry.line2);
}

/** The NORAD catalog number of a parsed entry, or null. */
export function elementsCatalogNumber(entry) {
  return entry.omm ? entry.omm.NORAD_CAT_ID : tleCatalogNumber(entry.line1);
}

/** The launch year from a parsed entry's international designator, or null. */
export function elementsLaunchYear(entry) {
  if (entry.omm) {
    const match = /^(\d{4})-/.exec(String(entry.omm.OBJECT_ID ?? ''));
    return match ? Number(match[1]) : null;
  }
  const shortYear = Number(String(entry.line1 || '').slice(9, 11));
  if (!Number.isFinite(shortYear)) return null;
  return shortYear >= 57 ? 1900 + shortYear : 2000 + shortYear;
}
