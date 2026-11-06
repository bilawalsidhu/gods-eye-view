import { createBikeshareLayer } from '../../layers/bikeshare/index.js';
import { rendererFor } from './renderers.js';
import * as render from '../../renderGovernor.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';

/**
 * Construct one layer using the application scene owners and a supplied
 * source; it draws with the engine's renderer from the registry
 * (render/display.js on every engine).
 */
export function createApplicationBikeshare({ source }) {
  return createBikeshareLayer({
    source,
    rendererFactory: ({ engine, ...context }) =>
      rendererFor('bikeshare', engine, context),
    services: { render, picking, overlays },
  });
}
