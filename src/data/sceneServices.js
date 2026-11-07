import { createSceneContext } from './contextStore.js';
import { createTrackedReadout } from './trackedReadout.js';
import { createWorldOverlay } from '../overlays/worldOverlay.js';
import { createRenderGovernor } from '../renderGovernor.js';
import { createPickRegistry } from './pickRegistry.js';
import { createSelectionDispatcher } from './selectionDispatcher.js';

// Portable layers may attach directly to an engine, outside the application.
// Their lookup reaches the same services the app publishes on its scene.
const scenes = new WeakMap();

/** Create the services for one attachment, including reuse of a parked engine. */
export function createSceneServices(engine, options = {}) {
  scenes.get(engine)?.destroy();
  const overlay = createWorldOverlay(engine);
  const context = createSceneContext(options.retainedSelection);
  const trackedReadout = createTrackedReadout(engine, {
    overlay: options.trackedOverlay ?? overlay,
    events: context.events,
    selectedContext: () => {
      // Retained layers replace hidden outgoing carriers after camera restore.
      // Initializing a readout must not clear their selection in the meantime.
      const store = context.getContextStore();
      return store.entities.get(store.selectedEntityId) ?? null;
    },
  });
  const render = createRenderGovernor(engine);
  const picking = createPickRegistry();
  const selection = createSelectionDispatcher(engine, { ...options, picking });
  let destroyed = false;
  const services = {
    picking,
    selection,
    context,
    trackedReadout,
    render,
    overlay,
    destroy(options) {
      if (destroyed) return;
      destroyed = true;
      selection.destroy();
      picking.destroy();
      trackedReadout.destroy();
      const retained = context.destroy(options);
      overlay.destroy();
      render.destroy();
      return retained;
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
