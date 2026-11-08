import { bindCctvWorldClickGesture } from '../../layers/cctv/worldClick.js';
import { createCctvLayer } from '../../layers/cctv/index.js';
import { rendererFor } from './renderers.js';
import * as credits from '../../data/dataCredits.js';
import * as activation from '../../cctvFocusRequest.js';
import { worldOverlayFor as overlays } from '../../overlays/worldOverlay.js';
import { CITY_POIS } from '../../cityPois.js';
import * as picking from '../../data/pickRegistry.js';
import * as focus from '../../data/focusDeemphasis.js';
import * as render from '../../renderGovernor.js';

/**
 * Construct one layer using the application scene owners and a supplied
 * source; it draws with the engine's renderer from the manifest
 * (render/display.js on every engine).
 */
export function createApplicationCctv({
  surface,
  source,
  rendererFactory = ({ engine, ...context }) =>
    rendererFor('cctv', engine, context),
}) {
  const { terrain, groundFloor: ground, meshFloor: mesh } = surface;
  const layer = createCctvLayer({
    source,
    rendererFactory,
    services: {
      credits,
      activation,
      overlays,
      locations: { CITY_POIS },
      picking,
      terrain,
      ground,
      mesh,
      focus,
      render,
    },
  });
  return {
    ...layer,
    bindCctvWorldClickGesture,
    // Legacy helper; production navigation uses the initialized owner.
    focusCctvRecord(engine, record, duration) {
      const display = engine
        ? rendererFor('cctv', engine, { services: {}, state: {} })
        : null;
      display?.attach();
      try {
        return layer.focusCctvRecord(display, record, duration);
      } finally {
        display?.destroy();
      }
    },
  };
}
