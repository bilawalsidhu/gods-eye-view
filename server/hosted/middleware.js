/**
 * Minimal connect-compatible middleware stack: enough of the API Vite's
 * `server.middlewares` offers (use(path?, fn), prefix stripping,
 * req.originalUrl, next(err)) for the existing provider plugins to mount
 * unchanged on a plain Node HTTP server.
 */
export function createMiddlewareStack() {
  const stack = [];
  function use(route, fn) {
    if (typeof route === 'function') {
      fn = route;
      route = '/';
    }
    const prefix = route === '/' ? '' : route.replace(/\/+$/, '');
    stack.push({ prefix, fn });
    return api;
  }
  function handle(req, res, done) {
    if (!req.originalUrl) req.originalUrl = req.url;
    const original = req.originalUrl;
    let i = 0;
    const next = (err) => {
      req.url = original;
      const layer = stack[i++];
      if (!layer) return done(err, req, res);
      const path = original.split('?')[0];
      if (layer.prefix) {
        const match =
          path === layer.prefix || path.startsWith(`${layer.prefix}/`);
        if (!match) return next(err);
        req.url = original.slice(layer.prefix.length) || '/';
        if (!req.url.startsWith('/')) req.url = `/${req.url}`;
      }
      try {
        if (err) {
          if (layer.fn.length === 4) return layer.fn(err, req, res, next);
          return next(err);
        }
        if (layer.fn.length === 4) return next();
        const out = layer.fn(req, res, next);
        if (out && typeof out.catch === 'function') out.catch(next);
      } catch (error) {
        next(error);
      }
    };
    next();
  }
  const api = { use, handle, stack };
  return api;
}
