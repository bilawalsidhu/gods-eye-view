import {
  normalizeCzibExport,
  parseCzibFeed,
} from '../../src/layers/czib/records.js';
import {
  coalesceProxyRequest,
  readResponseJsonCapped,
  readResponseTextCapped,
} from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// EASA Conflict Zone Information Bulletins (keyless; "reproduction is
// authorised, provided the source is acknowledged"). Two fixed URLs without
// a query string (EASA's robots.txt disallows query URLs): the JSON export
// holds status, countries and dates; the RSS feed holds the bulletin links
// and so the numbers. Bulletins change every few weeks, so an hour's cache
// keeps the proxy to a handful of requests a day.
export const CZIB_EXPORT_URL =
  'https://www.easa.europa.eu/en/domains/air-operations/czibs/export-json';
export const CZIB_FEED_URL =
  'https://www.easa.europa.eu/en/domains/air-operations/czibs/feed.xml';
const MINUTE = 60_000;
export const CZIB_TTL_MS = 60 * MINUTE;
/** Cooldown after a 429 when upstream sends no usable Retry-After. */
const COOLDOWN_MS = 5 * MINUTE;
/** Bounds for an upstream-supplied Retry-After. */
const COOLDOWN_MIN_MS = 30_000;
const COOLDOWN_MAX_MS = 60 * MINUTE;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/** Cooldown (ms) an upstream 429 earns, honouring Retry-After when sane. */
export function czibRetryCooldownMs(raw, nowMs) {
  const clamp = (ms) =>
    Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, ms));
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) return clamp(seconds * 1000);
    const at = Date.parse(raw);
    if (Number.isFinite(at) && at > nowMs) return clamp(at - nowMs);
  }
  return COOLDOWN_MS;
}

/** Fixed-origin, bounded EASA CZIB route for dev and preview. */
export function czibProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });
  let cached = null;
  let cooldownUntil = 0;

  async function get(url, accept, signal) {
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: { Accept: accept, 'User-Agent': 'gods-eye-view-czib/1.0' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) {
        cooldownUntil =
          now() +
          czibRetryCooldownMs(response.headers.get('retry-after'), now());
        throw Object.assign(new Error('upstream_rate_limited'), {
          status: 429,
        });
      }
      throw new Error('upstream_unavailable');
    }
    return response;
  }

  /** The RSS links, or null: the bulletins still stand without numbers. */
  async function loadLinks(signal) {
    try {
      const response = await get(
        CZIB_FEED_URL,
        'application/rss+xml, application/xml',
        signal,
      );
      return parseCzibFeed(
        await readResponseTextCapped(response, MAX_RESPONSE_BYTES, signal),
      );
    } catch (error) {
      if (error?.status === 429) throw error;
      return null;
    }
  }

  async function load() {
    if (now() < cooldownUntil)
      throw Object.assign(new Error('cooling_down'), { status: 429 });
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const [exported, links] = await Promise.all([
      get(CZIB_EXPORT_URL, 'application/json', signal).then((response) =>
        readResponseJsonCapped(response, MAX_RESPONSE_BYTES, signal),
      ),
      loadLinks(signal),
    ]);
    const bulletins = normalizeCzibExport(exported, links || new Map());
    if (!bulletins) throw new Error('invalid_export');
    return { fetchedAt: now(), bulletins, linksMissing: links === null };
  }

  async function acquire() {
    const previous = cached;
    if (previous && now() - previous.fetchedAt < CZIB_TTL_MS)
      return { value: previous, stale: false };
    try {
      const { promise } = coalesceProxyRequest(inFlight, 'czib', async () => {
        const value = await load();
        cached = value;
        return value;
      });
      return { value: await promise, stale: false };
    } catch (error) {
      if (previous) return { value: previous, stale: true };
      throw error;
    }
  }

  async function handler(req, res) {
    const json = (status, value, stale = false, retryAfterS = 60) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': String(retryAfterS) } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const { value, stale } = await acquire();
      json(
        200,
        {
          fetchedAt: value.fetchedAt,
          bulletins: value.bulletins,
          ...(value.linksMissing ? { linksMissing: true } : {}),
          ...(stale ? { stale: true } : {}),
        },
        stale,
      );
    } catch (error) {
      if (error?.status === 429) {
        // Tell the browser how long the upstream cooldown has left.
        const retryAfterS = Math.max(
          1,
          Math.ceil((cooldownUntil - now()) / 1000),
        );
        return json(429, { error: 'czib_rate_limited' }, false, retryAfterS);
      }
      json(502, { error: 'czib_unavailable' });
    }
  }

  return {
    name: 'czib',
    configureServer({ middlewares }) {
      middlewares.use('/api/czib', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/czib', handler);
    },
  };
}
