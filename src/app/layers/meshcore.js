import { createMeshcoreLayer } from '../../layers/meshcore/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire the MeshCore node map to the application overlay host. */
export function createApplicationMeshcore(options) {
  return createMeshcoreLayer({ overlayHost, ...options });
}
