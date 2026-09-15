import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldNewsSource } from './source.js';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError('not json');
      return body;
    },
  };
}

function article(overrides = {}) {
  return {
    id: 'wn-1',
    title: 'Port strike halts shipping in Rotterdam',
    url: 'https://news.example.com/rotterdam',
    domain: 'news.example.com',
    publishedAt: '2026-09-15T06:00:00Z',
    sentiment: -0.5,
    category: 'business',
    language: 'en',
    sourceCountry: 'nl',
    lat: 51.92,
    lon: 4.48,
    place: 'Rotterdam',
    placeFoundIn: 'title',
    placeMentions: 1,
    ...overrides,
  };
}

function payload(overrides = {}) {
  return {
    fetchedAt: 1_757_916_000_000,
    stale: false,
    ttlMs: 1_800_000,
    retentionMs: 3_600_000,
    pageSize: 20,
    count: 1,
    requested: 20,
    placedCount: 1,
    unplacedCount: 19,
    blocked: null,
    budget: { spent: 4, limit: 50, date: '2026-09-15' },
    quota: { left: 90, used: 10 },
    costPerRequest: 2,
    morePagesLeft: 2,
    articles: [article()],
    ...overrides,
  };
}

function recordingSource(reply) {
  const calls = [];
  const source = createWorldNewsSource({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return typeof reply === 'function' ? reply(url) : reply;
    },
  });
  return { source, calls };
}

test('a keyless proxy resolves keyRequired for both endpoints without throwing', async () => {
  const { source } = recordingSource(response(503, { error: 'no_key' }));
  assert.deepEqual(await source.getSnapshot(), { keyRequired: true });
  assert.deepEqual(await source.loadMore(), { keyRequired: true });
});

test('a healthy payload becomes validated rows plus the budget and paging facts', async () => {
  const { source, calls } = recordingSource(response(200, payload()));
  const snapshot = await source.getSnapshot({
    signal: new AbortController().signal,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/world-news');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(snapshot.keyRequired, undefined);
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].id, 'wn-1');
  assert.equal(
    snapshot.rows[0].publishedMs,
    Date.parse('2026-09-15T06:00:00Z'),
  );
  assert.equal(snapshot.fetchedAt, 1_757_916_000_000);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.blocked, null);
  assert.deepEqual(snapshot.budget, {
    spent: 4,
    limit: 50,
    date: '2026-09-15',
  });
  assert.deepEqual(snapshot.quota, { left: 90, used: 10 });
  assert.equal(snapshot.requested, 20);
  assert.equal(snapshot.unplacedCount, 19);
  assert.equal(snapshot.morePagesLeft, 2);
  assert.equal(snapshot.costPerRequest, 2);
});

test('a blocked-but-served payload keeps its blocked code and stale flag', async () => {
  const { source } = recordingSource(
    response(
      200,
      payload({
        stale: true,
        blocked: 'budget',
        quota: null,
        costPerRequest: null,
        morePagesLeft: 0,
      }),
    ),
  );
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.blocked, 'budget');
  assert.equal(snapshot.quota, null);
  assert.equal(snapshot.costPerRequest, null);
  assert.equal(snapshot.morePagesLeft, 0);
});

test('a malformed snapshot never becomes an authoritative empty map', async () => {
  for (const bad of [
    payload({ articles: [article({ lat: 120 })] }),
    payload({ articles: null }),
    { fetchedAt: 1 },
    null,
  ]) {
    const { source } = recordingSource(response(200, bad));
    await assert.rejects(source.getSnapshot(), /Malformed news snapshot/);
  }
});

test('non-OK statuses throw the contract message with the proxy code attached', async () => {
  for (const [status, body, code, message] of [
    [402, { error: 'quota' }, 'quota', 'World News quota exhausted'],
    [503, { error: 'quota' }, 'quota', 'World News quota exhausted'],
    [502, { error: 'bad_key' }, 'bad_key', 'World News key rejected'],
    [429, { error: 'budget' }, 'budget', 'daily news budget exhausted'],
    [429, { error: 'rate_limited' }, 'rate_limited', 'World News rate-limited'],
    [429, { error: 'pages' }, 'pages', 'extra pages exhausted'],
    [502, { error: 'upstream' }, 'upstream', 'World News HTTP 502'],
    [500, undefined, null, 'World News HTTP 500'],
  ]) {
    const { source } = recordingSource(response(status, body));
    await assert.rejects(source.getSnapshot(), (error) => {
      assert.equal(error.message, message, `${status} ${code}`);
      assert.equal(error.code, code, `${status} ${code}`);
      return true;
    });
  }
});

test('loadMore requests the extra-page endpoint with the same contract', async () => {
  const { source, calls } = recordingSource((url) =>
    url.endsWith('/more')
      ? response(
          200,
          payload({
            morePagesLeft: 1,
            articles: [
              article(),
              article({ id: 'wn-2', url: 'https://b.example/2' }),
            ],
          }),
        )
      : response(200, payload()),
  );
  const more = await source.loadMore();
  assert.equal(calls[0].url, '/api/world-news/more');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(more.rows.length, 2);
  assert.equal(more.morePagesLeft, 1);
});

test('cancellation is honored before the request and during body parsing', async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  let fetched = 0;
  const source = createWorldNewsSource({
    fetchImpl: async () => {
      fetched++;
      return response(200, payload());
    },
  });
  await assert.rejects(source.getSnapshot({ signal: preAborted.signal }), {
    name: 'AbortError',
  });
  assert.equal(fetched, 0, 'an aborted signal never reaches the network');

  const abort = new AbortController();
  const uncooperative = createWorldNewsSource({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        abort.abort();
        return payload();
      },
    }),
  });
  await assert.rejects(uncooperative.loadMore({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
