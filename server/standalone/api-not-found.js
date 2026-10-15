/** Finish unmatched API requests before Vite's HTML fallback. Install last. */
export function apiNotFoundPlugin() {
  const install = (server) => {
    server.middlewares.use('/api', (req, res) => {
      // Optional token discovery must not emit a browser error when absent.
      const noGoogleTokens =
        req.method === 'GET' &&
        req.url?.split('?')[0] === '/google/tiles-token';
      res.writeHead(noGoogleTokens ? 200 : 404, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify(noGoogleTokens ? null : { error: 'Unknown API route' }),
      );
    });
  };
  return {
    name: 'api-not-found',
    configureServer: install,
    configurePreviewServer: install,
  };
}
