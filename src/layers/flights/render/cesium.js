// The civil flights layer's renderer on Cesium: the shared aircraft renderer
// (src/layers/aircraft/render/cesium.js) with the flights' sprite-order slot
// and airplane.glb's nose offset. The flights' presentation choices (amber
// for known military, the TR-3B glyph, the IR boost as an unlit white
// model) are the layer's logic and reach the renderer as plain data.

import { createAircraftCesiumRenderer } from '../../aircraft/render/cesium.js';
import { MODEL_HEADING_OFFSET_DEG } from '../policy.js';

/**
 * Registry factory (src/app/layers/renderers.js): `(engine, options)`.
 * @param {object|null} engine The Cesium globe engine (null in unit tests).
 * @param {{ viewer: object, adopt?: object }} options
 */
export function createFlightsCesiumRenderer(engine, { viewer, adopt } = {}) {
  return createAircraftCesiumRenderer({
    viewer,
    engine,
    spriteLayer: 'flights',
    headingOffsetDeg: MODEL_HEADING_OFFSET_DEG,
    adopt,
  });
}
