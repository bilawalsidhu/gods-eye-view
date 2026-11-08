import { worldOverlayFor } from '../../overlays/worldOverlay.js';
import { rendererFor } from './renderers.js';
import * as credits from '../../data/dataCredits.js';
import { createAlprCamerasLayer } from '../../layers/alpr/index.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';

import { keyholeLabelAlphaFromGeometry } from '../../celestialRing.js';
import { refreshTrackedReadout } from '../../data/trackedReadout.js';

/**
 * Construct one layer using the application scene owners and a supplied
 * source; it draws with the engine's renderer from the manifest
 * (render/display.js on every engine).
 */
export function createApplicationAlpr({
  surface,
  source,
  rendererFactory = ({ engine, ...context }) =>
    rendererFor('alpr-cameras', engine, context),
}) {
  const { groundFloor } = surface;
  return createAlprCamerasLayer({
    source,
    rendererFactory,
    services: {
      credits,
      render,
      context,
      picking,
      groundFloor,
      overlays: {
        registerPaintLane: (lane, painter, options, engine) =>
          worldOverlayFor(engine)?.registerPaintLane(lane, painter, options),
        keyholeAlpha: keyholeLabelAlphaFromGeometry,
        refreshReadout: refreshTrackedReadout,
        subscribeMapStack(callback) {
          window.addEventListener('gev:map-stack-changed', callback);
          return () =>
            window.removeEventListener('gev:map-stack-changed', callback);
        },
      },
    },
  });
}
