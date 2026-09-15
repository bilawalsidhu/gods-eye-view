import { createMeteorsLayer } from '../../layers/meteors/index.js';
import * as render from '../../renderGovernor.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire meteor rendering to the application's pointer and render owners. */
export function createApplicationMeteors({ source }) {
  return createMeteorsLayer({
    source,
    services: { render, picking, isPointerFree },
  });
}
