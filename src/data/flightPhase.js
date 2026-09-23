// src/data/flightPhase.js
// Which part of its flight an aircraft is in, from the fields the tracked
// descriptor publishes — and, just as importantly, when that cannot be said.
//
// The classifier exists to answer "which controller would this aircraft be
// talking to", so every rule here is about what a controller's airspace
// boundary looks like, not about what the aeroplane is doing aerodynamically.
//
// TWO THINGS IT REFUSES TO GUESS, because guessing them produces confident
// wrong answers rather than visible gaps:
//
//   1. HEIGHT ABOVE THE FIELD. `altitudeM` on the tracked descriptor is
//      barometric MSL. 900 m MSL is short final at a coastal airport and below
//      the runway surface at one on a plateau, so without the field's elevation
//      there is no approach/cruise boundary to test against. A missing
//      elevation yields `airborne`, not a phase computed against sea level.
//   2. CLIMB VERSUS DESCENT. Level at 3,000 ft and descending through 3,000 ft
//      are the same row without a vertical rate, and they are different
//      controllers. A missing rate yields `airborne` too.
//
// `airborne` means "flying, cannot refine"; `unknown` means "cannot even say
// that". Both are results, not errors — a caller renders what it knows and
// says what it does not.

/**
 * Ground speed at or above which an aircraft on the ground is on a runway
 * rather than a taxiway — 50 kt. Taxi speed limits sit far below this, and a
 * takeoff or landing roll passes through it in seconds.
 */
const RUNWAY_SPEED_MPS = 25.7;

/**
 * Vertical rate whose magnitude counts as climbing or descending — 300 ft/min.
 * Below it an aircraft is holding an altitude; turbulence and the 64 ft
 * quantisation of a Mode S rate both live under this.
 *
 * DELIBERATELY TIGHTER than `VERT_TREND_MPS` (2 m/s, ~400 ft/min) in
 * `routePlausible.js`, which asks the same climbing-or-descending question for
 * a different purpose. That one decides whether to HIDE a route label, so it
 * only acts on a trend pronounced enough to call a filed route wrong, and the
 * cost of being wrong is a hidden label. This one picks which controller to
 * show, where the cost of being wrong is a frequency that reads level when the
 * aircraft is on a shallow descent. Between 1.524 and 2 the two modules
 * disagree by design: `routePlausible` declines to judge, and this classifier
 * calls it a descent.
 */
const LEVEL_RATE_MPS = 1.524;

/**
 * Height above the field below which a climbing aircraft is still on the
 * tower's initial climb and a descending one is on final — 1,500 ft, the
 * conventional circuit height. Above it the departure/arrival controller has
 * them.
 */
const CIRCUIT_AGL_M = 457;

/**
 * Height above the field above which an aircraft is between airports rather
 * than arriving at or leaving one — 10,000 ft, where the approach controller's
 * airspace typically gives way to the area centre.
 */
const ENROUTE_AGL_M = 3048;

/** Every value `classifyFlightPhase` can return. */
export const FLIGHT_PHASE = Object.freeze({
  TAXI: 'taxi',
  RUNWAY: 'runway',
  TAKEOFF: 'takeoff',
  CLIMB: 'climb',
  CRUISE: 'cruise',
  DESCENT: 'descent',
  APPROACH: 'approach',
  AIRBORNE: 'airborne',
  UNKNOWN: 'unknown',
});

/** What a reader should be told each phase means. */
export const FLIGHT_PHASE_LABELS = Object.freeze({
  taxi: 'Taxiing',
  runway: 'On the runway',
  takeoff: 'Taking off',
  climb: 'Climbing out',
  cruise: 'En route',
  descent: 'Descending',
  approach: 'On approach',
  airborne: 'Airborne',
  unknown: 'Unknown',
});

const finite = (value) => (Number.isFinite(value) ? value : null);

/**
 * Classify one aircraft's flight phase.
 *
 * @param {object} info - A tracked-aircraft descriptor (`getTrackedInfo()`),
 *   or anything carrying the same fields. Missing fields are tolerated and
 *   reported rather than assumed.
 * @param {number|null|undefined} info.altitudeM - Barometric/MSL altitude.
 * @param {boolean} [info.onGround] - Reported ground flag.
 * @param {number|null} [info.velocityMps] - Ground speed.
 * @param {number|null} [info.verticalRateMps] - Climb (+) or descent (-) rate.
 * @param {{fieldElevationM?: number|null}} [reference] - The airport the phase
 *   is being judged against; its elevation is what turns MSL into AGL.
 * @returns {{phase: string, label: string, aglM: number|null,
 *   missing: string[]}} The phase, a reader-facing label, the height above the
 *   field when it could be computed, and the names of the inputs that were
 *   absent — so a caller can say "no vertical rate reported" instead of
 *   showing a phase it invented.
 */
