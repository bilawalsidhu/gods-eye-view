import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NEWS_API_PATHS,
  createNewsSource,
  newsFeedQuery,
  newsQueryAllowed,
} from './source.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function recorder(respond) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  };
}

test('reads validated hotspots, feed and outlines from the same-origin routes', async () => {
  const { calls, fetchImpl } = recorder((url) => {
    if (url.startsWith('/api/news/hotspots'))
      return json({
        hotspots: [{ id: 'ua', name: 'UA', bbox: [22, 44, 42, 56] }],
      });
    if (url.startsWith('/api/news/feed'))
      return json({
        reports: [
          {
            id: 'r1',
            title: 'T',
            url: 'https://x.test/',
            publishedAt: '2026-10-28T09:00:00Z',
          },
        ],
        nextBefore: null,
      });
    return json({ polygons: [], borders: [], disputed: [] });
  });
  const source = createNewsSource({ fetchImpl });
  assert.equal((await source.getHotspots()).hotspots[0].id, 'ua');
  assert.equal(
    (await source.getFeed({ hotspot: 'all', today: true, limit: 60 }))
      .reports[0].id,
    'r1',
  );
  assert.deepEqual((await source.getOutline('ua')).polygons, []);
  await source.getCountryOutline('SD');
  await source.getHotspots({ hours: 6 });
  await source.getAreaOutline({ lat: 30.26666, lon: -97.7 });
  await source.getFeed({ hotspot: 'all', at: { lat: 30.26666, lon: -97.7 } });
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      '/api/news/hotspots',
      '/api/news/feed?hotspot=all&limit=60&today=1',
      '/api/news/outline?hotspot=ua&v=4',
      '/api/news/outline?country=SD&v=4',
      '/api/news/hotspots?hours=6',
      '/api/news/outline?at=30.27,-97.7&v=4',
      '/api/news/feed?hotspot=all&at=30.27%2C-97.7',
    ],
  );
  for (const { url, init } of calls) {
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.ok(init.signal instanceof AbortSignal);
    // Every URL the client sends is one a host's allowlist admits.
    assert.equal(newsQueryAllowed(new URL(url, 'http://h')), true, url);
  }
});

test('malformed, failed and unconfigured reads reject; a server without news is a permanent miss', async () => {
  const malformed = createNewsSource({ fetchImpl: async () => json({}) });
  await assert.rejects(malformed.getHotspots(), /Malformed news hotspots/);
  await assert.rejects(malformed.getFeed(), /Malformed news feed/);

  const down = createNewsSource({
    fetchImpl: async () => json({ error: 'upstream' }, 502),
  });
  await assert.rejects(down.getHotspots(), (error) => {
    assert.equal(error.message, 'News feed unavailable');
    assert.equal(error.retryable, true);
    assert.equal(error.unavailable, false);
    return true;
  });

  const unconfigured = createNewsSource({
    fetchImpl: async () =>
      json(
        { error: 'news_not_configured', unavailable: true, retryable: false },
        503,
      ),
  });
  await assert.rejects(unconfigured.getHotspots(), (error) => {
    assert.equal(error.message, 'News feed not configured on this server');
    assert.equal(error.code, 'unavailable');
    assert.equal(error.unavailable, true);
    assert.equal(error.retryable, false);
    return true;
  });
  const missing = createNewsSource({
    fetchImpl: async () => new Response('Not found', { status: 404 }),
  });
  await assert.rejects(missing.getFeed(), { unavailable: true });
  const broken = createNewsSource({
    fetchImpl: async () => new Response('{', { status: 200 }),
  });
  await assert.rejects(broken.getHotspots(), SyntaxError);
});

