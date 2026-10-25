// src/data/atcTuning.js
// What a listener should tune for the aircraft they are tracking: which
// airport, which controlling position, which frequency — and, at most airports
// in the world, why there is nothing to tune.
//
// This module is the honest half of the feature. The tempting design is a
// table from flight phase to frequency class (taxi→GND, takeoff→TWR,
// cruise→CNTR, approach→ATIS) applied unconditionally. The bundled pack says
// that table is a fiction almost everywhere: of its 9,562 airports only 443
// publish all four of TWR/GND/APP/ATIS and 5,902 publish none of them. So the
// phase produces a PREFERENCE ORDER, the airport's own published classes
// decide what is actually available, and when nothing in the order is
// published the caller is told that in words rather than shown a blank.

import {
  FLIGHT_DIRECTION,
  FLIGHT_PHASE,
  classifyFlightPhase,
  flightDirection,
} from './flightPhase.js';
import {
  CLASS_LABELS,
  airportByIdent,
  isControlled,
  nearestAirportsWithFrequencies,
} from './ourAirportsAtc.js';

/**
 * Frequency classes to prefer for each phase, best first.
 *
 * ATIS sits second on approach and descent on purpose: it is a recorded
 * broadcast rather than a conversation, so it is the thing you can always
 * hear, but it is not who the aircraft is talking to. CTAF/UNIC/AFIS are not
 * listed for any phase — they are the fallback below, because reaching them
 * means there is no controller, which is a different statement.
 */
const PHASE_PREFERENCE = Object.freeze({
  [FLIGHT_PHASE.TAXI]: ['GND', 'TWR'],
  [FLIGHT_PHASE.RUNWAY]: ['TWR', 'GND'],
  [FLIGHT_PHASE.TAKEOFF]: ['TWR', 'APP'],
  [FLIGHT_PHASE.CLIMB]: ['APP', 'CNTR', 'TWR'],
  [FLIGHT_PHASE.CRUISE]: ['CNTR', 'APP'],
  [FLIGHT_PHASE.DESCENT]: ['CNTR', 'APP', 'ATIS'],
  [FLIGHT_PHASE.APPROACH]: ['APP', 'ATIS', 'TWR'],
  // Flying, but the phase could not be refined: offer the positions that
  // handle an aircraft in the air, widest first, and let the airport decide.
  [FLIGHT_PHASE.AIRBORNE]: ['APP', 'TWR', 'CNTR', 'ATIS'],
  // Nothing is known about the aircraft. Anything a human talks on will do.
  [FLIGHT_PHASE.UNKNOWN]: ['TWR', 'APP', 'CNTR', 'GND', 'ATIS'],
});

/** Classes that mean "no controller here" — the fallback, never a preference. */
const ADVISORY_ORDER = Object.freeze(['CTAF', 'UNIC', 'AFIS']);

/**
 * What kind of thing is on each frequency. A panel needs this to phrase the
 * result truthfully: ATIS is a loop of recorded weather and runway
 * information, not a controller talking to this aircraft, and an advisory
 * frequency has no controller on it at all.
 */
export const CLASS_KIND = Object.freeze({
  TWR: 'control',
  GND: 'control',
  APP: 'control',
  CNTR: 'control',
  ATIS: 'broadcast',
  CTAF: 'advisory',
  UNIC: 'advisory',
  AFIS: 'advisory',
});

/** Why no frequency could be offered, in words a panel can print verbatim. */
export const NO_TUNING_REASON = Object.freeze({
  NO_AIRPORT: 'No airport with published frequencies within range.',
  UNCONTROLLED:
    'Uncontrolled field — no tower, ground or approach frequency published. ' +
    'Pilots self-announce on the common traffic advisory frequency.',
  NO_MATCHING_CLASS:
    'This airport publishes no frequency for that part of the flight.',
});

/**
 * Pick the frequency to offer at one airport for one phase.
 * @param {{frequencies: Array<{type: string, label: string, mhz: number}>}} airport
 *   A pack airport.
 * @param {string} phase - A `FLIGHT_PHASE` value.
 * @returns {{frequency: object|null, matchedPhase: boolean, reason: string|null}}
 *   `matchedPhase` is false when the frequency came from the advisory fallback
 *   rather than the phase's preference order, so a caller never presents a
 *   CTAF as if it were the controller for that phase.
 */
