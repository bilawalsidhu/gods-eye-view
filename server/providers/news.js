import { newsQueryAllowed } from '../../src/layers/news/source.js';
import { readResponseTextCapped } from './common/http.js';
import { sameSiteGated } from './common/same-site.js';
import { createKeyedNews } from './news/keyed.js';

// News (/api/news/*). With GEV_NEWS_ORIGIN set (a news server such as
// https://news.example), this forwards exactly the GET requests the news
// layer sends there and relays the JSON. Without it (or with a value that
// is no plain origin, warned of once), Core answers the same routes itself
// (news/keyed.js): Conflicts from GDELT's event exports with no key, and
// Liveuamap's items beside them with LIVEUAMAP_API_KEY; Local from World
// News API, "key required" while WORLDNEWSAPI_KEY is unset. A host that
// serves news only from its own server mounts it with `builtIn: false`.

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * The configured news server's origin, or null: http(s) only, no
 * credentials, query or fragment; a path is ignored.
 * @param {string|undefined} raw
 */
export function newsOrigin(raw = process.env.GEV_NEWS_ORIGIN) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Text for the log: no address (a key may ride in one), one short line. */
const logText = (error) =>
  `${error?.name || 'Error'}: ${String(error?.message ?? '')}`
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, '<url>')
    .replace(/\s+/g, ' ')
    .slice(0, 200);

/** GEV_NEWS_ORIGIN as newsOrigin reads it; a value it refuses is warned of once. */
function configuredOrigin(env, log) {
  let warned = null;
  return () => {
    const raw = String(env().GEV_NEWS_ORIGIN ?? '').trim();
    const base = newsOrigin(raw);
    if (!base && raw && warned !== raw) {
      warned = raw;
      // Not the value: it may carry credentials.
      log(
        '[news] GEV_NEWS_ORIGIN is not a plain http(s) origin; answering with the built-in news backend',
      );
    }
    return base;
  };
}

/** A 503's known key or configuration state, rebuilt from its fields; else null. */
async function upstreamState(upstream) {
  let body = null;
  try {
    body = JSON.parse(await readResponseTextCapped(upstream, 16 * 1024));
  } catch {
    return null;
  }
  if (body?.error === 'news_not_configured')
    return { error: body.error, unavailable: true, retryable: false };
  if (
    ['no_key', 'key_rejected', 'key_quota'].includes(body?.error) &&
    typeof body.key === 'string' &&
    /^[a-z][a-z0-9-]{0,31}$/.test(body.key)
  )
    return { error: body.error, key: body.key };
  return null;
}

/**
 * A thin, validated GET proxy for the news layer's three read routes, or
 * their keyed answers without a news server. A host that serves news only
 * from its own server passes `builtIn: false`: without GEV_NEWS_ORIGIN the
 * routes then answer "not configured" and Core reads nothing itself.
 * @param {{env?: () => object, log?: (message: string) => void, origin?: () => string|null, fetchImpl?: typeof fetch, timeoutMs?: number, builtIn?: boolean, keyed?: {answer: (path: string, params: URLSearchParams) => Promise<{status: number, body: object}>}|null}} [options]
 */
export function newsProxy({
  env = () => process.env,
  log = (message) => console.warn(message),
  origin = configuredOrigin(env, log),
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = TIMEOUT_MS,
  builtIn = true,
  keyed = builtIn ? createKeyedNews({ env, fetchImpl, log }) : null,
} = {}) {
  const json = (res, status, value) => {
    if (res.destroyed) return;
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(status === 405 ? { Allow: 'GET' } : {}),
    });
    res.end(typeof value === 'string' ? value : JSON.stringify(value));
  };

  async function handler(req, res) {
    if (req.method !== 'GET')
      return json(res, 405, { error: 'method_not_allowed' });
    let local, target;
    try {
      // `//[` and the like are no URL: a 400, not an unhandled rejection.
      local = new URL(req.url || '/', 'http://local');
      target = new URL(
        `/api/news${local.pathname}${local.search}`,
        'http://local',
      );
    } catch {
      return json(res, 400, { error: 'invalid_news_request' });
    }
    if (!newsQueryAllowed(target))
      return json(res, 400, { error: 'invalid_news_request' });
    const base = origin();
    if (!base) {
      if (!keyed)
        return json(res, 503, {
          error: 'news_not_configured',
          unavailable: true,
          retryable: false,
        });
      try {
        const { status, body } = await keyed.answer(
          local.pathname,
          target.searchParams,
        );
        return json(res, status, body);
      } catch (error) {
        log(`[news] built-in news answer failed: ${logText(error)}`);
        return json(res, 502, { error: 'news_unavailable' });
      }
    }
    try {
      const upstream = await fetchImpl(
        new URL(`${target.pathname}${target.search}`, base),
        {
          headers: { Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (upstream.status === 503) {
        // The news server's own key and configuration states reach the
        // panel as they are, so it can say which key is missing.
        const state = await upstreamState(upstream);
        if (state) return json(res, 503, state);
      }
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        return json(res, 502, {
          error: 'news_upstream_error',
          status: upstream.status,
        });
      }
      const text = await readResponseTextCapped(upstream, MAX_BYTES);
      // Relayed only as JSON; the browser validates every record.
      JSON.parse(text);
      return json(res, 200, text);
    } catch (error) {
      return json(res, error?.name === 'TimeoutError' ? 504 : 502, {
        error: 'news_unavailable',
      });
    }
  }

  // The routes spend keys and upstream reads: no other site's page, and no
  // proxied request, may drive them (SECURITY.md, cross-site gate).
  const gated = sameSiteGated(handler);
  return {
    name: 'news',
    configureServer({ middlewares }) {
      middlewares.use('/api/news', gated);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/news', gated);
    },
  };
}
