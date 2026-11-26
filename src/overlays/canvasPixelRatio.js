/**
 * @module overlays/canvasPixelRatio
 * @description How many backing pixels a full-screen 2D overlay canvas gives
 * one CSS pixel. A phone's 3x screen makes each full-screen canvas nine times
 * its CSS size: on a 390x844 iPhone, one 1170x2532 canvas is 11.9 MB of
 * pixels before the browser's own copies for compositing. On a touch-only
 * device the overlays are drawn at CSS pixels, as the globe under them is;
 * anywhere with a fine pointer they keep the display's ratio.
 */

/**
 * Whether the only pointer is a finger: `(pointer: coarse)` and not
 * `(pointer: fine)`. A browser without `matchMedia` is not touch only.
 * @param {{matchMedia?: (query: string) => {matches: boolean}}} [win]
 * @returns {boolean}
 */
export function isTouchOnly(win = globalThis.window) {
  if (typeof win?.matchMedia !== 'function') return false;
  return (
    win.matchMedia('(pointer: coarse)').matches === true &&
    win.matchMedia('(pointer: fine)').matches !== true
  );
}

/**
 * Backing pixels per CSS pixel for a full-screen overlay canvas: 1 on a
 * touch-only device, else the window's `devicePixelRatio` (at least 1),
 * capped at `max`.
 * @param {{devicePixelRatio?: number, matchMedia?: Function}} [win]
 * @param {number} [max]
 * @returns {number}
 */
export function overlayPixelRatio(win = globalThis.window, max = Infinity) {
  if (isTouchOnly(win)) return 1;
  return Math.min(max, Math.max(1, Number(win?.devicePixelRatio) || 1));
}
