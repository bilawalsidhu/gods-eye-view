/** Finish unmatched API requests before Vite's HTML fallback. Install last. */
export function apiNotFoundPlugin() {
  const install = (server) => {
    server.middlewares.use('/api', (_req, res) => {
      res.writeHead(404, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'Unknown API route' }));
    });
  };
  return {
    name: 'api-not-found',
    configureServer: install,
    configurePreviewServer: install,
  };
}
