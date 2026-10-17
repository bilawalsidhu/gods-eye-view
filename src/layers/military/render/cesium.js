// The military flights layer's renderer on Cesium: the shared aircraft
// renderer (src/layers/aircraft/render/cesium.js) with the military's
// sprite-order slot and jet.glb's nose offset (the per-class specs pass
// their own offset to setPose). The military's presentation choices (amber
// #FFB800 fleet, #FFD166 tracked, the IR boost as an unlit white model) are
// the layer's logic and reach the renderer as plain data.

import { createAircraftCesiumRenderer } from '../../aircraft/render/cesium.js';
import { MODEL_HEADING_OFFSET_DEG } from '../policy.js';

/**
 * Registry factory (src/app/layers/renderers.js): `(engine, options)`.
 * @param {object|null} engine The Cesium globe engine (null in unit tests).
 * @param {{ viewer: object, adopt?: object }} options
 */
export function createMilitaryCesiumRenderer(engine, { viewer, adopt } = {}) {
  return createAircraftCesiumRenderer({
    viewer,
    engine,
    spriteLayer: 'military',
    headingOffsetDeg: MODEL_HEADING_OFFSET_DEG,
    adopt,
  });
}
