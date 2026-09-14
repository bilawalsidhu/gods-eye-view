import { TRAFFIC_TIMING_ENABLED } from './policy.js';
import { createStyle } from './style.js';
import { createTiming } from './timing.js';
import { createModel } from './model.js';
import { createIngestion } from './ingestion.js';
import { createAnimation } from './animation.js';
import { createViewport } from './viewport.js';
import { createFlow } from './flow.js';
import { createRendering } from './rendering.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';
import { createState } from './state.js';

/** Construct one layer with its own scene state and supplied application services. */
export function createTrafficLayer({ services, source }) {
  if (
    ![
      'requestRoads',
      'getStatus',
      'fetchFlowForBounds',
      'getFlowSessionStats',
      'resetFlowTileCache',
    ].every((key) => typeof source?.[key] === 'function')
  )
    throw new TypeError('A traffic source is required');
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts, source };
  parts.style = createStyle(context);
  parts.timing = createTiming(context);
  parts.model = createModel(context);
  parts.ingestion = createIngestion(context);
  parts.animation = createAnimation(context);
  parts.viewport = createViewport(context);
  parts.flow = createFlow(context);
  parts.rendering = createRendering(context);
  parts.controls = createControls(context);
  parts.lifecycle = createLifecycle(context);
  state._parseRoads = TRAFFIC_TIMING_ENABLED
    ? (data, trace) =>
        trace
          ? parts.timing.parseRoadsTimed(data, trace)
          : parts.model.parseRoads(data)
    : parts.model.parseRoads;

  state._loadRoadsForBounds = TRAFFIC_TIMING_ENABLED
    ? parts.timing.loadRoadsForBoundsTimed
    : parts.ingestion.loadRoadsForBounds;

  return Object.assign(
    {},
    parts.controls.methods,
    parts.lifecycle.methods,
    parts.ingestion?.methods,
    {
      getTrafficTimingDiagnostics: parts.timing.getTrafficTimingDiagnostics,
      deriveTrafficFlowError: parts.flow.deriveTrafficFlowError,
      trafficFeedPresentation: parts.model.trafficFeedPresentation,
    },
  );
}

export { createTrafficSource } from './source.js';
