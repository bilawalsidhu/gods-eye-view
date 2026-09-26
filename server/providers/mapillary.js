import { installMapillaryRoutes } from './mapillary/routes.js';

/**
 * Vite plugin: Mapillary street-level coverage.
 *
 * Serves cached coverage vector tiles with the Mapillary token added
 * server-side (and the unused z14 image point layer stripped in transit),
 * plus a status route that says whether a token is configured.
 */
function mapillaryProxy() {
  return {
    name: 'mapillary-proxy',
    configureServer(server) {
      installMapillaryRoutes(server.middlewares);
    },
    configurePreviewServer(server) {
      installMapillaryRoutes(server.middlewares);
    },
  };
}

export { mapillaryProxy };
