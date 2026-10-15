// The Navara globe for the app's experimental engine mode: builds the view
// the product way (viewOptions.js) and the GlobeEngine on it. Load it with a
// dynamic import() so Navara stays out of the Cesium-mode bundle.

import ThreeView from '@navaramap/three';
import { DefaultPlugin } from '@navaramap/three-default-plugin';
import { createNavaraEngine } from './createNavaraEngine.js';
import { navaraHooks } from './internals.js';
import {
  NAVARA_CONTEXT_ATTRIBUTES,
  navaraScenePlan,
  navaraViewOptions,
} from './viewOptions.js';

// Navara 0.2.1 has no preserveDrawingBuffer option but takes a canvas whose
// WebGL2 context is already created (S4); three then uses that context.
function preservedCanvas(container) {
  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, {
    width: '100%',
    height: '100%',
    display: 'block',
  });
  container.appendChild(canvas);
  if (!canvas.getContext('webgl2', NAVARA_CONTEXT_ATTRIBUTES)) {
    canvas.remove();
    throw new Error('WebGL2 is not available');
  }
  return canvas;
}

/**
 * @param {{
 *   container: HTMLElement,
 *   effects?: 'minimal' | 'photoreal',
 *   pixelRatio?: number,
 * }} options `pixelRatio` only for measurements; the product uses the device's.
 * @returns {Promise<{ view: object, engine: import('../contract.js').GlobeEngine, destroy: () => void }>}
 */
export async function createNavaraGlobe({ container, effects, pixelRatio }) {
  if (!container) throw new TypeError('createNavaraGlobe needs a container');
  const plan = navaraScenePlan(effects);
  const canvas = preservedCanvas(container);
  let view;
  try {
    view = new ThreeView(navaraViewOptions({ container, canvas, pixelRatio }));
    const plugin = new DefaultPlugin();
    view.addPlugin(plugin);
    await view.init();
    if (plan.pluginDefault) plugin.addDefaultPhotorealScene();
    else {
      for (const name of plan.meshes) view.addMesh({ [name]: {} });
      for (const name of plan.lights) view.addLight({ [name]: {} });
      for (const name of plan.effects) view.addEffect({ [name]: {} });
    }
  } catch (error) {
    view?.dispose();
    canvas.remove();
    throw error;
  }
  const engine = createNavaraEngine(view, {
    hooks: navaraHooks(view),
    container,
  });
  let destroyed = false;
  return {
    view,
    engine,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      engine.destroy();
      view.dispose();
      canvas.remove();
    },
  };
}
