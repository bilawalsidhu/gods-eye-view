/**
 * Session-analytics no-op endpoint (`/api/analytics`).
 *
 * Dev counterpart of the Pages Function `functions/api/analytics.ts` —
 * accepts the anonymous pageview/layer/session_end pings from
 * `src/react/hooks/useSessionTracking.ts` and acknowledges them. The Pages
 * Function is also a no-op (Workers KV persistence is deliberately out of
 * scope), so dev and prod contracts are identical: any method → 200
 * {ok:true}, OPTIONS → 204 CORS preflight. Keeping the dev middleware
 * means the hook gets a real 200 in dev instead of a Vite 404 that only
 * succeeds because its failures are silently swallowed.
 */

/**
 * The request handler, exported for unit testing without a Vite server.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export async function analyticsHandler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ ok: true }));
}

/**
 * Vite plugin: analytics acknowledge endpoint.
 * @returns {import('vite').Plugin}
 */
export function analyticsProxy() {
  const install = (server) => {
    server.middlewares.use('/api/analytics', analyticsHandler);
  };
  return {
    name: 'analytics-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
