// Cesium's backend of the wind display: the wind renderer's streamlines
// (../rendering.js) over the viewer, read only once a Cesium globe draws.
import * as Cesium from 'cesium';
import { createWindRendering } from '../rendering.js';

export function createWindCesiumFlow(engine, { onStatusChange } = {}) {
  return createWindRendering({
    cesium: Cesium,
    container: engine.host.container,
    getViewer: () => engine.extensions.cesium.viewer,
    onStatusChange,
  });
}
