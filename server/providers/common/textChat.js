import { readRequestBody } from './request.js';
import {
  clientKey,
  makeCostRateLimiter,
  resolvePerMinuteCap,
} from './rate-limit.js';
import { waitForSignal } from '../../../src/sources/requestDeadline.js';
import { readResponseJsonCapped } from '../../../src/sources/httpBody.js';
import { isGeminiRequestOriginAllowed } from '../gemini/request.js';
import { parseUsage } from './textTools.js';

const MAX_BYTES = 512 * 1024;
const FAILURE = 'Could not connect. Try again.';
// A rejected key is not retried upstream for this long, unless the key changes.
const REJECTED_KEY_COOLDOWN_MS = 60_000;

// What an upstream failure says about the key or the account. Gemini answers
// an invalid key with 400 and an ErrorInfo reason, not 401; OpenAI answers an
// account without credit with 429 insufficient_quota, which waiting won't fix.
// A 403 is the key's project, region or permissions, so it cools down too but
// does not blame the key. Only small error bodies are read.
async function upstreamRefusal(response, signal) {
  const { status } = response;
  if (status === 401) return 'API_KEY_REJECTED';
  if (status === 403) return 'ACCESS_DENIED';
  if (![400, 429].includes(status)) return null;
  let error;
  try {
    error = (await readResponseJsonCapped(response, 16 * 1024, signal))?.error;
  } catch {
    return null;
  }
  if (
    status === 400 &&
    Array.isArray(error?.details) &&
    error.details.some((detail) => detail?.reason === 'API_KEY_INVALID')
  )
    return 'API_KEY_REJECTED';
  if (status === 429 && error?.code === 'insufficient_quota')
    return 'QUOTA_EXCEEDED';
  return null;
}

// Pass through only a delay in whole seconds, capped at an hour.
function upstreamRetryAfter(response) {
  const value = String(response.headers?.get?.('retry-after') ?? '').trim();
  if (!/^\d{1,6}$/.test(value)) return null;
  return String(Math.min(Math.max(Number(value), 1), 3600));
}

export function createTextChatHandler({
  provider,
  prepare,
  parse,
  fetchImpl = (...args) => fetch(...args),
  resolveApiKey,
  resolveHost = () => process.env.HOST,
  resolveAllowedHosts = () => process.env.GEV_ALLOWED_HOSTS,
  resolveRateLimit = () =>
    process.env[`GEV_RATELIMIT_${provider.toUpperCase()}_CHAT_PER_MIN`],
  // An unset chat throttle follows the provider's own cost throttle.
  resolveProviderRateLimit = () => undefined,
  providerPerMin = 30,
  // Returns { error, code } when the route must refuse before any key is used.
  refuse = () => null,
  now = Date.now,
  timeoutMs = 60000,
} = {}) {
  let limiter;
  let rejected = null;
  return async (req, res) => {
    if (req.aborted || res.destroyed || res.writableEnded) return;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, value, code) => {
      if (req.aborted || res.destroyed || res.writableEnded) return;
      res.statusCode = status;
      if (status >= 400) res.setHeader('Connection', 'close');
      res.end(
        JSON.stringify(
          typeof value === 'string'
            ? { error: value, ...(code ? { code } : {}) }
            : value,
        ),
      );
    };
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return reply(405, 'Method not allowed');
    }
    const lifetime = new AbortController();
    const disconnect = () => {
      if (!res.writableEnded) lifetime.abort();
    };
    req.once('aborted', disconnect);
    res.once('close', disconnect);
    const timer = setTimeout(() => lifetime.abort(), timeoutMs);
    timer.unref?.();
    let response;
    let usage = null;
    try {
      if (
        !isGeminiRequestOriginAllowed(req, resolveHost(), resolveAllowedHosts())
      )
        return reply(403, FAILURE);
      const refusal = refuse();
      if (refusal) return reply(503, refusal.error, refusal.code);
      const apiKey = String(resolveApiKey() || '').trim();
      if (!apiKey)
        return reply(
          503,
          'Add an API key in Provider Settings',
          'API_KEY_MISSING',
        );
      if (rejected && (rejected.key !== apiKey || now() >= rejected.until))
        rejected = null;
      if (rejected) {
        res.setHeader(
          'Retry-After',
          String(Math.max(1, Math.ceil((rejected.until - now()) / 1000))),
        );
        return reply(502, FAILURE, rejected.code);
      }
      if (limiter === undefined)
        limiter = makeCostRateLimiter(
          resolveRateLimit(),
          resolvePerMinuteCap(resolveProviderRateLimit(), providerPerMin),
        );
      if (limiter && !limiter(clientKey(req))) {
        res.setHeader('Retry-After', '60');
        return reply(429, FAILURE, 'RATE_LIMITED');
      }
      if (
        !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')
      )
        return reply(415, FAILURE);
      if (Number(req.headers['content-length']) > MAX_BYTES)
        return reply(413, FAILURE);
      const raw = await readRequestBody(req, MAX_BYTES, lifetime.signal);
      let input;
      try {
        input = JSON.parse(raw);
      } catch {
        return reply(400, FAILURE);
      }
      const prepared = prepare(input);
      if (!prepared) return reply(400, FAILURE);
      if (prepared.errorStatus) return reply(prepared.errorStatus, FAILURE);
      const { endpoint, body, headers } = prepared;
      lifetime.signal.throwIfAborted();
      const acquisition = Promise.resolve(
        fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: lifetime.signal,
          headers: { 'Content-Type': 'application/json', ...headers(apiKey) },
          body: JSON.stringify(body),
        }),
      );
      void acquisition.then(
        (late) => {
          response = late;
          if (lifetime.signal.aborted) void late.body?.cancel().catch(() => {});
        },
        () => {},
      );
      response = await waitForSignal(acquisition, lifetime.signal);
      lifetime.signal.throwIfAborted();
      if (response.redirected || (response.url && response.url !== endpoint))
        throw new Error('Unexpected destination');
      if (!response.ok) {
        const refusal = await upstreamRefusal(response, lifetime.signal);
        if (refusal) {
          void response.body?.cancel().catch(() => {});
          rejected = {
            key: apiKey,
            code: refusal,
            until: now() + REJECTED_KEY_COOLDOWN_MS,
          };
          return reply(502, FAILURE, refusal);
        }
        void response.body?.cancel().catch(() => {});
        if (![429, 503].includes(response.status)) return reply(502, FAILURE);
        const retryAfter = upstreamRetryAfter(response);
        if (retryAfter) res.setHeader('Retry-After', retryAfter);
        return reply(
          response.status,
          FAILURE,
          response.status === 429 ? 'RATE_LIMITED' : undefined,
        );
      }
      const data = await readResponseJsonCapped(
        response,
        MAX_BYTES,
        lifetime.signal,
      );
      lifetime.signal.throwIfAborted();
      usage = parseUsage(provider, data);
      const result = parse(data);
      if (!result || JSON.stringify(result).includes(apiKey))
        return reply(502, { error: FAILURE, usage });
      reply(200, { ...result, usage });
    } catch (error) {
      reply(
        error?.code === 'BODY_TOO_LARGE'
          ? 413
          : lifetime.signal.aborted
            ? 504
            : 502,
        { error: FAILURE, usage },
      );
    } finally {
      if (lifetime.signal.aborted)
        void response?.body?.cancel().catch(() => {});
      clearTimeout(timer);
      req.off('aborted', disconnect);
      res.off('close', disconnect);
    }
  };
}
