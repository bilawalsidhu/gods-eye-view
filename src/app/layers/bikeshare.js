import { createBikeshareLayer } from '../../layers/bikeshare/index.js';
import { rendererFor } from './renderers.js';
import * as render from '../../renderGovernor.js';
import * as picking from '../../data/pickRegistry.js';
import { worldOverlayFor as overlays } from '../../overlays/worldOverlay.js';

export function createApplicationBikeshare({ source }) {
  return createBikeshareLayer({
    source,
    rendererFactory: ({ engine, ...context }) =>
      rendererFor('bikeshare', engine, context),
    services: { render, picking, overlays },
  });
}
