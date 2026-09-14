import { createModel } from './model.js';
import { createRendering } from './rendering.js';
import { createIngestion } from './ingestion.js';
import { createViewport } from './viewport.js';
import { createSelection } from './selection.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';
import { createState } from './state.js';

/** Construct one layer with its own scene state and supplied application services. */
export function createInstallationsLayer({ services, source }) {
  if (
    typeof source?.getMappedSites !== 'function' ||
    typeof source?.searchNearby !== 'function'
  )
    throw new TypeError('An installation source is required');
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts, source };
  parts.model = createModel(context);
  parts.rendering = createRendering(context);
  parts.ingestion = createIngestion(context);
  parts.viewport = createViewport(context);
  parts.selection = createSelection(context);
  parts.controls = createControls(context);
  parts.lifecycle = createLifecycle(context);
  return Object.assign(
    {},
    parts.controls.methods,
    parts.lifecycle.methods,
    parts.ingestion?.methods,
    {
      approximateSurfaceDistanceM: parts.model.approximateSurfaceDistanceM,
      classifyGoogleMilitaryPlace: parts.model.classifyGoogleMilitaryPlace,
      installationSourceLabel: parts.model.installationSourceLabel,
      installationSurfaceHeightM: parts.rendering.installationSurfaceHeightM,
      installationWithinViewport: parts.model.installationWithinViewport,
      installationResponseSaturated: parts.model.installationResponseSaturated,
      installationRetryDelayMs: parts.viewport.installationRetryDelayMs,
    },
  );
}
export { createInstallationSource } from './source.js';
