import { createIngestion } from './ingestion.js';
import { createViewport } from './viewport.js';
import { createControls } from './controls.js';
import { createState } from './state.js';
import { createModel } from './model.js';

/** Construct one layer with its own scene state and supplied application services. */
export function createInstallationsLayer({
  services,
  source,
  overlayHost,
  rendererFactory,
}) {
  if (
    typeof source?.getMappedSites !== 'function' ||
    typeof source?.searchNearby !== 'function'
  )
    throw new TypeError('An installation source is required');
  if (typeof rendererFactory !== 'function')
    throw new TypeError('An installation renderer factory is required');
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts, source, overlayHost };
  parts.model = createModel(context);
  parts.ingestion = createIngestion(context);
  parts.viewport = createViewport(context);
  parts.controls = createControls(context);
  let renderer = null;
  const lifecycle = {
    init(viewer, options = {}) {
      if (renderer)
        throw new Error('Installations layer is already initialized');
      const engine = options.engine ?? null;
      renderer = rendererFactory({ ...context, viewer, engine });
      if (!renderer?.lifecycle?.methods)
        throw new Error('Installation renderer is unavailable');
      Object.assign(parts, renderer);
      return renderer.lifecycle.methods.init(viewer, options);
    },
    enable(...args) {
      return renderer?.lifecycle?.methods.enable(...args);
    },
    disable(...args) {
      return renderer?.lifecycle?.methods.disable(...args);
    },
    destroy(...args) {
      try {
        return renderer?.lifecycle?.methods.destroy(...args);
      } finally {
        renderer = null;
        for (const key of [
          'rendering',
          'namedMarkers',
          'selection',
          'lifecycle',
        ])
          delete parts[key];
      }
    },
  };
  return Object.assign(
    {},
    parts.controls.methods,
    lifecycle,
    parts.ingestion?.methods,
    {
      approximateSurfaceDistanceM: parts.model.approximateSurfaceDistanceM,
      classifyGoogleMilitaryPlace: parts.model.classifyGoogleMilitaryPlace,
      installationSourceLabel: parts.model.installationSourceLabel,
      installationSurfaceHeightM: parts.model.installationSurfaceHeightM,
      installationWithinViewport: parts.model.installationWithinViewport,
      installationResponseSaturated: parts.model.installationResponseSaturated,
      installationRetryDelayMs: parts.viewport.installationRetryDelayMs,
    },
  );
}
export { createInstallationSource } from './source.js';
