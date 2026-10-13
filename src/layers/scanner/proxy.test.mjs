import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  createScannerMiddleware,
  normalizeOpenMhzCalls,
  normalizeScannerFeeds,
} from '../../../server/providers/scanner.js';

const FEEDS = {
  feeds: [
    {
      id: 'city-pd',
      name: 'City PD',
      lat: 30,
      lon: -97,
      type: 'stream',
      url: 'https://stream.example.test/secret-token/pd.mp3',
    },
    {
      id: 'lan-box',
      name: 'LAN',
      lat: 30,
      lon: -97,
      type: 'stream',
      url: 'http://192.168.1.5:8000/x.mp3',
      allowPrivate: true,
    },
    {
      id: 'county-calls',
      name: 'County',
      lat: 31,
      lon: -98,
      type: 'openmhz',
      system: 'county1',
      talkgroup: 77,
    },
    { id: 'bad-url', name: 'Bad', lat: 0, lon: 0, type: 'stream', url: 'file:///etc/passwd' },
    { id: 'bad-lat', name: 'Bad', lat: 99, lon: 0, type: 'stream', url: 'https://a.test/x' },
  ],
};

async function withServer(options, run) {
  const middleware = createScannerMiddleware({
    readFeedsFile: () => JSON.stringify(FEEDS),
    lookupImpl: async (host) => [
      { address: host.startsWith('192.') ? host : '93.184.216.34', family: 4 },
    ],
    ...options,
  });
  const server = http.createServer((req, res) => {
    req.url = req.url.replace(/^\/api\/scanner/, '') || '/';
    middleware(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/scanner`;
  try {
    await run(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('feed registry drops invalid rows and never exposes URLs', async () => {
  const { feeds, registry } = normalizeScannerFeeds(FEEDS);
  assert.deepEqual(
    feeds.map((feed) => feed.id),
    ['city-pd', 'lan-box', 'county-calls'],
  );
  assert.equal(registry.has('bad-url'), false);
  await withServer({}, async (base) => {
    const text = await (await fetch(`${base}/feeds`)).text();
    assert.ok(!text.includes('secret-token'));
    assert.ok(!text.includes('192.168'));
    assert.equal(JSON.parse(text).feeds.length, 3);
  });
});

test('only registered ids and GET are served', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/stream/nope`)).status, 404);
    assert.equal((await fetch(`${base}/calls/city-pd`)).status, 404);
    assert.equal((await fetch(`${base}/stream/county-calls`)).status, 404);
    assert.equal((await fetch(`${base}/feeds`, { method: 'POST' })).status, 405);
  });
});

test('stream feeds are piped as audio through the registered URL', async () => {
  const seen = [];
  await withServer(
    {
      fetchImpl: async (url) => {
        seen.push(url);
        return new Response('AUDIO-BYTES', {
          headers: { 'content-type': 'text/html' },
        });
      },
    },
    async (base) => {
      const response = await fetch(`${base}/stream/city-pd`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'audio/mpeg');
      assert.equal(await response.text(), 'AUDIO-BYTES');
      assert.deepEqual(seen, ['https://stream.example.test/secret-token/pd.mp3']);
    },
  );
});

test('private addresses are refused unless the feed opts in', async () => {
  await withServer(
    {
      lookupImpl: async () => [{ address: '10.0.0.8', family: 4 }],
      fetchImpl: async () => new Response('ok', { headers: { 'content-type': 'audio/mpeg' } }),
    },
    async (base) => {
      assert.equal((await fetch(`${base}/stream/city-pd`)).status, 502);
      assert.equal((await fetch(`${base}/stream/lan-box`)).status, 200);
    },
  );
});

test('OpenMHz calls are filtered to https openmhz hosts, oldest first', async () => {
  const requested = [];
  await withServer(
    {
      fetchImpl: async (url) => {
        requested.push(String(url));
        return new Response(
          JSON.stringify({
            calls: [
              { _id: 'b', time: '2026-01-01T00:00:20Z', len: 4, talkgroupNum: 77, url: 'https://cdn.openmhz.com/b.m4a' },
              { _id: 'a', time: '2026-01-01T00:00:10Z', url: 'https://cdn.openmhz.com/a.m4a' },
              { _id: 'evil', time: '2026-01-01T00:00:30Z', url: 'https://evil.test/c.m4a' },
              { _id: 'plain', time: '2026-01-01T00:00:40Z', url: 'http://cdn.openmhz.com/d.m4a' },
            ],
          }),
        );
      },
    },
    async (base) => {
      const body = await (await fetch(`${base}/calls/county-calls`)).json();
      assert.deepEqual(
        body.calls.map((call) => call.id),
        ['a', 'b'],
      );
      assert.equal(
        requested[0],
        'https://api.openmhz.com/county1/calls?filter-type=talkgroup&filter-code=77',
      );
    },
  );
  assert.deepEqual(normalizeOpenMhzCalls({}), []);
});

test('a missing or corrupt feed file means no feeds, not a crash', async () => {
  await withServer(
    {
      readFeedsFile: () => {
        throw new Error('ENOENT');
      },
    },
    async (base) => {
      assert.deepEqual(await (await fetch(`${base}/feeds`)).json(), { feeds: [] });
    },
  );
});
