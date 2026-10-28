import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import {
  worldNewsProxy,
  nextUtcMidnight,
  WORLD_NEWS_RETENTION_MS,
  WORLD_NEWS_TTL_MS,
} from 'gods-eye-view/server/providers/world-news';
import { localProviderPlugins } from '../../server/providers/local.js';
import { estimateWorldNewsPoints } from '../data/worldNewsArticles.js';

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  assert.equal(routes.size, 1);
  assert.equal([...routes.keys()][0], '/api/world-news');
  return async (url = '/', method = 'GET') => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      end(body) {
        this.body = body;
      },
    };
    await [...routes.values()][0]({ url, method }, res);
    return res;
  };
}
function isolate(t, env = {}) {
  for (const [name, value] of Object.entries(env)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.mock.method(fsp, 'readFile', async () => {
    throw Error('no disk cache');
  });
  t.mock.method(fsp, 'stat', async () => {
    throw Error('no disk cache');
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
  t.mock.method(globalThis, 'setInterval', () => ({ unref() {} }));
  t.mock.method(console, 'warn', () => {});
}
const json = (res) => JSON.parse(res.body);
const KEYLESS_ENV = {
  WORLD_NEWS_API_KEY: '',
  WORLD_NEWS_DAILY_POINT_BUDGET: undefined,
  WORLD_NEWS_PAGES: undefined,
  WORLD_NEWS_WINDOW_HOURS: undefined,
  WORLD_NEWS_PAGE_SIZE: undefined,
  WORLD_NEWS_LANGUAGE: undefined,
  WORLD_NEWS_EXTRA_QUERY: undefined,
};

const place = (name, latitude, longitude, mentions = 1) => ({
  type: 'LOC',
  name,
  latitude,
  longitude,
  found_in: 'title',
  mentions,
});
function article(id, entities = [place('London', 51.5, -0.12)]) {
  return {
    id,
    title: `Headline ${id}`,
    text: 'FULL BODY TEXT',
    summary: 'summary',
    url: `https://example.com/${id}`,
    image: 'https://example.com/hero.jpg',
    publish_date: `2026-09-15 ${String(id % 24).padStart(2, '0')}:00:00`,
    authors: ['Jane Doe'],
    category: 'politics',
    language: 'en',
    source_country: 'us',
    sentiment: -0.5,
    entities: [
      ...entities,
      { type: 'PER', name: 'Some Person', found_in: 'title', mentions: 3 },
    ],
  };
}
function page(news, { request = 2, used = 2, left = 48, status = 200 } = {}) {
  return new Response(
    JSON.stringify({ offset: 0, number: news.length, available: 500, news }),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Quota-Request': String(request),
        'X-API-Quota-Used': String(used),
        'X-API-Quota-Left': String(left),
      },
    },
  );
}
const T0 = Date.UTC(2026, 8, 15, 12);
const MIN = 60_000;

test('composition mounts the world-news proxy once with both hooks and no acquisition', (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('construction must not fetch');
  });
  const plugins = localProviderPlugins().filter(
    (plugin) => plugin.name === 'world-news-proxy',
  );
  assert.equal(plugins.length, 1);
  assert.equal(typeof plugins[0].configureServer, 'function');
  assert.equal(typeof plugins[0].configurePreviewServer, 'function');
  assert.equal(nextUtcMidnight(T0), Date.UTC(2026, 8, 16));
});

test('keyless mode answers 503 no_key on every data route and never calls upstream', async (t) => {
  isolate(t, KEYLESS_ENV);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return page([article(1)]);
  });
  const request = install(worldNewsProxy({ pageDelayMs: 0 }));
  assert.equal((await request('/')).status, 503);
  assert.deepEqual(json(await request('/')), { error: 'no_key' });
  assert.equal((await request('/more')).status, 503);
  assert.equal((await request('/', 'POST')).status, 405);
  assert.equal((await request('/nope')).status, 404);
  const status = json(await request('/status'));
  assert.equal(status.hasKey, false);
  assert.equal(status.count, 0);
  assert.equal(status.morePagesLeft, 0);
  assert.equal(status.budget.limit, 40);
  assert.equal(calls, 0);
});

