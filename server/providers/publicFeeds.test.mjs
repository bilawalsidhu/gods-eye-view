import test from 'node:test';
import assert from 'node:assert/strict';
import { publicFeedsProxy } from './publicFeeds.js';

function harness(fetchImpl) {
  let handler;
  const proxy = publicFeedsProxy({ fetchImpl });
  proxy.configureServer({ middlewares: { use(path, fn) { assert.equal(path, '/api/public-feeds'); handler = fn; } } });
  return async (url, method = 'GET') => {
    const result = {};
    await handler({ url, method }, { writeHead(status, headers) { result.status = status; result.headers = headers; }, end(body) { result.body = body; } });
    return result;
  };
}

test('proxy fetches fixed upstream once and caches valid responses', async () => {
  const calls = [];
  const request = harness(async (url) => { calls.push(url); return new Response(JSON.stringify({ type: 'FeatureCollection', features: [] })); });
  assert.equal((await request('/volcanoes')).status, 200);
  assert.equal((await request('/volcanoes')).status, 200);
  assert.deepEqual(calls, ['https://volcanoes.usgs.gov/vsc/api/volcanoApi/geojson']);
  assert.equal((await request('/volcanoes?url=https://evil.example')).status, 404);
  assert.equal((await request('/volcanoes', 'POST')).status, 405);
});

test('proxy rejects failed and malformed upstream responses without caching', async () => {
  let n = 0;
  const request = harness(async () => { n++; return n === 1 ? new Response('oops', { status: 503 }) : new Response('{}'); });
  assert.equal((await request('/aurora')).status, 502);
  assert.equal((await request('/aurora')).status, 502);
  assert.equal(n, 2);
});
