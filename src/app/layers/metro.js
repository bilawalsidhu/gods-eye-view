import { createMetroLayer } from '../../layers/metro/index.js';
import * as render from '../../renderGovernor.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { overlayHost } from './overlayHost.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationMetro({ source }) {
  return createMetroLayer({
    source,
    overlayHost,
    services: { render, sprites, picking, isPointerFree },
  });
}
