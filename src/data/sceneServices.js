import { createRenderGovernor } from '../renderGovernor.js';
import { createPickRegistry } from './pickRegistry.js';
import { createSelectionDispatcher } from './selectionDispatcher.js';

// Portable layers may attach directly to an engine, outside the application.
// Their lookup reaches the same services the app publishes on its scene.
const scenes = new WeakMap();

/** Create the services for one attachment, including reuse of a parked engine. */
export function createSceneServices(engine, options = {}) {
  scenes.get(engine)?.destroy();
  const render = createRenderGovernor(engine);
  const picking = createPickRegistry();
  const selection = createSelectionDispatcher(engine, { ...options, picking });
  let destroyed = false;
  const services = {
    picking,
    selection,
    render,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      selection.destroy();
      picking.destroy();
      render.destroy();
    },
  };
  scenes.set(engine, services);
  return services;
}

/** A detached scene stays inert until an explicit new attachment replaces it. */
export function sceneServicesFor(engine) {
  if (!engine) return null;
  return scenes.get(engine) ?? createSceneServices(engine);
}
