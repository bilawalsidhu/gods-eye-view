import { newsQueryAllowed } from '../../src/layers/news/source.js';
import { readResponseTextCapped } from './common/http.js';

// News (/api/news/*): Core serves no news of its own. With GEV_NEWS_ORIGIN
// set (a news server such as https://news.example), this forwards exactly
// the GET requests the news layer sends there and relays the JSON; without
// it, every route answers "not configured" and the layer shows itself
// unavailable without retrying.

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

/**
 * A thin, validated GET proxy for the news layer's three read routes.
 * @param {{origin?: () => string|null, fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 */
export function newsProxy({
  origin = () => newsOrigin(),
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = TIMEOUT_MS,
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
    if (!base)
      return json(res, 503, {
        error: 'news_not_configured',
        unavailable: true,
        retryable: false,
      });
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
