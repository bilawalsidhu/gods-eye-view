import { gatedIonRoute } from './ionEndpoint.js';
import { gatedMapillaryGraphRoute } from './mapillaryGraph.js';

/** Attach the server-side key routes (ion endpoint, Mapillary Graph). */
export function installKeyIsolationRoutes(middlewares) {
  middlewares.use('/api/ion', gatedIonRoute());
  middlewares.use('/api/mapillary/graph', gatedMapillaryGraphRoute());
}

/**
 * Vite plugin: lets the browser use Cesium ion and the Mapillary Graph API
 * without holding CESIUM_ION_TOKEN or MAPILLARY_CLIENT_TOKEN.
 */
export function keyIsolationProxy() {
  return {
    name: 'gev-key-isolation',
    configureServer(server) {
      installKeyIsolationRoutes(server.middlewares);
    },
    configurePreviewServer(server) {
      installKeyIsolationRoutes(server.middlewares);
    },
  };
}
