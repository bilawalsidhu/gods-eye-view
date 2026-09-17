import test from 'node:test';
import assert from 'node:assert/strict';
import { rehydrateBody, resolveRequestUrl } from './vercel-adapter.js';

/** Reads a body the way server/providers/common/request.js `readRequestBodyCapped` does. */
async function readViaAsyncIterator(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Reads a body the way server/providers/common/request.js `readRequestBody` does. */
function readViaEvents(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

test('rehydrateBody is a no-op when req.body is undefined', () => {
  const req = { url: '/api/overpass', body: undefined };
  const result = rehydrateBody(req);
  assert.equal(result, req);
  assert.equal(Symbol.asyncIterator in req, false);
});

test('rehydrateBody replays a parsed JSON object through the async-iterator style', async () => {
  const req = { url: '/api/overpass', body: { query: 'node(1);out;' } };
  rehydrateBody(req);
  const text = await readViaAsyncIterator(req);
  assert.deepEqual(JSON.parse(text), { query: 'node(1);out;' });
});

test('rehydrateBody replays a string body through the on("data"/"end") style', async () => {
  const req = { url: '/api/openai/hud-summary', body: '{"prompt":"hi"}' };
  rehydrateBody(req);
  const text = await readViaEvents(req);
  assert.equal(text, '{"prompt":"hi"}');
});

test('rehydrateBody handles a Buffer body unchanged', async () => {
  const req = { url: '/api/overpass', body: Buffer.from('raw-bytes') };
  rehydrateBody(req);
  const text = await readViaAsyncIterator(req);
  assert.equal(text, 'raw-bytes');
});

test('rehydrateBody is idempotent: calling it twice does not double the payload', async () => {
  const req = { url: '/api/overpass', body: { a: 1 } };
  rehydrateBody(req);
  rehydrateBody(req);
  const text = await readViaAsyncIterator(req);
  assert.deepEqual(JSON.parse(text), { a: 1 });
});

test('resolveRequestUrl prefers req.url when it already looks like an API path', () => {
  const req = { url: '/api/firms/status?x=1', query: { route: ['ignored'] } };
  assert.equal(resolveRequestUrl(req), '/api/firms/status?x=1');
});

test('resolveRequestUrl rebuilds the path from req.query.route (array) when req.url is not an API path', () => {
  const req = { url: '/', query: { route: ['firms', 'status'] } };
  assert.equal(resolveRequestUrl(req), '/api/firms/status');
});

test('resolveRequestUrl rebuilds the path from req.query.route (string) and preserves other query params', () => {
  const req = { url: '', query: { route: 'celestrak', GROUP: 'active' } };
  assert.equal(resolveRequestUrl(req), '/api/celestrak?GROUP=active');
});

test('resolveRequestUrl falls back to bare /api with no route segments', () => {
  const req = { url: undefined, query: {} };
  assert.equal(resolveRequestUrl(req), '/api');
});
