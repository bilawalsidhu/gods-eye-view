import { sameSiteGated } from '../common/same-site.js';
import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { readResponseTextCapped } from '../common/http.js';

/**
 * Mapillary Graph API without the client token in the browser.
 *
 * MapillaryJS and the Street Level source call the Graph API for image
 * metadata, sequences and image tiles. Those calls go to this route instead;
 * the server adds the token as an `Authorization: OAuth` header. Only the
 * paths and parameters the app uses are forwarded, and the image CDN URLs in
 * the answers are returned unchanged (they carry no token).
 */

export const MAPILLARY_GRAPH_ORIGIN = 'https://graph.mapillary.com';
const GRAPH_MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
export const GRAPH_ROUTE_MAX_PER_MIN = 1200;

/** `images`, `image_ids`, `{imageId}`, `{imageId}/tiles`. */
const PATH_PATTERN = /^\/(images|image_ids|\d{1,20}(?:\/tiles)?)$/;
/** Query parameters the Graph calls use; anything else is dropped. */
const ALLOWED_PARAMS = new Set([
  'image_ids',
  'sequence_ids',
  'sequence_id',
  's2',
  'fields',
  'limit',
  'lat',
  'lng',
  'radius',
  'z',
]);
const VALUE_PATTERN = /^[A-Za-z0-9_.,:+-]{0,4000}$/;

export function mapillaryGraphToken(env = process.env) {
  return String(env.MAPILLARY_CLIENT_TOKEN || '').trim();
}

/** Upstream path + query for a request, or null when the request is refused. */
export function buildGraphUpstream(rawUrl) {
  const [path, query = ''] = String(rawUrl || '').split('?');
  if (!PATH_PATTERN.test(path)) return null;
  const incoming = new URLSearchParams(query);
  const outgoing = new URLSearchParams();
  for (const [name, value] of incoming) {
    if (!ALLOWED_PARAMS.has(name)) continue; // includes any client access_token
    if (!VALUE_PATTERN.test(value)) return null;
    outgoing.append(name, value);
  }
  const search = outgoing.toString();
  return `${MAPILLARY_GRAPH_ORIGIN}${path}${search ? `?${search}` : ''}`;
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(extraHeaders))
    res.setHeader(name, value);
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

/** Handler mounted at `/api/mapillary/graph`. */
export function createMapillaryGraphHandler({
  fetchImpl = (...args) => globalThis.fetch(...args),
  env = process.env,
  allow = makeRateLimiter({
    windowMs: 60_000,
    max: GRAPH_ROUTE_MAX_PER_MIN,
    globalMax: GRAPH_ROUTE_MAX_PER_MIN * 4,
  }),
} = {}) {
  return async function graphRoute(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method not allowed' });
    if (!allow(clientKey(req)))
      return sendJson(
        res,
        429,
        { error: 'Too many Graph requests', retryAfter: 5 },
        { 'Retry-After': '5' },
      );
    const upstream = buildGraphUpstream(req.url);
    if (!upstream) return sendJson(res, 400, { error: 'Graph path refused' });
    const token = mapillaryGraphToken(env);
    if (!token)
      return sendJson(res, 503, { error: 'no_key', keyRequired: true });
    const abandoned = new AbortController();
    res.on?.('close', () => abandoned.abort());
    try {
      const response = await fetchImpl(upstream, {
        headers: {
          Authorization: `OAuth ${token}`,
          Accept: 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.any([
          abandoned.signal,
          AbortSignal.timeout(FETCH_TIMEOUT_MS),
        ]),
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel?.().catch(() => {});
        return sendJson(res, 403, {
          error: 'Mapillary rejected the access token',
          keyRejected: true,
        });
      }
      if (response.status === 429) {
        await response.body?.cancel?.().catch(() => {});
        const retryAfter = Number(response.headers.get('retry-after')) || 60;
        return sendJson(
          res,
          429,
          { error: 'Mapillary is rate-limiting Graph requests', retryAfter },
          { 'Retry-After': String(retryAfter) },
        );
      }
      let text;
      try {
        text = await readResponseTextCapped(response, GRAPH_MAX_BYTES);
      } catch {
        return sendJson(res, 502, { error: 'Mapillary answer was too large' });
      }
      // Never echo the token, even if an upstream error body quotes it.
      if (text.includes(token))
        return sendJson(res, 502, { error: 'Mapillary answer refused' });
      if (res.writableEnded) return undefined;
      // Pass Mapillary's JSON (including its error bodies) straight through.
      return sendJson(res, response.status, text, {
        'Cache-Control': response.ok ? 'private, max-age=60' : 'no-store',
      });
    } catch (error) {
      if (res.writableEnded || abandoned.signal.aborted) return undefined;
      return sendJson(res, 502, {
        error:
          error?.name === 'TimeoutError' ? 'Graph timeout' : 'Graph failed',
      });
    }
  };
}

export const gatedMapillaryGraphRoute = (options) =>
  sameSiteGated(createMapillaryGraphHandler(options));
