import { createDispatchLayer } from '../../layers/dispatch/index.js';
import * as render from '../../renderGovernor.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { overlayHost } from './overlayHost.js';

/** Construct the 911 dispatch layer using the application scene owners. */
export function createApplicationDispatch({ source }) {
  return createDispatchLayer({
    source,
    overlayHost,
    services: { render, sprites, picking, isPointerFree },
  });
}
