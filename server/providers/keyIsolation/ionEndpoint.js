import { sameSiteGated } from '../common/same-site.js';
import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { readResponseTextCapped } from '../common/http.js';

/**
 * Cesium ion without the long-lived token in the browser.
 *
 * CesiumJS asks `{server}v1/assets/{id}/endpoint` for each ion asset and then
 * uses the answer (tile URL + a short-lived, per-asset access token). This
 * route answers that exact request shape from the server: it calls the real
 * ion API with CESIUM_ION_TOKEN and returns only ion's endpoint document. For
 * terrain that document carries a one-hour JWT limited to the one asset; for
 * Bing and Google 3D it carries Cesium's own provider URL/key. The configured
 * token never leaves the process (a response containing it is refused).
 */

export const ION_API_ORIGIN = 'https://api.cesium.com';
/** Assets the app uses: World Terrain, Bing aerial/labels/road, Google 3D Tiles. */
export const ION_ALLOWED_ASSETS = Object.freeze(
  new Set(['1', '2', '3', '4', '2275207']),
);
const ENDPOINT_MAX_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
/** Serve a cached endpoint only while its token has at least this long left. */
const MIN_REMAINING_MS = 10 * 60 * 1000;
/** Endpoint documents without a token expiry (external assets) are kept this long. */
const NO_EXPIRY_TTL_MS = 30 * 60 * 1000;
export const ION_ROUTE_MAX_PER_MIN = 300;

export function ionToken(env = process.env) {
  return String(env.CESIUM_ION_TOKEN || '').trim();
}

/** `exp` (ms) from a JWT, or null when the string is not one. */
export function jwtExpiryMs(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    );
    return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export class IonEndpointError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'IonEndpointError';
    this.status = status;
    Object.assign(this, extra);
  }
}

/**
 * @param {{fetchImpl?: Function, now?: () => number, env?: object}} [options]
 * @returns {(assetId: string, signal?: AbortSignal) => Promise<string>} JSON text
 */
export function createIonEndpointFetcher({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  env = process.env,
} = {}) {
  /** @type {Map<string, {text: string, validUntil: number}>} */
  const cache = new Map();
  /** @type {Map<string, Promise<string>>} */
  const inflight = new Map();

  async function load(assetId, token) {
    const response = await fetchImpl(
      `${ION_API_ORIGIN}/v1/assets/${assetId}/endpoint`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'X-Cesium-Client': 'GEV-server',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel?.().catch(() => {});
      throw new IonEndpointError(403, 'Cesium ion rejected the access token', {
        keyRejected: true,
      });
    }
    if (response.status === 429) {
      await response.body?.cancel?.().catch(() => {});
      throw new IonEndpointError(429, 'Cesium ion is rate-limiting requests', {
        retryAfter: Number(response.headers.get('retry-after')) || 60,
      });
    }
    if (response.status === 404) {
      await response.body?.cancel?.().catch(() => {});
      throw new IonEndpointError(404, 'Unknown ion asset');
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new IonEndpointError(502, `Cesium ion HTTP ${response.status}`);
    }
    let text;
    try {
      text = await readResponseTextCapped(response, ENDPOINT_MAX_BYTES);
    } catch {
      throw new IonEndpointError(502, 'Cesium ion answer was too large');
    }
    let document;
    try {
      document = JSON.parse(text);
    } catch {
      throw new IonEndpointError(502, 'Cesium ion answer was not JSON');
    }
    // The long-lived token must never be echoed to a browser.
    if (text.includes(token))
      throw new IonEndpointError(502, 'Cesium ion answer refused');
    const expiry = jwtExpiryMs(document?.accessToken);
    cache.set(assetId, {
      text,
      validUntil: expiry ?? now() + NO_EXPIRY_TTL_MS,
      hasExpiry: expiry !== null,
    });
    return text;
  }

  return async function fetchEndpoint(assetId) {
    const token = ionToken(env);
    if (!token)
      throw new IonEndpointError(503, 'no_key', { keyRequired: true });
    const hit = cache.get(assetId);
    if (hit && hit.validUntil - now() > (hit.hasExpiry ? MIN_REMAINING_MS : 0))
      return hit.text;
    if (!inflight.has(assetId)) {
      const pending = load(assetId, token).finally(() =>
        inflight.delete(assetId),
      );
      inflight.set(assetId, pending);
    }
    return inflight.get(assetId);
  };
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(extraHeaders))
    res.setHeader(name, value);
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

/**
 * Handler mounted at `/api/ion`: GET /status and GET /v1/assets/{id}/endpoint.
 * Any client-supplied access_token or Authorization header is ignored.
 */
export function createIonRouteHandler({
  fetchEndpoint = createIonEndpointFetcher(),
  env = process.env,
  allow = makeRateLimiter({
    windowMs: 60_000,
    max: ION_ROUTE_MAX_PER_MIN,
    globalMax: ION_ROUTE_MAX_PER_MIN * 4,
  }),
} = {}) {
  return async function ionRoute(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method not allowed' });
    const path = (req.url || '').split('?')[0];
    if (path === '/status')
      return sendJson(res, 200, { configured: Boolean(ionToken(env)) });
    const match = /^\/v1\/assets\/(\d{1,9})\/endpoint$/.exec(path);
    if (!match || !ION_ALLOWED_ASSETS.has(match[1]))
      return sendJson(res, 404, { error: 'Unknown ion route' });
    if (!allow(clientKey(req))) {
      return sendJson(
        res,
        429,
        { error: 'Too many ion requests', retryAfter: 5 },
        { 'Retry-After': '5' },
      );
    }
    try {
      return sendJson(res, 200, await fetchEndpoint(match[1]));
    } catch (error) {
      if (error instanceof IonEndpointError) {
        const headers = error.retryAfter
          ? { 'Retry-After': String(error.retryAfter) }
          : {};
        return sendJson(
          res,
          error.status,
          {
            error: error.message,
            ...(error.keyRequired ? { keyRequired: true } : {}),
            ...(error.keyRejected ? { keyRejected: true } : {}),
          },
          headers,
        );
      }
      return sendJson(res, 502, { error: 'Cesium ion request failed' });
    }
  };
}

export const gatedIonRoute = (options) =>
  sameSiteGated(createIonRouteHandler(options));
