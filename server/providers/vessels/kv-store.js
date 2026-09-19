/**
 * server/providers/vessels/kv-store.js — a tiny Redis-over-REST client for
 * the serverless AIS snapshot cache (Vercel KV / Upstash Redis REST API).
 *
 * A Vercel Function instance keeps no state between invocations it can rely
 * on, and AISStream allows ONE WebSocket per API key at a time, so two warm
 * instances collecting the same scene would fight over the key. Sharing the
 * last snapshot through Redis lets every instance answer from the copy the
 * most recent collector wrote. No SDK — two REST calls:
 *
 *   GET  {url}/get/{key}            → { result: "<string>" | null }
 *   POST {url}/set/{key}?EX={ttl}   body = the string value → { result: "OK" }
 *
 * both with `Authorization: Bearer <token>`. Configured by either
 * KV_REST_API_URL + KV_REST_API_TOKEN (Vercel KV) or
 * UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN. Absent both, the store
 * is a no-op (`enabled: false`). Failures never propagate: they are logged
 * ONCE per process and the caller carries on with its in-memory copy.
 */
import { fetchUpstream } from '../common/upstream.js';

const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_TTL_SEC = 120;

/** Resolve the REST endpoint from the environment; null when not configured. */
export function kvConfigFromEnv(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return {
    url: String(url).trim().replace(/\/+$/, ''),
    token: String(token).trim(),
    provider: env.KV_REST_API_URL ? 'vercel-kv' : 'upstash',
  };
}

/**
 * @param {object} [options]
 * @param {{url:string,token:string}|null} [options.config] defaults to kvConfigFromEnv()
 * @param {Function} [options.fetchImpl] defaults to globalThis.fetch at call time
 * @param {string} [options.prefix='ais-serverless:'] key namespace
 * @param {Function} [options.warn]
 * @param {number} [options.timeoutMs]
 */
export function createKvStore({
  config = kvConfigFromEnv(),
  fetchImpl,
  prefix = 'ais-serverless:',
  warn = (message) => console.warn(message),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let warned = false;
  const failOnce = (operation, detail) => {
    if (warned) return;
    warned = true;
    warn(
      `[ais-serverless] shared KV ${operation} failed — continuing with the in-memory snapshot only (${detail})`,
    );
  };
  const request = (path, init = {}) =>
    fetchUpstream(`${config.url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(init.headers || {}),
      },
      timeoutMs,
      retries: 0,
      label: 'KV',
      fetchImpl,
    });

  return {
    enabled: Boolean(config),
    provider: config?.provider || null,

    /** Parsed JSON value stored under `key`, or null when absent/unreadable. */
    async get(key) {
      if (!config) return null;
      try {
        const result = await request(
          `/get/${encodeURIComponent(prefix + key)}`,
        );
        if (!result.ok) {
          failOnce('get', result.error?.message || `HTTP ${result.status}`);
          return null;
        }
        const body = JSON.parse(result.text);
        if (body?.error) {
          failOnce('get', String(body.error));
          return null;
        }
        const raw = body?.result;
        if (raw == null) return null;
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (error) {
        failOnce('get', error?.message || 'unreadable response');
        return null;
      }
    },

    /** Store `value` (JSON) under `key` with an expiry; resolves true on success. */
    async set(key, value, { ttlSec = DEFAULT_TTL_SEC } = {}) {
      if (!config) return false;
      try {
        const ttl = Math.max(1, Math.round(Number(ttlSec) || DEFAULT_TTL_SEC));
        const result = await request(
          `/set/${encodeURIComponent(prefix + key)}?EX=${ttl}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            body: JSON.stringify(value),
          },
        );
        if (!result.ok) {
          failOnce('set', result.error?.message || `HTTP ${result.status}`);
          return false;
        }
        const body = JSON.parse(result.text);
        if (body?.error) {
          failOnce('set', String(body.error));
          return false;
        }
        return true;
      } catch (error) {
        failOnce('set', error?.message || 'unreadable response');
        return false;
      }
    },
  };
}
