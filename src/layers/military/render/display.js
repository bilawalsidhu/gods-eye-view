// The military flights layer's display, the same on every engine: the
// aircraft display (src/layers/aircraft/render/display.js) in the military's
// sprite slot with jet.glb's nose offset (the per-class specs pass their own
// offset to setPose). The military's presentation choices (amber #FFB800
// fleet, #FFD166 tracked, the IR boost as an unlit white model) are the
// layer's logic and reach the display as plain data.

import { aircraftLayerDisplay } from '../../aircraft/render/display.js';
import { MODEL_HEADING_OFFSET_DEG } from '../policy.js';

/** Registry factory (src/app/layers/renderers.js): `(engine, options)`. */
export const createMilitaryDisplay = aircraftLayerDisplay(
  'military',
  MODEL_HEADING_OFFSET_DEG,
);
