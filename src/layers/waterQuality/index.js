import { createModel } from './model.js';
import { createRendering } from './rendering.js';
import { createIngestion } from './ingestion.js';
import { createViewport } from './viewport.js';
import { createSelection } from './selection.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';
import { createState } from './state.js';

/** Construct one layer with its own scene state and supplied application services. */
export function createWaterQualityLayer({ services, source }) {
  if (
    typeof source?.getStations !== 'function' ||
    typeof source?.getResults !== 'function'
  )
    throw new TypeError('A water-quality source is required');
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
      siteSurfaceHeightM: parts.rendering.siteSurfaceHeightM,
      siteWithinViewport: parts.model.siteWithinViewport,
      waterQualitySourceLabel: parts.model.waterQualitySourceLabel,
      waterQualityRetryDelayMs: parts.viewport.waterQualityRetryDelayMs,
    },
  );
}
export { createWaterQualitySource } from './source.js';
