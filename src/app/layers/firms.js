import { overlayHost } from './overlayHost.js';
import { rendererFor } from './renderers.js';
import { createFirmsHeatmapLayer as createLayer } from '../../layers/firms/index.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';
import { worldOverlayFor as overlays } from '../../overlays/worldOverlay.js';
import * as focus from '../../worldFocus.js';
export const firmsServices = {
  render,
  context,
  picking,
  overlays,
  focus,
};

/**
 * Bind a supplied fire feed to the application scene service owners; it
 * draws with the engine's renderer from the manifest (render/display.js on
 * every engine).
 */
export function createApplicationFirms({ surface, ...options }) {
  return createLayer({
    ...options,
    icon: options.icon ?? '▲',
    source: options.source ?? 'NASA FIRMS',
    feed: options.feed,
    services: { ...firmsServices, anchors: surface.anchors },
    renderer: options.renderer ?? {
      create: ({ engine, ...renderOptions }) =>
        rendererFor('local-firms', engine, renderOptions),
    },
    overlayHost: options.overlayHost ?? overlayHost,
  });
}
