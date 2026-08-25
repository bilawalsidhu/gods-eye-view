/**
 * Turning one propagated orbit into the two lines a globe draws, and the sentence a card
 * prints beside them.
 *
 * **Why this is a file and not four lines inside the layer.** Alexander Fanthome asked on
 * 2026-08-25 for assets to "show the path they have trvelled, and the future path they will
 * travel". For a satellite the future half of that is genuinely computable: SGP4 solves an
 * orbit, so where the object will be in forty minutes is arithmetic rather than a guess. The
 * half behind it is *not* a travelled path. This project records no position history at all,
 * so there is nothing observed to draw, and what `SatelliteEngine.orbitAt` produces behind the
 * object is the same propagator run backwards from the same element set. Over one revolution
 * that is accurate to about a kilometre and it is still a computation, and a line on a globe
 * says "it went this way" whether or not anybody watched it go. So the split and the sentence
 * that labels it travel together, in one module, rather than the split living in a renderer
 * and the sentence being written again wherever somebody remembers to.
 *
 * No Cesium and no DOM, so all of it is tested in the node runner. The renderer takes two
 * flat arrays and knows nothing about epochs; the card takes a string and knows nothing about
 * Float64Arrays.
 */

import type { OrbitTrack } from './orbit';

/**
 * One orbit as two lines, meeting at the object.
 *
 * The sample at `nowIndex` is the last of `behind` and the first of `ahead`. That is
 * deliberate duplication: two polylines that split a shared vertex between them meet across a
 * gap of one sample, which at orbital speed is about 25 km of missing line under the mark
 * itself. Whoever notices it will read it as a broken primitive rather than as an off-by-one.
 */
export interface SplitTrack {
  /** Where the object was, propagated backwards. Earliest sample first. */
  behind: Float64Array;
  /** Where the object will be, propagated forwards. The object's own position first. */
  ahead: Float64Array;
}

/** Milliseconds in a minute, an hour and a day, for the age wording below. */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Split one track at the object into the half behind it and the half ahead of it.
 *
 * `subarray` rather than `slice`: both halves are views onto the buffer the worker already
 * transferred, so this costs two objects and no copy. Cesium reads the numbers straight out
 * when it builds its positions, and neither half is written to.
 */
export function splitTrack(track: OrbitTrack): SplitTrack {
  const split = (track.nowIndex + 1) * 3;
  return {
    behind: track.lonLatAlt.subarray(0, split),
    ahead: track.lonLatAlt.subarray(split - 3),
  };
}

/** How many samples the track holds, which is the only thing its length means. */
function sampleCount(track: OrbitTrack): number {
  return track.lonLatAlt.length / 3;
}

/**
 * How far ahead of the object the forward line reaches, in milliseconds.
 *
 * Samples are evenly spaced across `spanMs`, so this is the share of the span above
 * `nowIndex`. For a low orbit it is about 46 minutes; in geostationary orbit it is twelve
 * hours, because half a revolution is half a day.
 */
export function forwardHorizonMs(track: OrbitTrack): number {
  const samples = sampleCount(track);
  if (samples < 2) {
    return 0;
  }
  return (track.spanMs * (samples - 1 - track.nowIndex)) / (samples - 1);
}

/**
 * A duration as the coarsest two units that describe it: `46 min`, `2 h 11 min`, `3 d 4 h`.
 *
 * Rounded down rather than to nearest, on both an age and a horizon. An element set 3 days
 * and 23 hours old reading "4 d" would put it the wrong side of the 3.5-day staleness guard
 * in the reader's head, and a horizon reading longer than it is is a claim about a further
 * future than the line actually draws.
 */
function duration(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped >= DAY_MS) {
    const days = Math.floor(clamped / DAY_MS);
    const hours = Math.floor((clamped - days * DAY_MS) / HOUR_MS);
    return hours === 0 ? `${days} d` : `${days} d ${hours} h`;
  }
  if (clamped >= HOUR_MS) {
    const hours = Math.floor(clamped / HOUR_MS);
    const minutes = Math.floor((clamped - hours * HOUR_MS) / MINUTE_MS);
    return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
  }
  return `${Math.floor(clamped / MINUTE_MS)} min`;
}

/**
 * The sentence that goes on the card beside a drawn orbit.
 *
 * **Every clause in it is load-bearing.** It names the horizon, because a line drawn round
 * the globe gives no sense of whether it covers forty minutes or half a day. It names the age
 * of the element set, because that is the one input the accuracy depends on and it is the
 * thing the 3.5-day guard is about. And it says outright that the half behind the object was
 * computed rather than observed, because this is the only place in the product where a line
 * is drawn through positions nobody reported, and the rest of the product's honesty about
 * position rests on that never being done silently. Compare `contracts/social.py`'s
 * `location_basis`: same rule, that a derived thing says it is derived, applied to a line
 * instead of a point.
 *
 * `nowMs` is passed rather than read, so this holds no clock and a test states the instant it
 * is asserting about.
 */
export function trackProvenance(track: OrbitTrack, nowMs: number): string {
  return [
    `Orbit shown ${duration(forwardHorizonMs(track))} ahead and the same behind,`,
    `computed from an element set ${duration(nowMs - track.epochMs)} old.`,
    'Neither half is an observed track: both are propagated from those elements.',
  ].join(' ');
}