test('keyed flow: request shape, stripping, cache hit, TTL merge, retention purge and stale serving', async (t) => {
  isolate(t, { ...KEYLESS_ENV, WORLD_NEWS_API_KEY: 'fixture-key' });
  let now = T0;
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  let upstream = () =>
    page([
      article(1),
      article(2, [{ ...place('Berlin', 52.5, 13.4), found_in: 'text' }]),
      article(3, []),
    ]);
  t.mock.method(globalThis, 'fetch', async (raw, init) => {
    const url = new URL(raw);
    calls.push({ url, init });
    return upstream(url);
  });
  const request = install(worldNewsProxy({ pageDelayMs: 0 }));

  const first = await request('/');
  assert.equal(first.status, 200);
  assert.equal(first.headers['Cache-Control'], 'no-store');
  const body = json(first);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url.hostname, 'api.worldnewsapi.com');
  assert.equal(url.pathname, '/search-news');
  assert.equal(url.searchParams.get('number'), '100');
  assert.equal(url.searchParams.get('offset'), '0');
  assert.equal(url.searchParams.get('sort'), 'publish-time');
  assert.equal(url.searchParams.get('sort-direction'), 'DESC');
  assert.equal(url.searchParams.get('add-entities'), 'true');
  assert.equal(url.searchParams.get('language'), 'en');
  // 72 hours back by default (WORLD_NEWS_WINDOW_HOURS).
  assert.equal(
    url.searchParams.get('earliest-publish-date'),
    '2026-09-12 12:00:00',
  );
  assert.equal(url.searchParams.has('api-key'), false);
  assert.equal(init.headers['x-api-key'], 'fixture-key');
  assert.equal(body.count, 1);
  assert.equal(body.requested, 3);
  assert.equal(body.unplacedCount, 2);
  assert.equal(body.stale, false);
  assert.equal(body.blocked, null);
  assert.equal(body.fetchedAt, T0);
  assert.equal(body.ttlMs, WORLD_NEWS_TTL_MS);
  assert.equal(body.retentionMs, WORLD_NEWS_RETENTION_MS);
  assert.deepEqual(body.budget, {
    spent: 2,
    limit: 40,
    date: '2026-09-15',
    worldPageFits: true,
    viewPageFits: true,
  });
  assert.deepEqual(body.quota, { used: 2, left: 48 });
  assert.equal(body.costPerRequest, 2);
  assert.equal(body.costMeasured, true);
  assert.equal(body.morePagesLeft, 3);
  assert.deepEqual(
    body.articles.map((a) => a.id),
    ['wn-1'],
  );
  const serialized = JSON.stringify(body);
  for (const leaked of ['FULL BODY', 'Jane Doe', 'hero.jpg', 'Some Person'])
    assert.equal(serialized.includes(leaked), false, leaked);

  // Fresh cache hit: no upstream call.
  assert.equal(json(await request('/')).count, 1);
  assert.equal(calls.length, 1);
  const status = json(await request('/status'));
  assert.equal(status.hasKey, true);
  assert.equal(status.lastFetch, T0);
  assert.equal(status.stale, false);

  // Past the TTL: refresh, merged with the retained batch, duplicates collapse.
  now = T0 + 31 * MIN;
  upstream = () => page([article(4), article(1)]);
  const second = json(await request('/'));
  assert.equal(calls.length, 2);
  assert.deepEqual(second.articles.map((a) => a.id).sort(), ['wn-1', 'wn-4']);
  assert.equal(second.requested, 5);
  assert.equal(second.fetchedAt, now);
  assert.equal(second.budget.spent, 4);

  // 61 min after the first batch it is purged; the second batch is stale and
  // upstream is down → served stale with the failure code, flat point charged.
  now = T0 + 61 * MIN;
  upstream = () => new Response('offline', { status: 500 });
  const stale = json(await request('/'));
  assert.equal(calls.length, 3);
  assert.equal(stale.stale, true);
  assert.equal(stale.blocked, 'upstream');
  assert.deepEqual(stale.articles.map((a) => a.id).sort(), ['wn-1', 'wn-4']);
  assert.equal(stale.budget.spent, 5);
  assert.equal(stale.morePagesLeft, 0);
  assert.equal(json(await request('/status')).blocked, 'upstream');
  // Within the 60 s upstream backoff no new call is made.
  assert.equal(json(await request('/')).blocked, 'upstream');
  assert.equal(calls.length, 3);

  // Once every batch is older than the retention cap nothing is served stale.
  now = T0 + 31 * MIN + WORLD_NEWS_RETENTION_MS;
  const gone = await request('/');
  assert.equal(calls.length, 4);
  assert.equal(gone.status, 502);
  assert.deepEqual(json(gone), { error: 'upstream' });
  assert.equal(json(await request('/status')).count, 0);
});

