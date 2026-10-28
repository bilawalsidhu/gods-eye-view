import { createLifecycle } from './cesium/lifecycle.js';
import { createRendering } from './cesium/rendering.js';
import { createSelection } from './cesium/selection.js';
import { createViewport } from './cesium/viewport.js';

/** Compose the existing Cesium-owned bikeshare render modules. */
export function createBikeshareCesiumRenderer(context) {
  return {
    rendering: createRendering(context),
    selection: createSelection(context),
    viewport: createViewport(context),
    lifecycle: createLifecycle(context),
  };
}
