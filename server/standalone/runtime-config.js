/** Supply only the credentials intentionally used by browser-side providers. */
export function runtimeConfigPlugin({ env = process.env } = {}) {
  const install = (server) => {
    server.middlewares.use('/api/runtime-config', (req, res, next) => {
      if (new URL(req.url || '/', 'http://localhost').pathname !== '/') {
        next();
        return;
      }
      const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      };
      if (req.method !== 'GET') {
        res.writeHead(405, { ...headers, Allow: 'GET' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      res.writeHead(200, headers);
      res.end(
        JSON.stringify({
          googleMapsApiKey: env.GOOGLE_MAPS_API_KEY || '',
          cesiumIonToken: env.CESIUM_ION_TOKEN || '',
          mapillaryClientToken: env.MAPILLARY_CLIENT_TOKEN || '',
        }),
      );
    });
  };
  return {
    name: 'runtime-browser-config',
    configureServer: install,
    configurePreviewServer: install,
  };
}
