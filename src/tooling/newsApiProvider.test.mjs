import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchNewsApiArticles,
  newsApiProxy,
  normalizeNewsApiArticles,
} from '../../server/providers/newsapi.js';

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return async (url = '/', method = 'GET') => {
    const response = {
      statusCode: 200,
      headers: {},
      writeHead(status, headers = {}) {
        this.statusCode = status;
        this.headers = headers;
      },
      end(body) {
        this.body = body;
      },
    };
    await routes.get('/api/news')({ url, method }, response);
    return response;
  };
}

test('NewsAPI requests use encoded Dutch queries and keep the key in a server header', async () => {
  let requested;
  const secret = 'fixture-newsapi-key';
  const result = await fetchNewsApiArticles('politics', {
    apiKey: secret,
    fetchImpl: async (url, options) => {
      requested = { url: String(url), options };
      return Response.json({
        status: 'ok',
        totalResults: 1,
        articles: [
          {
            title: 'Kabinet maakt bekend',
            url: 'https://news.example/story',
            source: { name: 'Nieuwsbron' },
            publishedAt: '2026-09-27T19:00:00Z',
          },
        ],
      });
    },
  });
  const url = new URL(requested.url);
  assert.equal(url.origin, 'https://newsapi.org');
  assert.equal(url.pathname, '/v2/everything');
  assert.equal(
    url.searchParams.get('q'),
    'politiek OR kabinet OR "Tweede Kamer" OR verkiezingen OR regering',
  );
  assert.equal(url.searchParams.get('language'), 'nl');
  assert.equal(url.searchParams.get('sortBy'), 'publishedAt');
  assert.equal(url.searchParams.get('pageSize'), '8');
  assert.ok(requested.url.includes('%22Tweede+Kamer%22'));
  assert.equal(requested.options.headers['X-Api-Key'], secret);
  assert.equal(url.searchParams.has('apiKey'), false);
  assert.equal(requested.url.includes(secret), false);
  assert.equal(result.status, 'ready');
  assert.equal(result.articles[0].domain, 'news.example');
});

test('world news searches worldwide without a country restriction and remains Dutch-language', async () => {
  let requestedUrl;
  const result = await fetchNewsApiArticles('world', {
    apiKey: 'fixture-world-key',
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return Response.json({
        status: 'ok',
        totalResults: 0,
        articles: [],
      });
    },
  });
  assert.equal(requestedUrl.searchParams.get('language'), 'nl');
  assert.equal(requestedUrl.searchParams.has('country'), false);
  assert.match(requestedUrl.searchParams.get('q'), /wereld/);
  assert.match(requestedUrl.searchParams.get('q'), /Oekraïne/);
  assert.equal(result.status, 'empty');
});

test('NewsAPI article normalization rejects unsafe or removed stories and deduplicates', () => {
  assert.deepEqual(
    normalizeNewsApiArticles({
      articles: [
        {
          title: 'Dutch update',
          url: 'https://news.example/one',
          publishedAt: '2026-09-27T19:00:00Z',
        },
        {
          title: 'Dutch   update',
          url: 'https://news.example/two',
        },
        { title: 'Unsafe', url: 'javascript:alert(1)' },
        { title: '[Removed]', url: 'https://other.example/removed' },
      ],
    }),
    [
      {
        title: 'Dutch update',
        url: 'https://news.example/one',
        domain: 'news.example',
        source: 'news.example',
        publishedAt: '2026-09-27T19:00:00.000Z',
      },
    ],
  );
});

test('NewsAPI upstream rate limits carry only a bounded retry delay', async () => {
  await assert.rejects(
    fetchNewsApiArticles('crises', {
      apiKey: 'fixture-secret',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ status: 'error', code: 'rateLimited' }),
          { status: 429, headers: { 'Retry-After': '45' } },
        ),
    }),
    (error) => {
      assert.equal(error.code, 'rate_limited');
      assert.equal(error.retryAfter, 45);
      assert.equal(error.message, 'rate_limited');
      return true;
    },
  );
});

test('news route reports a missing key and rejects unknown categories explicitly', async () => {
  const request = install(
    newsApiProxy({
      apiKey: () => '',
      fetchArticles: () => assert.fail('must not call NewsAPI without a key'),
    }),
  );
  const missing = await request('/?category=world');
  assert.equal(missing.statusCode, 503);
  assert.deepEqual(JSON.parse(missing.body), {
    error: 'NEWSAPI_API_KEY is not configured',
    code: 'missing_api_key',
  });
  const invalid = await request('/?category=all');
  assert.equal(invalid.statusCode, 400);
  assert.equal(JSON.parse(invalid.body).code, 'invalid_category');
});

test('news route caches successful categories and returns empty results distinctly', async () => {
  let requests = 0;
  const request = install(
    newsApiProxy({
      apiKey: () => 'fixture-secret',
      fetchArticles: async (category) => {
        requests += 1;
        return {
          status: 'empty',
          category,
          totalResults: 0,
          articles: [],
          source: 'NewsAPI',
        };
      },
    }),
  );
  const first = await request('/?category=economy');
  const cached = await request('/?category=economy');
  assert.equal(first.statusCode, 200);
  assert.deepEqual(JSON.parse(first.body).articles, []);
  assert.equal(JSON.parse(first.body).status, 'empty');
  assert.equal(cached.headers['X-News-Cache'], 'HIT');
  assert.equal(JSON.parse(cached.body).cached, true);
  assert.equal(requests, 1);
});

test('news route exposes an upstream rate limit with a bounded retry hint and sanitizes failures', async () => {
  const limited = install(
    newsApiProxy({
      apiKey: () => 'fixture-secret',
      fetchArticles: async () => {
        const error = new Error('provider detail');
        error.code = 'rate_limited';
        error.retryAfter = 40;
        throw error;
      },
    }),
  );
  const response = await limited('/?category=crises');
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['Retry-After'], '40');
  assert.deepEqual(JSON.parse(response.body), {
    error: 'NewsAPI request limit reached',
    code: 'rate_limited',
  });

  const failed = install(
    newsApiProxy({
      apiKey: () => 'fixture-secret',
      fetchArticles: async () => {
        throw new Error('upstream detail or credential');
      },
    }),
  );
  const failure = await failed('/?category=politics');
  assert.equal(failure.statusCode, 502);
  assert.equal(failure.body.includes('credential'), false);
  assert.equal(JSON.parse(failure.body).code, 'upstream_error');
});
