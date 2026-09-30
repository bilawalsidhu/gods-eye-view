import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_TV_TTL_MS, liveTvProxy } from '../../server/providers/liveTv.js';

const API = 'https://iptv-org.github.io/api/';
const FILES = [
  `${API}channels.json`,
  `${API}streams.json`,
  `${API}blocklist.json`,
  `${API}countries.json`,
];
const NOW = Date.parse('2026-09-30T10:00:00Z');

const database = () => ({
  [`${API}channels.json`]: [
    {
      id: 'News.uk',
      name: 'News',
      country: 'UK',
      categories: ['news'],
      is_nsfw: false,
      closed: null,
    },
    {
      id: 'Blocked.uk',
      name: 'Blocked',
      country: 'UK',
      categories: [],
      is_nsfw: false,
      closed: null,
    },
  ],
  [`${API}streams.json`]: [
    {
      channel: 'News.uk',
      url: 'https://news.example/live.m3u8',
      quality: '720p',
      labels: [],
      user_agent: null,
      referrer: null,
    },
    {
      channel: 'Blocked.uk',
      url: 'https://blocked.example/live.m3u8',
      quality: null,
      labels: [],
      user_agent: null,
      referrer: null,
    },
  ],
  [`${API}blocklist.json`]: [{ channel: 'Blocked.uk', reason: 'dmca' }],
  [`${API}countries.json`]: [{ code: 'UK', name: 'United Kingdom' }],
});

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = liveTvProxy(options);
  assert.equal(plugin.name, 'live-tv');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/live-tv');
        handler = callback;
      },
    },
  });
  return async (url = '/', method = 'GET', peer = 'local') => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ url, method, socket: { remoteAddress: peer } }, res);
    return res;
  };
}

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: reads the four fixed iptv-org files and never a stream URL`, async () => {
    const calls = [];
    const data = database();
    const request = install(
      {
        now: () => NOW,
        fetchImpl: async (url, options) => {
          calls.push(url);
          assert.ok(options.signal instanceof AbortSignal);
          assert.equal(options.redirect, 'error');
          return Response.json(data[url]);
        },
      },
      hook,
    );
    const res = await request('/?url=https://invalid.example/x.m3u8');
    assert.equal(res.status, 200);
    assert.deepEqual(calls.sort(), [...FILES].sort());
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(res.body.countries, [
      {
        code: 'UK',
        name: 'United Kingdom',
        lon: -2.12,
        lat: 54.4,
        channels: 1,
      },
    ]);
    assert.equal(res.body.totals.excluded.blocklist, 1);
    const country = await request('/country/UK');
    assert.equal(country.status, 200);
    assert.deepEqual(country.body.channels, [
      {
        id: 'News.uk',
        name: 'News',
        categories: ['news'],
        streams: [
          {
            url: 'https://news.example/live.m3u8',
            quality: '720p',
            labels: [],
          },
        ],
      },
    ]);
    assert.equal(calls.length, 4, 'the country page reuses the cached index');
  });
}

test('routes validate method, path and country code before any upstream read', async () => {
  let calls = 0;
  const data = database();
  const request = install({
    now: () => NOW,
    fetchImpl: async (url) => {
      calls++;
      return Response.json(data[url]);
    },
  });
  assert.equal((await request('/', 'POST')).status, 405);
  assert.equal((await request('/unknown')).status, 404);
  assert.equal((await request('/country/uk')).status, 400);
  assert.equal((await request('/country/..%2F..')).status, 400);
  assert.equal(calls, 0);
  assert.equal((await request('/country/FR')).status, 404);
});

test('the index is cached for its TTL, then rebuilt; failures serve the last copy', async () => {
  let clock = NOW;
  let fail = false;
  let calls = 0;
  const data = database();
  const request = install({
    now: () => clock,
    fetchImpl: async (url) => {
      calls++;
      if (fail) return new Response('nope', { status: 503 });
      return Response.json(data[url]);
    },
  });
  assert.equal((await request('/')).status, 200);
  assert.equal(calls, 4);
  clock += LIVE_TV_TTL_MS - 1;
  assert.equal((await request('/')).status, 200);
  assert.equal(calls, 4);
  clock += 2;
  fail = true;
  const stale = await request('/');
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.equal(stale.body.countries.length, 1);
});

test('without any good copy a failure is a 502 and the next try waits', async () => {
  let clock = NOW;
  let calls = 0;
  const request = install({
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      return Response.json({ not: 'an array' });
    },
  });
  const first = await request('/');
  assert.equal(first.status, 502);
  assert.equal(first.body.error, 'live_tv_unavailable');
  const before = calls;
  assert.equal((await request('/')).status, 502);
  assert.equal(calls, before, 'backs off instead of refetching at once');
  clock += 5 * 60_000;
  await request('/');
  assert.ok(calls > before);
});

test('a client over the per-minute budget is refused', async () => {
  const data = database();
  const request = install({
    now: () => NOW,
    fetchImpl: async (url) => Response.json(data[url]),
  });
  let last;
  for (let i = 0; i < 61; i++) last = await request('/', 'GET', 'greedy');
  assert.equal(last.status, 429);
  assert.equal(last.headers['Retry-After'], '60');
  assert.equal((await request('/', 'GET', 'polite')).status, 200);
});
