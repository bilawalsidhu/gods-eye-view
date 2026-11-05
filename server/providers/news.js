import { newsQueryAllowed } from '../../src/layers/news/source.js';
import { readResponseTextCapped } from './common/http.js';
import { createKeyedNews } from './news/keyed.js';

// News (/api/news/*). With GEV_NEWS_ORIGIN set (a news server such as
// https://news.example), this forwards exactly the GET requests the news
// layer sends there and relays the JSON. Without it (or with a value that
// is no plain origin, warned of once), Core answers the same routes itself
// (news/keyed.js): Conflicts from GDELT's event exports with no key, and
// Liveuamap's items beside them with LIVEUAMAP_API_KEY; Local from World
// News API, "key required" while WORLDNEWSAPI_KEY is unset.

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

/**
 * A thin, validated GET proxy for the news layer's three read routes, or
 * their keyed answers without a news server.
 * @param {{env?: () => object, log?: (message: string) => void, origin?: () => string|null, fetchImpl?: typeof fetch, timeoutMs?: number, keyed?: {answer: (path: string, params: URLSearchParams) => Promise<{status: number, body: object}>}}} [options]
 */
export function newsProxy({
  env = () => process.env,
  log = (message) => console.warn(message),
  origin = configuredOrigin(env, log),
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = TIMEOUT_MS,
  keyed = createKeyedNews({ env, fetchImpl, log }),
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
    const local = new URL(req.url || '/', 'http://local');
    const target = new URL(
      `/api/news${local.pathname}${local.search}`,
      'http://local',
    );
    if (!newsQueryAllowed(target))
      return json(res, 400, { error: 'invalid_news_request' });
    const base = origin();
    if (!base) {
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

  return {
    name: 'news',
    configureServer({ middlewares }) {
      middlewares.use('/api/news', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/news', handler);
    },
  };
}