test('a section read from a key the server lacks names the key and is asked again', async () => {
  const answer = (body) =>
    createNewsSource({
      fetchImpl: async () =>
        new Response(JSON.stringify(body), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
  await assert.rejects(
    answer({ error: 'no_key', key: 'liveuamap' }).getHotspots(),
    (error) => {
      assert.equal(error.keyRequired, true);
      assert.equal(error.keyRejected, false);
      assert.equal(error.keyId, 'liveuamap');
      assert.equal(error.unavailable, false);
      assert.equal(error.retryable, true);
      return true;
    },
  );
  await assert.rejects(
    answer({ error: 'key_rejected', key: 'worldnewsapi' }).getFeed({
      at: { lat: 51.13, lon: 71.43 },
    }),
    { keyRequired: true, keyRejected: true, keyId: 'worldnewsapi' },
  );
  // The day's allowance spent: still the key's matter, back tomorrow.
  await assert.rejects(
    answer({ error: 'key_quota', key: 'worldnewsapi' }).getFeed(),
    {
      keyRequired: true,
      keyRejected: false,
      keyQuota: true,
      keyId: 'worldnewsapi',
      unavailable: false,
    },
  );
  // A key name not in the registry's form is an ordinary failure.
  await assert.rejects(
    answer({ error: 'no_key', key: '<script>' }).getHotspots(),
    (error) => error.keyRequired === undefined && error.code === 'http',
  );
});

test('reads time out and follow the caller signal', async () => {
  // AbortSignal.timeout does not hold the event loop open: the hanging fetch
  // does, until its signal aborts, so the run cannot end before it.
  const hang = (_url, { signal }) =>
    new Promise((_, reject) => {
      const alive = setTimeout(() => {}, 60_000);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(alive);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  const slow = createNewsSource({ fetchImpl: hang, timeoutMs: 20 });
  // Out of time it reads unavailable, in the app's words, as retryable.
  await assert.rejects(slow.getHotspots(), {
    message: 'News feed unavailable',
    code: 'timeout',
    retryable: true,
  });
  // The caller's abort stays its own, even once the time is up too.
  const late = (_url, { signal }) =>
    new Promise((_, reject) => {
      setTimeout(() => reject(signal.reason), 40);
    });
  const leaving = new AbortController();
  const gone = createNewsSource({ fetchImpl: late, timeoutMs: 20 }).getFeed(
    {},
    { signal: leaving.signal },
  );
  leaving.abort(new Error('gone'));
  await assert.rejects(gone, /gone/);
  const caller = new AbortController();
  const pending = createNewsSource({ fetchImpl: hang }).getFeed(
    {},
    { signal: caller.signal },
  );
  caller.abort(new Error('gone'));
  await assert.rejects(pending, /gone/);
  await assert.rejects(
    createNewsSource({ fetchImpl: hang }).getHotspots({
      signal: AbortSignal.abort(new Error('already')),
    }),
    /already/,
  );
});

test('the host allowlist admits the client routes and refuses anything else', () => {
  const allowed = (path) => newsQueryAllowed(new URL(path, 'http://h'));
  assert.deepEqual(NEWS_API_PATHS, [
    '/api/news/hotspots',
    '/api/news/feed',
    '/api/news/outline',
  ]);
  assert.equal(
    allowed(
      `/api/news/feed?${newsFeedQuery({ hotspot: 'ua-ru-war', before: '2026-10-28T08:00:00.000Z', limit: 500, category: 'strike', relevance: 'core,related', geo: true, today: true, events: true })}`,
    ),
    true,
  );
  assert.equal(allowed('/api/news/hotspots?hours=6'), true);
  for (const path of [
    '/api/news/hotspots?hours=0',
    '/api/news/hotspots?hours=25',
    '/api/news/hotspots?hours=6&hours=3',
    '/api/news/hotspots?hours=6&x=1',
    '/api/news/hotspots?x=1',
    '/api/news/feed?limit=501',
    '/api/news/feed?limit=0',
    '/api/news/feed?hotspot=all&hotspot=ua',
    '/api/news/feed?since=yesterday',
    '/api/news/feed?geo=yes',
    '/api/news/feed?side=UA',
    '/api/news/air-alerts',
    '/api/news/outline?hotspot=ua',
    '/api/news/outline?hotspot=ua&v=2',
    '/api/news/outline?country=ukraine&v=4',
    '/api/news/outline?at=30.267,-97.7&v=4',
    '/api/news/outline?at=30.27&v=4',
    '/api/news/outline?at=30.27,-97.7&country=US&v=4',
    '/api/news/feed?at=30.267,-97.7',
  ])
    assert.equal(allowed(path), false, path);
});
