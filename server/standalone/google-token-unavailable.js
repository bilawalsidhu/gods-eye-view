/**
 * Treat an unavailable Google Maps tile-token endpoint as a supported, silent
 * outcome. Install after real token providers and before the unknown-API 404.
 */
export function googleTokenUnavailablePlugin() {
  const install = (server) => {
    server.middlewares.use((req, res, next) => {
      const pathname = String(req.url || '').split('?')[0];
      if (
        (req.method !== 'GET' && req.method !== 'HEAD') ||
        pathname !== '/api/google/tiles-token'
      ) {
        next();
        return;
      }

      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
    });
  };

  return {
    name: 'google-token-unavailable',
    configureServer: install,
    configurePreviewServer: install,
  };
}
