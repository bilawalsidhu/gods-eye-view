// The civil flights layer's renderer on the Navara engine: the shared
// aircraft renderer with airplane.glb's nose offset. Registered for 'navara'
// by the Navara mode after its import() (src/app/navaraMode.js).

import { aircraftLayerNavaraRenderer } from '../../aircraft/render/navara.js';
import { MODEL_HEADING_OFFSET_DEG } from '../policy.js';

export const createFlightsNavaraRenderer = aircraftLayerNavaraRenderer(
  'flights',
  MODEL_HEADING_OFFSET_DEG,
);
