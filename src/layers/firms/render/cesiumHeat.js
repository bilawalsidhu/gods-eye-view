// The heatmap's Cesium backend (render/heatField.js): one full-globe imagery
// tile on the active map stack's imagery host, else on the viewer's imagery
// layers (heatImagery.js).
import * as Cesium from 'cesium';
import { createHeatImagery } from '../heatImagery.js';

/**
 * @param {{ viewer: object }} cesium The engine's Cesium extension.
 * @param {() => ({ collection: object, kind: string } | null)} [imageryHost]
 */
export function createFirmsCesiumHeat({ viewer }, imageryHost) {
  return createHeatImagery({
    cesium: Cesium,
    getHost: () =>
      imageryHost?.() ?? {
        collection: viewer.imageryLayers ?? null,
        kind: 'globe',
      },
  });
}
