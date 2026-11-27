import { createFirmsHeatmapLayer as createLayer } from '../../layers/firms/index.js';
import * as render from '../../renderGovernor.js';
import * as sprites from '../../data/spriteOrder.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';
import { overlayHost } from './overlayHost.js';
import * as focus from '../../worldFocus.js';
export const firmsServices = {
  render,
  sprites,
  context,
  picking,
  focus,
};

/** Bind a supplied fire feed to the application scene service owners. */
export function createApplicationFirms({ surface, ...options }) {
  return createLayer({
    ...options,
    icon: options.icon ?? '▲',
    source: options.source ?? 'NASA FIRMS',
    feed: options.feed,
    services: { ...firmsServices, anchors: surface.anchors },
    overlayHost: options.overlayHost ?? overlayHost,
  });
}
