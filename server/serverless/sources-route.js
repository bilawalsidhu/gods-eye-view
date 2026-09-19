/**
 * server/serverless/sources-route.js — the generic Connect-style HTTP wrapper
 * for every Gate 3 source adapter (rows 2–N). One factory, mounted per
 * capability by server/serverless/app.js on the shared router, so every
 * `/api/sources/*` endpoint is served by the existing catch-all Vercel
 * function (api/[...route].js) and the function count stays at 9.
 *
 * Adapter contract (see server/sources/_shared.js):
 *   adapter(query: Record<string,string>, { signal, env, now, pathParams })
 *     → { ok:true, status:200, data, provenance }
 *     | { ok:false, status, error:{ code, message, param? } }
 *
 * The handler: accepts GET/HEAD only (405 otherwise), forwards the raw query
 * string entries untouched (the adapter's whitelist is the validator),
 * cancels the adapter when the client disconnects (AbortController → the
 * `signal` option), sets `Cache-Control` from `cacheSeconds` on success and
 * `no-store` on every error, and never throws (500 → `sources_error`).
 *
 * `pathParams` lets one adapter serve `/api/sources/<family>/<id>` style
 * routes: the mount is `/api/sources/<family>` and the remaining path
 * segments are passed as `pathParams` (e.g. ['catalog'] or ['austin',
 * 'snapshot']). Adapters that do not take path segments should reject a
 * non-empty `pathParams` with a 404 `not_found`.
 */

export function createSourceHandler(
  adapter,
  { cacheSeconds = 60, env = process.env, now = () => new Date() } = {},
) {
  if (typeof adapter !== 'function') {
    throw new TypeError('createSourceHandler(adapter) requires a function');
  }
  return async function sourceHandler(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET, HEAD');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        endJson(res, req, {
          error: { code: 'method_not_allowed', message: 'GET or HEAD only' },
        });
        return;
      }
      const requestUrl = new URL(req.url, 'http://localhost');
      const query = Object.fromEntries(requestUrl.searchParams.entries());
      const pathParams = requestUrl.pathname
        .split('/')
        .filter((s) => s.length > 0)
        .map((s) => decodeURIComponent(s));

      const controller = new AbortController();
      const onClose = () => controller.abort();
      if (typeof req.on === 'function') req.on('close', onClose);

      let result;
      try {
        result = await adapter(query, {
          signal: controller.signal,
          env,
          now,
          pathParams,
        });
      } finally {
        if (typeof req.off === 'function') req.off('close', onClose);
      }
      if (res.writableEnded || res.headersSent) return;

      if (!result || typeof result !== 'object') {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        endJson(res, req, {
          error: {
            code: 'sources_error',
            message: 'adapter returned no result',
          },
        });
        return;
      }

      if (!result.ok) {
        res.statusCode = Number.isInteger(result.status) ? result.status : 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        if (result.error?.retry_after) {
          res.setHeader('Retry-After', String(result.error.retry_after));
        }
        endJson(res, req, { error: result.error });
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(
        'Cache-Control',
        cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store',
      );
      endJson(res, req, {
        ...result.data,
        provenance: result.provenance,
        query,
      });
    } catch (error) {
      // Never throw out of the handler — log server-side only.
      console.error('[sources-route] unhandled error:', error?.stack || error);
      if (res.writableEnded || res.headersSent) return;
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      endJson(res, req, {
        error: { code: 'sources_error', message: 'unexpected adapter failure' },
      });
    }
  };
}

/** Write the JSON body, except for HEAD (headers only, per HTTP semantics). */
function endJson(res, req, payload) {
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(JSON.stringify(payload));
}
