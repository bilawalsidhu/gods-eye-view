import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createMeteorProvider,
  meteorsProxy,
} from '../../../server/providers/meteors.js';
import { GMN_SUMMARY_URL } from './records.js';
const fixture = readFileSync(
  new URL('./fixtures/gmn-example.txt', import.meta.url),
  'utf8',
);
const initial = Date.parse('2026-09-15T07:00:00Z');

test('concurrent requests coalesce and cache for six hours', async () => {
  let calls = 0;
  const provider = createMeteorProvider({
    now: () => initial,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, GMN_SUMMARY_URL);
      assert.equal(options.redirect, 'error');
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(fixture);
    },
  });
  const [a, b] = await Promise.all([
    provider.getSnapshot(),
    provider.getSnapshot(),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.stale, false);
  assert.deepEqual(a, b);
  await provider.getSnapshot();
  assert.equal(calls, 1);
});

test('failed or malformed refresh retains observations and marks them stale; retry is bounded', async () => {
  let time = initial,
    calls = 0;
  const provider = createMeteorProvider({
    now: () => time,
    fetchImpl: async () => {
      calls++;
      return new Response(calls === 1 ? fixture : '<html>down</html>');
    },
  });
  const first = await provider.getSnapshot();
  time += 6 * 3600000;
  const stale = await provider.getSnapshot();
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, first.fetchedAt);
  assert.deepEqual(stale.records, first.records);
  await provider.getSnapshot();
  assert.equal(calls, 2);
});

test('a stale published batch is not called fresh just because it downloaded now', async () => {
  const provider = createMeteorProvider({
    now: () => initial + 48 * 3600000,
    fetchImpl: async () => new Response(fixture),
  });
  assert.equal((await provider.getSnapshot()).stale, true);
});

test('no cache plus oversized upstream fails and suppresses repeated requests', async () => {
  let calls = 0;
  const provider = createMeteorProvider({
    now: () => initial,
    fetchImpl: async () => {
      calls++;
      return new Response('large', {
        headers: { 'content-length': String(65 * 1024 * 1024) },
      });
    },
  });
  await assert.rejects(provider.getSnapshot(), /unavailable/);
  await assert.rejects(provider.getSnapshot(), /unavailable/);
  assert.equal(calls, 1);
});

test('Vite registration returns no post-hook and requests cannot choose another upstream', async () => {
  let middleware,
    calls = 0;
  const plugin = meteorsProxy({
    now: () => initial,
    fetchImpl: async () => {
      calls++;
      return new Response(fixture);
    },
  });
  const server = {
    middlewares: {
      use(path, handler) {
        assert.equal(path, '/api/meteors');
        middleware = handler;
        return () => {
          throw new Error('Not a post hook');
        };
      },
    },
  };
  assert.equal(plugin.configureServer(server), undefined);
  assert.equal(plugin.configurePreviewServer(server), undefined);
  async function request(url, method) {
    let status;
    await middleware(
      { url, method },
      {
        writeHead(code) {
          status = code;
        },
        end() {},
      },
    );
    return status;
  }
  assert.equal(await request('/?url=https://example.com', 'GET'), 404);
  assert.equal(await request('/', 'POST'), 405);
  assert.equal(calls, 0);
  assert.equal(await request('/', 'GET'), 200);
  assert.equal(calls, 1);
});
