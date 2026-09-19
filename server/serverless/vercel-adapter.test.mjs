import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rehydrateBody,
  resolveRequestUrl,
  stripVercelInjectedQuery,
} from './vercel-adapter.js';

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

test('resolveRequestUrl strips the query keys Vercel injects via the /api/:path* rewrite and the [...route] match', () => {
  const req = {
    url: '/api/sources/earthquakes?starttime=2026-09-17T18:34:32Z&__gev_api_path=sources%2Fearthquakes&...route=route',
    query: {
      starttime: '2026-09-17T18:34:32Z',
      __gev_api_path: 'sources/earthquakes',
      '...route': 'route',
    },
  };
  assert.equal(
    resolveRequestUrl(req),
    '/api/sources/earthquakes?starttime=2026-09-17T18:34:32Z',
  );
});

test("stripVercelInjectedQuery leaves the caller's own parameters byte-for-byte and drops the whole query when nothing is left", () => {
  assert.equal(
    stripVercelInjectedQuery(
      '/api/ais-live?bbox=29.2,-95.2,29.9,-94.4&maxRows=200&...route=route',
    ),
    '/api/ais-live?bbox=29.2,-95.2,29.9,-94.4&maxRows=200',
  );
  assert.equal(
    stripVercelInjectedQuery(
      '/api/celestrak/stations?__gev_api_path=celestrak%2Fstations&...route=route',
    ),
    '/api/celestrak/stations',
  );
  assert.equal(
    stripVercelInjectedQuery('/api/celestrak/stations'),
    '/api/celestrak/stations',
  );
  assert.equal(
    stripVercelInjectedQuery('/api/x?path=keep-me'),
    '/api/x?path=keep-me',
  );
});

test('resolveRequestUrl (fallback rebuild) ignores the injected keys in req.query too', () => {
  const req = {
    url: '',
    query: {
      route: ['tomtom', 'status'],
      point: '30.25,-97.75',
      __gev_api_path: 'tomtom/status',
      '...route': 'route',
    },
  };
  assert.equal(
    resolveRequestUrl(req),
    '/api/tomtom/status?point=30.25%2C-97.75',
  );
});

test('rehydrateBody re-encodes a Vercel-pre-parsed form body (application/x-www-form-urlencoded) as the form string, not JSON', async () => {
  // Real Vercel hands `/api/overpass` `{ data: '<Overpass QL>' }` for a form POST
  // (observed 2026-09-19); the sanitizer needs `data=<query>` back.
  const query = '[out:json][timeout:20];(way["highway"~"^(motorway|trunk)$"](30.24,-97.76,30.26,-97.74););out geom qt;';
  const req = {
    url: '/api/overpass',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: { data: query },
  };
  rehydrateBody(req);
  const text = await readViaAsyncIterator(req);
  const params = new URLSearchParams(text);
  assert.deepEqual(params.getAll('data'), [query]);
  assert.equal(text.startsWith('data='), true);
  // a JSON body keeps the JSON path
  const json = { url: '/api/x', headers: { 'content-type': 'application/json' }, body: { query: 'node(1);out;' } };
  rehydrateBody(json);
  assert.deepEqual(JSON.parse(await readViaAsyncIterator(json)), { query: 'node(1);out;' });
});
