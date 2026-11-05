import { createBikeshareLayer } from '../../layers/bikeshare/index.js';
import { createBikeshareCesiumRenderer } from '../../layers/bikeshare/render/cesium.js';
import { rendererFor } from './renderers.js';
import * as render from '../../renderGovernor.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationBikeshare({ source }) {
  return createBikeshareLayer({
    source,
    rendererFactory: ({ engine, ...context }) =>
      engine?.kind === 'navara'
        ? rendererFor('bikeshare', engine, context)
        : createBikeshareCesiumRenderer(context),
    services: { render, sprites, picking, overlays },
  });
}
