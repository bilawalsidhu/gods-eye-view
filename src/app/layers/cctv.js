import {
  createCctvCesiumRenderer,
  bindCctvWorldClickGesture,
} from '../../layers/cctv/render/cesium.js';
import { createCctvLayer } from '../../layers/cctv/index.js';
import { rendererFor } from './renderers.js';
import * as credits from '../../data/dataCredits.js';
import * as sprites from '../../data/spriteOrder.js';
import * as activation from '../../cctvFocusRequest.js';
import * as overlays from '../../overlays/worldOverlay.js';
import * as locations from '../../locations.js';
import * as picking from '../../data/pickRegistry.js';
import * as focus from '../../data/focusDeemphasis.js';
import * as render from '../../renderGovernor.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationCctv({
  surface,
  source,
  rendererFactory = ({ engine, ...context }) =>
    engine?.kind === 'navara'
      ? rendererFor('cctv', engine, context)
      : createCctvCesiumRenderer(context),
}) {
  const { terrain, groundFloor: ground, meshFloor: mesh } = surface;
  const layer = createCctvLayer({
    source,
    rendererFactory,
    services: {
      credits,
      sprites,
      activation,
      overlays,
      locations,
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
    // Legacy native helper; production navigation uses the initialized owner.
    focusCctvRecord(viewer, record, duration) {
      const renderer = viewer
        ? createCctvCesiumRenderer({ services: {}, state: {} })
        : null;
      renderer?.attach(viewer);
      return layer.focusCctvRecord(renderer, record, duration);
    },
  };
}
