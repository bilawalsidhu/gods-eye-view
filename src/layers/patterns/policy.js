/**
 * @file Pattern Watch — circling-aircraft detection.
 *
 * A derived layer: it consumes the position snapshots the flights and
 * military layers already hold (no new network source) and flags aircraft
 * whose recent track keeps turning in one direction inside a small area —
 * the loitering signature journalists use to find surveillance flights.
 *
 * Ethics, stated where the numbers surface: a circling flag is a PATTERN,
 * not an accusation. Training flights, traffic-watch aircraft, holding
 * stacks near airports, and survey work all circle. The layer names what
 * the track did, never what the operator intends, and it works from the
 * same public feeds the flight layers already display.
 *
 * @module data/patternWatch
 */

export const LAYER_ID = 'flight-patterns';

/** Detection sweeps piggyback on data the flight layers refresh themselves. */
export const UPDATE_INTERVAL_MS = 15000;

/** Track memory per aircraft; circles older than this stop counting. */
export const HISTORY_WINDOW_MS = 12 * 60 * 1000;

/** Samples closer together than this are redundant and dropped. */
export const SAMPLE_MIN_INTERVAL_MS = 5000;

/** Per-aircraft sample cap — bounds memory however fast feeds refresh. */
export const MAX_SAMPLES = 160;

/** Displacements shorter than this don't produce a bearing: GPS jitter on a
 * slow or parked aircraft must never accumulate into a fake orbit. */
export const MIN_SEGMENT_M = 150;

/** Two full same-direction revolutions before an aircraft is flagged. */
export const MIN_TOTAL_TURN_DEG = 720;

/** The whole recent track must fit inside this radius to read as loitering
 * rather than an en-route curve. */
export const MAX_LOITER_RADIUS_M = 8000;

/** Sustained behavior only: at least this much track time in the window. */
export const MIN_SPAN_MS = 4 * 60 * 1000;

/** And enough distinct legs that a couple of noisy bearings can't sum to a
 * revolution. */
export const MIN_SEGMENTS = 8;

/** Alert palette — coral, matching the app's selection/alert accent. */
export const PATTERN_COLOR = '#ff6474';