test('extra query passes through without overriding owned parameters; measured cost gates page size and TTL; budget blocks', async (t) => {
  isolate(t, {
    ...KEYLESS_ENV,
    WORLD_NEWS_API_KEY: 'k1',
    WORLD_NEWS_DAILY_POINT_BUDGET: '20',
    WORLD_NEWS_LANGUAGE: '',
    WORLD_NEWS_EXTRA_QUERY:
      'has-location=true&fields=id,title&number=5&api-key=leak&sort=x',
  });
  let now = T0;
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  let cost = 12;
  t.mock.method(globalThis, 'fetch', async (raw) => {
    const url = new URL(raw);
    calls.push(url);
    return page([article(1)], { request: cost, used: cost, left: 50 - cost });
  });
  const request = install(worldNewsProxy({ pageDelayMs: 0 }));
  const first = json(await request('/'));
  assert.equal(calls[0].searchParams.get('has-location'), 'true');
  assert.equal(calls[0].searchParams.get('fields'), 'id,title');
  assert.equal(calls[0].searchParams.get('number'), '100');
  assert.equal(calls[0].searchParams.get('sort'), 'publish-time');
  assert.equal(calls[0].searchParams.has('api-key'), false);
  assert.equal(calls[0].searchParams.has('language'), false);
  assert.equal(first.costPerRequest, 12);
  assert.equal(first.pageSize, 50);
  assert.equal(first.ttlMs, 45 * MIN);
  assert.equal(first.budget.spent, 12);
  // Inside the gated TTL the cache is served; after it the smaller page is used.
  now = T0 + 40 * MIN;
  assert.equal(json(await request('/')).stale, false);
  assert.equal(calls.length, 1);
  now = T0 + 46 * MIN;
  cost = 7;
  const second = json(await request('/'));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].searchParams.get('number'), '50');
  assert.equal(second.budget.spent, 19);
  // The next 50-result page is priced at 6.5 points and 19 + 6.5 would cross
  // the budget of 20, so no call is made: the retained batch is served stale.
  now = T0 + 92 * MIN;
  const blocked = json(await request('/'));
  assert.equal(calls.length, 2);
  assert.equal(blocked.budget.spent, 19);
  assert.equal(blocked.stale, true);
  assert.equal(blocked.blocked, 'budget');
  assert.equal(blocked.morePagesLeft, 0);
  assert.equal(json(await request('/status')).blocked, 'budget');
  assert.equal((await request('/more')).status, 429);
  assert.deepEqual(json(await request('/more')), { error: 'budget' });
  assert.equal(calls.length, 2);
  // A new UTC day resets the governor.
  now = Date.UTC(2026, 8, 16, 0, 1);
  const reset = json(await request('/'));
  assert.equal(calls.length, 3);
  assert.equal(reset.blocked, null);
  assert.deepEqual(reset.budget, {
    spent: 7,
    limit: 20,
    date: '2026-09-16',
    worldPageFits: true,
    viewPageFits: true,
  });
});

