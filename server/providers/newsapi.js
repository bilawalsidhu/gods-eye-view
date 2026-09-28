import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { readResponseJsonCapped } from './common/http.js';
import { coalesceProxyRequest } from './common/http.js';

const NEWS_API_URL = 'https://newsapi.org/v2/everything';
const NEWS_CACHE_MS = 5 * 60_000;
const NEWS_MAX_ARTICLES = 8;
const NEWS_CATEGORIES = Object.freeze({
  world:
    'wereld OR buitenland OR internationaal OR Europa OR Azië OR Afrika OR Amerika OR China OR Rusland OR Oekraïne OR "Midden-Oosten" OR klimaat OR technologie',
  politics: 'politiek OR kabinet OR "Tweede Kamer" OR verkiezingen OR regering',
  economy: 'economie OR financieel OR beurs OR bedrijven OR inflatie',
  crises: 'ramp OR crisis OR noodweer OR overstroming OR aardbeving OR brand',
});

function safeArticleUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function normalizeNewsApiArticles(payload, limit = NEWS_MAX_ARTICLES) {
  const rows = Array.isArray(payload?.articles) ? payload.articles : [];
  const articles = [];
  const seen = new Set();
  for (const row of rows) {
    const url = safeArticleUrl(row?.url);
    const title = String(row?.title || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
    if (!url || !title || title === '[Removed]') continue;
    const domain = new URL(url).hostname.replace(/^www\./, '');
    const signature = `${title.toLowerCase()}|${domain}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    const publishedAt = Number.isNaN(Date.parse(row?.publishedAt))
      ? null
      : new Date(row.publishedAt).toISOString();
    articles.push({
      title,
      url,
      domain,
      source: String(row?.source?.name || domain)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80),
      publishedAt,
    });
    if (articles.length >= Math.max(1, Math.min(NEWS_MAX_ARTICLES, limit)))
      break;
  }
  return articles;
}

function providerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function retryAfterSeconds(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(300, Math.max(1, Math.ceil(seconds)));
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp)
    ? Math.min(300, Math.max(1, Math.ceil((timestamp - Date.now()) / 1000)))
    : 60;
}

async function fetchNewsApiArticles(
  category,
  {
    apiKey = process.env.NEWSAPI_API_KEY,
    fetchImpl = globalThis.fetch,
    timeoutMs = 10_000,
  } = {},
) {
  const query = NEWS_CATEGORIES[category];
  if (!query) throw providerError('invalid_category');
  if (!String(apiKey || '').trim()) throw providerError('missing_api_key');

  const params = new URLSearchParams({
    q: query,
    language: 'nl',
    sortBy: 'publishedAt',
    pageSize: String(NEWS_MAX_ARTICLES),
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${NEWS_API_URL}?${params}`, {
      headers: { Accept: 'application/json', 'X-Api-Key': String(apiKey) },
      redirect: 'error',
      signal: controller.signal,
    });
    if (response.status === 429) {
      const error = providerError('rate_limited');
      error.retryAfter = retryAfterSeconds(
        response.headers?.get?.('Retry-After'),
      );
      throw error;
    }
    if (!response.ok) throw providerError('upstream_error');
    const payload = await readResponseJsonCapped(
      response,
      2 * 1024 * 1024,
      controller.signal,
    );
    if (payload?.status !== 'ok') {
      if (payload?.code === 'rateLimited') {
        const error = providerError('rate_limited');
        error.retryAfter = retryAfterSeconds(
          response.headers?.get?.('Retry-After'),
        );
        throw error;
      }
      throw providerError('upstream_error');
    }
    const articles = normalizeNewsApiArticles(payload);
    return {
      status: articles.length ? 'ready' : 'empty',
      category,
      totalResults: Number.isFinite(payload.totalResults)
        ? payload.totalResults
        : articles.length,
      articles,
      source: 'NewsAPI',
    };
  } catch (error) {
    if (error?.code) throw error;
    throw providerError('upstream_error');
  } finally {
    clearTimeout(timeout);
  }
}

function newsApiProxy({
  fetchArticles = fetchNewsApiArticles,
  apiKey = () => process.env.NEWSAPI_API_KEY,
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const rateLimiter = makeRateLimiter({
    windowMs: 60_000,
    max: 20,
    globalMax: 120,
  });

  const respond = (res, status, payload, headers = {}) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(JSON.stringify(payload));
  };

  function install(middlewares) {
    middlewares.use('/api/news', async (req, res) => {
      if (req.method !== 'GET')
        return respond(res, 405, { error: 'Method not allowed' });
      if (!rateLimiter(clientKey(req)))
        return respond(
          res,
          429,
          { error: 'Too many news requests', code: 'rate_limited' },
          { 'Retry-After': '10' },
        );
      const url = new URL(req.url || '', 'http://localhost');
      const category = url.searchParams.get('category') || '';
      if (!Object.hasOwn(NEWS_CATEGORIES, category))
        return respond(res, 400, {
          error: 'Choose world, politics, economy, or crises',
          code: 'invalid_category',
        });
      if (!String(apiKey() || '').trim())
        return respond(res, 503, {
          error: 'NEWSAPI_API_KEY is not configured',
          code: 'missing_api_key',
        });

      const cached = cache.get(category);
      if (cached && Date.now() - cached.cachedAt < NEWS_CACHE_MS)
        return respond(
          res,
          200,
          { ...cached.payload, status: cached.payload.status, cached: true },
          { 'Cache-Control': 'public, max-age=120', 'X-News-Cache': 'HIT' },
        );

      const request = coalesceProxyRequest(inFlight, category, () =>
        fetchArticles(category),
      );
      try {
        const payload = await request.promise;
        cache.set(category, { payload, cachedAt: Date.now() });
        return respond(res, 200, payload, {
          'Cache-Control': 'public, max-age=120',
          'X-News-Cache': request.shared ? 'INFLIGHT' : 'MISS',
        });
      } catch (error) {
        if (error?.code === 'rate_limited')
          return respond(
            res,
            429,
            {
              error: 'NewsAPI request limit reached',
              code: 'rate_limited',
            },
            { 'Retry-After': String(error.retryAfter || 60) },
          );
        if (error?.code === 'missing_api_key')
          return respond(res, 503, {
            error: 'NEWSAPI_API_KEY is not configured',
            code: 'missing_api_key',
          });
        return respond(res, 502, {
          error: 'NewsAPI is temporarily unavailable',
          code: 'upstream_error',
        });
      }
    });
  }

  return {
    name: 'newsapi-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export {
  NEWS_CATEGORIES,
  fetchNewsApiArticles,
  newsApiProxy,
  normalizeNewsApiArticles,
};
