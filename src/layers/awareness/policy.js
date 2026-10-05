export const AIRCRAFT_DEPENDENCIES = ['flights', 'military'];

export const DEFERRED_DEPENDENCIES = [
  'ais-live-vessels',
  'military-installations',
];

export const DEPENDENCIES = [
  ...AIRCRAFT_DEPENDENCIES,
  ...DEFERRED_DEPENDENCIES,
];

export const AWARENESS_REFRESH_MS = 750;

/** @constant {number} Refresh cadence while the camera pose is CHANGING.
 *  Owner playtest 2026-08-18: the Contacts direction arrows and card readouts
 *  "feel sluggish when you look around" — at the parked 750 ms cadence the
 *  arrows lag the view by up to three quarters of a second. */

export const AWARENESS_MOTION_REFRESH_MS = 175;

/** @constant {number} How long the pose signature must stay UNCHANGED before
 *  the view counts as parked again. The signature is quantized, so a slow drag
 *  crosses a bin only every few frames; without this hysteresis every crossing
 *  read as a motion-end and refreshed at nearly display rate. */

export const AWARENESS_MOTION_SETTLE_MS = 250;

export const AWARENESS_REEVALUATE_DISTANCE_M = 250;

export const AWARENESS_PAGE_ROTATE_MS = 10000;

export const AWARENESS_PAGE_SIZE = 3;

export const AWARENESS_MAX_EXAMPLES = 10;

// Navigation walks the whole 250 km cohort, not the ten rows the panel shows,
// so these caps sit far above any realistic in-range population rather than at
// the display limit. They are still FINITE: an unbounded materialization would
// let a pathological feed sort an eleven-thousand-contact array on every
// refresh. Truthfulness does not depend on them — `summarizeAwarenessCohort`
// derives `count` from the full in-range set before any slice.

export const AWARENESS_QUERY_LIMIT = 20000;

export const AWARENESS_MAX_NAVIGATION_EXAMPLES = 10000;

export const CONTEXT_RIM_HEIGHT_M = 2500;

export const VESSEL_FOCUS_RADIUS_M = 3000;

export const SOURCE_LABEL = {
  flights: 'OpenSky',
  military: 'adsb.lol',
  'ais-live-vessels': 'AISStream',
  'military-installations': 'OpenStreetMap',
};

/**
 * Whether a refresh tick could confirm the subject in its source collection.
 * UNCHECKED means the tick did not look — it must never change the verdict.
 */

export const SUBJECT_PRESENCE = Object.freeze({
  LIVE: 'live',
  MISSING: 'missing',
  UNCHECKED: 'unchecked',
});
