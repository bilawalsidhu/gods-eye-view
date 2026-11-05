// The military flights layer's renderer on the Navara engine: the shared
// aircraft renderer with jet.glb's nose offset. Registered for 'navara' by
// the Navara mode after its import() (src/app/navaraMode.js).

import { aircraftLayerNavaraRenderer } from '../../aircraft/render/navara.js';
import { MODEL_HEADING_OFFSET_DEG } from '../policy.js';

export const createMilitaryNavaraRenderer = aircraftLayerNavaraRenderer(
  'military',
  MODEL_HEADING_OFFSET_DEG,
);
