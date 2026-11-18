/**
 * @module data/renderedFrames
 * @description How many frames a viewer's renderer has drawn: a key that
 * changes once per drawn frame, after it is drawn, for per-frame caches.
 * Everything that reads a cache keyed by it in one tick (the follow camera,
 * the frame's `preUpdate` and `preRender` work, the readouts in its
 * `postRender`) sees one value; a tick that draws nothing keeps the key, as
 * the default renderer's own frame number does.
 */
import { findFrame } from '../render/rendererOf.js';

/** Per frame port: `{count}`, counted on its `postRender`. */
const counters = new WeakMap();

/**
 * The number of frames drawn so far on `viewer`'s frame port, or -1 when it
 * has none. Counting starts on the first call.
 * @param {object|null|undefined} viewer
 * @returns {number}
 */
export function renderedFrames(viewer) {
  const frame = viewer ? findFrame(viewer) : null;
  if (!frame) return -1;
  let counter = counters.get(frame);
  if (!counter) {
    counter = { count: 0 };
    counters.set(frame, counter);
    frame.on('postRender', () => {
      counter.count += 1;
    });
  }
  return counter.count;
}
