import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CZIB_EXPORT_URL,
  CZIB_FEED_URL,
  CZIB_MAX_STALE_MS,
  CZIB_TTL_MS,
  czibProxy,
  czibRetryCooldownMs,
} from '../../server/providers/czib.js';

const EXPORT = {
  conflict_zones: [
    {
      Nid: '20585',
      issued_date: '2017-03-31T00:00:00+0300',
      valid_until_date: '31/10/2026',
      field_easa_valid_until_descr:
        '<p>31/10/2026, unless reviewed earlier.</p>',
      name: 'Airspace of Mali',
      status: 'Active',
      country: 'Mali',
      updated: '<time datetime="2026-09-10T10:39:53+03:00">x</time>',
    },
    {
      Nid: '20591',
      issued_date: '2017-04-01T00:00:00+0300',
      valid_until_date: '',
      name: 'Airspace of North Korea – Pyongyang Flight Information Region',
      status: 'Withdrawn',
      country: 'North Korea',
      updated: '',
    },
  ],
};
const FEED = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><link>https://www.easa.europa.eu/domains/air-operations/czibs/czib-2017-01r20</link>
<guid isPermaLink="false">20585 on Fri, 31 Mar 2017 00:00:00 +0300</guid></item>
</channel></rss>`;

/** A fetch that answers both fixed EASA URLs, or `override(url)` first. */
function upstream(calls, override = () => null) {
  return async (url, options) => {
    calls?.push(url);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
    const custom = await override(url);
    if (custom) return custom;
    if (url === CZIB_EXPORT_URL) return Response.json(EXPORT);
    if (url === CZIB_FEED_URL)
      return new Response(FEED, {
        headers: { 'content-type': 'application/rss+xml' },
      });
    throw new Error(`unexpected ${url}`);
  };
}

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = czibProxy(options);
  assert.equal(plugin.name, 'czib');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/czib');
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
  test(`${hook}: reads only the two fixed EASA URLs and joins them`, async () => {
    const calls = [];
    const request = install(
      { now: () => 1234, fetchImpl: upstream(calls) },
      hook,
    );
    const res = await request('/?url=https://invalid.example');
    assert.equal(res.status, 200);
    assert.deepEqual(calls.sort(), [CZIB_EXPORT_URL, CZIB_FEED_URL].sort());
    assert.ok(
      calls.every((url) => !url.includes('?')),
      'no query URLs',
    );
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.headers['X-Data-Stale'], undefined);
    assert.equal(res.body.fetchedAt, 1234);
    assert.equal(res.body.linksMissing, undefined);
    assert.deepEqual(
      res.body.bulletins.map(({ id, number, status }) => [id, number, status]),
      [
        ['20585', 'CZIB-2017-01R20', 'active'],
        ['20591', '', 'withdrawn'],
      ],
    );
  });
}

test('one hour of cache, and concurrent reads share one upstream pair', async () => {
  let clock = 0;
  const calls = [];
  const request = install({ now: () => clock, fetchImpl: upstream(calls) });
  await Promise.all([request(), request('/', 'GET', 'other')]);
  assert.equal(calls.length, 2);
  clock = CZIB_TTL_MS - 1;
  await request();
  assert.equal(calls.length, 2);
  clock = CZIB_TTL_MS;
  await request();
  assert.equal(calls.length, 4);
});

test('a failed RSS feed keeps the bulletins and reports the numbers missing', async () => {
  const request = install({
    fetchImpl: upstream(null, (url) =>
      url === CZIB_FEED_URL ? new Response('down', { status: 503 }) : null,
    ),
  });
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.body.linksMissing, true);
  assert.deepEqual(
    res.body.bulletins.map(({ number }) => number),
    ['', ''],
  );
});

test('an export failure serves the last good copy as stale, else 502', async () => {
  let clock = 0;
  let fail = false;
  const request = install({
    now: () => clock,
    fetchImpl: upstream(null, () => {
      if (fail) throw new Error('network');
      return null;
    }),
  });
  fail = true;
  const cold = await request();
  assert.equal(cold.status, 502);
  assert.deepEqual(cold.body, { error: 'czib_unavailable' });
  fail = false;
  await request();
  fail = true;
  clock = CZIB_TTL_MS + 1;
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-Data-Stale'], 'true');
  assert.equal(res.body.stale, true);
  assert.equal(res.body.fetchedAt, 0);
  assert.equal(res.body.staleAgeMs, CZIB_TTL_MS + 1);
  assert.equal(res.body.bulletins.length, 2);
});

test('the last good copy is served for at most the maximum stale age', async () => {
  let clock = 0;
  let fail = false;
  const request = install({
    now: () => clock,
    fetchImpl: upstream(null, () => {
      if (fail) throw new Error('network');
      return null;
    }),
  });
  assert.equal(CZIB_MAX_STALE_MS, 72 * 3_600_000);
  const fresh = await request();
  assert.equal(fresh.body.stale, undefined);
  assert.equal(fresh.body.staleAgeMs, undefined);
  fail = true;
  clock = CZIB_MAX_STALE_MS;
  const edge = await request();
  assert.equal(edge.status, 200);
  assert.equal(edge.body.staleAgeMs, CZIB_MAX_STALE_MS);
  clock = CZIB_MAX_STALE_MS + 1;
  const old = await request();
  assert.equal(old.status, 502);
  assert.deepEqual(old.body, { error: 'czib_unavailable' });
  assert.equal(old.headers['X-Data-Stale'], undefined);
  // EASA back: a fresh copy is served again.
  fail = false;
  const back = await request();
  assert.equal(back.status, 200);
  assert.equal(back.body.fetchedAt, CZIB_MAX_STALE_MS + 1);
  assert.equal(back.body.stale, undefined);
});

test('an upstream 429 starts a cooldown with no further upstream calls', async () => {
  let clock = 0;
  let calls = 0;
  const request = install({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return new Response('slow down', {
        status: 429,
        headers: { 'retry-after': '120' },
      });
    },
  });
  const first = await request();
  assert.equal(first.status, 429);
  assert.deepEqual(first.body, { error: 'czib_rate_limited' });
  assert.equal(first.headers['Retry-After'], '120');
  const upstreamCalls = calls;
  assert.ok(upstreamCalls >= 1 && upstreamCalls <= 2);
  clock = 60_000;
  const cooling = await request();
  assert.equal(cooling.status, 429);
  assert.equal(cooling.headers['Retry-After'], '60');
  assert.equal(calls, upstreamCalls, 'no upstream call during the cooldown');
  clock = 120_001;
  await request();
  assert.ok(calls > upstreamCalls, 'the cooldown ends');
});

test('Retry-After accepts seconds or an HTTP date, clamped to 30 s to 60 min', () => {
  const now = Date.UTC(2026, 8, 29, 12);
  assert.equal(czibRetryCooldownMs('90', now), 90_000);
  assert.equal(czibRetryCooldownMs('1', now), 30_000);
  assert.equal(czibRetryCooldownMs('86400', now), 60 * 60_000);
  assert.equal(
    czibRetryCooldownMs(new Date(now + 600_000).toUTCString(), now),
    600_000,
  );
  assert.equal(czibRetryCooldownMs(null, now), 5 * 60_000);
  assert.equal(czibRetryCooldownMs('soon', now), 5 * 60_000);
});

test('an oversized or malformed export is refused', async () => {
  const oversized = install({
    fetchImpl: upstream(null, (url) =>
      url === CZIB_EXPORT_URL
        ? new Response('x'.repeat(2 * 1024 * 1024 + 1), {
            headers: { 'content-type': 'application/json' },
          })
        : null,
    ),
  });
  assert.equal((await oversized()).status, 502);
  const malformed = install({
    fetchImpl: upstream(null, (url) =>
      url === CZIB_EXPORT_URL ? Response.json({ conflict_zones: 'no' }) : null,
    ),
  });
  assert.equal((await malformed()).status, 502);
});

test('the route rejects other methods, paths and floods', async () => {
  const request = install({ fetchImpl: upstream() });
  const post = await request('/', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET');
  assert.equal((await request('/other')).status, 404);
  let last;
  for (let index = 0; index < 31; index += 1)
    last = await request('/', 'GET', 'one');
  assert.equal(last.status, 429);
  assert.deepEqual(last.body, { error: 'rate_limited' });
  assert.equal((await request('/', 'GET', 'two')).status, 200);
});
