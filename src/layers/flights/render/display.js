// The civil flights layer's display, the same on every engine: the aircraft
// display (src/layers/aircraft/render/display.js) in the flights' sprite
// slot with airplane.glb's nose offset. The flights' presentation choices
// (amber for known military, the TR-3B glyph, the IR boost as an unlit
// white model) are the layer's logic and reach the display as plain data.

import { aircraftLayerDisplay } from '../../aircraft/render/display.js';
import { MODEL_HEADING_OFFSET_DEG } from '../policy.js';

/** Registry factory (src/app/layers/renderers.js): `(engine, options)`. */
export const createFlightsDisplay = aircraftLayerDisplay(
  'flights',
  MODEL_HEADING_OFFSET_DEG,
);
