import { createVirtualCamerasLayer } from '../../layers/cameras/index.js';
import * as render from '../../renderGovernor.js';
import * as geoid from '../../data/geoid.js';

/**
 * Construct the Virtual Cameras layer over the Simulation layer's targets,
 * with the application's ground-floor cache for tripod heights and the render
 * governor. The shell attaches navigation authority after construction.
 * @param {object} options
 * @param {object} options.simulation The Simulation layer instance.
 * @param {object|null} [options.groundFloor] `createGroundFloor()` instance.
 */
export function createApplicationVirtualCameras({
  simulation,
  groundFloor = null,
  ...options
}) {
  if (!simulation?.getTargets)
    throw new TypeError('Virtual cameras need the Simulation layer');
  return createVirtualCamerasLayer({
    services: {
      render,
      geoid,
      groundFloor: groundFloor
        ? {
            cachedGroundFloor: groundFloor.cachedGroundFloor,
            warmGroundFloor: groundFloor.warmGroundFloor,
          }
        : null,
    },
    targets: () => simulation.getTargets(),
    scenarioCameras: () => simulation.getCameras?.() || [],
    subscribeScenario: (listener) => simulation.subscribe?.(listener),
    scenarioTimeS: () => simulation.getClock?.().timeS || 0,
    ...options,
  });
}
