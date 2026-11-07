// GlobeRender on the app's render governor, which owns Cesium's
// requestRenderMode and maximumRenderTimeChange; the engine only takes a
// hold under its own owner id. The full-frame effects (visual styles,
// bloom, sharpening) are the scene's post stages (postStages.js), the
// contact sonar the scene's native draw commands (sonar.js).

import {
  governorRequestRender,
  holdContinuousRender,
  isRenderGovernorInstalled,
  releaseContinuousRender,
} from '../../renderGovernor.js';
import { CONTACT_SONAR_INITIAL, mergeContactSonar } from '../contract.js';
import { createCesiumPostStages } from './postStages.js';
import { createCesiumSonar } from './sonar.js';

export const RENDER_OWNER = 'globe-engine';

/**
 * @param {Cesium.Viewer} viewer
 * @param {{ requestRender?: (reason: string) => void,
 *   createStage?: (options: object) => object,
 *   createSonar?: typeof createCesiumSonar }} [options] `requestRender`
 *   defaults to the render governor when it governs this viewer, else the
 *   scene itself (before the governor is installed, or on another viewer);
 *   `createStage` (postStages.js) and `createSonar` are test seams.
 * @returns {{ render: import('../contract.js').GlobeRender,
 *   sonarDiagnostics: () => object, destroy: () => void }}
 */
export function createCesiumRender(
  viewer,
  {
    requestRender = (reason) => {
      if (isRenderGovernorInstalled(viewer)) governorRequestRender(reason);
      else viewer.scene.requestRender?.();
    },
    createStage,
    createSonar = createCesiumSonar,
  } = {},
) {
  let held = false;
  const effects = createCesiumPostStages(viewer, {
    requestRender,
    ...(createStage ? { createStage } : {}),
  });
  const sonar = createSonar(viewer);
  let contactSonar = { ...CONTACT_SONAR_INITIAL };
  // Whether Cesium is drawing a frame: a sonar change outside one asks for
  // a frame, one inside it (the app's, every frame) draws in it.
  let drawing = false;
  let removeFrameWatch = null;
  const watchFrames = () => {
    const { scene } = viewer;
    if (removeFrameWatch || !scene.preUpdate?.addEventListener) return;
    const removers = [
      scene.preUpdate.addEventListener(() => {
        drawing = true;
      }),
      scene.postRender.addEventListener(() => {
        drawing = false;
      }),
    ];
    removeFrameWatch = () => {
      for (const remove of removers) remove();
    };
  };
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
    ...effects.render,
    setContactSonar(options) {
      const next = mergeContactSonar(contactSonar, options);
      const changed = Object.keys(next).some(
        (key) => next[key] !== contactSonar[key],
      );
      contactSonar = next;
      if (!changed) return;
      watchFrames();
      sonar.set({ ...next });
      if (!drawing) requestRender('cyber-sonar');
    },
    contactSonar: () => ({ ...contactSonar }),
  };
  return {
    render,
    sonarDiagnostics: () => sonar.diagnostics(),
    destroy() {
      if (held) render.setContinuous(false);
      removeFrameWatch?.();
      sonar.destroy();
      effects.destroy();
    },
  };
}
