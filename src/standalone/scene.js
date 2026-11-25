import { createApplicationScene, loadDefaultRenderer } from '../app/scene.js';
import { createApplicationRequestServices } from '../services/requests.js';
/** The default renderer plugin, loading from the first call (`app/scene.js`). */
export { loadDefaultRenderer };

/** Supply standalone request services when directly constructing a scene. */
export function createStandaloneScene(options) {
  return createApplicationScene({
    requestServices: createApplicationRequestServices(),
    ...options,
  });
}