test('provider failures map to blocked states, preserve the cache and clear on their own terms', async (t) => {
  isolate(t, { ...KEYLESS_ENV, WORLD_NEWS_API_KEY: 'k1' });
  let now = T0;
  t.mock.method(Date, 'now', () => now);
  let status = 402;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return status === 200
      ? page([article(1)])
      : page([], { status, request: 1, used: 50, left: 0 });
  });
  const request = install(worldNewsProxy({ pageDelayMs: 0 }));

  // 402 without a cache → 503 quota until 00:00 UTC. The provider does not
  // bill a refusal, so its X-API-Quota-Request header is not charged.
  let res = await request('/');
  assert.equal(res.status, 503);
  assert.deepEqual(json(res), { error: 'quota' });
  assert.equal(json(await request('/status')).blocked, 'quota');
  assert.deepEqual(json(await request('/status')).quota, { used: 50, left: 0 });
  assert.equal(json(await request('/status')).budget.spent, 0);
  now = T0 + 5 * 3_600_000;
  status = 200;
  assert.equal((await request('/')).status, 503);
  assert.equal(calls, 1);
  now = nextUtcMidnight(T0) + MIN;
  assert.equal(json(await request('/')).count, 1);
  assert.equal(calls, 2);

  // 429 → rate_limited for 10 s, cache served stale meanwhile.
  now += WORLD_NEWS_TTL_MS + MIN;
  status = 429;
  let body = json(await request('/'));
  assert.equal(body.stale, true);
  assert.equal(body.blocked, 'rate_limited');
  assert.equal(calls, 3);
  now += 5_000;
  assert.equal(json(await request('/')).blocked, 'rate_limited');
  assert.equal(calls, 3);
  now += 6_000;
  status = 200;
  body = json(await request('/'));
  assert.equal(body.blocked, null);
  assert.equal(calls, 4);

  // 401 → bad_key until the key changes.
  now += WORLD_NEWS_TTL_MS + MIN;
  status = 401;
  body = json(await request('/'));
  assert.equal(body.blocked, 'bad_key');
  assert.equal(calls, 5);
  now += 3 * MIN;
  assert.equal(json(await request('/')).blocked, 'bad_key');
  assert.equal(calls, 5);
  process.env.WORLD_NEWS_API_KEY = 'k2';
  status = 200;
  body = json(await request('/'));
  assert.equal(body.blocked, null);
  assert.equal(calls, 6);

  // A malformed body is an upstream failure; the retained batch survives.
  now += WORLD_NEWS_TTL_MS + MIN;
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ news: 'not-a-list' }),
  );
  body = json(await request('/'));
  assert.equal(body.blocked, 'upstream');
  assert.equal(body.stale, true);
  assert.equal(body.count, 1);
});

test('LOAD MORE fetches the next offset, is capped per hour and counts against the budget', async (t) => {
  isolate(t, {
    ...KEYLESS_ENV,
    WORLD_NEWS_API_KEY: 'k1',
    WORLD_NEWS_PAGE_SIZE: '10',
    // One page per refresh, so this covers /more's own offset walk and hourly
    // cap rather than the initial-load page count (see the defaults test).
    WORLD_NEWS_PAGES: '1',
  });
  let now = T0;
  t.mock.method(Date, 'now', () => now);
  const offsets = [];
  t.mock.method(globalThis, 'fetch', async (raw) => {
    const url = new URL(raw);
    const offset = Number(url.searchParams.get('offset'));
    offsets.push(offset);
    const ids = Array.from({ length: 10 }, (_, i) => offset + i + 1);
    return page(
      ids.map((id) => article(id)),
      { request: 1.1 },
    );
  });
  const request = install(worldNewsProxy({ pageDelayMs: 0 }));
  // Without a snapshot, /more behaves like a first load.
  const first = json(await request('/more'));
  assert.deepEqual(offsets, [0]);
  assert.equal(first.count, 10);
  assert.equal(first.morePagesLeft, 3);
  const more = json(await request('/more'));
  assert.deepEqual(offsets, [0, 10]);
  assert.equal(more.count, 20);
  assert.equal(more.morePagesLeft, 2);
  assert.equal(more.stale, false);
  assert.equal(more.budget.spent, 2.2);
  assert.equal(json(await request('/more')).morePagesLeft, 1);
  assert.equal(json(await request('/more')).morePagesLeft, 0);
  assert.deepEqual(offsets, [0, 10, 20, 30]);
  const capped = await request('/more');
  assert.equal(capped.status, 429);
  assert.deepEqual(json(capped), { error: 'pages' });
  assert.equal(offsets.length, 4);
  // The plain snapshot still serves everything that was loaded.
  assert.equal(json(await request('/')).count, 40);
  // An hour later the extra-page allowance is back and a refresh starts over.
  now = T0 + 61 * MIN;
  const refreshed = json(await request('/'));
  assert.deepEqual(offsets.at(-1), 0);
  assert.equal(refreshed.morePagesLeft, 3);
});

