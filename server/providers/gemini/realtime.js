import { waitForSignal } from '../../../src/sources/requestDeadline.js';
import { clientKey, makeCostRateLimiter } from '../common/rate-limit.js';
import { readResponseJsonCapped } from '../../../src/sources/httpBody.js';
import {
  GEMINI_TOKEN_ENDPOINT,
  GEMINI_LIVE_WEBSOCKET_URL,
  GEMINI_LIVE_MODEL_DEFAULT,
  createGeminiLiveConfig,
  normalizeGeminiModel,
} from './config.js';
import {
  isGeminiRequestOriginAllowed,
  readGeminiTokenRequest,
} from './request.js';

const UPSTREAM_RESPONSE_BYTES = 32 * 1024;
const MINT_FAILURE = 'Gemini voice could not connect. Try again.';

export function createGeminiTokenHandler({
  annotationGuidance,
  tools,
  fetchImpl = (...args) => fetch(...args),
  resolveApiKey = () => process.env.GEMINI_API_KEY,
  resolveModel = () =>
    process.env.GEMINI_LIVE_MODEL || GEMINI_LIVE_MODEL_DEFAULT,
  resolveHost = () => process.env.HOST,
  resolveAllowedHosts = () => process.env.GEV_ALLOWED_HOSTS,
  resolveRateLimit = () => process.env.GEV_RATELIMIT_GEMINI_PER_MIN ?? '30',
  now = Date.now,
  timeoutMs = 15_000,
} = {}) {
  let limiter;
  return async (req, res) => {
    if (req.aborted || res.destroyed || res.writableEnded) return;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, errorOrPayload) => {
      if (res.destroyed || res.writableEnded) return;
      res.statusCode = status;
      if (status >= 400) res.setHeader('Connection', 'close');
      res.end(
        JSON.stringify(
          typeof errorOrPayload === 'string'
            ? { error: errorOrPayload }
            : errorOrPayload,
        ),
      );
    };
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return reply(405, 'Method not allowed');
    }
    let apiKey;
    let model;
    try {
      if (
        !isGeminiRequestOriginAllowed(req, resolveHost(), resolveAllowedHosts())
      )
        return reply(403, 'Gemini voice requires a same-origin app request');
      apiKey = String(resolveApiKey() || '').trim();
      if (!apiKey)
        return reply(503, 'Add a Gemini API key in Provider Settings');
      model = normalizeGeminiModel(resolveModel());
      if (!model)
        return reply(503, 'The Gemini Live model configuration is invalid');
      if (limiter === undefined)
        limiter = makeCostRateLimiter(resolveRateLimit(), 30);
      if (limiter && !limiter(clientKey(req))) {
        res.setHeader('Retry-After', '60');
        return reply(
          429,
          'Gemini voice is starting too often. Try again shortly.',
        );
      }
    } catch {
      // Connect does not observe the handler's returned promise. A synchronous
      // configuration resolver must fail with a bounded, fixed response.
      return reply(503, MINT_FAILURE);
    }

    const lifetime = new AbortController();
    let disconnected = false;
    const disconnect = () => {
      disconnected = true;
      lifetime.abort(new DOMException('Request closed', 'AbortError'));
    };
    const responseClosed = () => {
      if (!res.writableEnded) disconnect();
    };
    req.once('aborted', disconnect);
    res.once('close', responseClosed);
    const deadline = setTimeout(() => {
      lifetime.abort(
        new DOMException('Token request timed out', 'TimeoutError'),
      );
    }, timeoutMs);
    deadline.unref?.();
    let acquiredResponse;
    try {
      const inputMode = await readGeminiTokenRequest(req, lifetime.signal);
      lifetime.signal.throwIfAborted();
      const config = createGeminiLiveConfig(
        annotationGuidance,
        inputMode,
        tools,
      );
      const issuedAt = now();
      // REST uses bidiGenerateContentSetup. liveConnectConstraints is the SDK
      // input shape, converted before transport. With no fieldMask the complete
      // setup is locked to this server-owned configuration.
      const request = {
        uses: 1,
        expireTime: new Date(issuedAt + 30 * 60_000).toISOString(),
        newSessionExpireTime: new Date(issuedAt + 60_000).toISOString(),
        bidiGenerateContentSetup: { model: `models/${model}`, ...config },
      };
      const acquisition = Promise.resolve(
        fetchImpl(GEMINI_TOKEN_ENDPOINT, {
          method: 'POST',
          redirect: 'error',
          signal: lifetime.signal,
          headers: {
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        }),
      );
      // A fetch implementation can ignore abort. Bound this caller's wait and
      // discard a response that arrives after timeout/disconnection.
      void acquisition.then(
        (late) => {
          acquiredResponse = late;
          if (lifetime.signal.aborted) void late.body?.cancel().catch(() => {});
        },
        () => {},
      );
      const response = await waitForSignal(acquisition, lifetime.signal);
      lifetime.signal.throwIfAborted();
      if (
        response.redirected ||
        (response.url && response.url !== GEMINI_TOKEN_ENDPOINT)
      ) {
        void response.body?.cancel().catch(() => {});
        throw new Error('Unexpected token response destination');
      }
      if (!response.ok) {
        // Never forward upstream bodies, headers or exception messages.
        void response.body?.cancel().catch(() => {});
        if (response.status === 429) {
          res.setHeader('Retry-After', '60');
          return reply(429, 'Gemini quota is unavailable. Try again later.');
        }
        if (response.status === 401 || response.status === 403)
          return reply(
            503,
            'Gemini access was refused. Check the API key and model access.',
          );
        if (response.status === 400 || response.status === 404)
          return reply(
            502,
            'Gemini Live is unavailable for the configured model.',
          );
        return reply(502, MINT_FAILURE);
      }
      const data = await readResponseJsonCapped(
        response,
        UPSTREAM_RESPONSE_BYTES,
        lifetime.signal,
      );
      lifetime.signal.throwIfAborted();
      if (
        !data ||
        Array.isArray(data) ||
        typeof data !== 'object' ||
        typeof data.name !== 'string' ||
        data.name.length > 8192 ||
        !/^auth_tokens\/[A-Za-z0-9._~+/=-]+$/.test(data.name) ||
        data.name.includes(apiKey)
      )
        throw new Error('Invalid ephemeral token');
      reply(200, {
        token: data.name,
        model,
        config,
        websocketUrl: GEMINI_LIVE_WEBSOCKET_URL,
      });
    } catch (error) {
      if (disconnected || req.aborted) return;
      if (error?.code === 'BODY_TOO_LARGE')
        return reply(413, 'Token request is too large');
      if (error?.code === 'BAD_CONTENT_TYPE')
        return reply(415, 'Use an empty JSON token request');
      if (error?.code === 'BAD_BODY')
        return reply(400, 'Use an empty JSON token request');
      reply(lifetime.signal.aborted ? 504 : 502, MINT_FAILURE);
    } finally {
      // Abort can happen after acquisition resolves but before this handler
      // resumes and passes ownership to the body reader.
      if (lifetime.signal.aborted)
        void acquiredResponse?.body?.cancel().catch(() => {});
      clearTimeout(deadline);
      req.off('aborted', disconnect);
      res.off('close', responseClosed);
    }
  };
}
