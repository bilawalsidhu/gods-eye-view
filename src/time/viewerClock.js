import { findFrame } from '../render/rendererOf.js';

/**
 * Draw the sky at the world time: the sun, moon, stars, atmosphere and the
 * lighting on the tiles all read the frame port's scene time, which never
 * moved on its own, so before this the sky stayed at the moment the page
 * loaded.
 *
 * Each frame's time is set in `preUpdate`, so the sky is drawn at the same
 * moment the layers read that frame.
 * @param {object} viewer
 * @param {() => number} readTime Epoch ms the sky is drawn at.
 * @param {{subscribe?: Function, requestRender?: () => void}} [options]
 *   A world clock to hear moves from, so a resting scene repaints when the
 *   world time jumps.
 * @returns {() => void} Stop following.
 */
export function followWorldTime(
  viewer,
  readTime,
  {
    subscribe,
    requestRender = () => findFrame(viewer)?.requestRender('world-time'),
  } = {},
) {
  const frame = findFrame(viewer);
  const off = frame?.on('preUpdate', () => frame.setTime(readTime())) ?? null;
  let last = readTime();
  const unsubscribe =
    subscribe?.(() => {
      const next = readTime();
      if (next === last) return;
      last = next;
      requestRender();
    }) ?? (() => {});
  return () => {
    off?.();
    unsubscribe();
  };
}
