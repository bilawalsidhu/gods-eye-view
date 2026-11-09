/**
 * @file The bundled UCS Satellite Database pack: operator, owner country and
 * purpose for active satellites, keyed by NORAD catalog number.
 *
 * Data: `local_data/ucs_satellites/ucs_satellites.json`, built by
 * `scripts/build-ucs-satellites.py` from UCS-Satellite-Database 5-1-2023
 * (https://www.ucsusa.org/satellite_database; free, unrestricted use, with an
 * acknowledgement). Loaded once, on demand, by the satellites layer; a failed
 * load is retried after a cooldown rather than remembered for the session.
 *
 * @module data/ucsSatellites
 */

import { loadBundledJson } from './bundledJson.js';
import { createRetryableLoader } from './retryableLoad.js';

const PACK_URL = new URL(
  './local_data/ucs_satellites/ucs_satellites.json',
  import.meta.url,
);

/**
 * One UCS row: what UCS says about a satellite's operator and purpose.
 * @typedef {{noradId: number, operator: string|null,
 *   operatorCountry: string|null, purpose: string|null}} UcsSatellite
 */

/**
 * Expand the pack's string-table rows into records keyed by NORAD number.
 * A pack of the wrong shape throws: read as an empty pack it would be kept
 * for the session, and every satellite would quietly lose its UCS evidence.
 * A malformed row is skipped.
 * @param {{fields: string[], strings: Record<string, string[]>,
 *   records: Array<number[]>}} pack Parsed `ucs_satellites.json`.
 * @returns {Map<number, UcsSatellite>}
 */
export function indexUcsPack(pack) {
  const byNorad = new Map();
  const fields = pack?.fields;
  if (
    !Array.isArray(fields) ||
    fields[0] !== 'noradId' ||
    !Array.isArray(pack.records)
  )
    throw new TypeError('UCS pack has an unexpected shape');
  for (const row of pack.records) {
    const noradId = row?.[0];
    if (!Number.isInteger(noradId) || noradId <= 0) continue;
    const record = { noradId };
    for (let i = 1; i < fields.length; i++) {
      const text = pack.strings?.[fields[i]]?.[row[i]];
      record[fields[i]] = text ? text : null;
    }
    byNorad.set(noradId, record);
  }
  return byNorad;
}

/** The pack, loaded and indexed once. */
export const loadUcsSatellites = createRetryableLoader(async () =>
  indexUcsPack(await loadBundledJson(PACK_URL)),
);
