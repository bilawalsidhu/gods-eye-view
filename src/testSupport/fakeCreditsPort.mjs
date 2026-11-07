/**
 * The Cesium renderer's own credits port over a fake viewer's
 * `creditDisplay`, for tests of code that adds credits through the port
 * and checks what Cesium's display was given.
 */
import { bindRenderer, rendererOf } from '../render/rendererOf.js';
import { createCesiumCredits } from '../render/cesium/credits.js';

const noEvent = { addEventListener: () => () => {} };

/**
 * @param {{creditDisplay?: object, scene?: object}} viewer
 * @returns {import('../render/contract/credits').CreditsPort}
 */
export function fakeCesiumCredits(viewer) {
  return createCesiumCredits({
    display: viewer.creditDisplay,
    scene: { postRender: noEvent },
    report: (error) => {
      throw error;
    },
    requestRender: () => viewer.scene?.requestRender?.(),
  }).port;
}

/**
 * Bind a renderer with just that port to `viewer`; a viewer already bound
 * keeps its renderer. Returns the viewer.
 * @template V
 * @param {V} viewer
 * @returns {V}
 */
export function bindFakeCesiumCredits(viewer) {
  if (!rendererOf(viewer))
    bindRenderer(viewer, { credits: fakeCesiumCredits(viewer) });
  return viewer;
}
