import { createLifecycle } from './cesium/lifecycle.js';
import { createNamedMarkers } from './cesium/namedMarkers.js';
import { createRendering } from './cesium/rendering.js';
import { createSelection } from './cesium/selection.js';

/** Compose the existing Cesium-owned scene, input and entity adapters. */
export function createInstallationsCesiumRenderer(context) {
  return {
    lifecycle: createLifecycle(context),
    namedMarkers: createNamedMarkers(context),
    rendering: createRendering(context),
    selection: createSelection(context),
  };
}
