import { msg } from '../../i18n/marker.js';
/**
 * Station colours, chosen to survive red-green colour blindness.
 *
 * Availability runs along the blue-yellow axis (which red-green deficiencies
 * leave intact) and is repeated in brightness and size, so no one cue has to
 * carry it alone:
 *
 *   free   bright yellow  -> lots of room, big and opaque
 *   busy   teal           -> getting full
 *   nearly violet, dim    -> last slot or two
 *   full   grey, faint    -> can't get in, small and see-through
 *
 * The waterfall uses an inferno-style ramp, also colour-blind safe.
 */

export const LOAD_STYLES = Object.freeze({
  free: Object.freeze({
    css: '#ffe14d',
    alpha: 1,
    size: 11,
    label: msg('Free slots'),
  }),
  busy: Object.freeze({
    css: '#1fb5a8',
    alpha: 0.85,
    size: 9,
    label: msg('Busy'),
  }),
  nearly: Object.freeze({
    css: '#8e5bd0',
    alpha: 0.6,
    size: 8,
    label: msg('Nearly full'),
  }),
  full: Object.freeze({
    css: '#7d8296',
    alpha: 0.32,
    size: 6,
    label: msg('No free slots'),
  }),
});

/** Bucket a station by how many slots are left. */
export function loadBucket(station) {
  const { users, usersMax } = station;
  if (users >= usersMax) return 'full';
  if (usersMax - users <= 1 && usersMax > 1) return 'nearly';
  return users / usersMax >= 0.5 ? 'busy' : 'free';
}

export function stationStyle(station) {
  const bucket = loadBucket(station);
  return { bucket, ...LOAD_STYLES[bucket] };
}

const INFERNO = [
  [0, 0, 4],
  [40, 11, 84],
  [101, 21, 110],
  [159, 42, 99],
  [212, 72, 66],
  [245, 125, 21],
  [250, 193, 39],
  [252, 255, 164],
];

/** 256-entry RGB lookup table for waterfall intensity (0..255). */
export function buildWaterfallPalette() {
  const table = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (INFERNO.length - 1);
    const lo = Math.min(INFERNO.length - 2, Math.floor(t));
    const f = t - lo;
    for (let c = 0; c < 3; c++)
      table[i * 3 + c] =
        INFERNO[lo][c] + (INFERNO[lo + 1][c] - INFERNO[lo][c]) * f;
  }
  return table;
}
