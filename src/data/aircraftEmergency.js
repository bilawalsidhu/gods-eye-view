// src/data/aircraftEmergency.js
/**
 * Transponder emergency status for one aircraft, from the Mode A squawk and
 * the ADS-B emergency/priority field.
 *
 * Emergency squawks are ICAO-standard worldwide: 7500 unlawful interference,
 * 7600 radio failure, 7700 general emergency. readsb (adsb.lol) also reports
 * `emergency`, "a superset of the 7x00 squawks": none, general, lifeguard,
 * minfuel, nordo, unlawful, downed, reserved. OpenSky state vectors carry the
 * squawk only.
 *
 * The status is what the transponder broadcast in THIS poll, never a finding:
 * crews pass through 7x00 codes while dialling, and a real emergency clears
 * when the code does. Callers keep it per poll (not sticky).
 */

/** @constant {string} Tint for aircraft broadcasting an emergency (not a priority). */
export const EMERGENCY_TINT_CSS = '#FF4444';

const SQUAWK_KINDS = { 7500: 'unlawful', 7600: 'nordo', 7700: 'general' };

const KINDS = {
  general: { label: 'General emergency', severity: 'emergency' },
  unlawful: { label: 'Unlawful interference', severity: 'emergency' },
  nordo: { label: 'Radio failure', severity: 'emergency' },
  downed: { label: 'Downed aircraft', severity: 'emergency' },
  minfuel: { label: 'Minimum fuel', severity: 'priority' },
  lifeguard: { label: 'Lifeguard (medical priority)', severity: 'priority' },
};

/**
 * A Mode A code as its four octal digits, else null.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeSquawk(value) {
  const code = String(value ?? '').trim();
  return /^[0-7]{4}$/.test(code) ? code : null;
}

/**
 * Emergency status from one observation. An explicit ADS-B status wins; a
 * 7x00 squawk counts even when the ADS-B field says `none`.
 * @param {{squawk?: unknown, emergency?: unknown}} [observation]
 * @returns {{kind: string, label: string, severity: 'emergency'|'priority',
 *   squawk: string|null, source: 'ads-b'|'squawk'}|null} `source` is
 *   'squawk' when the Mode A code itself names the status (so it can be
 *   quoted), else 'ads-b'.
 */
export function aircraftEmergency({ squawk, emergency } = {}) {
  const code = normalizeSquawk(squawk);
  const reported = String(emergency ?? '')
    .trim()
    .toLowerCase();
  const fromAdsb = Object.hasOwn(KINDS, reported);
  const kind = fromAdsb ? reported : (SQUAWK_KINDS[code] ?? null);
  if (!kind) return null;
  return {
    kind,
    ...KINDS[kind],
    squawk: code,
    source: SQUAWK_KINDS[code] === kind ? 'squawk' : 'ads-b',
  };
}

/**
 * True when the aircraft is broadcasting an emergency (not a priority status).
 * @param {{severity?: string}|null|undefined} status
 * @returns {boolean}
 */
export function isEmergency(status) {
  return status?.severity === 'emergency';
}
