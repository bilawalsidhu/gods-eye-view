import { createApplicationScene } from '../app/scene.js';
import { createApplicationRequestServices } from '../services/requests.js';
import { endpointSet, storedApiBase } from '../mobile/runtimeConfig.js';
/** Supply standalone request services when directly constructing a scene. */
export function createStandaloneScene(options) {
  return createApplicationScene({
    requestServices: createApplicationRequestServices({
      endpoints: endpointSet(storedApiBase()),
    }),
    ...options,
  });
}
