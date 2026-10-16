// The civil flights layer's renderer on the Navara engine: the shared
// aircraft renderer (src/layers/aircraft/render/navara.js) with the flights'
// sprite slot (drawn over the other contact layers, as data/spriteOrder
// orders them on Cesium) and airplane.glb's nose offset. Registered for
// 'navara' by the Navara mode after its import() (src/app/navaraMode.js).

import { createAircraftNavaraRenderer } from '../../aircraft/render/navara.js';
import { SPRITE_LAYER_ORDER } from '../../../data/spriteOrder.js';
import { MODEL_HEADING_OFFSET_DEG } from '../policy.js';

/**
 * Registry factory (src/app/layers/renderers.js): `(engine, options)`.
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 */
export function createFlightsNavaraRenderer(engine) {
  return createAircraftNavaraRenderer({
    engine,
    layerId: 'flights',
    order: SPRITE_LAYER_ORDER.indexOf('flights'),
    headingOffsetDeg: MODEL_HEADING_OFFSET_DEG,
  });
}
