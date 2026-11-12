import { sameSiteGatedBehindProxy } from '../common/same-site.js';
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
 * Bing it carries the Bing Maps key ion supplies (CesiumJS hands the
 * document's options, key included, to its Bing imagery provider) and for
 * Google 3D the provider's options (its URL). The configured token never
 * leaves the process (a response containing it is refused).
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
/**
 * ...and for at most this long. After ion rejects an asset token CesiumJS asks
 * for the endpoint again with the very request it made first (once per
 * asset), so a document handed out longer ago than this is fetched anew
 * rather than returned a second time. So while ion answers, that is at most
 * one ion call per allow-listed asset per interval, however many clients ask;
 * while it does not, see TRANSIENT_BACKOFF_S.
 */
const REFETCH_AFTER_MS = 60 * 1000;
/** Endpoint documents without a token expiry (external assets) are kept this long. */
const NO_EXPIRY_TTL_MS = 30 * 60 * 1000;
/**
 * After ion fails for a passing reason (no answer, a timeout, 429, 5xx) it is
 * left alone this long, or for the Retry-After it names, at most a minute.
 */
const TRANSIENT_BACKOFF_S = 10;
const MAX_BACKOFF_S = 60;
export const ION_ROUTE_MAX_PER_MIN = 300;

/** Seconds to leave ion alone: its Retry-After when it is a number of seconds, else the default. */
function retryAfterSeconds(response) {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(Math.ceil(seconds), MAX_BACKOFF_S)
    : TRANSIENT_BACKOFF_S;
}

/** Marks an error as ion's passing trouble, with the seconds to wait. */
const transient = (retryAfter = TRANSIENT_BACKOFF_S) => ({
  transient: true,
  retryAfter,
});

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
  /** @type {Map<string, {until: number, status: number, message: string}>} */
  const backoff = new Map();

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
      throw new IonEndpointError(
        429,
        'Cesium ion is rate-limiting requests',
        transient(retryAfterSeconds(response)),
      );
    }
    if (response.status === 404) {
      await response.body?.cancel?.().catch(() => {});
      throw new IonEndpointError(404, 'Unknown ion asset');
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      // A server error or a timeout is ion's trouble and passes; any other
      // refusal is about this request and does not.
      throw new IonEndpointError(
        502,
        `Cesium ion HTTP ${response.status}`,
        response.status >= 500 || response.status === 408
          ? transient(retryAfterSeconds(response))
          : {},
      );
    }
    let text;
    try {
      text = await readResponseTextCapped(response, ENDPOINT_MAX_BYTES);
    } catch {
      throw new IonEndpointError(
        502,
        'Cesium ion answer was too large',
        transient(),
      );
    }
    let document;
    try {
      document = JSON.parse(text);
    } catch {
      throw new IonEndpointError(
        502,
        'Cesium ion answer was not JSON',
        transient(),
      );
    }
    // The long-lived token must never be echoed to a browser.
    if (text.includes(token))
      throw new IonEndpointError(502, 'Cesium ion answer refused', transient());
    const expiry = jwtExpiryMs(document?.accessToken);
    cache.set(assetId, {
      text,
      fetchedAt: now(),
      validUntil: expiry ?? now() + NO_EXPIRY_TTL_MS,
      hasExpiry: expiry !== null,
    });
    return text;
  }

  /** Whether a held document may be handed out now (its token has life left). */
  const usable = (hit, at) =>
    hit.validUntil - at > (hit.hasExpiry ? MIN_REMAINING_MS : 0);

  /**
   * What can be answered without calling ion: `{text}` for a document held in
   * memory, `{error}` for an answer already known, `{pending}` for a call to
   * ion that is already under way (a request joins it), or null when answering
   * needs a new call to ion.
   */
  function peek(assetId) {
    if (!ionToken(env))
      return {
        error: new IonEndpointError(503, 'no_key', { keyRequired: true }),
      };
    const at = now();
    const hit = cache.get(assetId);
    if (hit && usable(hit, at) && at - hit.fetchedAt < REFETCH_AFTER_MS)
      return { text: hit.text };
    // Ion failed a moment ago: do not ask again yet. Serve the document
    // while its token is good, else the failure.
    const failed = backoff.get(assetId);
    if (failed && at < failed.until) {
      if (hit && usable(hit, at)) return { text: hit.text };
      return {
        error: new IonEndpointError(failed.status, failed.message, {
          retryAfter: Math.max(1, Math.ceil((failed.until - at) / 1000)),
        }),
      };
    }
    const pending = inflight.get(assetId);
    return pending ? { pending } : null;
  }

  /**
   * Call ion for a new document. When ion has a passing failure and a held
   * document still has a good token, that document is the answer; a refusal
   * (token rejected, asset not available) removes the held document.
   */
  async function refresh(assetId, token) {
    try {
      const text = await load(assetId, token);
      backoff.delete(assetId);
      return text;
    } catch (cause) {
      const error =
        cause instanceof IonEndpointError
          ? cause
          : new IonEndpointError(502, 'Cesium ion request failed', transient());
      if (!error.transient) {
        cache.delete(assetId);
        throw error;
      }
      backoff.set(assetId, {
        until: now() + error.retryAfter * 1000,
        status: error.status,
        message: error.message,
      });
      const hit = cache.get(assetId);
      if (hit && usable(hit, now())) return hit.text;
      throw error;
    }
  }

  async function fetchEndpoint(assetId) {
    const memory = peek(assetId);
    if (memory?.error) throw memory.error;
    if (memory?.text !== undefined) return memory.text;
    if (memory?.pending) return memory.pending;
    const pending = refresh(assetId, ionToken(env)).finally(() =>
      inflight.delete(assetId),
    );
    inflight.set(assetId, pending);
    return pending;
  }
  fetchEndpoint.peek = peek;
  return fetchEndpoint;
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
    // The limit protects ion. An answer the fetcher already holds costs ion
    // nothing and does not count; only a request that would call ion does.
    const memory = fetchEndpoint.peek?.(match[1]);
    if (!memory && !allow(clientKey(req))) {
      return sendJson(
        res,
        429,
        { error: 'Too many ion requests', retryAfter: 5 },
        { 'Retry-After': '5' },
      );
    }
    try {
      if (memory?.error) throw memory.error;
      return sendJson(
        res,
        200,
        memory?.text ?? (await (memory?.pending ?? fetchEndpoint(match[1]))),
      );
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

/**
 * The route behind the proxy-tolerant gate: ion has to answer for terrain and
 * imagery to render, also when the app is served through a reverse proxy
 * (which adds the forwarding headers the full gate refuses). What it hands
 * out is ion's short-lived, single-asset endpoint document for an allow-listed
 * asset, never the account token; cross-site browser requests are still
 * refused.
 */
export const gatedIonRoute = (options) =>
  sameSiteGatedBehindProxy(createIonRouteHandler(options));
