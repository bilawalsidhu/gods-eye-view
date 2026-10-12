import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createAreaNewsHandler, areaNewsProxy } from './area-news.js';
import { sameSiteGated } from './common/same-site.js';
test('Vite registration cannot invoke middleware as a startup callback', () => {
  const installed = [];
  const server = {
    middlewares: {
      use: (route, handler) => {
        installed.push(route);
        return () => {
          throw Error('Invalid startup callback');
        };
      },
    },
  };
  const plugin = areaNewsProxy();
  assert.equal(plugin.configureServer(server), undefined);
  assert.equal(plugin.configurePreviewServer(server), undefined);
  assert.deepEqual(installed, ['/api/area-news', '/api/area-news']);
});
const now = Date.parse('2026-10-12T12:00Z'),
  input = {
    area: { west: -98, south: 30, east: -97, north: 31 },
    place: 'Austin',
    topic: '',
    start: '2026-10-10T00:00:00Z',
    end: '2026-10-12T12:00:00Z',
  };
async function invoke(h, body = input, headers = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:4173',
      origin: 'http://127.0.0.1:4173',
      'content-type': 'application/json',
      ...headers,
    },
    socket: { remoteAddress: '127.0.0.1' },
  });
  const res = new EventEmitter();
  res.setHeader = () => {};
  res.end = (s) => {
    res.writableEnded = true;
    res.body = JSON.parse(s);
  };
  await h(req, res);
  return res;
}
test('fixed DOC2 endpoint receives text/dates only and preserves geography/date caveats', async () => {
  let sent;
  const h = createAreaNewsHandler({
    now: () => now,
    fetchImpl: async (url, options) => {
      sent = { url, options };
      return new Response(
        JSON.stringify({
          articles: [
            {
              url: 'https://publisher.example/news',
              title: 'Austin news',
              seendate: '20261011T120000Z',
            },
          ],
        }),
      );
    },
  });
  const r = await invoke(h);
  assert.equal(r.statusCode, 200);
  const u = new URL(sent.url);
  assert.equal(u.origin, 'https://api.gdeltproject.org');
  assert.equal(u.searchParams.get('startdatetime'), '20261010000000');
  assert.equal(u.searchParams.get('maxrecords'), '25');
  assert.ok(!sent.url.includes('-98') && !sent.url.includes('west'));
  assert.equal(sent.options.redirect, 'error');
  assert.match(r.body.geography, /not verified spatial filtering/);
  assert.match(r.body.dateBasis, /seen\/indexed/);
});
test('rate-limit/HTML/malformed responses are errors and never counterfeit empty results', async () => {
  for (const response of [
    new Response('busy', { status: 429 }),
    new Response('<html>error</html>'),
    new Response('{}'),
  ]) {
    const h = createAreaNewsHandler({
      now: () => now,
      fetchImpl: async () => response,
    });
    const r = await invoke(h);
    assert.ok(r.statusCode >= 400);
    assert.ok(r.body.error);
    assert.equal(r.body.articles, undefined);
  }
});
test('foreign-origin and invalid area requests never reach upstream', async () => {
  let calls = 0;
  const h = createAreaNewsHandler({
    now: () => now,
    fetchImpl: async () => {
      calls++;
      return new Response('{"articles":[]}');
    },
  });
  assert.equal(
    (
      await invoke(sameSiteGated(h), input, {
        origin: 'https://foreign.example',
        'sec-fetch-site': 'cross-site',
      })
    ).statusCode,
    403,
  );
  assert.equal((await invoke(h, { ...input, area: {} })).statusCode, 400);
  assert.equal(calls, 0);
});

test('upstream Retry-After prevents another external request for its full interval', async () => {
  let clock = now,
    calls = 0;
  const h = createAreaNewsHandler({
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      return new Response('limited', {
        status: 429,
        headers: { 'Retry-After': '120' },
      });
    },
  });
  const first = await invoke(h);
  assert.equal(first.body.retryAfterSeconds, 120);
  clock += 10000;
  const second = await invoke(h);
  assert.equal(second.body.retryAfterSeconds, 110);
  assert.equal(calls, 1);
});
