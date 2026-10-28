import { createRadioCesiumRenderer } from '../../layers/radio/render/cesium.js';
import { createRadioLayer } from '../../layers/radio/index.js';
import { rendererFor } from './renderers.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import * as globe from '../../celestialRing.js';
import * as render from '../../renderGovernor.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationRadio({
  surface,
  source,
  rendererFactory = ({ engine, ...context }) =>
    engine?.kind === 'navara'
      ? rendererFor('radio', engine, context)
      : createRadioCesiumRenderer(context),
}) {
  const { groundFloor: ground } = surface;
  return createRadioLayer({
    source,
    rendererFactory,
    services: { ground, picking, overlays, globe, render },
  });
}
