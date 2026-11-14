import { t, tn } from '../i18n/index.js';

/**
 * The tracked-aircraft line for a Brazilian registration's ANAC RAB details
 * (server/providers/aircraft/anacRab.js): "Built 1972 · 1 seat · Private".
 * Only technical facts reach the client; the RAB's owner and operator
 * columns never leave the server.
 */

/**
 * Brazilian general aviation flies under its own mark as callsign ("PTTSI").
 * For a transponder in Brazil's ICAO block (E40000-E7FFFF) that mark lets the
 * server find the ANAC record when adsbdb does not know the aircraft.
 * @param {string} icao24
 * @param {string|null|undefined} callsign
 * @returns {string|null} The mark without a dash, or null.
 */
export function brazilianTail(icao24, callsign) {
  if (!/^e[4-7][0-9a-f]{4}$/i.test(String(icao24 ?? ''))) return null;
  const mark = String(callsign ?? '')
    .trim()
    .toUpperCase()
    .replace(/-/g, '');
  return /^P[PRSTU][A-Z]{3}$/.test(mark) ? mark : null;
}

/**
 * @param {string|null|undefined} operation 'airline' | 'air-taxi' |
 *   'government' | 'private'
 * @returns {string} Translated label, or '' when unknown.
 */
export function aircraftOperationLabel(operation) {
  switch (operation) {
    case 'airline':
      return t('Airline', { context: 'aircraft operation' });
    case 'air-taxi':
      return t('Air taxi', { context: 'aircraft operation' });
    case 'government':
      return t('Government', { context: 'aircraft operation' });
    case 'private':
      return t('Private', { context: 'aircraft operation' });
    default:
      return '';
  }
}

/**
 * @param {{year?: number|null, seats?: number|null, operation?: string|null}|null|undefined} rab
 * @returns {string} The line, or '' when the record has nothing to show.
 */
export function aircraftRegistryLine(rab) {
  if (!rab || typeof rab !== 'object') return '';
  const parts = [];
  if (Number.isInteger(rab.year))
    parts.push(t('Built {year}', { year: String(rab.year) }));
  if (Number.isInteger(rab.seats) && rab.seats > 0)
    parts.push(tn(rab.seats, '{count} seat', '{count} seats'));
  const operation = aircraftOperationLabel(rab.operation);
  if (operation) parts.push(operation);
  return parts.join(' · ');
}
