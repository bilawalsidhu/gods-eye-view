import { installMapillaryRoutes } from './mapillary/routes.js';

/**
 * Vite plugin: cached Mapillary coverage tiles (token added server-side) and a
 * status route that says whether a token is configured.
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
