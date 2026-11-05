import test from 'node:test';
import assert from 'node:assert/strict';
import { shipwrecksProxy } from '../../server/providers/shipwrecks.js';

const EMODNET = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'heritageshipwrecks.1',
      geometry: { type: 'Point', coordinates: [-0.92, 50.74] },
      properties: { name: 'HMS/m A1', sink_yr: '1911', country: 'UK' },
    },
  ],
};

function fakeFetch({ wikidataFails = false, emodnetFails = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const href = String(url);
    if (href.includes('query.wikidata.org')) {
      if (wikidataFails) return new Response('', { status: 503 });
      return Response.json({ results: { bindings: [] } });
    }
    if (emodnetFails) return new Response('', { status: 503 });
    if (href.includes('ows.emodnet-humanactivities.eu'))
      return Response.json(EMODNET);
    return new Response('', { status: 404 });
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

test('serves one cached snapshot from fixed upstreams', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const handler = handlerOf(shipwrecksProxy({ fetchImpl }));
  const first = await request(handler);
  assert.equal(first.status, 200);
  assert.equal(first.body.records.length, 1);
  assert.equal(first.body.records[0].name, 'HMS/m A1');
  assert.equal(first.body.records[0].year, 1911);
  assert.deepEqual(first.body.sources, { emodnet: true, wikidata: true });
  for (const { url } of calls)
    assert.match(
      url,
      /^https:\/\/(ows\.emodnet-humanactivities\.eu\/wfs\?|query\.wikidata\.org\/sparql\?)/,
    );
  const count = calls.length;
  await request(handler);
  assert.equal(calls.length, count, 'second request is served from cache');
});

test('one failing source still serves the other; both failing is a 502', async () => {
  const partial = handlerOf(
    shipwrecksProxy({
      fetchImpl: fakeFetch({ wikidataFails: true }).fetchImpl,
    }),
  );
  const ok = await request(partial);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.sources, { emodnet: true, wikidata: false });

  const down = handlerOf(
    shipwrecksProxy({
      fetchImpl: fakeFetch({ wikidataFails: true, emodnetFails: true })
        .fetchImpl,
    }),
  );
  assert.equal((await request(down)).status, 502);
});

test('a failed refresh serves the last snapshot as stale', async () => {
  let clock = 0;
  let fail = false;
  const { fetchImpl: good } = fakeFetch();
  const { fetchImpl: bad } = fakeFetch({
    wikidataFails: true,
    emodnetFails: true,
  });
  const handler = handlerOf(
    shipwrecksProxy({
      fetchImpl: (...args) => (fail ? bad : good)(...args),
      now: () => clock,
    }),
  );
  await request(handler);
  fail = true;
  clock = 25 * 60 * 60 * 1000;
  const stale = await request(handler);
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
});

test('rejects other methods and routes', async () => {
  const handler = handlerOf(
    shipwrecksProxy({ fetchImpl: fakeFetch().fetchImpl }),
  );
  assert.equal((await request(handler, { method: 'POST' })).status, 405);
  assert.equal((await request(handler, { url: '/x' })).status, 404);
});
