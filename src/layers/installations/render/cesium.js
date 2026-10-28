import { createLifecycle } from '../lifecycle.js';
import { createNamedMarkers } from '../namedMarkers.js';
import { createRendering } from '../rendering.js';
import { createSelection } from '../selection.js';

/** Compose the existing Cesium-owned scene, input and entity adapters. */
export function createInstallationsCesiumRenderer(context) {
  return {
    lifecycle: createLifecycle(context),
    namedMarkers: createNamedMarkers(context),
    rendering: createRendering(context),
    selection: createSelection(context),
  };
}
