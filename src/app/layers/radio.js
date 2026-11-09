import { createRadioLayer } from '../../layers/radio/index.js';
import { rendererFor } from './renderers.js';
import * as picking from '../../data/pickRegistry.js';
import { worldOverlayFor as overlays } from '../../overlays/worldOverlay.js';
import * as globe from '../../celestialRing.js';
import * as render from '../../renderGovernor.js';

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
