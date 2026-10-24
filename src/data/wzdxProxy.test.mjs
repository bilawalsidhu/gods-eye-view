import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  WZDX_FAILURE_BACKOFF_MS,
  WZDX_FEEDS,
  WZDX_FEED_MAX_BYTES,
  WZDX_REFRESH_MS,
  WZDX_STALE_LIMIT_MS,
  wzdxProxy,
} from '../../server/providers/wzdx.js';

// Trimmed real feeds read on 24 Oct 2026 (CC0 1.0).
const body = (id) =>
  readFileSync(
    new URL(`../layers/workZones/fixtures/wzdx-${id}.json`, import.meta.url),
    'utf8',
  );
const NOW = Date.parse('2026-10-24T03:13:00Z');
const FEEDS = [
  {
    id: 'mn',
    name: 'Minnesota',
    publisher: 'Minnesota DOT',
    url: 'https://mn.example.test/wzdx',
  },
  {
    id: 'md',
    name: 'Maryland',
    publisher: 'Maryland DOT SHA',
    url: 'https://md.example.test/wzdx',
  },
];

function install({ responses, clock, feeds = FEEDS } = {}) {
  const calls = [];
  let handler;
  const plugin = wzdxProxy({
    feeds,
    now: () => clock.now,
    warn() {},
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      const answer = responses[new URL(url).hostname.split('.')[0]];
      return typeof answer === 'function' ? answer() : answer.clone();
    },
  });
  plugin.configureServer({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/wzdx');
        handler = callback;
      },
    },
  });
  const request = async (url = '/events', method = 'GET', headers = {}) => {
    const res = {
      writeHead(status, head) {
        this.status = status;
        this.headers = head;
      },
      end(payload) {
        this.raw = payload;
        const text = Buffer.isBuffer(payload)
          ? gunzipSync(payload).toString('utf8')
          : payload;
        this.body = JSON.parse(text);
      },
    };
    await handler(
      { url, method, headers, socket: { remoteAddress: 'peer' } },
      res,
    );
    return res;
  };
  return { calls, request, plugin };
}

const ok = (id) =>
  new Response(body(id), { headers: { 'content-type': 'application/json' } });

test('the feed list is fixed in code, keyless https, with publishers named', () => {
  assert.ok(WZDX_FEEDS.length >= 3 && WZDX_FEEDS.length <= 10);
  for (const feed of WZDX_FEEDS) {
    const url = new URL(feed.url);
    assert.equal(url.protocol, 'https:');
    assert.ok(!/key|token/i.test(url.search), `${feed.id} needs no key`);
    assert.ok(feed.publisher && feed.name && feed.id);
    // Status pieces split feed names on ", " (ui/statusText.js).
    assert.ok(!feed.name.includes(', '), feed.name);
  }
  assert.equal(
    new Set(WZDX_FEEDS.map((feed) => feed.id)).size,
    WZDX_FEEDS.length,
  );
});

test('one shared snapshot: concurrent clients coalesce into one read per feed', async () => {
  const clock = { now: NOW };
  const { calls, request } = install({
    clock,
    responses: { mn: ok('mn'), md: ok('md') },
  });
  const [a, b, c] = await Promise.all([request(), request(), request()]);
  assert.equal(calls.length, 2);
  for (const res of [a, b, c]) assert.equal(res.status, 200);
  assert.deepEqual(
    a.body.feeds.map(({ id, status, version }) => [id, status, version]),
    [
      ['mn', 'live', '4.0'],
      ['md', 'live', '4.1'],
    ],
  );
  assert.equal(a.body.events.length, 5);
  assert.equal(a.headers['Cache-Control'], 'no-store');
  // Inside the refresh window nothing is read again.
  clock.now += WZDX_REFRESH_MS - 1;
  await request();
  assert.equal(calls.length, 2);
});

