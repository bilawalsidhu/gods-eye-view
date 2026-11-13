import test from 'node:test';
import assert from 'node:assert/strict';
import { airAccidentsProxy } from '../../server/providers/airAccidents.js';

const binding = (qid, lon, lat, extra = {}) => ({
  item: { value: `http://www.wikidata.org/entity/${qid}` },
  itemLabel: { value: `Accident ${qid}` },
  coord: { value: `Point(${lon} ${lat})` },
  ...extra,
});

/** The own-coordinate query has no FILTER NOT EXISTS; the placed one does. */
const isPlaced = (url) =>
  decodeURIComponent(String(url)).includes('FILTER NOT EXISTS');

function fakeFetch({ ownFails = false, placedFails = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (!String(url).startsWith('https://query.wikidata.org/sparql'))
      return new Response('', { status: 404 });
    if (isPlaced(url)) {
      if (placedFails) return new Response('', { status: 503 });
      return Response.json({
        results: {
          bindings: [
            binding('Q2', 10, 20, { placeLabel: { value: 'Some Airport' } }),
          ],
        },
      });
    }
    if (ownFails) return new Response('', { status: 503 });
    return Response.json({ results: { bindings: [binding('Q1', 1, 2)] } });
  };
  return { fetchImpl, calls };
}

function handlerOf(plugin) {
  let handler;
  plugin.configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  return handler;
}

function request(handler, { method = 'GET', url = '/' } = {}) {
  return new Promise((resolve) => {
    const res = {
      destroyed: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        resolve({
          status: this.status,
          headers: this.headers,
          body: JSON.parse(body),
        });
      },
    };
    handler(
      { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
      res,
    );
  });
}

test('serves one cached snapshot of both Wikidata queries', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const handler = handlerOf(airAccidentsProxy({ fetchImpl, now: () => 1000 }));
  const first = await request(handler);
  assert.equal(first.status, 200);
  assert.equal(first.body.complete, true);
  assert.deepEqual(
    first.body.records.map(({ id, approximate, place }) => ({
      id,
      approximate,
      place,
    })),
    [
      { id: 'wikidata:Q1', approximate: false, place: undefined },
      { id: 'wikidata:Q2', approximate: true, place: 'Some Airport' },
    ],
  );
  // Null fields are left out of the response.
  assert.equal('fatalities' in first.body.records[0], false);
  assert.equal(calls.length, 2);
  for (const { options } of calls) {
    assert.match(options.headers['User-Agent'], /God's Eye View/);
    assert.equal(options.redirect, 'error');
  }
  await request(handler);
  assert.equal(calls.length, 2, 'the second request is served from cache');
});

test('the placed query failing still serves the own-coordinate accidents', async () => {
  const { fetchImpl } = fakeFetch({ placedFails: true });
  const handler = handlerOf(airAccidentsProxy({ fetchImpl }));
  const { status, body } = await request(handler);
  assert.equal(status, 200);
  assert.equal(body.complete, false);
  assert.deepEqual(
    body.records.map(({ id }) => id),
    ['wikidata:Q1'],
  );
});

test('a malformed 200 from the placed query reports an incomplete snapshot', async () => {
  const { fetchImpl: good } = fakeFetch();
  let placedCalls = 0;
  const fetchImpl = async (url, options) => {
    if (isPlaced(url)) {
      placedCalls++;
      // An HTTP success with no bindings array is not a completed SPARQL query.
      return Response.json({ results: { bindings: null } });
    }
    return good(url, options);
  };
  const handler = handlerOf(airAccidentsProxy({ fetchImpl, now: () => 1000 }));
  const { status, body } = await request(handler);
  assert.equal(status, 200);
  assert.equal(body.complete, false);
  assert.deepEqual(
    body.records.map(({ id }) => id),
    ['wikidata:Q1'],
  );
  assert.equal(placedCalls, 2, 'invalid envelopes are retried once');
});

test('the own-coordinate query failing is a 502', async () => {
  const { fetchImpl } = fakeFetch({ ownFails: true });
  const handler = handlerOf(airAccidentsProxy({ fetchImpl }));
  const { status, body } = await request(handler);
  assert.equal(status, 502);
  assert.equal(body.error, 'air_accidents_unavailable');
});

test('a cut-off answer is asked for again past the edge cache', async () => {
  const { fetchImpl: good } = fakeFetch();
  const urls = [];
  const fetchImpl = async (url, options) => {
    urls.push(decodeURIComponent(String(url)));
    if (urls.length === 1 && !isPlaced(url))
      return new Response(
        '{"head":{"vars":[]},"results":{"bindings":[{"item"',
        {
          status: 200,
        },
      );
    return good(url, options);
  };
  const handler = handlerOf(airAccidentsProxy({ fetchImpl, now: () => 7 }));
  const { status, body } = await request(handler);
  assert.equal(status, 200);
  assert.equal(body.records.length, 2);
  const own = urls.filter((url) => !isPlaced(url));
  assert.equal(own.length, 2);
  assert.notEqual(own[0], own[1]);
  assert.match(own[1], /# retry 7/);
});

test('a failed refresh serves the last snapshot as stale', async () => {
  let time = 0;
  let fail = false;
  const { fetchImpl: good } = fakeFetch();
  const { fetchImpl: bad } = fakeFetch({ ownFails: true });
  const handler = handlerOf(
    airAccidentsProxy({
      fetchImpl: (...args) => (fail ? bad : good)(...args),
      now: () => time,
    }),
  );
  assert.equal((await request(handler)).status, 200);
  fail = true;
  time = 25 * 60 * 60 * 1000;
  const stale = await request(handler);
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  time = 9 * 24 * 60 * 60 * 1000;
  assert.equal((await request(handler)).status, 502);
});

test('rejects other methods and routes', async () => {
  const { fetchImpl } = fakeFetch();
  const handler = handlerOf(airAccidentsProxy({ fetchImpl }));
  const post = await request(handler, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET');
  const other = await request(handler, { url: '/other' });
  assert.equal(other.status, 404);
});
