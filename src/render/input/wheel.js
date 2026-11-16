/**
 * @module render/input/wheel
 * @description A DOM wheel event as the input port's `wheel` delta: lines
 * scrolled, counted as the reference renderer counts them, so a camera
 * controller that turns lines back into pixels at `WHEEL_PX_PER_LINE`
 * zooms exactly as the reference does in every browser.
 *
 * The reference takes a pixel-mode wheel as its pixels, a line-mode one at
 * 40 px a line and a page-mode one at 120 px a page. Lines are those
 * pixels over 40: a line-mode wheel is its own lines, a page is 3 lines,
 * and a pixel-mode wheel (Chrome's notch is 100 px) is its pixels over 40
 * (2.5 lines a notch).
 */

/** Pixels a wheel line stands for: the reference renderer's own count. */
export const WHEEL_PX_PER_LINE = 40;
/** Lines a wheel page stands for: the reference's 120 px a page. */
export const WHEEL_LINES_PER_PAGE = 3;

/**
 * Lines scrolled by a DOM wheel event, down positive (as `deltaY`).
 * @param {{deltaY: number, deltaMode?: number}} event
 * @returns {number}
 */
export function wheelLines({ deltaY, deltaMode = 0 }) {
  if (deltaMode === 1) return deltaY;
  if (deltaMode === 2) return deltaY * WHEEL_LINES_PER_PAGE;
  return deltaY / WHEEL_PX_PER_LINE;
}
