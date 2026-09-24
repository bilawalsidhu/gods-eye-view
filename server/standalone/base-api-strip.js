/**
 * Strip the deployment base from provider routes before they reach the
 * '/api/...' middlewares.
 *
 * Provider middlewares mount at '/api/...'; when the app runs under a
 * deployment base (GEV_BASE_PATH, e.g. '/gods-eye/') the browser requests
 * '<base>api/...', so without this every provider would fall through to the
 * SPA fallback and answer HTML — or 404 when the caller asks for JSON.
 * Documents and assets keep their base and stay with Vite's own handling.
 *
 * @param {string} [base] The Vite `base` (defaults to the root, needs no plugin).
 * @returns {import('vite').Plugin|null}
 */
export function baseApiStripPlugin(base) {
  const prefix =
    typeof base === 'string' && base !== '/' ? base.replace(/\/$/, '') : '';
  if (!prefix) return null;
  const strip = (req, _res, next) => {
    if (typeof req.url === 'string' && req.url.startsWith(`${prefix}/api/`)) {
      req.url = req.url.slice(prefix.length);
    }
    next();
  };
  return {
    name: 'base-api-strip',
    configureServer: (server) => {
      server.middlewares.use(strip);
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(strip);
    },
  };
}