export function tuneAirportForPhase(airport, phase) {
  const available = new Map();
  for (const frequency of airport?.frequencies || []) {
    if (!available.has(frequency.type))
      available.set(frequency.type, frequency);
  }
  const preference =
    PHASE_PREFERENCE[phase] || PHASE_PREFERENCE[FLIGHT_PHASE.UNKNOWN];
  for (const type of preference) {
    const frequency = available.get(type);
    if (frequency) return { frequency, matchedPhase: true, reason: null };
  }
  for (const type of ADVISORY_ORDER) {
    const frequency = available.get(type);
    if (frequency) {
      return {
        frequency,
        matchedPhase: false,
        reason: NO_TUNING_REASON.UNCONTROLLED,
      };
    }
  }
  return {
    frequency: null,
    matchedPhase: false,
    reason: NO_TUNING_REASON.NO_MATCHING_CLASS,
  };
}

/**
 * Choose the airport whose frequencies matter to this aircraft right now.
 *
 * Departing, the origin still owns it; arriving, the destination does. The
 * route comes from the tracked descriptor's adsbdb enrichment and is already
 * plausibility-gated by the flights layer, so when it is present it is better
 * evidence than proximity — an aircraft climbing out of a field ten miles from
 * a bigger one is talking to the field it left, not the bigger one.
 *
 * Keyed on DIRECTION, not on the full phase, and that is deliberate: the phase
 * needs the chosen airport's elevation, so asking for it here would be
 * circular. Direction needs neither an airport nor an altitude.
 * @param {object} info - Tracked-aircraft descriptor.
 * @param {{maxKm?: number}} [options] - Search radius for the proximity fallback.
 * @returns {Promise<{airport: object|null, basis: string}>} The airport and how
 *   it was chosen (`'origin'`, `'destination'` or `'nearest'`).
 */
export async function chooseReferenceAirport(info, options = {}) {
  const { maxKm = 250 } = options;
  const direction = flightDirection(info);
  const departing =
    direction === FLIGHT_DIRECTION.GROUND ||
    direction === FLIGHT_DIRECTION.CLIMBING;
  const arriving = direction === FLIGHT_DIRECTION.DESCENDING;
  const routeIdent = departing
    ? info?.route?.origin?.code
    : arriving
      ? info?.route?.destination?.code
      : null;
  if (routeIdent) {
    const airport = await airportByIdent(routeIdent);
    if (airport) {
      return { airport, basis: departing ? 'origin' : 'destination' };
    }
  }
  const [nearest] = await nearestAirportsWithFrequencies(
    info?.latitude,
    info?.longitude,
    { limit: 1, maxKm },
  );
  return { airport: nearest || null, basis: nearest ? 'nearest' : 'none' };
}

/**
 * The whole answer for one tracked aircraft: which airport, which position,
 * which frequency, and what to say when there isn't one.
 *
 * The order matters. Direction picks the airport; the airport's elevation
 * turns the aircraft's MSL altitude into height above that field; only then is
 * the phase decidable. Classifying first and choosing second would mean
 * classifying against sea level, which is wrong by the field elevation — 1,655 m
 * at Denver, enough to put an aircraft on short final into the cruise band.
 * @param {object} info - Tracked-aircraft descriptor (`getTrackedInfo()`).
 * @param {{maxKm?: number}} [options] - Search radius for the nearest-airport
 *   fallback.
 * @returns {Promise<{airport: object|null, basis: string, phase: string,
 *   phaseLabel: string, aglM: number|null, missing: string[],
 *   frequency: object|null, positionLabel: string|null, kind: string|null,
 *   matchedPhase: boolean, controlled: boolean, reason: string|null}>}
 *   Everything a panel needs, with
 *   `reason` populated whenever `frequency` is null or came from the advisory
 *   fallback, and `missing` naming the inputs the phase could not be built on.
 */
export async function resolveAtcTuning(info, options = {}) {
  const { airport, basis } = await chooseReferenceAirport(info, options);
  const phaseResult = classifyFlightPhase(info, {
    fieldElevationM: airport?.elevationM ?? null,
  });
  const common = {
    basis,
    phase: phaseResult.phase,
    phaseLabel: phaseResult.label,
    aglM: phaseResult.aglM,
    missing: phaseResult.missing,
  };
  if (!airport) {
    return {
      ...common,
      airport: null,
      frequency: null,
      positionLabel: null,
      kind: null,
      matchedPhase: false,
      controlled: false,
      reason: NO_TUNING_REASON.NO_AIRPORT,
    };
  }
  const { frequency, matchedPhase, reason } = tuneAirportForPhase(
    airport,
    phaseResult.phase,
  );
  return {
    ...common,
    airport,
    frequency,
    positionLabel: frequency
      ? CLASS_LABELS[frequency.type] || frequency.type
      : null,
    // 'control' | 'broadcast' | 'advisory' — so the panel can say "ATIS
    // (recorded)" rather than implying a controller is speaking to this
    // aircraft on it.
    kind: frequency ? CLASS_KIND[frequency.type] || null : null,
    matchedPhase,
    controlled: isControlled(airport),
    reason,
  };
}

export const ATC_PHASE_PREFERENCE = PHASE_PREFERENCE;
