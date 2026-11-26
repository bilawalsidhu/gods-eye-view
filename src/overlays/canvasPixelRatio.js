/**
 * @module overlays/canvasPixelRatio
 * @description How many backing pixels a full-screen 2D overlay canvas gives
 * one CSS pixel. A phone's 3x screen makes each full-screen canvas nine times
 * its CSS size: on a 390x844 iPhone, one 1170x2532 canvas is 11.9 MB of
 * pixels before the browser's own copies for compositing. On a touch-only
 * device the overlays are drawn at CSS pixels, as the globe under them is;
 * anywhere with a fine pointer they keep the display's ratio.
 */

/** The queries whose answers decide `isTouchOnly`. */
const POINTER_QUERIES = Object.freeze([
  '(pointer: coarse)',
  '(any-pointer: fine)',
]);

/**
 * Whether the only pointer is a finger: `(pointer: coarse)` and no
 * `(any-pointer: fine)`, as the renderers' `touchOnly` fact. A tablet with a
 * trackpad, mouse or pencil attached has a fine pointer, so is not touch
 * only. A browser without `matchMedia` is not touch only.
 * @param {{matchMedia?: (query: string) => {matches: boolean}}} [win]
 * @returns {boolean}
 */
export function isTouchOnly(win = globalThis.window) {
  if (typeof win?.matchMedia !== 'function') return false;
  return (
    win.matchMedia('(pointer: coarse)').matches === true &&
    win.matchMedia('(any-pointer: fine)').matches !== true
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

/**
 * Call `onChange` whenever `isTouchOnly`'s answer changes: a trackpad,
 * mouse or pencil attached to a tablet or taken away. A change event that
 * leaves the answer as it was calls nothing.
 * @param {(() => void)} onChange
 * @param {{matchMedia?: Function}} [win]
 * @returns {() => void} Stops watching.
 */
export function watchTouchOnly(onChange, win = globalThis.window) {
  if (typeof win?.matchMedia !== 'function') return () => {};
  const stops = [];
  let touchOnly = isTouchOnly(win);
  const listener = () => {
    const next = isTouchOnly(win);
    if (next === touchOnly) return;
    touchOnly = next;
    onChange();
  };
  for (const text of POINTER_QUERIES) {
    let query;
    try {
      query = win.matchMedia(text);
    } catch {
      continue;
    }
    if (typeof query?.addEventListener === 'function') {
      query.addEventListener('change', listener);
      stops.push(() => query.removeEventListener('change', listener));
    } else if (typeof query?.addListener === 'function') {
      query.addListener(listener);
      stops.push(() => query.removeListener(listener));
    }
  }
  return () => {
    for (const stop of stops.splice(0)) stop();
  };
}
