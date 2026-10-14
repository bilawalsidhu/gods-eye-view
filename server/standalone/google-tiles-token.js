import { GOOGLE_TOKEN_PATH } from '../../src/maps/googleTokens.js';

/**
 * Answer the Google tiles token endpoint with no tokens to offer. A keyless
 * boot asks for one once per page load; without this, the request falls
 * through to the API 404 catch-all and logs a console error. The client
 * treats any non-token answer as "no tokens offered", and a server that does
 * offer tokens registers its route first, so this middleware never runs.
 */
export function googleTilesTokenPlugin() {
  const install = (server) => {
    server.middlewares.use(GOOGLE_TOKEN_PATH, (_req, res) => {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
    });
  };
  return {
    name: 'google-tiles-token',
    configureServer: install,
    configurePreviewServer: install,
  };
}
