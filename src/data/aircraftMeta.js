// src/data/aircraftMeta.js
/**
 * Sticky per-aircraft metadata merge: once a field has resolved for an
 * aircraft, a later snapshot that MISSES the field (empty/null — OpenSky and
 * adsb.lol both do this intermittently) must not regress it. A later snapshot
 * that CHANGES the field always wins. Pattern from skylight (MIT)
 * server/src/datasource.ts "sticky enrichment".
 */

/**
 * Keep the last non-empty value of a textual metadata field (callsign, squawk,
 * registration, route). A blank `next` never blanks a resolved `prev`.
 *
 * @param {string|null|undefined} next Incoming value from the newest snapshot; may be missing or whitespace.
 * @param {string|null|undefined} prev Previously resolved value carried on the tracked aircraft record.
 * @returns {string} Trimmed `next` when it has content, otherwise trimmed `prev`, otherwise `''`.
 */
export function stickyText(next, prev) {
  const n = String(next || '').trim();
  if (n) return n;
  const p = String(prev || '').trim();
  return p || '';
}

/**
 * Same stickiness for numeric fields (altitude, velocity, heading): a feed
 * dropping the field must not pull a known value back to the default.
 *
 * @param {number|null|undefined} next Incoming numeric value from the newest snapshot.
 * @param {number|null|undefined} prev Previously resolved value for this aircraft.
 * @param {number} fallback Value used when neither snapshot ever supplied a finite number (layer default, e.g. 0 heading).
 * @returns {number} First finite value among `next`, `prev`, `fallback`.
 */
export function stickyNumber(next, prev, fallback) {
  if (Number.isFinite(next)) return next;
  if (Number.isFinite(prev)) return prev;
  return fallback;
}
