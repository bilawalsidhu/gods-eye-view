/**
 * @file Rules every aircraft type catalog entry must satisfy. Shared by the
 * builder (scripts/build-aircraft-catalog.mjs refuses to write a
 * catalog that breaks them) and the unit tests.
 */

import { classifyAircraft } from '../aircraftClass.js';

export const AIRCRAFT_CLASSES = Object.freeze([
  'light',
  'glider',
  'turboprop',
  'airliner',
  'widebody',
  'quadjet',
  'helicopter',
  'fastjet',
  'bizjet',
  'uav',
]);

export const ROLES = Object.freeze(['civil', 'military', 'both']);

/** Licences a bundled photo may carry. NC, ND, GFDL-only and fair use are out. */
export const LICENCE_PATTERN = /^(?:CC0|PD|CC BY(?:-SA)? \d\.\d)$/;

export const MAX_PHOTO_WIDTH = 640;
export const MAX_PHOTO_BYTES = 120 * 1024;

const SPEC_NUMBERS = ['lengthM', 'spanM', 'engines', 'firstFlightYear'];

/**
 * @param {Array<object>} entries catalog.json
 * @param {{ photoBytes: (publicPath: string) => number | null }} io size of a
 *   file under public/, or null when it does not exist.
 * @returns {string[]} one line per broken rule; empty when the catalog is valid.
 */
export function validateCatalog(entries, { photoBytes }) {
  const problems = [];
  const seen = new Set();
  let previous = '';
  for (const entry of entries) {
    const icao = entry?.icao;
    const fail = (rule) => problems.push(`${icao ?? '?'}: ${rule}`);
    if (typeof icao !== 'string' || !/^[A-Z0-9]{2,4}$/.test(icao)) {
      fail('icao must be a 2-4 character upper-case designator');
      continue;
    }
    if (seen.has(icao)) fail('duplicate icao');
    if (icao <= previous) fail('entries must be sorted by icao');
    seen.add(icao);
    previous = icao;
    if (!entry.name) fail('name is required');
    if (!ROLES.includes(entry.role)) fail(`role ${entry.role} is not allowed`);
    if (!AIRCRAFT_CLASSES.includes(entry.class))
      fail(`class ${entry.class} is unknown`);
    const classified = classifyAircraft({ typeCode: icao });
    if (entry.class !== classified) {
      const override = entry.classOverride;
      if (!override || override.classifier !== classified || !override.reason)
        fail(
          `class ${entry.class} disagrees with classifyAircraft (${classified}) and no override is recorded`,
        );
    }
    for (const key of SPEC_NUMBERS) {
      const value = entry.specs?.[key];
      if (value !== undefined && !(Number.isFinite(value) && value > 0))
        fail(`specs.${key} must be a positive number`);
    }
    if (entry.photo === null) continue;
    const photo = entry.photo ?? {};
    if (photo.path !== `/aircraft-types/${icao}.webp`)
      fail('photo.path must be /aircraft-types/<icao>.webp');
    if (!LICENCE_PATTERN.test(photo.licence ?? ''))
      fail(`photo licence ${photo.licence} is not allowlisted`);
    if (!/^https:\/\//.test(photo.licenceUrl ?? '') && photo.licence !== 'PD')
      fail(
        `photo.licenceUrl is required for ${photo.licence} (got ${photo.licenceUrl})`,
      );
    if (!String(photo.author ?? '').trim()) fail('photo.author is required');
    if (
      !String(photo.sourceUrl ?? '').startsWith(
        'https://commons.wikimedia.org/wiki/File:',
      )
    )
      fail('photo.sourceUrl must be a Commons file page');
    if (
      !Number.isInteger(photo.width) ||
      photo.width <= 0 ||
      photo.width > MAX_PHOTO_WIDTH ||
      !Number.isInteger(photo.height) ||
      photo.height <= 0
    )
      fail(`photo must be at most ${MAX_PHOTO_WIDTH} px wide`);
    const bytes = photoBytes(photo.path ?? '');
    if (bytes === null) fail(`photo file ${photo.path} is missing`);
    else if (bytes > MAX_PHOTO_BYTES)
      fail(`photo file is ${bytes} bytes, over ${MAX_PHOTO_BYTES}`);
  }
  return problems;
}
