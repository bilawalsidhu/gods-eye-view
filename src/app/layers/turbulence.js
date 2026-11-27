import { createTurbulenceLayer } from '../../layers/turbulence/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { worldClock } from '../../time/worldClock.js';

/** Wire NOAA AWC turbulence into the application catalog. */
export function createApplicationTurbulence(options) {
  return createTurbulenceLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    picking,
    clock: worldClock,
    ...options,
  });
}
