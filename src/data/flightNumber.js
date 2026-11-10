/**
 * Airline flight numbers, read as typed text and turned into the ICAO
 * callsigns aircraft broadcast.
 *
 * A passenger knows a flight as its IATA flight number ("BA 123", "A3 602"),
 * while the transponder broadcasts an ICAO callsign ("BAW123", "AEE602"). This
 * module parses either form and builds the exact callsigns to look for. It
 * makes no request: the IATA → ICAO airline mapping is passed in by the caller.
 *
 * Only exact callsigns are produced. A flight whose callsign does not follow
 * its flight number (alphanumeric callsigns such as "EZY12AB") is found by its
 * callsign, not by its flight number.
 * @module flightNumber
 */

/** Longest flight number: four digits, as published by airlines. */
const MAX_FLIGHT_DIGITS = 4;

/**
 * Two-character IATA designator then the number: "BA123", "ba 123", "A3-602",
 * "U2 1234". The designator holds a letter; the third character is a digit or
 * a separator, so a three-letter ICAO prefix never reads as IATA.
 */
const IATA_PATTERN = /^([A-Z0-9]{2})[\s-]*(\d{1,4})([A-Z]?)$/;
/** Three-letter ICAO designator then the number: "BAW123", "aee 602". */
const ICAO_PATTERN = /^([A-Z]{3})[\s-]*(\d{1,4})([A-Z]?)$/;

/**
 * Parse a typed or spoken flight number.
 * @param {*} text Query text.
 * @returns {{kind: 'iata'|'icao', designator: string, number: string, suffix: string, label: string}|null}
 *   The parsed flight, with `number` stripped of leading zeros and `label`
 *   in a display form ("BA 123", "BAW123"); null when the text is not a
 *   flight number.
 */
export function parseFlightNumberQuery(text) {
  const compact = String(text ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
  if (!compact || compact.length > 12) return null;
  const read = (match, kind) => {
    const [, designator, digits, suffix] = match;
    if (!/[A-Z]/.test(designator)) return null;
    if (digits.length > MAX_FLIGHT_DIGITS) return null;
    const number = digits.replace(/^0+(?=\d)/, '');
    if (number === '0') return null;
    return {
      kind,
      designator,
      number,
      suffix,
      label:
        kind === 'iata'
          ? `${designator} ${number}${suffix}`
          : `${designator}${number}${suffix}`,
    };
  };
  const icao = ICAO_PATTERN.exec(compact);
  if (icao) return read(icao, 'icao');
  const iata = IATA_PATTERN.exec(compact);
  if (iata) return read(iata, 'iata');
  return null;
}

/**
 * Exact callsigns a parsed flight may broadcast.
 *
 * An ICAO flight is its own callsign. An IATA flight becomes one callsign per
 * airline holding that IATA code: codes are reassigned, so a lookup can answer
 * with more than one airline, and only an aircraft actually broadcasting one of
 * the callsigns decides which was meant.
 * @param {ReturnType<typeof parseFlightNumberQuery>} flight Parsed flight.
 * @param {Array<{icao?: string, iata?: string}>} [airlines] Airlines that hold
 *   the flight's IATA designator; ignored for an ICAO flight.
 * @returns {string[]} Callsigns, uppercase, without duplicates.
 */
export function flightCallsignCandidates(flight, airlines = []) {
  if (!flight) return [];
  const tail = `${flight.number}${flight.suffix || ''}`;
  if (flight.kind === 'icao') return [`${flight.designator}${tail}`];
  const callsigns = new Set();
  for (const airline of airlines || []) {
    const icao = String(airline?.icao ?? '')
      .trim()
      .toUpperCase();
    const iata = String(airline?.iata ?? '')
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{3}$/.test(icao)) continue;
    if (iata && iata !== flight.designator) continue;
    callsigns.add(`${icao}${tail}`);
  }
  return [...callsigns];
}

/**
 * Whether a contact's callsign is exactly one of the candidates. Callsigns are
 * compared without case and surrounding padding (feeds pad them to 8
 * characters), never by prefix: "BAW12" must not answer for "BAW123".
 * @param {*} callsign Contact's callsign.
 * @param {string[]} candidates From {@link flightCallsignCandidates}.
 * @returns {boolean}
 */
export function callsignMatchesFlight(callsign, candidates) {
  const text = String(callsign ?? '')
    .trim()
    .toUpperCase();
  return Boolean(text) && candidates.includes(text);
}
