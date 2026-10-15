// GlobeRender on the app's render governor, which owns Cesium's
// requestRenderMode and maximumRenderTimeChange; the engine only takes a
// hold under its own owner id.

import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../../renderGovernor.js';

export const RENDER_OWNER = 'globe-engine';

/**
 * @param {Cesium.Viewer} viewer
 * @param {{ requestRender?: (reason: string) => void }} [options]
 * @returns {{ render: import('../contract.js').GlobeRender, destroy: () => void }}
 */
export function createCesiumRender(
  viewer,
  { requestRender = governorRequestRender } = {},
) {
  let held = false;
  const render = {
    request() {
      requestRender(RENDER_OWNER);
    },
    setContinuous(enabled) {
      held = Boolean(enabled);
      if (held) holdContinuousRender(RENDER_OWNER);
      else releaseContinuousRender(RENDER_OWNER);
    },
    // The scene's real mode: another owner's hold keeps it continuous.
    isContinuous: () => viewer.scene.requestRenderMode === false,
  };
  return {
    render,
    destroy() {
      if (held) render.setContinuous(false);
    },
  };
}
