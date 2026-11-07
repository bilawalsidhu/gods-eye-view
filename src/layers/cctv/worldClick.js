// The CCTV world click: a tracking click over engine.input, shared by the
// display (render/display.js) and the application layer.

import {
  bindTrackingClickGesture,
  isTrackingClickGesture,
} from '../../data/trackingClickGesture.js';

/** The tracking click gesture over engine.input (the CCTV world click). */
export function bindCctvWorldClickGesture(handler, onClick, options = {}) {
  bindTrackingClickGesture(
    handler,
    (click, gesture) => {
      if (!isTrackingClickGesture(gesture)) return;
      onClick(click);
    },
    options,
  );
}
