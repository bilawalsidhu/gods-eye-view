// src/data/ourAirportsAtc.js
// Offline lookup over the bundled OurAirports ATC frequency pack
// (src/data/local_data/ourairports_atc/) — "which controlling position could
// the aircraft I am tracking be talking to, and on what frequency".
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: map a flight phase onto a
// frequency class. The source data does not support it. Of the 9,562 airports
// in the pack only 443 publish all four of TWR/GND/APP/ATIS, and 5,902 publish
// no controlled position at all — at those fields the honest answer is
// "uncontrolled, CTAF 122.800, pilots self-announce", not a tower that does not
// exist. Callers get the classes an airport actually publishes and are expected
// to say what is there, not to promise a rail that isn't.
//
// The pack is loaded lazily and once: nothing is read until a caller asks.

import { createRetryableLoader } from './retryableLoad.js';
import { greatCircleKm } from './routePlausible.js';

/**
 * Frequency classes carried by the pack, in OurAirports' own vocabulary.
 * CONTROLLED means a human controller with authority; ADVISORY means a shared
 * frequency where pilots announce their own intentions (CTAF/UNICOM) or an
 * information officer without control authority (AFIS).
 */
export const CONTROLLED_CLASSES = Object.freeze([
  'TWR',
  'GND',
  'APP',
  'ATIS',
  'CNTR',
]);
export const ADVISORY_CLASSES = Object.freeze(['CTAF', 'UNIC', 'AFIS']);

/** Human-readable expansion for each class the pack can contain. */
export const CLASS_LABELS = Object.freeze({
  TWR: 'Tower',
  GND: 'Ground',
  APP: 'Approach',
  ATIS: 'ATIS',
  CNTR: 'Center',
  CTAF: 'CTAF',
  UNIC: 'UNICOM',
  AFIS: 'AFIS',
});

const loadPack = createRetryableLoader(async () => {
  // Vite bundles this JSON as a module; the import attribute is what Node needs
  // to load the same file under node:test (same pattern as
  // naturalEarthRegions.js / neighborhoodPolygons.js). One path, so no node:
  // import reaches the browser.
  const mod = await import('./local_data/ourairports_atc/frequencies.json', {
    with: { type: 'json' },
  });
  const pack = mod.default || mod;
  const types = pack.types || [];
  return {
    meta: pack.meta || null,
    airports: (pack.airports || []).map(
      ([ident, name, lat, lon, frequencies]) => ({
        ident,
        name,
        lat,
        lon,
        // Decoded once at load, not per query: the pack stores the class as an
        // index into `types` to keep the bytes down, and every consumer wants
        // the name.
        frequencies: frequencies.map(([typeIndex, mhz]) => ({
          type: types[typeIndex],
          label: CLASS_LABELS[types[typeIndex]] || types[typeIndex],
          mhz,
        })),
      }),
    ),
  };
});

/**
 * Load the whole pack (idempotent; the retryable loader collapses concurrent
 * callers onto one import and replays a failure inside its cooldown).
 * @returns {Promise<{meta: object|null, airports: Array<object>}>} The pack.
 */
export async function loadAtcFrequencies() {
  return loadPack();
}

/**
 * True when the airport publishes at least one controlled position — i.e. there
 * is someone to hear. The inverse is not "no radio": an advisory-only field
 * still has a frequency, it just has no controller on it.
 * @param {{frequencies: Array<{type: string}>}} airport - A pack airport.
 * @returns {boolean} Whether any frequency is a controlled class.
 */
export function isControlled(airport) {
  return (airport?.frequencies || []).some((f) =>
    CONTROLLED_CLASSES.includes(f.type),
  );
}

/**
 * Group an airport's frequencies by class, preserving pack order within each.
 * @param {{frequencies: Array<{type: string, mhz: number}>}} airport - A pack airport.
 * @returns {Record<string, Array<{type: string, label: string, mhz: number}>>}
 *   Class → frequencies; classes the airport does not publish are absent, so a
 *   caller cannot mistake "not published" for "published as empty".
 */
export function frequenciesByClass(airport) {
  const out = {};
  for (const frequency of airport?.frequencies || []) {
    (out[frequency.type] ||= []).push(frequency);
  }
  return out;
}

/**
 * The airports nearest a position that publish any frequency, nearest first.
 *
 * Linear scan with a cheap bounding-box reject before the great-circle call —
 * the pack is under ten thousand entries, so an index would cost more to build
 * and keep than it saves.
 * @param {number} lat - Latitude in degrees.
 * @param {number} lon - Longitude in degrees.
 * @param {{limit?: number, maxKm?: number, controlledOnly?: boolean}} [options]
 *   `limit` caps results (default 5); `maxKm` is the search radius (default
 *   250); `controlledOnly` drops advisory-only fields.
 * @returns {Promise<Array<{ident: string, name: string, lat: number,
 *   lon: number, distanceKm: number, controlled: boolean,
 *   frequencies: Array<{type: string, label: string, mhz: number}>}>>}
 *   Nearest airports, nearest first; empty when nothing is in range.
 */
export async function nearestAirportsWithFrequencies(lat, lon, options = {}) {
  const { limit = 5, maxKm = 250, controlledOnly = false } = options;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const { airports } = await loadPack();
  // One degree of latitude is ~111 km everywhere; one degree of longitude is
  // that times cos(lat) and collapses at the poles, so the longitude window is
  // only a reject filter — never the distance.
  const latWindow = maxKm / 111;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const lonWindow =
    Math.abs(cosLat) < 0.01 ? 180 : maxKm / (111 * Math.abs(cosLat));
  const hits = [];
  for (const airport of airports) {
    if (Math.abs(airport.lat - lat) > latWindow) continue;
    // Longitude difference the short way round, so a search near the
    // antimeridian does not reject the airport on the other side of it.
    const dLon = Math.abs(((airport.lon - lon + 540) % 360) - 180);
    if (dLon > lonWindow) continue;
    if (controlledOnly && !isControlled(airport)) continue;
    const distanceKm = greatCircleKm(lat, lon, airport.lat, airport.lon);
    if (distanceKm > maxKm) continue;
    hits.push({ ...airport, distanceKm, controlled: isControlled(airport) });
  }
  hits.sort(
    (a, b) => a.distanceKm - b.distanceKm || (a.ident < b.ident ? -1 : 1),
  );
  return hits.slice(0, Math.max(0, limit));
}

/**
 * Look one airport up by its OurAirports ident (ICAO where one exists, else the
 * local code) — the identifier the adsbdb route enrichment already carries.
 * @param {string} ident - Airport ident, case-insensitive.
 * @returns {Promise<object|null>} The pack airport, or null when absent.
 */
export async function airportByIdent(ident) {
  const wanted = String(ident ?? '')
    .trim()
    .toUpperCase();
  if (!wanted) return null;
  const { airports } = await loadPack();
  return airports.find((a) => a.ident === wanted) || null;
}