test('only GET on the fixed path; a client cannot steer the upstream', async () => {
  const clock = { now: NOW };
  const { calls, request } = install({
    clock,
    responses: { mn: ok('mn'), md: ok('md') },
  });
  const post = await request('/events', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET');
  assert.equal((await request('/events/../x')).status, 404);
  assert.equal((await request('/')).status, 404);
  assert.equal((await request('/feeds')).status, 404);
  assert.equal(calls.length, 0);
  const res = await request('/events?url=https://evil.example/&feed=x');
  assert.equal(res.status, 200);
  assert.deepEqual(calls.map((url) => new URL(url).hostname).sort(), [
    'md.example.test',
    'mn.example.test',
  ]);
});

test('a failed feed keeps its previous events as stale, then expires', async () => {
  const clock = { now: NOW };
  let mdUp = true;
  const { request } = install({
    clock,
    responses: {
      mn: ok('mn'),
      md: () => (mdUp ? ok('md') : new Response('busy', { status: 503 })),
    },
  });
  await request();
  mdUp = false;
  clock.now += WZDX_REFRESH_MS;
  // Stale-while-revalidate: this answer is the old snapshot; the refresh
  // runs behind it.
  const first = await request();
  assert.equal(first.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await request();
  const md = second.body.feeds.find((feed) => feed.id === 'md');
  assert.equal(md.status, 'stale');
  assert.equal(md.error, 'http_503');
  assert.equal(md.count, 2);
  assert.equal(second.body.events.filter((e) => e.feed === 'md').length, 2);
  assert.equal(
    second.body.feeds.find((feed) => feed.id === 'mn').status,
    'live',
  );
  // Past the stale limit the old events are no longer served.
  clock.now += WZDX_STALE_LIMIT_MS;
  await request();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const expired = await request();
  const gone = expired.body.feeds.find((feed) => feed.id === 'md');
  assert.equal(gone.status, 'unavailable');
  assert.equal(gone.count, 0);
  assert.equal(expired.body.events.filter((e) => e.feed === 'md').length, 0);
});

test('no data at all answers 503 with Retry-After and backs off upstream', async () => {
  const clock = { now: NOW };
  const { calls, request } = install({
    clock,
    responses: {
      mn: () => Promise.reject(new TypeError('fetch failed: secret detail')),
      md: () => new Response('<html>', { status: 200 }),
    },
  });
  const res = await request();
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'wzdx_unavailable');
  assert.ok(Number(res.headers['Retry-After']) >= 5);
  assert.ok(!JSON.stringify(res.body).includes('secret'));
  assert.equal(calls.length, 2);
  clock.now += WZDX_FAILURE_BACKOFF_MS - 1000;
  assert.equal((await request()).status, 503);
  assert.equal(calls.length, 2, 'no upstream read inside the backoff');
  clock.now += 1000;
  await request();
  assert.equal(calls.length, 4);
});

test('per-feed failures are fixed codes: size cap, version, status, network', async () => {
  const clock = { now: NOW };
  const legacy = JSON.parse(body('md'));
  legacy.feed_info.version = '3.1';
  const feeds = ['big', 'old', 'down', 'gone', 'mn'].map((id) => ({
    id,
    name: id,
    publisher: id,
    url: `https://${id}.example.test/wzdx`,
  }));
  const { request } = install({
    clock,
    feeds,
    responses: {
      big: () =>
        new Response('{}', {
          headers: { 'content-length': String(WZDX_FEED_MAX_BYTES + 1) },
        }),
      old: () => Response.json(legacy),
      down: () => new Response('x', { status: 502 }),
      gone: () => Promise.reject(new TypeError('getaddrinfo ENOTFOUND')),
      mn: ok('mn'),
    },
  });
  const res = await request();
  assert.equal(res.status, 200);
  assert.deepEqual(
    Object.fromEntries(res.body.feeds.map((feed) => [feed.id, feed.error])),
    {
      big: 'too_large',
      old: 'unsupported_version',
      down: 'http_502',
      gone: 'network',
      mn: null,
    },
  );
});

test('the snapshot is sent gzipped to clients that accept it', async () => {
  const clock = { now: NOW };
  const { request } = install({
    clock,
    responses: { mn: ok('mn'), md: ok('md') },
  });
  const plain = await request();
  const zipped = await request('/events', 'GET', {
    'accept-encoding': 'gzip, deflate, br',
  });
  assert.equal(zipped.headers['Content-Encoding'], 'gzip');
  assert.ok(Buffer.isBuffer(zipped.raw));
  assert.deepEqual(zipped.body, plain.body);
  assert.ok(Number(plain.headers['X-Snapshot-Age']) >= 0);
});

test('preview mounts the same route', () => {
  let mounted = null;
  wzdxProxy({ feeds: FEEDS }).configurePreviewServer({
    middlewares: { use: (path) => (mounted = path) },
  });
  assert.equal(mounted, '/api/wzdx');
});
