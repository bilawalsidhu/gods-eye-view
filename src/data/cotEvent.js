/**
 * @file Pure helpers for Cursor-on-Target (CoT) events — shared by the
 * server-side TAK connector (vite.config.js) and the client TAK layer
 * (takEvents.js). No XML/TLS imports here on purpose: safe to bundle into
 * the browser. XML parsing and the TCP/TLS socket live in cotDecode.js
 * (server-only).
 * @module data/cotEvent
 */

/**
 * MIL-STD-2525 affiliation codes, the 2nd hyphen-segment of an "atom" CoT
 * type (`a-<affiliation>-...`, e.g. `a-f-G-U-C` = friendly ground unit).
 * Non-atom types (`b-*` bits/PLI, `u-*` user shapes, etc.) have no
 * affiliation in this scheme — cotAffiliation returns null for those.
 */
const AFFILIATION_LABELS = Object.freeze({
  f: 'FRIENDLY',
  h: 'HOSTILE',
  n: 'NEUTRAL',
  u: 'UNKNOWN',
  a: 'ASSUMED_FRIEND',
  s: 'SUSPECT',
  j: 'JOKER',
  k: 'FAKER',
  p: 'PENDING',
});

/** Affiliation display color, matching the standard MIL-STD-2525 palette. */
export const AFFILIATION_COLOR = Object.freeze({
  FRIENDLY: '#3fa9f5',
  ASSUMED_FRIEND: '#3fa9f5',
  HOSTILE: '#ff4d4d',
  SUSPECT: '#ff4d4d',
  FAKER: '#ff4d4d',
  NEUTRAL: '#3ecf5e',
  UNKNOWN: '#ffd23f',
  PENDING: '#ffd23f',
  JOKER: '#c9c9c9',
});
export const AFFILIATION_DEFAULT_COLOR = '#c9c9c9';

/**
 * @param {string|null|undefined} type CoT event type, e.g. `a-f-G-U-C`.
 * @returns {string|null} An AFFILIATION_LABELS value, or null when `type`
 *   isn't an "atom" (`a-*`) type — affiliation doesn't apply to those.
 */
export function cotAffiliation(type) {
  const t = String(type || '');
  if (!t.startsWith('a-')) return null;
  const code = t.split('-')[1];
  return AFFILIATION_LABELS[code] || null;
}

/**
 * @param {string|null|undefined} staleIso CoT `stale` attribute (ISO 8601).
 * @param {number} [nowMs]
 * @returns {boolean} True once the event has passed its own declared stale time.
 */
export function cotIsExpired(staleIso, nowMs = Date.now()) {
  const t = staleIso ? Date.parse(staleIso) : NaN;
  return Number.isFinite(t) ? nowMs > t : false;
}
