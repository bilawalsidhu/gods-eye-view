import { fetchEarthquakes as defaultFetchEarthquakes } from '../sources/usgs-earthquakes.js';

/**
 * Connect-style GET/HEAD handler for `/api/sources/earthquakes` — a thin
 * HTTP wrapper around server/sources/usgs-earthquakes.js.
 *
 * Mounted directly on the shared router by server/serverless/app.js (see
 * the "Gate 3 row 1" comment there), so this is served by the existing
 * catch-all Vercel function (api/[...route].js) rather than needing a
 * function of its own.
 *
 * Mounted at `/api/sources/earthquakes`, so per
 * server/serverless/router.js's Connect-mount semantics `req.url` here is
 * the remainder after the mount point — e.g. `/?minmagnitude=5` for a
 * request to `/api/sources/earthquakes?minmagnitude=5`, or plain `/` with
 * no query string at all.
 *
 * @param {{fetchEarthquakes?: typeof defaultFetchEarthquakes}} [deps]
 * @returns {(req: object, res: object) => Promise<void>}
 */
export function createEarthquakesHandler({
  fetchEarthquakes = defaultFetchEarthquakes,
} = {}) {
  return async function earthquakesHandler(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET, HEAD');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        endJson(res, req, { error: 'method_not_allowed' });
        return;
      }

      const requestUrl = new URL(req.url, 'http://localhost');
      // Forwarded, as-is, to the adapter and echoed back under `query` in
      // the success body below — the adapter (validateQuery) is what
      // normalises/defaults/rejects these, not this route.
      const query = Object.fromEntries(requestUrl.searchParams.entries());

      const result = await fetchEarthquakes(query);

      if (!result.ok) {
        res.statusCode = result.status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        // validateQuery() failures carry an `unknown` array (possibly
        // empty); adapter/upstream failures carry a `detail` string
        // instead — that shape is how the two are told apart here.
        const isValidationFailure = Object.prototype.hasOwnProperty.call(
          result,
          'unknown',
        );
        const body = isValidationFailure
          ? {
              error: 'invalid_query',
              message: result.error,
              unknown: result.unknown,
            }
          : { error: result.error, detail: result.detail };
        endJson(res, req, body);
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=60');
      endJson(res, req, {
        source: 'USGS',
        coverage: 'observed',
        count: result.count,
        events: result.events,
        provenance: result.provenance,
        query,
      });
    } catch (error) {
      // Never throw out of the handler — log server-side only.
      console.error(
        '[earthquakes-route] unhandled error:',
        error?.stack || error,
      );
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      endJson(res, req, { error: 'sources_error' });
    }
  };
}

/** Write the JSON body, except for HEAD (headers only, no body, per HTTP semantics). */
function endJson(res, req, payload) {
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(JSON.stringify(payload));
}