export function classifyFlightPhase(info, reference = {}) {
  const altitudeM = finite(info?.altitudeM);
  const velocityMps = finite(info?.velocityMps);
  const verticalRateMps = finite(info?.verticalRateMps);
  const fieldElevationM = finite(reference?.fieldElevationM);

  const missing = [];
  if (altitudeM === null) missing.push('altitudeM');
  if (verticalRateMps === null) missing.push('verticalRateMps');
  if (fieldElevationM === null) missing.push('fieldElevationM');

  const aglM =
    altitudeM !== null && fieldElevationM !== null
      ? altitudeM - fieldElevationM
      : null;
  const result = (phase) => ({
    phase,
    label: FLIGHT_PHASE_LABELS[phase],
    aglM,
    missing,
  });

  // The ground flag is the one input that needs neither an altitude nor a
  // reference airport, so it is tested first and it wins: an aircraft
  // reporting itself on the ground is not on approach, whatever its
  // barometric altitude says.
  if (info?.onGround === true) {
    if (velocityMps === null) return result(FLIGHT_PHASE.TAXI);
    return result(
      velocityMps >= RUNWAY_SPEED_MPS ? FLIGHT_PHASE.RUNWAY : FLIGHT_PHASE.TAXI,
    );
  }

  if (altitudeM === null) {
    // No altitude. The ground flag is all that is left: an explicit `false`
    // still says airborne; anything else says nothing at all.
    return result(
      info?.onGround === false ? FLIGHT_PHASE.AIRBORNE : FLIGHT_PHASE.UNKNOWN,
    );
  }

  // Airborne from here. Without BOTH a field elevation and a vertical rate
  // there is no boundary to measure against and no direction to measure in.
  if (aglM === null || verticalRateMps === null) {
    return result(FLIGHT_PHASE.AIRBORNE);
  }

  if (verticalRateMps > LEVEL_RATE_MPS) {
    return result(
      aglM < CIRCUIT_AGL_M ? FLIGHT_PHASE.TAKEOFF : FLIGHT_PHASE.CLIMB,
    );
  }
  if (verticalRateMps < -LEVEL_RATE_MPS) {
    return result(
      aglM < ENROUTE_AGL_M ? FLIGHT_PHASE.APPROACH : FLIGHT_PHASE.DESCENT,
    );
  }
  // Level. Well above the field it is en route; close to it, level flight is a
  // circuit, a hold or a level-off — all still the airport's business, and
  // none of them distinguishable from one sample.
  return result(
    aglM >= ENROUTE_AGL_M ? FLIGHT_PHASE.CRUISE : FLIGHT_PHASE.AIRBORNE,
  );
}

/** Coarse vertical direction, independent of any airport. */
export const FLIGHT_DIRECTION = Object.freeze({
  GROUND: 'ground',
  CLIMBING: 'climbing',
  DESCENDING: 'descending',
  LEVEL: 'level',
  UNKNOWN: 'unknown',
});

/**
 * Which way the aircraft is going, using only what it reports about itself.
 *
 * This exists to break a circular dependency: the full phase needs the
 * reference airport's elevation, and choosing the reference airport needs to
 * know whether the aircraft is leaving one or arriving at one. Direction needs
 * neither an airport nor an altitude, so it can be asked first.
 * @param {object} info - A tracked-aircraft descriptor.
 * @returns {string} A `FLIGHT_DIRECTION` value.
 */
export function flightDirection(info) {
  if (info?.onGround === true) return FLIGHT_DIRECTION.GROUND;
  const verticalRateMps = finite(info?.verticalRateMps);
  if (verticalRateMps === null) return FLIGHT_DIRECTION.UNKNOWN;
  if (verticalRateMps > LEVEL_RATE_MPS) return FLIGHT_DIRECTION.CLIMBING;
  if (verticalRateMps < -LEVEL_RATE_MPS) return FLIGHT_DIRECTION.DESCENDING;
  return FLIGHT_DIRECTION.LEVEL;
}

export const FLIGHT_PHASE_THRESHOLDS = Object.freeze({
  RUNWAY_SPEED_MPS,
  LEVEL_RATE_MPS,
  CIRCUIT_AGL_M,
  ENROUTE_AGL_M,
});
