import { MID_COUNTRIES } from './ais-mid-table.js';

/**
 * Offline identity derivation for AIS contacts.
 *
 * Everything here is computed from the identifiers the vessel already
 * broadcasts — no upstream, no key, no latency. Flag state comes from the MMSI
 * itself, and an IMO number carries its own check digit, so both are decided
 * locally and are available for every contact rather than the small minority
 * that some enrichment provider happens to know about.
 */

/** MMSI categories that are not a ship station, per ITU-R M.585. */
const MMSI_KINDS = Object.freeze({
  SHIP: 'SHIP',
  COAST_STATION: 'COAST STATION',
  GROUP: 'GROUP OF SHIPS',
  SAR_AIRCRAFT: 'SAR AIRCRAFT',
  HANDHELD: 'HANDHELD / DIVER',
  AUXILIARY: 'AUXILIARY CRAFT',
  AID_TO_NAVIGATION: 'AID TO NAVIGATION',
  FREE_FORM: 'AIS-SART / MOB / EPIRB',
  UNKNOWN: 'UNKNOWN',
});

export { MMSI_KINDS };

/**
 * Classifies an MMSI and extracts its Maritime Identification Digits.
 *
 * The MID is not always the leading three digits: coast stations, aids to
 * navigation and the rest carry a prefix first. Reading blindly from position
 * zero would report an aid to navigation off the Dutch coast as a ship
 * registered in whatever country digits 1-3 happen to spell.
 *
 * @param {string|number} mmsi
 * @returns {{kind:string, mid:number|null}}
 */
export function classifyMmsi(mmsi) {
  const digits = String(mmsi ?? '').replace(/\D/g, '');
  if (digits.length < 9) return { kind: MMSI_KINDS.UNKNOWN, mid: null };
  const mid = (offset) => {
    const value = Number(digits.slice(offset, offset + 3));
    return Number.isFinite(value) ? value : null;
  };
  if (digits.startsWith('00'))
    return { kind: MMSI_KINDS.COAST_STATION, mid: mid(2) };
  if (digits.startsWith('0')) return { kind: MMSI_KINDS.GROUP, mid: mid(1) };
  if (digits.startsWith('111'))
    return { kind: MMSI_KINDS.SAR_AIRCRAFT, mid: mid(3) };
  if (digits.startsWith('98'))
    return { kind: MMSI_KINDS.AUXILIARY, mid: mid(2) };
  if (digits.startsWith('99'))
    return { kind: MMSI_KINDS.AID_TO_NAVIGATION, mid: mid(2) };
  if (
    digits.startsWith('970') ||
    digits.startsWith('972') ||
    digits.startsWith('974')
  )
    return { kind: MMSI_KINDS.FREE_FORM, mid: null };
  if (digits.startsWith('8')) return { kind: MMSI_KINDS.HANDHELD, mid: mid(1) };
  const leading = Number(digits[0]);
  if (leading >= 2 && leading <= 7)
    return { kind: MMSI_KINDS.SHIP, mid: mid(0) };
  return { kind: MMSI_KINDS.UNKNOWN, mid: null };
}

/**
 * Flag state for an MMSI.
 * @returns {{code:string, name:string, kind:string}|null}
 */
export function flagFromMmsi(mmsi) {
  const { kind, mid } = classifyMmsi(mmsi);
  if (mid === null) return null;
  const entry = MID_COUNTRIES[mid];
  if (!entry) return null;
  return { code: entry[0], name: entry[1], kind };
}

/**
 * Validates an IMO ship-identification number by its check digit: the first
 * six digits weighted 7..2, summed, and the last digit of that sum must equal
 * the seventh. Catches transposed and mistyped numbers before they are used
 * as a lookup key against a sanctions list.
 */
export function isValidImo(imo) {
  const digits = String(imo ?? '').replace(/\D/g, '');
  if (digits.length !== 7) return false;
  let sum = 0;
  for (let i = 0; i < 6; i += 1) sum += Number(digits[i]) * (7 - i);
  return sum % 10 === Number(digits[6]);
}

/** Normalizes a vessel name for comparison: upper case, alphanumerics only. */
export function normalizeVesselName(name) {
  return String(name ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}
