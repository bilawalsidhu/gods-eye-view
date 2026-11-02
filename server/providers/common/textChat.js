import { readRequestBody } from './request.js';
import { clientKey, makeCostRateLimiter } from './rate-limit.js';
import { waitForSignal } from '../../../src/sources/requestDeadline.js';
import { readResponseJsonCapped } from '../../../src/sources/httpBody.js';
import { isGeminiRequestOriginAllowed } from '../gemini/request.js';
import { parseUsage } from './textTools.js';

const MAX_BYTES = 512 * 1024;
const FAILURE = 'Could not connect. Try again.';
export function createTextChatHandler({
  provider,
  prepare,
  parse,
  fetchImpl = (...args) => fetch(...args),
  resolveApiKey,
  resolveHost = () => process.env.HOST,
  resolveAllowedHosts = () => process.env.GEV_ALLOWED_HOSTS,
  resolveRateLimit = () =>
    process.env[`GEV_RATELIMIT_${provider.toUpperCase()}_CHAT_PER_MIN`] ?? '60',
  timeoutMs = 60000,
} = {}) {
  let limiter;
  return async (req, res) => {
    if (req.aborted || res.destroyed || res.writableEnded) return;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, value) => {
      if (req.aborted || res.destroyed || res.writableEnded) return;
      res.statusCode = status;
      if (status >= 400) res.setHeader('Connection', 'close');
      res.end(
        JSON.stringify(typeof value === 'string' ? { error: value } : value),
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
      const apiKey = String(resolveApiKey() || '').trim();
      if (!apiKey) return reply(503, 'Add an API key in Provider Settings');
      if (limiter === undefined)
        limiter = makeCostRateLimiter(resolveRateLimit(), 60);
      if (limiter && !limiter(clientKey(req))) {
        res.setHeader('Retry-After', '60');
        return reply(429, FAILURE);
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
        void response.body?.cancel().catch(() => {});
        return reply(
          [429, 503].includes(response.status) ? response.status : 502,
          FAILURE,
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
