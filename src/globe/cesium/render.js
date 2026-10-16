// GlobeRender on the app's render governor, which owns Cesium's
// requestRenderMode and maximumRenderTimeChange; the engine only takes a
// hold under its own owner id.

import {
  governorRequestRender,
  holdContinuousRender,
  isRenderGovernorInstalled,
  releaseContinuousRender,
} from '../../renderGovernor.js';
import { SHARPEN_INITIAL, mergeSharpen } from '../contract.js';

export const RENDER_OWNER = 'globe-engine';

/**
 * @param {Cesium.Viewer} viewer
 * @param {{ requestRender?: (reason: string) => void }} [options] Defaults to
 *   the render governor when it governs this viewer, else the scene itself
 *   (before the governor is installed, or on another viewer).
 * @returns {{ render: import('../contract.js').GlobeRender, destroy: () => void }}
 */
export function createCesiumRender(
  viewer,
  {
    requestRender = (reason) => {
      if (isRenderGovernorInstalled(viewer)) governorRequestRender(reason);
      else viewer.scene.requestRender?.();
    },
  } = {},
) {
  let held = false;
  let sharpen = { ...SHARPEN_INITIAL };
  const render = {
    request(reason = RENDER_OWNER) {
      requestRender(reason);
    },
    setContinuous(enabled) {
      held = Boolean(enabled);
      if (held) holdContinuousRender(RENDER_OWNER);
      else releaseContinuousRender(RENDER_OWNER);
    },
    // The scene's real mode: another owner's hold keeps it continuous.
    isContinuous: () => viewer.scene.requestRenderMode === false,
    // State only: in Cesium mode the app's own post stage sharpens
    // (src/ui/visualEffects.js), and the scene stays as it was.
    setSharpen(options) {
      sharpen = mergeSharpen(sharpen, options);
    },
    sharpen: () => ({ ...sharpen }),
  };
  return {
    render,
    destroy() {
      if (held) render.setContinuous(false);
    },
  };
}
