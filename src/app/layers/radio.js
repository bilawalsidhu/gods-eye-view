import { createRadioLayer } from '../../layers/radio/index.js';
import { rendererFor } from './renderers.js';
import * as picking from '../../data/pickRegistry.js';
import { worldOverlayFor as overlays } from '../../overlays/worldOverlay.js';
import * as globe from '../../celestialRing.js';
import * as render from '../../renderGovernor.js';

/**
 * Construct one layer using the application scene owners and a supplied
 * source; it draws with the engine's renderer from the manifest
 * (render/display.js on every engine).
 */
export function createApplicationRadio({
  surface,
  source,
  rendererFactory = ({ engine, ...context }) =>
    rendererFor('radio', engine, context),
}) {
  const { groundFloor: ground } = surface;
  return createRadioLayer({
    source,
    rendererFactory,
    services: { ground, picking, overlays, globe, render },
  });
}
