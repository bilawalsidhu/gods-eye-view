// Cesium's backend of the wind display: the wind renderer's streamlines
// over the viewer, read only once a Cesium globe draws.
import * as Cesium from 'cesium';
import { createWindRendering } from './windRendering.js';

export function createWindCesiumFlow(engine, { onStatusChange } = {}) {
  return createWindRendering({
    cesium: Cesium,
    container: engine.host.container,
    getViewer: () => engine.extensions.cesium.viewer,
    onStatusChange,
  });
}
