import { createPolicyHelpers } from './policyHelpers.js';
import { createIngestion } from './ingestion.js';
import { createSatelliteIntents } from './satelliteIntents.js';
import { createOrbitRendering } from './orbitRendering.js';
import { createOverlays } from './overlays.js';
import { createSelection } from './selection.js';
import { createReplay } from './replay.js';
import { createPanel } from './panel.js';
import { createPaths } from './paths.js';
import { createLaunchPad } from './launchPad.js';
import { createCamera } from './camera.js';
import { createModel } from './model.js';
import { createRendering } from './rendering.js';
import { createTesting } from './testing.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';
import { createState } from './state.js';

/** Construct one layer with its own scene state and supplied application services. */
export function createRocketLaunchesLayer({ services, source }) {
  if (typeof source?.getLaunches !== 'function')
    throw new TypeError('A launches source is required');
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts, source };
  parts.policyHelpers = createPolicyHelpers(context);
  parts.ingestion = createIngestion(context);
  parts.satelliteIntents = createSatelliteIntents(context);
  parts.orbitRendering = createOrbitRendering(context);
  parts.overlays = createOverlays(context);
  parts.selection = createSelection(context);
  parts.replay = createReplay(context);
  parts.panel = createPanel(context);
  parts.paths = createPaths(context);
  parts.launchPad = createLaunchPad(context);
  parts.camera = createCamera(context);
  parts.model = createModel(context);
  parts.rendering = createRendering(context);
  parts.testing = createTesting(context);
  parts.controls = createControls(context);
  parts.lifecycle = createLifecycle(context);
  const layer = Object.assign(
    {},
    parts.controls.methods,
    parts.lifecycle.methods,
    parts.ingestion.methods,
    parts.panel.commands,
    {
      subscribePanel: parts.panel.subscribePanel,
      waitForSatelliteIntents: parts.satelliteIntents.settled,
      subscribeReplayOverlay: parts.overlays.subscribeReplayOverlay,
    },
  );
  Object.defineProperty(layer, 'testing', { value: parts.testing });
  return layer;
}
export {
  ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID,
  ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID,
  ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
  ROCKET_MISSION_AMBIENT_OVERLAY_COLLISION_CAPACITY,
  ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_OPTIONS,
  LAUNCH_PAD_ZONE_RADIUS_M,
} from './policy.js';
export { createLaunchSource } from './source.js';