test('a response without quota headers is charged at the documented estimate and labelled unmeasured', async (t) => {
  isolate(t, { ...KEYLESS_ENV, WORLD_NEWS_API_KEY: 'fixture-key' });
  t.mock.method(Date, 'now', () => T0);
  let withHeaders = false;
  t.mock.method(globalThis, 'fetch', async () => {
    const news = [article(1), article(2), article(3)];
    if (withHeaders) return page(news);
    return new Response(
      JSON.stringify({ offset: 0, number: 3, available: 500, news }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  const request = install(worldNewsProxy({ pageDelayMs: 0 }));
  const estimate = estimateWorldNewsPoints(3);
  const body = json(await request('/'));
  assert.equal(body.costMeasured, false);
  assert.equal(body.costPerRequest, estimate);
  assert.equal(body.budget.spent, estimate);
  assert.deepEqual(body.quota, { used: null, left: null });
  const status = json(await request('/status'));
  assert.equal(status.costMeasured, false);
  assert.equal(status.costPerRequest, estimate);
  withHeaders = true;
  const more = json(await request('/more'));
  assert.equal(
    more.costMeasured,
    true,
    'a measured header wins once it appears',
  );
  assert.equal(more.costPerRequest, 2);
});

test('page count and time window are configurable, and clamped', async (t) => {
  // Only a place named in the TITLE can be pinned, so roughly a third of any
  // page reaches the map. Paging is the lever that adds headlines: a wider
  // window alone returns the same newest articles first.
  const run = async (env) => {
    const calls = [];
    isolate(t, { ...KEYLESS_ENV, WORLD_NEWS_API_KEY: 'k1', ...env });
    t.mock.method(Date, 'now', () => T0);
    t.mock.method(globalThis, 'fetch', async (raw) => {
      const url = new URL(raw);
      const size = Number(url.searchParams.get('number'));
      const offset = Number(url.searchParams.get('offset'));
      calls.push({
        offset,
        since: url.searchParams.get('earliest-publish-date'),
      });
      // Full pages, so the walk is never cut short by a short page.
      return page(
        Array.from({ length: size }, (_, i) => article(offset + i + 1)),
        { request: 1 },
      );
    });
    const request = install(worldNewsProxy({ pageDelayMs: 0 }));
    json(await request('/'));
    return calls;
  };

  const byDefault = await run({});
  assert.equal(byDefault.length, 1, 'one page per refresh by default');
  assert.equal(byDefault[0].since, '2026-09-12 12:00:00'); // 72h before T0

  assert.deepEqual(
    (await run({ WORLD_NEWS_PAGES: '5' })).map(({ offset }) => offset),
    [0, 100, 200, 300, 400],
  );
  assert.equal(
    (await run({ WORLD_NEWS_PAGES: '99' })).length,
    5,
    'clamped to WORLD_NEWS_MAX_PAGES',
  );

  assert.equal(
    (await run({ WORLD_NEWS_WINDOW_HOURS: '24' }))[0].since,
    '2026-09-14 12:00:00',
  );
  assert.equal(
    (await run({ WORLD_NEWS_WINDOW_HOURS: '100000' }))[0].since,
    '2026-09-08 12:00:00', // clamped to 168h
  );
  assert.equal(
    (await run({ WORLD_NEWS_WINDOW_HOURS: 'nonsense' }))[0].since,
    '2026-09-12 12:00:00', // falls back to the 72h default
  );
});

test('a page size that shrinks mid-refresh does not cut paging short', async (t) => {
  // The measured-cost gate halves the page size once the first response
  // reveals the cost, so page 1 asks for 100 and page 2 onwards for 50. A
  // 50-result page compared against a captured size of 100 looked like the
  // provider had run out, so paging stopped after two pages however many
  // WORLD_NEWS_PAGES asked for, and the offset walked past unread articles.
  isolate(t, {
    ...KEYLESS_ENV,
    WORLD_NEWS_API_KEY: 'k1',
    WORLD_NEWS_PAGES: '5',
    // Five pages charged 12 points each need more than the default budget of
    // 40 admits; this test is about the offset walk, not the governor.
    WORLD_NEWS_DAILY_POINT_BUDGET: '100',
  });
  t.mock.method(Date, 'now', () => T0);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (raw) => {
    const url = new URL(raw);
    const number = Number(url.searchParams.get('number'));
    calls.push({ number, offset: Number(url.searchParams.get('offset')) });
    // Over the gate threshold, so every later page is the halved size.
    return page(
      Array.from({ length: number }, (_, i) =>
        article(calls.length * 1000 + i),
      ),
      { request: 12 },
    );
  });
  const request = install(worldNewsProxy({ pageDelayMs: 0 }));
  const body = json(await request('/'));

  assert.equal(calls.length, 5, 'all five pages are fetched');
  assert.deepEqual(
    calls.map(({ number }) => number),
    [100, 50, 50, 50, 50],
    'the gate halves the page after the first response',
  );
  // Offsets follow the articles actually read, so nothing is skipped.
  assert.deepEqual(
    calls.map(({ offset }) => offset),
    [0, 100, 150, 200, 250],
  );
  assert.equal(body.requested, 300);
});

/**
 * Charge every page at the documented rate with location entities, 1 point
 * plus 0.11 per result, and answer full pages so nothing ends a walk early.
 */
function documentedRateUpstream(t, calls) {
  t.mock.method(globalThis, 'fetch', async (raw) => {
    const url = new URL(raw);
    const number = Number(url.searchParams.get('number'));
    const offset = Number(url.searchParams.get('offset'));
    calls.push({
      number,
      offset,
      region: url.searchParams.has('location-filter'),
    });
    const news = Array.from({ length: number }, (_, i) =>
      article(calls.length * 1000 + i),
    );
    return page(news, { request: estimateWorldNewsPoints(number) });
  });
}

test('the default settings keep a day of refreshes inside the free plan', async (t) => {
  // The review case: at the old default of five pages, two refreshes 46 min
  // apart spent 12 + 4 x 6.5 = 38 and then 32.5 more, 70.5 points against the
  // free plan's 50, because the budget was only checked before a refresh.
  isolate(t, { ...KEYLESS_ENV, WORLD_NEWS_API_KEY: 'k1' });
  let now = T0;
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  documentedRateUpstream(t, calls);
  const request = install(worldNewsProxy({ pageDelayMs: 0 }));

  const spent = [];
  for (let refresh = 0; refresh < 12; refresh++) {
    now = T0 + refresh * 46 * MIN;
    await request('/');
    // Read from /status: once the last batch ages out, a blocked snapshot
    // answers 429 without a payload.
    spent.push(json(await request('/status')).budget.spent);
  }
  assert.ok(spent.at(-1) <= 40, `spent ${spent.at(-1)} of 40`);
  // One page per refresh: 12 for the first, 6.5 once the cost gate halves it.
  assert.deepEqual(spent.slice(0, 5), [12, 18.5, 25, 31.5, 38]);
  assert.equal(calls.length, 5);
  assert.equal(json(await request('/status')).blocked, 'budget');
});

test('every page of a refresh is admitted against the budget, and a stopped refresh keeps its pages', async (t) => {
  isolate(t, {
    ...KEYLESS_ENV,
    WORLD_NEWS_API_KEY: 'k1',
    WORLD_NEWS_PAGES: '5',
  });
  let now = T0;
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  documentedRateUpstream(t, calls);
  const request = install(worldNewsProxy({ pageDelayMs: 0 }));

  // The old default of five pages, under the default budget of 40.
  const first = json(await request('/'));
  assert.equal(calls.length, 5);
  assert.equal(first.budget.spent, 38);
  // The next worldwide page (6.5) no longer fits 38 of 40, so even the fresh
  // payload says so, and so does every cache hit within the TTL; LOAD MORE
  // is not offered only to be refused.
  assert.equal(first.blocked, 'budget');
  assert.equal(first.morePagesLeft, 0);
  now = T0 + 10 * MIN;
  const hit = json(await request('/'));
  assert.equal(calls.length, 5);
  assert.equal(hit.stale, false);
  assert.equal(hit.blocked, 'budget');
  assert.equal(hit.morePagesLeft, 0);
  // 38 + 6.5 would cross 40, so the second refresh never reaches upstream.
  now = T0 + 46 * MIN;
  const second = json(await request('/'));
  assert.equal(calls.length, 5);
  assert.equal(second.budget.spent, 38);
  assert.equal(second.stale, true);
  assert.equal(second.blocked, 'budget');

  // A tighter budget stops the walk partway: pages one to three are spent
  // (12, 18.5, 25), page four would reach 31.5 of 30. The fetched pages are
  // served as a fresh batch that reports the budget stop.
  isolate(t, { WORLD_NEWS_DAILY_POINT_BUDGET: '30' });
  now = T0;
  calls.length = 0;
  const partial = json(await install(worldNewsProxy({ pageDelayMs: 0 }))('/'));
  assert.equal(calls.length, 3);
  assert.equal(partial.budget.spent, 25);
  assert.equal(partial.stale, false);
  assert.equal(partial.blocked, 'budget');
  assert.equal(partial.requested, 200);
});

test('LOAD MORE and NEWS IN VIEW are refused before the call when it would cross the budget', async (t) => {
  isolate(t, {
    ...KEYLESS_ENV,
    WORLD_NEWS_API_KEY: 'k1',
    WORLD_NEWS_DAILY_POINT_BUDGET: '20',
  });
  t.mock.method(Date, 'now', () => T0);
  const calls = [];
  documentedRateUpstream(t, calls);
  const request = install(worldNewsProxy({ pageDelayMs: 0 }));

  assert.equal(json(await request('/')).budget.spent, 12);
  // 12 + 6.5 fits under 20; a second extra page would take it to 25.
  assert.equal(json(await request('/more')).budget.spent, 18.5);
  const refused = await request('/more');
  assert.equal(refused.status, 429);
  assert.deepEqual(json(refused), { error: 'budget' });
  assert.equal(calls.length, 2);

  // A view page asks for 25 results (3.75 points): over a budget of 3 it is
  // refused without a call, while a budget of 4 admits it although a full
  // worldwide page (12 points) would not fit.
  const view = '/?region=view&lat=56&lon=37.5&radius=50';
  isolate(t, { WORLD_NEWS_DAILY_POINT_BUDGET: '3' });
  calls.length = 0;
  const tight = await install(worldNewsProxy({ pageDelayMs: 0 }))(view);
  assert.equal(tight.status, 429);
  assert.deepEqual(json(tight), { error: 'budget' });
  assert.equal(calls.length, 0);
  isolate(t, { WORLD_NEWS_DAILY_POINT_BUDGET: '4' });
  const fresh = install(worldNewsProxy({ pageDelayMs: 0 }));
  const admitted = json(await fresh(view));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].region, true);
  assert.equal(admitted.budget.spent, 3.75);
  assert.equal((await fresh('/')).status, 429);
  assert.equal(calls.length, 1);

  // A view payload reports the budget at the price of the next VIEW page:
  // at 3.75 of 10 another 3.75 still fits, although a worldwide page (12)
  // does not, so the chip that would be admitted is not greyed out.
  isolate(t, { WORLD_NEWS_DAILY_POINT_BUDGET: '10' });
  calls.length = 0;
  const roomy = install(worldNewsProxy({ pageDelayMs: 0 }));
  const firstView = json(await roomy(view));
  assert.equal(firstView.budget.spent, 3.75);
  assert.equal(firstView.blocked, null);
  // The pinned circle's cache hit is priced the same way, without a call.
  const cachedView = json(await roomy(view));
  assert.equal(calls.length, 1);
  assert.equal(cachedView.blocked, null);
  const secondView = json(
    await roomy('/?region=view&lat=48.9&lon=2.3&radius=50'),
  );
  assert.equal(calls.length, 2);
  assert.equal(secondView.budget.spent, 7.5);
  assert.equal(secondView.blocked, 'budget', '7.5 + 3.75 would cross 10');
});

test('a budget stop sets no upstream backoff, and a billed call whose body failed is charged what it measured', async (t) => {
  isolate(t, {
    ...KEYLESS_ENV,
    WORLD_NEWS_API_KEY: 'k1',
    WORLD_NEWS_PAGES: '5',
    WORLD_NEWS_DAILY_POINT_BUDGET: '30',
  });
  let now = T0;
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  documentedRateUpstream(t, calls);
  const request = install(worldNewsProxy({ pageDelayMs: 0 }));
  const partial = json(await request('/'));
  assert.equal(partial.blocked, 'budget');
  assert.equal(calls.length, 3);
  // The refusal never reached the provider: nothing is logged as an upstream
  // failure, and once the budget allows it the next call goes straight out
  // rather than waiting out a 60 s upstream backoff.
  assert.equal(
    console.warn.mock.calls.some(({ arguments: args }) =>
      String(args[0]).includes('upstream failed'),
    ),
    false,
  );
  process.env.WORLD_NEWS_DAILY_POINT_BUDGET = '100';
  now = T0 + 30_000;
  const more = await request('/more');
  assert.equal(more.status, 200);
  assert.equal(calls.length, 4);

  // A billed response whose body is malformed counts its X-API-Quota-Request.
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(JSON.stringify({ news: 'not-a-list' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Quota-Request': '12',
        },
      }),
  );
  const before = json(await request('/status')).budget.spent;
  assert.equal((await request('/more')).status, 502);
  assert.equal(json(await request('/status')).budget.spent, before + 12);
});

