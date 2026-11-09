// Cesium owns its render mode and scene effects. Scene services drive this API.

import * as Cesium from 'cesium';
import { CONTACT_SONAR_INITIAL, mergeContactSonar } from '../contract.js';
import { createCesiumPostStages } from './postStages.js';
import { createCesiumSonar } from './sonar.js';

export const RENDER_OWNER = 'globe-engine';

/**
 * @param {Cesium.Viewer} viewer
 * @param {{ requestRender?: (reason: string) => void,
 *   createStage?: (options: object) => object,
 *   createSonar?: typeof createCesiumSonar }} [options] `requestRender`
 *   defaults to the scene itself;
 *   `createStage` (postStages.js) and `createSonar` are test seams.
 * @returns {{ render: import('../contract.js').GlobeRender,
 *   sonarDiagnostics: () => object, destroy: () => void }}
 */
export function createCesiumRender(
  viewer,
  {
    requestRender = () => viewer.scene.requestRender?.(),
    createStage,
    createSonar = createCesiumSonar,
  } = {},
) {
  viewer.scene.maximumRenderTimeChange = Infinity;
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
    if (removeFrameWatch) return;
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
      viewer.scene.requestRenderMode = !enabled;
    },
    isContinuous: () => viewer.scene.requestRenderMode === false,
    maxTextureSize: () => Cesium.ContextLimits.maximumTextureSize,
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
      render.setContinuous(false);
      removeFrameWatch?.();
      sonar.destroy();
      effects.destroy();
    },
  };
}
