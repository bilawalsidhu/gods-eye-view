import { createSpcOutlooksLayer } from '../../layers/spc/index.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { hitTestWorldOverlay } from '../../overlays/worldOverlay.js';

/** Wire forecast selection to the application's shared pointer/overlay policy. */
export function createApplicationSpcOutlooks(options) {
  return createSpcOutlooksLayer({
    isPointerFree,
    hitTestOverlay: hitTestWorldOverlay,
    ...options,
  });
}