test('a failed call is charged only what the provider billed', async (t) => {
  isolate(t, { ...KEYLESS_ENV, WORLD_NEWS_API_KEY: 'k1' });
  t.mock.method(Date, 'now', () => T0);
  const malformed = (headers) =>
    new Response(JSON.stringify({ news: 'not-a-list' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  const failed = (status) => page([], { status, request: 5 });
  const cases = [
    [
      '2xx, malformed body',
      () => malformed({ 'X-API-Quota-Request': '12' }),
      12,
    ],
    ['2xx, malformed body, no header', () => malformed({}), 1],
    ['402 refusal', () => failed(402), 0],
    ['429 refusal', () => failed(429), 0],
    ['401 refusal', () => failed(401), 0],
    ['403 refusal', () => failed(403), 0],
    ['503, header ignored', () => failed(503), 1],
    [
      'no response',
      () => {
        throw new TypeError('fetch failed');
      },
      1,
    ],
    [
      'timed out',
      () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
      1,
    ],
  ];
  for (const [label, respond, points] of cases) {
    t.mock.method(globalThis, 'fetch', async () => respond());
    const request = install(worldNewsProxy({ pageDelayMs: 0 }));
    assert.notEqual((await request('/')).status, 200, label);
    assert.equal(json(await request('/status')).budget.spent, points, label);
  }
});

test('every payload says whether the next worldwide page and the next view page fit', async (t) => {
  isolate(t, {
    ...KEYLESS_ENV,
    WORLD_NEWS_API_KEY: 'k1',
    WORLD_NEWS_DAILY_POINT_BUDGET: '17',
  });
  t.mock.method(Date, 'now', () => T0);
  const calls = [];
  documentedRateUpstream(t, calls);
  const request = install(worldNewsProxy({ pageDelayMs: 0 }));
  // 12 spent: a gated worldwide page (6.5) no longer fits 17, a view page
  // (3.75) still does, and the payload, a cache hit and /status all say so.
  for (const body of [
    json(await request('/')),
    json(await request('/')),
    json(await request('/status')),
  ]) {
    assert.equal(body.budget.spent, 12);
    assert.equal(body.budget.worldPageFits, false);
    assert.equal(body.budget.viewPageFits, true);
  }
  const view = json(await request('/?region=view&lat=56&lon=37.5&radius=50'));
  assert.equal(calls.length, 2);
  assert.equal(view.budget.spent, 15.75);
  // Now neither kind fits: 15.75 + 3.75 would cross 17 as well.
  assert.equal(view.budget.viewPageFits, false);
  assert.equal(view.blocked, 'budget');
});
