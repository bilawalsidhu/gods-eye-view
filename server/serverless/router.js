/**
 * A tiny, dependency-free re-implementation of Connect's `app.use(path, fn)` /
 * `app.handle(req, res, out)` mount semantics (the `connect` npm package,
 * vendored inside Vite as `server.middlewares` — see
 * node_modules/vite/dist/node/chunks/dep-*.js, `proto.use` / `proto.handle`).
 *
 * The Vite provider plugins in server/providers/** were written against real
 * Connect semantics (`server.middlewares.use('/api/x', handler)`), so a
 * serverless router that wants to reuse that handler code unmodified must
 * reproduce those semantics exactly:
 *
 *  - A layer registered at `route` matches a request path when the path
 *    equals `route`, or starts with `route` followed by `/` or `.`.
 *  - `req.originalUrl` is set once, before any layer runs, and never mutated
 *    again.
 *  - Before a matched layer's handler is called, `req.url` is rewritten to
 *    the remainder of the path after `route` is stripped (query string
 *    preserved). An empty or non-`/`-prefixed remainder gets a leading `/`
 *    added back.
 *  - When the handler's `next()` is called (or the layer's handler throws /
 *    rejects), `req.url` is restored to its pre-layer value before the next
 *    layer is matched — every layer's mount check is against the ORIGINAL
 *    path, not the previous layer's remainder.
 *  - A handler with arity >= 4 is treated as an error handler and is only
 *    invoked while an error is pending; every other handler is skipped while
 *    an error is pending (Connect's `call()`).
 *
 * Deliberately NOT reproduced: absolute-URI request lines (`getProtohost` in
 * real Connect) — irrelevant here since Vercel and our own dev-server only
 * ever hand us origin-relative `req.url` values.
 *
 * Extension over real Connect: a handler that returns a Promise which
 * rejects is treated the same as a synchronous throw (real Connect's `call()`
 * does not await anything and would produce an unhandled rejection instead —
 * unacceptable inside a serverless function). Every provider handler in this
 * repository is `async`, so this extension is what makes `next(err)` /
 * the final error responder reachable at all.
 */

/** Split a Connect-style `req.url` into its raw pathname (no decoding, matching the `parseurl` package). */
function pathnameOf(url) {
  const raw = String(url || '/');
  let end = raw.length;
  const queryIndex = raw.indexOf('?');
  if (queryIndex !== -1 && queryIndex < end) end = queryIndex;
  const hashIndex = raw.indexOf('#');
  if (hashIndex !== -1 && hashIndex < end) end = hashIndex;
  const pathname = raw.slice(0, end);
  return pathname === '' ? '/' : pathname;
}

/** Whether `pathname` is mounted-under `route` per Connect's boundary rule (exact, `/`, or `.`). */
function matchesRoute(pathname, route) {
  if (pathname.toLowerCase().slice(0, route.length) !== route.toLowerCase()) {
    return false;
  }
  const boundary = pathname.length > route.length ? pathname[route.length] : '';
  return !boundary || boundary === '/' || boundary === '.';
}

/** Default terminal handler when no `done` callback is supplied to `handle()`. */
function defaultDone(res) {
  return function done(err) {
    if (res.headersSent || res.writableEnded) return;
    if (err) {
      // Never leak err.message/err.stack to the client — log server-side only.
      console.error('[serverless-router] unhandled error:', err?.stack || err);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'proxy_error' }));
      return;
    }
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: 'Not Found' }));
  };
}

/** Invoke one layer's handler with Connect's arity-based error dispatch, catching sync throws and async rejections. */
function invokeLayer(layer, err, req, res, next) {
  const handle = layer.handle;
  const arity = handle.length;
  const hasError = Boolean(err);
  const isErrorHandler = arity >= 4;
  if (hasError !== isErrorHandler) {
    // Error pending but this is a plain handler, or no error but this layer
    // only handles errors: Connect skips straight past it.
    next(err);
    return;
  }
  try {
    const result = isErrorHandler
      ? handle(err, req, res, next)
      : handle(req, res, next);
    if (result && typeof result.then === 'function') {
      result.then(null, (asyncErr) => next(asyncErr));
    }
  } catch (syncErr) {
    next(syncErr);
  }
}

/**
 * Create a Connect-compatible mount router.
 * @returns {{use: (path: string|Function, fn?: Function) => object, handle: (req: object, res: object, done?: (err?: unknown) => void) => void}}
 */
function createMountRouter() {
  const stack = [];

  const router = {
    use(path, fn) {
      let route = path;
      let handle = fn;
      if (typeof path !== 'string') {
        handle = path;
        route = '/';
      }
      if (typeof handle !== 'function') {
        throw new TypeError(
          'createMountRouter().use() requires a handler function',
        );
      }
      // Strip exactly one trailing slash, same as Connect — '/' becomes ''
      // (root-mounted layers then match every path with no url rewriting).
      if (route.endsWith('/')) route = route.slice(0, -1);
      stack.push({ route, handle });
      return router;
    },

    handle(req, res, done) {
      const finalize = typeof done === 'function' ? done : defaultDone(res);
      if (req.originalUrl == null) req.originalUrl = req.url;

      let index = 0;
      let removed = '';
      let slashAdded = false;

      function next(err) {
        if (slashAdded) {
          req.url = req.url.slice(1);
          slashAdded = false;
        }
        if (removed.length !== 0) {
          req.url = removed + req.url;
          removed = '';
        }
        if (res.writableEnded || res.headersSent) {
          // A layer already finished the response but kept calling next();
          // stop walking rather than risk a "headers already sent" crash.
          return;
        }

        const layer = stack[index++];
        if (!layer) {
          finalize(err);
          return;
        }

        const pathname = pathnameOf(req.url);
        if (!matchesRoute(pathname, layer.route)) {
          next(err);
          return;
        }

        if (layer.route.length !== 0) {
          removed = layer.route;
          req.url = req.url.slice(layer.route.length);
          if (req.url[0] !== '/') {
            req.url = '/' + req.url;
            slashAdded = true;
          }
        }

        invokeLayer(layer, err, req, res, next);
      }

      next();
    },
  };

  return router;
}

export { createMountRouter };
