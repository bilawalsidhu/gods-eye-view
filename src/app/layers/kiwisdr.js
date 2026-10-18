import { createKiwiSdrLayer } from '../../layers/kiwisdr/index.js';
import * as render from '../../renderGovernor.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import * as input from '../../data/inputOwnership.js';
import * as camera from '../../data/cameraSensitivity.js';

/** Construct the KiwiSDR layer using the application scene owners and a supplied source. */
export function createApplicationKiwiSdr({ source }) {
  return createKiwiSdrLayer({
    source,
    services: { render, sprites, picking, input, camera },
  });
}
