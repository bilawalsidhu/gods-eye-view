import { createCctvLayer } from '../../layers/cctv/index.js';
import { rendererFor } from './renderers.js';
import * as credits from '../../data/dataCredits.js';
import * as activation from '../../cctvFocusRequest.js';
import { worldOverlayFor as overlays } from '../../overlays/worldOverlay.js';
import { CITY_POIS } from '../../cityPois.js';
import * as picking from '../../data/pickRegistry.js';
import * as focus from '../../data/focusDeemphasis.js';
import * as render from '../../renderGovernor.js';

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
  return layer;
}
